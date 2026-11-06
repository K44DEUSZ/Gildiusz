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
import { dirname, join } from "node:path";
import { loadConfig, loadEnvironment } from "../config.js";
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

async function main(): Promise<void> {
  const config = loadConfig(),
    environment = loadEnvironment();
  const errors = lintContent(config);
  if (errors.length) throw new Error(errors.join("\n"));
  const release = await acquireLock(environment.databasePath);
  const store = new Store(environment.databasePath);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
    allowedMentions: noMentions,
    rest: { retries: 0, timeout: 15000 },
  });
  let context: BotContext | undefined;
  let filter: AttachmentFilter | undefined;
  let rooms: ReturnType<typeof discordRoomService> | undefined;
  let stopping = false,
    ticking = false,
    retentionAt = 0;
  const inFlight = new Set<Promise<unknown>>();
  function track(task: Promise<unknown>): void {
    const tracked = task
      .catch((error) => {
        console.error(`Event failed: ${errorCode(error)}`);
      })
      .finally(() => {
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
  }
  const healthPath = join(dirname(environment.databasePath), "health.json");
  mkdirSync(dirname(healthPath), { recursive: true });
  function health(ready: boolean) {
    writeFileSync(healthPath, JSON.stringify({ ready, updated: Date.now() }) + "\n");
  }
  health(false);
  const timer = setInterval(() => {
    if (ticking || stopping || !context || !rooms) return;
    ticking = true;
    track(
      (async () => {
        health(client.isReady() && context!.guild.available && client.ws.status === 0);
        await rooms!.reconcile();
        if (Date.now() > retentionAt) {
          await context!.retention();
          retentionAt = Date.now() + 3600000;
        }
      })()
        .catch((error) => context!.alert("maintenance", "runtime", errorCode(error)))
        .finally(() => {
          ticking = false;
        }),
    );
  }, 5000);
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    health(false);
    client.removeAllListeners(Events.VoiceStateUpdate);
    client.removeAllListeners(Events.MessageCreate);
    client.removeAllListeners(Events.MessageUpdate);
    client.removeAllListeners(Events.InteractionCreate);
    try {
      await Promise.all([...inFlight]);
      await filter?.drain();
      await rooms?.queue.drain();
    } finally {
      await client.destroy();
      store.close();
      await release();
    }
  }
  process.once("SIGINT", () => {
    void stop().catch((error) => {
      console.error(`Shutdown failed: ${errorCode(error)}`);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void stop().catch((error) => {
      console.error(`Shutdown failed: ${errorCode(error)}`);
      process.exitCode = 1;
    });
  });
  client.once(Events.ClientReady, () => {
    void (async () => {
      if (client.user!.id !== environment.clientId)
        throw new Error("Bot identity differs from DISCORD_CLIENT_ID.");
      const application = await client.application!.fetch();
      const flags = ApplicationFlagsBitField.Flags;
      if (
        !application.flags.has(flags.GatewayMessageContent) &&
        !application.flags.has(flags.GatewayMessageContentLimited)
      )
        throw new Error("Enable Message Content Intent in Developer Portal before starting.");
      const guild = await client.guilds.fetch(environment.guildId);
      if (guild.ownerId !== environment.ownerId)
        throw new Error("Expected owner differs from the guild owner.");
      await guild.channels.fetch();
      const me = await guild.members.fetchMe();
      if (me.permissions.has(P.Administrator))
        throw new Error("Remove Administrator from the bot.");
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
        !guild.channels.cache
          .get(store.id("category.rooms"))
          ?.permissionsFor(me)
          ?.has(P.ManageRoles)
      )
        throw new Error("Room overwrite management is unavailable.");
      context = new BotContext(client, guild, store, config, environment);
      filter = new AttachmentFilter(context);
      rooms = discordRoomService(context);
      await rooms.reconcile();
      await context.retention();
      health(true);
      console.log("Bot started. Timezone: Europe/Warsaw.");
    })().catch(async (error) => {
      console.error(
        `Startup failed: ${error instanceof Error ? error.message.replace(environment.token, "[redacted]") : errorCode(error)}`,
      );
      await stop();
      process.exitCode = 1;
    });
  });
  client.on(Events.MessageCreate, (message) => {
    if (!stopping && filter && message.guildId === environment.guildId) {
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
    if (!stopping && filter)
      track(
        filter
          .handle(message)
          .catch((error) => context?.alert("attachments", message.id, errorCode(error))),
      );
  });
  client.on(Events.VoiceStateUpdate, (previous, state) => {
    if (stopping) return;
    track(
      (async () => {
        if (!context || !rooms || state.guild.id !== environment.guildId) return;
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
    track(
      (async () => {
        if (!context || !rooms) return;
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
  client.on(Events.Error, (error) => {
    console.error(`Discord error: ${errorCode(error)}`);
  });
  try {
    await client.login(environment.token);
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch((error) => {
  console.error(`Bot stopped: ${errorCode(error)}`);
  process.exitCode = 1;
});
