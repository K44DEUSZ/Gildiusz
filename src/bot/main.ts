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
import type { Server } from "node:http";
import { dirname, join } from "node:path";
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
import { PublicInstallations } from "../control/installations.js";
import { publicConfig } from "../control/configuration.js";
import { startControlServer } from "../control/server.js";
import { ControlError, type ControlSnapshot } from "../control/contracts.js";
import {
  authorizeControl,
  controlResources,
  validateControl,
  prepareRolePanel,
  finishRolePanel,
  rolePanel,
  selectionChoices,
} from "./control.js";
import { commands } from "./commands.js";
interface GuildRuntime {
  context: BotContext;
  filter: AttachmentFilter;
  rooms: ReturnType<typeof discordRoomService> | null;
  retentionAt: number;
  roleSelection: Awaited<ReturnType<typeof discordRoleSelection>>;
  rolesAt: number;
}

async function main(): Promise<void> {
  const credentials = loadCredentials();
  const publicInstallations =
    process.env.PUBLIC_INSTALLS === "1"
      ? new PublicInstallations(
          process.env.CONTROL_DATA_DIR || join(dirname(healthPath()), "public-guilds"),
        )
      : undefined;
  const legacy = loadInstallations();
  const installations = [
    ...legacy,
    ...(publicInstallations
      ?.values()
      .filter((entry) => !legacy.some((value) => value.guildId === entry.guildId)) ?? []),
  ];
  const configs = new Map(
    installations.map((installation) => {
      const config = installation.public ? publicConfig() : loadConfig(installation.configPath);
      const errors = installation.public ? [] : lintContent(config);
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
  const controlTasks = new Set<Promise<unknown>>();
  const changing = new Set<string>();
  let controlServer: Server | undefined;
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
    const ready =
      !stopping && connected && (guilds.length === 0 || guilds.some((guild) => guild.ready));
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
    return !stopping && !changing.has(guildId ?? "") && runtime && available(runtime)
      ? runtime
      : undefined;
  }
  async function createRuntime(installation: GuildInstallation): Promise<GuildRuntime> {
    const config = configs.get(installation.guildId)!;
    const store = stores.get(installation.guildId)!;
    const environment = { ...credentials, ...installation };
    const guild = await client.guilds.fetch(installation.guildId);
    if (!installation.public && guild.ownerId !== installation.ownerId)
      throw new Error("Expected owner differs from the guild owner.");
    await guild.channels.fetch();
    const me = await guild.members.fetchMe();
    if (me.permissions.has(P.Administrator)) throw new Error("Remove Administrator from the bot.");
    const context = new BotContext(client, guild, store, config, environment, !installation.public);
    const filter = new AttachmentFilter(context);
    const rooms = context.control.rooms.categoryId ? discordRoomService(context) : null;
    await rooms?.reconcile();
    if (context.control.modules.reactions && store.resource("control.role-panel"))
      await finishRolePanel(context, rolePanel(context));
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

  async function snapshot(runtime: GuildRuntime): Promise<ControlSnapshot> {
    const { context } = runtime,
      panel = rolePanel(context);
    return {
      configuration: context.control,
      resources: await controlResources(context.guild),
      installation: {
        ready: available(runtime),
        managedLayout: context.managedLayout,
        activeRooms: context.store.rooms().length,
        ...(panel
          ? {
              rolePanelUrl:
                "https://discord.com/channels/" +
                context.guild.id +
                "/" +
                panel.channelId +
                "/" +
                panel.id,
            }
          : {}),
      },
    };
  }
  async function controlRequest(path: string, body: unknown): Promise<unknown> {
    if (stopping)
      throw new ControlError(503, "stopping", "Bot jest ponownie uruchamiany. Spróbuj za chwilę.");
    const guildId = path.split("/")[2];
    const authorization = await authorizeControl(client, guildId, body);
    if (!guildId) {
      const candidates = (body as { guildIds?: unknown }).guildIds;
      if (
        !Array.isArray(candidates) ||
        candidates.length > 200 ||
        candidates.some((id) => typeof id !== "string" || !/^\d{17,20}$/.test(id))
      )
        throw new ControlError(400, "guilds", "Nieprawidłowa lista serwerów.");
      const guilds: string[] = [];
      for (const id of new Set(candidates as string[])) {
        const guild = client.guilds.cache.get(id);
        if (!guild) continue;
        try {
          const member = await guild.members.fetch({ user: authorization.actor, force: true });
          if (
            !member.pending &&
            !member.isCommunicationDisabled() &&
            (guild.ownerId === member.id || member.permissions.has(P.ManageGuild))
          )
            guilds.push(id);
        } catch {
          /* Guild access may have been revoked. */
        }
      }
      return { guilds };
    }
    if (changing.has(guildId))
      throw new ControlError(409, "busy", "Trwa zapisywanie ustawień tego serwera.");
    let runtime = lookup(guildId);
    let installation = installations.find((entry) => entry.guildId === guildId);
    if (!installation) {
      if (!publicInstallations || !authorization.guild)
        throw new ControlError(404, "not_configured", "Ten serwer nie ma jeszcze konfiguracji.");
      installation = publicInstallations.add(guildId, authorization.guild.ownerId);
      releases.push(await acquireLock(installation.databasePath));
      stores.set(guildId, new Store(installation.databasePath, guildId));
      configs.set(guildId, publicConfig());
      installations.push(installation);
      runtime = await createRuntime(installation);
      registry.register(installation);
      registry.replace(guildId, runtime);
    }
    if (!runtime)
      throw new ControlError(503, "not_ready", "Bot uruchamia ten serwer. Spróbuj za chwilę.");
    if (!path.endsWith("/save")) return snapshot(runtime);
    changing.add(guildId);
    let committed = false;
    try {
      await Promise.all([...inFlight]);
      await runtime.filter.drain();
      await runtime.rooms?.queue.drain();
      await runtime.roleSelection?.queue.drain();
      await authorizeControl(client, guildId, body);
      const value = await validateControl(runtime.context, authorization.configuration);
      const old = rolePanel(runtime.context),
        oldChoices = selectionChoices(runtime.context);
      const panel = await prepareRolePanel(runtime.context, value);
      if (old && (!value.modules.reactions || panel?.id !== old.id)) {
        for (const choice of oldChoices)
          for (const user of runtime.context.store.roleSelections(choice.key))
            await runtime.roleSelection?.handle({
              guild: guildId,
              channel: old.channelId,
              message: old.id,
              emoji: choice.emoji,
              user,
              active: false,
            });
      }
      const current = runtime.context.settings.read();
      await authorizeControl(client, guildId, body);
      const values = {
        ...current.values,
        maximum: value.rooms.maxRooms,
        emptySeconds: value.rooms.idleSeconds,
        extensions: value.files.formats.length
          ? value.files.formats.map((entry) => entry.toLowerCase())
          : current.values.extensions,
      };
      try {
        stores
          .get(guildId)!
          .saveControlConfiguration(
            guildId,
            value,
            values,
            value.revision,
            authorization.actor,
            panel && panel.id !== old?.id ? panel : undefined,
          );
      } catch (error) {
        if (error instanceof Error && error.message === "settings_conflict")
          throw new ControlError(
            409,
            "conflict",
            "Ustawienia zmieniły się podczas zapisu. Odśwież panel.",
          );
        throw error;
      }
      committed = true;
      runtime = await createRuntime(installation);
      registry.replace(guildId, runtime);

      if (old && (!value.modules.reactions || old.id !== panel?.id)) {
        try {
          const channel = await runtime.context.guild.channels.fetch(old.channelId);
          if (channel?.isTextBased()) {
            const message = await channel.messages.fetch(old.id);
            if (message.author.id === credentials.clientId)
              await message.edit({
                content:
                  "Ten panel wyboru ról został wyłączony. Aktualne ustawienia prowadzi administracja serwera.",
                allowedMentions: noMentions,
              });
          }
        } catch {
          runtime.context.store.event("role-panel", old.id, "retire_notice_failed");
        }
      }
      changing.delete(guildId);
      health();
      return snapshot(runtime);
    } catch (error) {
      if (committed) {
        registry.invalidate(guildId);
        const saved = await snapshot(runtime);
        saved.installation.ready = false;
        return saved;
      } else await runtime.roleSelection?.reconcile().catch(() => {});
      throw error;
    } finally {
      changing.delete(guildId);
      health();
    }
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
            if (!available(runtime) || changing.has(runtime.context.guild.id)) return;
            try {
              await runtime.rooms?.reconcile();
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
    controlServer?.close();
    health();
    client.removeAllListeners(Events.VoiceStateUpdate);
    client.removeAllListeners(Events.MessageCreate);
    client.removeAllListeners(Events.MessageUpdate);
    client.removeAllListeners(Events.InteractionCreate);
    client.removeAllListeners(Events.MessageReactionAdd);
    client.removeAllListeners(Events.MessageReactionRemove);
    shutdown = (async () => {
      try {
        await Promise.all([...inFlight, ...controlTasks]);
        await Promise.all(
          registry.values().map(async (runtime) => {
            await runtime.filter.drain();
            await runtime.rooms?.queue.drain();
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
      if (publicInstallations) {
        await client.application!.commands.set(commands());
      }
      if (process.env.CONTROL_KEY)
        controlServer = await startControlServer(
          process.env.CONTROL_KEY,
          Number(process.env.CONTROL_PORT || 35471),
          (path, body) => {
            const task = controlRequest(path, body);
            controlTasks.add(task);
            void task.finally(() => controlTasks.delete(task)).catch(() => {});
            return task;
          },
        );
      for (const installation of installations)
        if (installation.public && !client.guilds.cache.has(installation.guildId))
          registry.remove(installation.guildId);
      connected = true;
      console.log("Bot connected. Timezone: Europe/Warsaw.");
    })().catch(async (error) => {
      console.error(`Startup failed: ${errorCode(error)}`);
      await stop();
      process.exitCode = 1;
    });
  });
  // Losing access to one guild must not restart the other installations.
  client.on(Events.GuildCreate, (guild) => {
    const installation = installations.find((entry) => entry.guildId === guild.id);
    if (installation) registry.register(installation);
  });
  client.on(Events.GuildDelete, (guild) => {
    const runtime = registry.invalidate(guild.id);
    if (installations.find((entry) => entry.guildId === guild.id)?.public)
      registry.remove(guild.id);
    if (runtime)
      track(
        Promise.all([
          runtime.filter.drain(),
          runtime.rooms?.queue.drain(),
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
    if (!rooms) return;
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
        if (
          context.control.modules.rooms &&
          state.channelId === context.control.rooms.entryChannelId &&
          state.member
        ) {
          const member = state.member;
          try {
            await rooms.enter({ id: member.id, name: member.displayName, bot: member.user.bot });
          } catch (error) {
            await context.notify(
              member.id,
              null,
              error instanceof Error && context.texts[error.message] ? error.message : "roomFailed",
            );
            if (member.voice.channelId === context.control.rooms.entryChannelId)
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
        if (interaction.isChatInputCommand() && interaction.commandName === "konfiguracja") {
          const member = await context.member(interaction.user.id);
          if (member.id !== context.guild.ownerId && !member.permissions.has(P.ManageGuild))
            throw Error("Missing ManageGuild");
          const origin = process.env.WEB_ORIGIN;
          await interaction.reply({
            content: origin
              ? "Ustawienia serwera: " + new URL("/panel/" + context.guild.id, origin).href
              : "Panel WWW nie ma jeszcze publicznego adresu. Użyj /ustawienia.",
            flags: MessageFlags.Ephemeral,
            allowedMentions: noMentions,
          });
          return;
        }
        if (await settingsInteraction(context, interaction)) return;
        if (!interaction.isChatInputCommand()) return;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          if (stopping || interaction.guildId !== environment.guildId)
            throw new Error("Ta komenda działa na skonfigurowanym serwerze.");
          await context.member(interaction.user.id);
          if (interaction.commandName === "pokoj") {
            if (!rooms || (!context.control.modules.rooms && !context.store.rooms().length)) {
              await interaction.editReply("Pokoje są wyłączone na tym serwerze.");
              return;
            }
            await roomCommand(context, rooms, interaction);
          } else if (interaction.commandName === "zglos") {
            if (!context.control.modules.reports) {
              await interaction.editReply("Zgłoszenia są wyłączone na tym serwerze.");
              return;
            }
            await submitReport(context, interaction);
          } else throw new Error("Unknown command.");
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
