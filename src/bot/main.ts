import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  ApplicationFlagsBitField,
  PermissionFlagsBits as P,
} from "discord.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, loadCredentials } from "../config.js";
import { Store } from "../storage/store.js";
import { acquireLock } from "../storage/lock.js";
import { BotContext } from "./context.js";
import { AttachmentFilter } from "./attachments.js";
import { discordRoomService, roomCommand } from "./rooms.js";
import { submitReport } from "./reports.js";
import { errorCode, noMentions } from "../shared/utils.js";
import { lintContent } from "../content.js";
import { isManagedPinNotice } from "../shared/pin-notices.js";
import { settingsInteraction } from "./settings-panel.js";
import { discordRoleSelection } from "./role-selection.js";

import { loadInstallations, healthPath, type GuildInstallation } from "../installations.js";
import { GuildRegistry } from "./guild-registry.js";
interface GuildRuntime {
  context: BotContext;
  filter: AttachmentFilter;
  rooms: ReturnType<typeof discordRoomService>;
  retentionAt: number;
  roleSelection: Awaited<ReturnType<typeof discordRoleSelection>>;
  rolesAt: number;
}

async function main(): Promise<void> {
  const credentials = loadCredentials();
  const installations = loadInstallations();
  const configs = new Map(
    installations.map((installation) => {
      const config = loadConfig(installation.configPath);
      const errors = lintContent(config);
      if (errors.length) throw Error(errors.join("\n"));
      return [installation.guildId, config];
    }),
  );
  const stores = new Map<string, Store>();
  const releases: (() => Promise<void>)[] = [];
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    allowedMentions: noMentions,
    rest: { retries: 0, timeout: 15000 },
  });
  const registry = new GuildRegistry<GuildRuntime>(installations);
  let stopping = false,
    ticking = false,
    initializing = false,
    connected = false;
  const inFlight = new Set<Promise<unknown>>();
  function track(task: Promise<unknown>): void {
    const tracked = task
      .catch((error) => console.error(`Event failed: ${errorCode(error)}`))
      .finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
  }
  const path = healthPath();
  mkdirSync(dirname(path), { recursive: true });
  const available = (runtime: GuildRuntime) =>
    runtime.context.guild.available && client.isReady() && client.ws.status === 0;
  function health() {
    const guilds = registry.statuses(available);
    const ready = !stopping && connected && guilds.some((guild) => guild.ready);
    writeFileSync(
      path,
      JSON.stringify({
        ready,
        degraded: guilds.some((guild) => !guild.ready),
        guilds,
        updated: Date.now(),
      }) + "\n",
    );
  }
  function lookup(guildId: string | null | undefined) {
    const runtime = registry.get(guildId);
    return !stopping && runtime && available(runtime) ? runtime : undefined;
  }
  async function createRuntime(installation: GuildInstallation): Promise<GuildRuntime> {
    const config = configs.get(installation.guildId)!;
    const store = stores.get(installation.guildId)!;
    const environment = { ...credentials, ...installation };
    const guild = await client.guilds.fetch(installation.guildId);
    if (guild.ownerId !== installation.ownerId)
      throw new Error("Expected owner differs from the guild owner.");
    await guild.channels.fetch();
    const me = await guild.members.fetchMe();
    if (me.permissions.has(P.Administrator)) throw new Error("Remove Administrator from the bot.");
    if (!me.permissions.has([P.ManageChannels, P.MoveMembers]))
      throw new Error("Missing runtime guild permissions.");
    for (const channelSpec of config.channels) {
      const channel = guild.channels.cache.get(store.id(`channel.${channelSpec.key}`));
      if (!channel) throw new Error(`Configured channel is missing: ${channelSpec.key}`);
      if (
        !channel
          .permissionsFor(me)
          ?.has([P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.ManageMessages])
      )
        throw new Error(`Missing message/filter permissions in ${channelSpec.key}.`);
    }
    if (
      !guild.channels.cache.get(store.id("category.rooms"))?.permissionsFor(me)?.has(P.ManageRoles)
    )
      throw new Error("Room overwrite management is unavailable.");
    const context = new BotContext(client, guild, store, config, environment);
    const filter = new AttachmentFilter(context);
    const rooms = discordRoomService(context);
    await rooms.reconcile();
    const roleSelection = await discordRoleSelection(context).catch(async (error) => {
      await context.alert("role-selection", "panel", errorCode(error));
      return null;
    });
    await context.retention();
    console.log(`Guild started: ${guild.id}`);
    return {
      context,
      filter,
      rooms,
      roleSelection,
      rolesAt: Date.now() + 300000,
      retentionAt: Date.now() + 3600000,
    };
  }
  const timer = setInterval(() => {
    if (stopping) return;
    // A slow guild API request must not suppress health signals or other guilds' maintenance.
    health();
    if (!connected || !client.isReady()) return;
    if (!initializing) {
      initializing = true;
      track(
        registry
          .initialize(createRuntime, (guildId, error) => {
            console.error(`Guild unavailable: ${guildId}; ${errorCode(error)}`);
          })
          .finally(() => {
            initializing = false;
            health();
          }),
      );
    }
    if (ticking) return;
    ticking = true;
    track(
      (async () => {
        await Promise.all(
          registry.values().map(async (runtime) => {
            if (!available(runtime)) return;
            try {
              await runtime.rooms.reconcile();
              if (Date.now() >= runtime.rolesAt) {
                runtime.rolesAt = Date.now() + 300000;
                if (runtime.roleSelection) await runtime.roleSelection.reconcile();
                else runtime.roleSelection = await discordRoleSelection(runtime.context);
              }
              if (Date.now() > runtime.retentionAt) {
                await runtime.context.retention();
                runtime.retentionAt = Date.now() + 3600000;
              }
            } catch (error) {
              await runtime.context.alert("maintenance", "runtime", errorCode(error));
            }
          }),
        );
        health();
      })().finally(() => {
        ticking = false;
      }),
    );
  }, 5000);
  let shutdown: Promise<void> | undefined;
  function stop(): Promise<void> {
    if (shutdown) return shutdown;
    stopping = true;
    clearInterval(timer);
    health();
    client.removeAllListeners(Events.VoiceStateUpdate);
    client.removeAllListeners(Events.MessageCreate);
    client.removeAllListeners(Events.MessageUpdate);
    client.removeAllListeners(Events.InteractionCreate);
    client.removeAllListeners(Events.MessageReactionAdd);
    client.removeAllListeners(Events.MessageReactionRemove);
    shutdown = (async () => {
      try {
        await Promise.all([...inFlight]);
        await Promise.all(
          registry.values().map(async (runtime) => {
            await runtime.filter.drain();
            await runtime.rooms.queue.drain();
            await runtime.roleSelection?.queue.drain();
          }),
        );
      } finally {
        await client.destroy();
        for (const store of stores.values()) store.close();
        for (const release of releases.reverse()) await release();
      }
    })();
    return shutdown;
  }
  const onSignal = () => {
    void stop().catch((error) => {
      console.error(`Shutdown failed: ${errorCode(error)}`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  client.once(Events.ClientReady, () => {
    void (async () => {
      if (client.user!.id !== credentials.clientId)
        throw Error("Bot identity differs from DISCORD_CLIENT_ID.");
      const application = await client.application!.fetch();
      const flags = ApplicationFlagsBitField.Flags;
      if (
        !application.flags.has(flags.GatewayMessageContent) &&
        !application.flags.has(flags.GatewayMessageContentLimited)
      )
        throw Error("Enable Message Content Intent in Developer Portal before starting.");
      connected = true;
      console.log("Bot connected. Timezone: Europe/Warsaw.");
    })().catch(async (error) => {
      console.error(`Startup failed: ${errorCode(error)}`);
      await stop();
      process.exitCode = 1;
    });
  });
  // Losing access to one guild must not restart the other installations.
  client.on(Events.GuildDelete, (guild) => {
    const runtime = registry.invalidate(guild.id);
    if (runtime)
      track(
        Promise.all([
          runtime.filter.drain(),
          runtime.rooms.queue.drain(),
          runtime.roleSelection?.queue.drain(),
        ]),
      );
    health();
  });
  client.on(Events.MessageCreate, (message) => {
    const runtime = lookup(message.guildId);
    if (runtime) {
      const { context, filter } = runtime;
      const { store, environment } = context;
      if (
        isManagedPinNotice(
          {
            id: message.id,
            type: message.type,
            channel_id: message.channelId,
            author: { id: message.author.id },
            message_reference: message.reference
              ? { message_id: message.reference.messageId, channel_id: message.reference.channelId }
              : undefined,
          },
          message.channelId,
          environment.clientId,
          new Set(
            store
              .resources()
              .filter((entry) => entry.kind === "message")
              .map((entry) => entry.id),
          ),
        )
      ) {
        track(message.delete());
        return;
      }
      track(
        filter
          .handle(message)
          .catch((error) => context?.alert("attachments", message.id, errorCode(error))),
      );
    }
  });
  client.on(Events.MessageUpdate, (_, message) => {
    const runtime = lookup(message.guildId);
    if (!runtime) return;
    const { context, filter } = runtime;
    if (!stopping)
      track(
        filter
          .handle(message)
          .catch((error) => context?.alert("attachments", message.id, errorCode(error))),
      );
  });
  for (const [event, active] of [
    [Events.MessageReactionAdd, true],
    [Events.MessageReactionRemove, false],
  ] as const)
    client.on(event, (...args) => {
      const [reaction, user] = args;
      const runtime = lookup(reaction.message.guildId);
      if (!runtime?.roleSelection || user.id === credentials.clientId || user.bot) return;
      track(
        runtime.roleSelection
          .handle({
            guild: reaction.message.guildId,
            channel: reaction.message.channelId,
            message: reaction.message.id,
            emoji: reaction.emoji.id ? null : reaction.emoji.name,
            user: user.id,
            active,
          })
          .catch((error) => runtime.context.alert("role-selection", user.id, errorCode(error))),
      );
    });
  client.on(Events.VoiceStateUpdate, (previous, state) => {
    const runtime = lookup(state.guild.id);
    if (!runtime) return;
    const { context, rooms } = runtime;
    const { store } = context;
    track(
      (async () => {
        await rooms.recordPresence(state.id, previous.channelId, state.channelId);
        if (state.channelId && state.member && !state.member.user.bot) {
          const managed =
            store
              .resources()
              .some((resource) => resource.kind === "channel" && resource.id === state.channelId) ||
            Boolean(store.room(state.channelId));
          if (managed) {
            try {
              await context.member(state.id);
            } catch (error) {
              if (error instanceof Error && ["pending", "timeout"].includes(error.message)) {
                await state.member.voice.disconnect(
                  "Wymagane kroki dołączenia lub ograniczenie moderacyjne",
                );
                await context.notify(state.id, null, error.message);
                return;
              }
              throw error;
            }
          }
        }
        if (state.channelId === store.id("channel.join") && state.member) {
          const member = state.member;
          try {
            await rooms.enter({ id: member.id, name: member.displayName, bot: member.user.bot });
          } catch (error) {
            await context.notify(
              member.id,
              null,
              error instanceof Error && context.texts[error.message] ? error.message : "roomFailed",
            );
            if (member.voice.channelId === store.id("channel.join"))
              await member.voice.disconnect("Nie udało się utworzyć pokoju");
            await context.alert("rooms", member.id, errorCode(error));
          }
        }
        await rooms.reconcile();
      })().catch((error) => context?.alert("rooms", state.id, errorCode(error))),
    );
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (stopping) return;
    const runtime = lookup(interaction.guildId);
    if (!runtime) {
      if (interaction.isChatInputCommand())
        track(
          interaction.reply({
            content:
              "Ten serwer nie jest jeszcze skonfigurowany lub bot jest chwilowo niedostępny.",
            flags: MessageFlags.Ephemeral,
          }),
        );
      return;
    }
    const { context, rooms } = runtime;
    const { environment } = context;
    track(
      (async () => {
        if (await settingsInteraction(context, interaction)) return;
        if (!interaction.isChatInputCommand()) return;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          if (stopping || interaction.guildId !== environment.guildId)
            throw new Error("Ta komenda działa na skonfigurowanym serwerze.");
          await context.member(interaction.user.id);
          if (interaction.commandName === "pokoj") await roomCommand(context, rooms, interaction);
          else if (interaction.commandName === "zglos") await submitReport(context, interaction);
          else throw new Error("Unknown command.");
        } catch (error) {
          const known = error instanceof Error ? context.texts[error.message] : undefined;
          await interaction.editReply(known ?? context.texts.operationFailed);
          await context.alert("commands", interaction.user.id, errorCode(error));
        }
      })().catch((error) => {
        console.error(`Interaction failed: ${errorCode(error)}`);
      }),
    );
  });
  client.on(Events.Error, (error) => console.error(`Discord error: ${errorCode(error)}`));
  health();
  try {
    for (const installation of installations) {
      releases.push(await acquireLock(installation.databasePath));
      stores.set(installation.guildId, new Store(installation.databasePath, installation.guildId));
    }
    await client.login(credentials.token);
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch((error) => {
  console.error(`Bot stopped: ${errorCode(error)}`);
  process.exitCode = 1;
});
