import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  ApplicationFlagsBitField,
  PermissionFlagsBits as P,
  REST,
} from "discord.js";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, loadCredentials } from "../config.js";
import { Store } from "../storage/store.js";
import { acquireLock } from "../storage/lock.js";
import {
  acquireDataRootLease,
  assertRestoreStartupAllowed,
  assertSourcePreparationComplete,
  currentRecoverySchemaPolicy,
  schemaOf,
  verifySchema,
} from "../storage/recovery/index.js";
import { BotContext } from "./context.js";
import { AttachmentFilter } from "./attachments.js";
import { discordRoomService, roomCommand } from "./rooms.js";
import { submitReport } from "./reports.js";
import { errorCode, noMentions, SerialQueue } from "../shared/utils.js";
import { regularFile } from "../storage/recovery/files.js";
import { lintContent } from "../content.js";
import { isManagedPinNotice } from "../shared/pin-notices.js";
import { settingsInteraction } from "./settings-panel.js";
import { discordRoleSelection } from "./role-selection.js";

import { loadInstallations, healthPath, type GuildInstallation } from "../installations.js";
import { GuildRegistry } from "./guild-registry.js";
import { PublicInstallations } from "../control/installations.js";
import { publicConfig } from "../control/configuration.js";
import { startControlServer } from "../control/server.js";
import {
  ControlError,
  parseControlPath,
  parseVersionedRequest,
  versionedResponse,
  controlOperations,
  type ControlSnapshot,
} from "../control/contracts.js";
import { JobRunner } from "../core/jobs/runner.js";
import { JobStore } from "../core/jobs/store.js";
import { pruneDomainData } from "../storage/domain-retention.js";
import { ModuleRuntime } from "./module-runtime.js";
import { memberFacts, freshMember } from "./module-permissions.js";
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
import { announcementInteraction } from "./announcement-commands.js";
import { communityInteraction } from "./community-commands.js";
import { MeetingMembership } from "./meeting-membership.js";
import { TwitchRuntime } from "./twitch-runtime.js";
import { twitchConfiguration } from "./twitch-config.js";
import { createTwitchIngress, type TwitchIngress } from "../modules/twitch/server.js";
import { TwitchHistoryRetention } from "../modules/twitch/retention.js";
import { ModuleSettingsStore } from "../core/modules/settings.js";
import { AnnouncementAssetStore } from "../modules/announcement-assets/store.js";
import { freshBotGuildPresence } from "./guild-presence.js";
import { GuildActivity } from "./guild-activity.js";
import { RetentionSchedule } from "./retention-schedule.js";
import { RuntimeObservations } from "./runtime-observations.js";
import { serverRulesInteraction } from "./server-rules-interactions.js";
import { ServerRulesRetention } from "../modules/server-rules/retention.js";
import {
  drainRulesDeletionOutbox,
  pruneRulesDeletionJournal,
} from "../storage/rules-deletion-journal.js";
import {
  openRulesDeletionLifecycle,
  rulesDeletionInstallationKey,
  type RulesDeletionLifecycle,
} from "../storage/rules-deletion-lifecycle.js";
import {
  GuildUninstallRetention,
  readUninstallMarker,
  recordGuildMembership,
  type PurgeOutcome,
  type RetentionInstallation,
  unverifiedRulesDeletionGapFile,
} from "../storage/uninstall-retention.js";
interface GuildRuntime {
  context: BotContext;
  modules: ModuleRuntime;
  membership: MeetingMembership;
  filter: AttachmentFilter;
  rooms: ReturnType<typeof discordRoomService> | null;
  retentionAt: number;
  roleSelection: Awaited<ReturnType<typeof discordRoleSelection>>;
  rolesAt: number;
}

async function main(): Promise<void> {
  const path = healthPath(),
    dataRoot = dirname(path);
  assertRestoreStartupAllowed(dataRoot);
  assertSourcePreparationComplete(dataRoot);
  const credentials = loadCredentials();
  const memberEvents = process.env.GILDIUSZ_MEMBER_EVENTS === "1";
  const publicDirectory = resolve(process.env.CONTROL_DATA_DIR || join(dataRoot, "public-guilds"));
  const publicInstallations =
    process.env.PUBLIC_INSTALLS === "1" || existsSync(join(publicDirectory, "installations.json"))
      ? new PublicInstallations(publicDirectory)
      : undefined;
  const legacy =
    publicInstallations && !process.env.GUILDS_PATH && !process.env.DISCORD_GUILD_ID
      ? []
      : loadInstallations();
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
  const guildReleases = new Map<string, () => Promise<void>>();
  const guildLeasePaths = new Map<string, string>();
  const openingStores = new Map<string, Promise<void>>();
  const releases: (() => Promise<void>)[] = [];
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      ...(memberEvents ? [GatewayIntentBits.GuildMembers] : []),
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
      Partials.User,
      ...(memberEvents ? [Partials.GuildMember] : []),
    ],
    allowedMentions: noMentions,
    rest: { retries: 0, timeout: 15000 },
  });
  const publicationRest = new REST({
    retries: 0,
    timeout: 15000,
    rejectOnRateLimit: () => true,
  }).setToken(credentials.token);
  const registry = new GuildRegistry<GuildRuntime>(installations);
  let stopping = false,
    ticking = false,
    initializing = false,
    connected = false,
    ownsDataRoot = false;
  const inFlight = new Set<Promise<unknown>>();
  const guildActivity = new GuildActivity();
  const controlTasks = new Set<Promise<unknown>>();
  const changing = new Set<string>();
  const uninstalled = new Set<string>();
  const guildEpochs = new Map<string, number>();
  const purgingGuilds = new Set<string>();
  let uninstallRetention: GuildUninstallRetention | undefined;
  let uninstallSweepAt = 0;
  let uninstallSweeping = false;
  let uninstallCursor = 0;
  const retentionSchedule = new RetentionSchedule();
  const localRetentionBusy = new Set<string>();
  const closingRuntimes = new Map<string, GuildRuntime>();
  const retentionWarnings = new Map<string, string>();
  let deletionProofState: "uninitialized" | "ready" | "blocked" = "uninitialized";
  let deletionProofCode: string | null = "source_uninitialized";
  let deletionProofAt = 0;
  let deletionProofBusy = false;
  let controlServer: Server | undefined;
  let twitch: TwitchRuntime | undefined;
  let integrationDatabase: DatabaseSync | undefined;
  let twitchIngress: TwitchIngress | undefined;
  let twitchHistory: TwitchHistoryRetention | undefined;
  let twitchHistoryAt = 0;
  const twitchHistoryJobs = new WeakMap<Store, JobStore>();
  const deletionQueue = new SerialQueue();
  let deletionLifecycle: RulesDeletionLifecycle | undefined;
  const epoch = (guildId: string) => guildEpochs.get(guildId) ?? 0;
  const bumpEpoch = (guildId: string) => guildEpochs.set(guildId, epoch(guildId) + 1);
  function rulesSourceError(code: string): Error & { code: string } {
    return Object.assign(Error(code), { code });
  }
  function sourceExists(file: string): boolean {
    try {
      lstatSync(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  function rulesJournalMode(): "legacy" | "format1" | "format2" {
    const file = join(dataRoot, "rules-acceptance-deletions", "journal.json"),
      policy = sourceExists(join(dataRoot, "uninstall-retention", "source-policy.json"));
    if (!sourceExists(file)) {
      if (policy) throw rulesSourceError("source_unavailable");
      return "legacy";
    }
    if (regularFile(file) > 3 * 1024 * 1024) throw rulesSourceError("journal_quota");
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value.format === 2) return "format2";
    if (value.format === 1 && !policy) return "format1";
    throw rulesSourceError("journal_upgrade_required");
  }
  function canonicalRulesInstallations(): GuildInstallation[] {
    // Configuration and the durable registry are authoritative; neither Stores nor Gateway cache is inventory.
    const configured =
      publicInstallations && !process.env.GUILDS_PATH && !process.env.DISCORD_GUILD_ID
        ? []
        : loadInstallations();
    const known = new Map(configured.map((row) => [row.guildId, row]));
    const file = join(publicDirectory, "installations.json");
    if (sourceExists(file)) {
      if (regularFile(file) > 1024 * 1024) throw rulesSourceError("invalid_inventory");
      const rows: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(rows) || rows.length > 1000) throw rulesSourceError("invalid_inventory");
      const seen = new Set<string>();
      for (const row of rows) {
        if (
          !row ||
          typeof row.guildId !== "string" ||
          !/^\d{17,20}$/.test(row.guildId) ||
          typeof row.ownerId !== "string" ||
          !/^\d{17,20}$/.test(row.ownerId) ||
          seen.has(row.guildId)
        )
          throw rulesSourceError("invalid_inventory");
        seen.add(row.guildId);
        const previous = known.get(row.guildId);
        if (previous) {
          if (previous.ownerId !== row.ownerId) throw rulesSourceError("invalid_inventory");
        } else
          known.set(row.guildId, {
            guildId: row.guildId,
            ownerId: row.ownerId,
            configPath: "",
            databasePath: join(publicDirectory, row.guildId, "gildiusz.sqlite"),
            public: true,
          });
      }
    }
    return [...known.values()];
  }
  function rulesLifecycle(): RulesDeletionLifecycle {
    return (deletionLifecycle ??= openRulesDeletionLifecycle({
      dataRoot,
      readCanonicalInstallations: canonicalRulesInstallations,
      ownership: {
        assertHeld() {
          if (!ownsDataRoot || stopping) throw rulesSourceError("writer_active");
        },
        assertGuildLease(guildId, file) {
          if (!guildReleases.has(guildId) || guildLeasePaths.get(guildId) !== resolve(file))
            throw rulesSourceError("guild_lease_required");
        },
        assertQuiescent() {
          if (connected || initializing || controlTasks.size)
            throw rulesSourceError("quiescence_required");
        },
      },
    }));
  }
  function assertLegacyRulesDatabase(installation: Pick<GuildInstallation, "databasePath">): void {
    regularFile(installation.databasePath);
    const db = new DatabaseSync(installation.databasePath, { readOnly: true });
    try {
      if (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='resources'").get() &&
        db.prepare("SELECT 1 FROM resources WHERE key=?").get(rulesDeletionInstallationKey)
      )
        throw rulesSourceError("source_unavailable");
    } finally {
      db.close();
    }
  }
  async function beforeStoreOpen(
    installation: GuildInstallation,
    pristine: boolean,
  ): Promise<void> {
    const mode = rulesJournalMode();
    if (mode !== "format2") {
      if (pristine) throw rulesSourceError("journal_upgrade_required");
      assertLegacyRulesDatabase(installation);
      return;
    }
    await deletionQueue.run(async () => {
      const scope = await rulesLifecycle().classifyBeforeOpen(installation);
      if (
        scope.state === "retiring" ||
        (!pristine && !["active", "admitting"].includes(scope.state))
      )
        throw rulesSourceError("installation_not_admitted");
      if (
        uninstallRetention?.status(installation.guildId) &&
        !uninstallRetention.status(installation.guildId)!.reopenable
      )
        throw rulesSourceError("retirement_pending");
    });
  }
  async function deferPublicRulesReservation(installation: GuildInstallation): Promise<boolean> {
    if (!installation.public || rulesJournalMode() !== "format2") return false;
    const state = await deletionQueue.run(() => rulesLifecycle().classifyBeforeOpen(installation));
    if (!["untracked", "retired"].includes(state.state)) return false;
    // The durable row is a reservation, not proof of pristine data or current Discord authority.
    // A fresh owner/ManageGuild request can retry it; startup must never auto-admit its database.
    registry.remove(installation.guildId);
    configs.delete(installation.guildId);
    const index = installations.findIndex((entry) => entry.guildId === installation.guildId);
    if (index >= 0) installations.splice(index, 1);
    return true;
  }
  async function assertRulesInstallationReady(installation: GuildInstallation): Promise<void> {
    if (rulesJournalMode() !== "format2") {
      assertLegacyRulesDatabase(installation);
      return;
    }
    await deletionQueue.run(async () => {
      const scope = await rulesLifecycle().classifyBeforeOpen(installation);
      if (scope.state !== "active") throw rulesSourceError("installation_not_admitted");
      const store = stores.get(installation.guildId);
      if (!store) throw rulesSourceError("source_unavailable");
      await rulesLifecycle().admitPristine({
        guildId: installation.guildId,
        store,
        operationId: randomUUID(),
        checkFence: () => !stopping && !purgingGuilds.has(installation.guildId),
      });
    });
  }
  async function rulesPurgeBridge(
    installation: RetentionInstallation,
    confirm: boolean,
  ): Promise<void> {
    const mode = rulesJournalMode();
    if (mode === "format1") {
      if (sourceExists(installation.databasePath)) assertLegacyRulesDatabase(installation);
      return;
    }
    if (mode === "legacy") throw rulesSourceError("source_uninitialized");
    await deletionQueue.run(async () => {
      const port = rulesLifecycle(),
        scope = await port.classifyBeforeOpen(installation);
      if (!scope.epoch) throw rulesSourceError("installation_not_admitted");
      const request = {
        guildId: installation.guildId,
        expectedEpoch: scope.epoch,
        operationId: scope.operationId ?? randomUUID(),
      };
      if (confirm) await port.confirmRetired(request);
      else await port.prepareRetirement(request);
    });
  }
  async function repairRulesSources(sources: readonly [string, Store][]) {
    return deletionQueue.run(async () => {
      const port = rulesLifecycle();
      await port.recoverPending({
        checkFence: (guildId) => !stopping && !purgingGuilds.has(guildId),
      });
      const view = await port.snapshot();
      const active = view.active.map(({ guildId }) => {
        const store = sources.find(([id]) => id === guildId)?.[1];
        if (!store) throw rulesSourceError("source_unavailable");
        return { guildId, jobs: new JobStore(store.db) };
      });
      const drained = await port.drainActiveOutbox({ stores: active });
      const current = await port.snapshot();
      return { pending: drained.pending, complete: current.complete, blockers: current.blockers };
    });
  }
  async function finishCommittedUninstalls(): Promise<void> {
    if (!uninstallRetention) return;
    const pending = uninstallRetention.pendingInstallations();
    if (pending.length > 1000) throw rulesSourceError("journal_quota");
    for (const installation of pending) {
      if (stopping) return;
      if (uninstallRetention.status(installation.guildId)?.phase === "prepared") continue;
      const task = uninstallRetention.purge(installation, stores.get(installation.guildId), {
        // Committed housekeeping never asks for new Discord authority or performs a new API lookup.
        freshProof: async () => ({
          state: "unknown",
          observedAt: Date.now(),
          source: "discord-rest",
        }),
        checkFence: () => !stopping,
        withClosedGuild,
      });
      // The purge drains this guild's activity itself; tracking it there would wait on its own Promise.
      track(task);
      const result = await task;
      if (result.state === "purged") {
        const guildId = installation.guildId;
        stores.delete(guildId);
        configs.delete(guildId);
        const index = installations.findIndex((entry) => entry.guildId === guildId);
        if (index >= 0) installations.splice(index, 1);
        registry.remove(guildId);
        await guildReleases.get(guildId)?.();
        guildReleases.delete(guildId);
        guildLeasePaths.delete(guildId);
        purgingGuilds.delete(guildId);
        changing.delete(guildId);
      }
    }
  }
  async function openStore(installation: GuildInstallation, pristine = false): Promise<void> {
    if (stores.has(installation.guildId)) return;
    const pending = openingStores.get(installation.guildId);
    if (pending) return pending;
    const work = (async () => {
      await beforeStoreOpen(installation, pristine);
      const retained = guildReleases.get(installation.guildId);
      if (
        retained &&
        guildLeasePaths.get(installation.guildId) !== resolve(installation.databasePath)
      )
        throw rulesSourceError("guild_lease_required");
      const release =
        retained ?? (await acquireLock(installation.databasePath, { createTarget: pristine }));
      try {
        if (stopping) throw Object.assign(Error("Startup stopped."), { code: "stopping" });
        stores.set(
          installation.guildId,
          new Store(installation.databasePath, installation.guildId),
        );
        guildReleases.set(installation.guildId, release);
        guildLeasePaths.set(installation.guildId, resolve(installation.databasePath));
      } catch (error) {
        await release();
        guildReleases.delete(installation.guildId);
        guildLeasePaths.delete(installation.guildId);
        throw error;
      }
    })().finally(() => openingStores.delete(installation.guildId));
    openingStores.set(installation.guildId, work);
    await work;
  }
  async function presentInstallation(guildId: string): Promise<void> {
    if (stopping) return;
    const started = epoch(guildId);
    uninstalled.delete(guildId);
    // A closed Store belongs to the purge callback until it returns; a join only changes its fence.
    if (purgingGuilds.has(guildId)) return;
    if (uninstallRetention && !uninstallRetention.cancelPrepared(guildId)) {
      purgingGuilds.add(guildId);
      changing.add(guildId);
      return;
    }
    let installation = installations.find((entry) => entry.guildId === guildId);
    let fallback = false;
    if (!installation) {
      const configured = legacy.find((entry) => entry.guildId === guildId);
      if (configured) {
        installation = configured;
        fallback = true;
      }
    }
    if (!installation) return;
    await openStore(installation);
    await assertRulesInstallationReady(installation);
    if (stopping || epoch(guildId) !== started || uninstalled.has(guildId)) return;
    if (fallback) {
      const config = loadConfig(installation.configPath);
      installations.push(installation);
      configs.set(guildId, config);
    }
    const store = stores.get(guildId)!;
    recordGuildMembership(store, guildId, {
      state: "present",
      source: "gateway-join",
      observedAt: Date.now(),
    });
    purgingGuilds.delete(guildId);
    changing.delete(guildId);
    jobRunner.resumeGuild(guildId);
    registry.register(installation);
  }
  async function withClosedGuild(
    guildId: string,
    work: () => Promise<PurgeOutcome>,
  ): Promise<PurgeOutcome | undefined> {
    if (stopping || initializing || controlTasks.size) return;
    changing.add(guildId);
    purgingGuilds.add(guildId);
    const runtime = registry.get(guildId) ?? closingRuntimes.get(guildId);
    if (runtime) closingRuntimes.set(guildId, runtime);
    registry.remove(guildId);
    if (!(await jobRunner.suspendGuild(guildId))) return;
    if (!(await guildActivity.drain(guildId))) return;
    if (runtime) {
      const drained = await new Promise<boolean>((resolve) => {
        const deadline = setTimeout(() => resolve(false), 5000);
        void Promise.all([
          runtime.membership.stop(),
          runtime.filter.drain(),
          runtime.rooms?.queue.drain(),
          runtime.roleSelection?.queue.drain(),
        ]).then(
          () => {
            clearTimeout(deadline);
            resolve(true);
          },
          () => {
            clearTimeout(deadline);
            resolve(false);
          },
        );
      });
      if (!drained) return;
      closingRuntimes.delete(guildId);
    }
    stores.get(guildId)?.close();
    stores.delete(guildId);
    if (!guildReleases.has(guildId)) {
      const installation =
        installations.find((entry) => entry.guildId === guildId) ??
        uninstallRetention?.pendingInstallations().find((entry) => entry.guildId === guildId);
      if (!installation) throw Error("Missing retention installation.");
      guildReleases.set(
        guildId,
        await acquireLock(installation.databasePath, { createTarget: false }),
      );
      guildLeasePaths.set(guildId, resolve(installation.databasePath));
    }
    const outcome = await work();
    if (outcome.store === "reopen") {
      const installation = installations.find((entry) => entry.guildId === guildId);
      if (installation && !stores.has(guildId)) await openStore(installation);
      purgingGuilds.delete(guildId);
      changing.delete(guildId);
      jobRunner.resumeGuild(guildId);
      if (installation && !uninstalled.has(guildId) && client.guilds.cache.has(guildId))
        await presentInstallation(guildId);
    }
    return outcome;
  }
  async function sweepUninstalled(): Promise<void> {
    if (!uninstallRetention || stopping || !connected || !client.isReady()) return;
    const candidates = new Map(
      [
        ...installations.filter((entry) => uninstalled.has(entry.guildId)),
        ...uninstallRetention.pendingInstallations(),
      ].map((entry) => [entry.guildId, entry]),
    );
    const entries = [...candidates.values()];
    for (let offset = 0; offset < Math.min(5, entries.length); offset++) {
      const installation = entries[(uninstallCursor + offset) % entries.length];
      const guildId = installation.guildId,
        started = epoch(guildId);
      const freshProof = () => freshBotGuildPresence(publicationRest, guildId);
      const checkFence = () => !stopping && client.isReady() && epoch(guildId) === started;
      const store = stores.get(guildId);
      if (store && !uninstallRetention.status(guildId)) {
        const proof = await freshProof();
        if (!checkFence()) continue;
        recordGuildMembership(store, guildId, proof);
        if (proof.state === "present") {
          uninstalled.delete(guildId);
          changing.delete(guildId);
          purgingGuilds.delete(guildId);
          jobRunner.resumeGuild(guildId);
          const full = installations.find((entry) => entry.guildId === guildId);
          if (full) registry.register(full);
          continue;
        }
        if (!readUninstallMarker(store, guildId)) continue;
      }
      const result = await uninstallRetention.purge(installation, store, {
        freshProof,
        checkFence,
        withClosedGuild,
      });
      if (result.state === "rejoined") {
        uninstalled.delete(guildId);
        purgingGuilds.delete(guildId);
        changing.delete(guildId);
        jobRunner.resumeGuild(guildId);
        const full = installations.find((entry) => entry.guildId === guildId);
        if (full && stores.has(guildId)) {
          recordGuildMembership(stores.get(guildId)!, guildId, {
            state: "present",
            source: "gateway-join",
            observedAt: Date.now(),
          });
          registry.register(full);
        }
      }
      if (result.state === "purged") {
        stores.delete(guildId);
        configs.delete(guildId);
        retentionSchedule.forget(guildId);
        const index = installations.findIndex((entry) => entry.guildId === guildId);
        if (index >= 0) installations.splice(index, 1);
        await guildReleases.get(guildId)?.();
        guildReleases.delete(guildId);
        guildLeasePaths.delete(guildId);
        purgingGuilds.delete(guildId);
        changing.delete(guildId);
        jobRunner.resumeGuild(guildId);
        // A return after a committed wipe needs explicit pristine enrollment, never legacy auto-create.
      }
      if (result.state === "pending" || result.state === "deferred") {
        const warning = `${result.state}:${result.phase ?? "preflight"}`;
        if (retentionWarnings.get(guildId) !== warning)
          console.error(`Uninstall retention incomplete: ${guildId}; ${warning}`);
        retentionWarnings.set(guildId, warning);
      } else retentionWarnings.delete(guildId);
    }
    if (entries.length) uninstallCursor = (uninstallCursor + 5) % entries.length;
  }
  function track(task: Promise<unknown>, guildId?: string | null): Promise<unknown> {
    const tracked = task
      .catch((error) => console.error(`Event failed: ${errorCode(error)}`))
      .finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    if (guildId) guildActivity.track(guildId, tracked);
    return tracked;
  }
  const available = (runtime: GuildRuntime) =>
    runtime.context.guild.available && client.isReady() && client.ws.status === 0;
  let observations: RuntimeObservations | undefined;
  function health() {
    if (!ownsDataRoot) return;
    const guilds = registry.statuses(available);
    const ready =
      !stopping && connected && (guilds.length === 0 || guilds.some((guild) => guild.ready));
    writeFileSync(
      path,
      JSON.stringify({
        ready,
        degraded:
          guilds.some((guild) => !guild.ready) ||
          retentionWarnings.size > 0 ||
          deletionProofState === "blocked",
        retentionWarnings: [...retentionWarnings].map(([guildId, state]) => ({ guildId, state })),
        rulesDeletionProof: { state: deletionProofState, code: deletionProofCode },
        guilds,
        updated: Date.now(),
        observations: observations?.sample() ?? null,
      }) + "\n",
    );
  }
  function lookup(guildId: string | null | undefined) {
    const runtime = registry.get(guildId);
    return !stopping && !changing.has(guildId ?? "") && runtime && available(runtime)
      ? runtime
      : undefined;
  }
  const jobRunner = new JobRunner(
    () =>
      registry.values().map((runtime) => ({
        guildId: runtime.context.guild.id,
        store: runtime.modules.jobs,
        available: () => !stopping && !changing.has(runtime.context.guild.id) && available(runtime),
      })),
    async (job, execution) => {
      const runtime = lookup(job.guildId);
      if (!runtime)
        return {
          state: "retry",
          at: Date.now() + 5000,
          error: "guild_unavailable",
          rateLimited: true,
        };
      if (job.type.startsWith("twitch."))
        return twitch
          ? twitch.execute(job, execution)
          : {
              state: "retry",
              at: execution.now() + 60000,
              error: "integration_unavailable",
              rateLimited: true,
            };
      return runtime.modules.execute(job, execution);
    },
    { onError: (code, jobId) => console.error(`Job ${jobId}: ${code}`) },
  );
  async function createRuntime(installation: GuildInstallation): Promise<GuildRuntime> {
    const started = epoch(installation.guildId);
    await assertRulesInstallationReady(installation);
    const config = configs.get(installation.guildId)!;
    const store = stores.get(installation.guildId)!;
    const environment = { ...credentials, ...installation };
    const guild = await client.guilds.fetch(installation.guildId);
    if (!installation.public && guild.ownerId !== installation.ownerId)
      throw new Error("Expected owner differs from the guild owner.");
    await guild.channels.fetch();
    const me = await guild.members.fetchMe();
    if (me.permissions.has(P.Administrator)) throw new Error("Remove Administrator from the bot.");
    if (
      stopping ||
      epoch(installation.guildId) !== started ||
      uninstalled.has(installation.guildId)
    )
      throw rulesSourceError("operation_obsolete");
    const context = new BotContext(client, guild, store, config, environment, !installation.public);
    let assets: AnnouncementAssetStore | undefined;
    if (process.env.GILDIUSZ_BETA_MODULES === "1") {
      try {
        assets = new AnnouncementAssetStore(
          store.db,
          guild.id,
          join(dirname(path), "announcement-assets"),
        );
      } catch (error) {
        console.error(`Announcement images unavailable: ${guild.id}; ${errorCode(error)}`);
      }
    }
    const modules = new ModuleRuntime(
      context,
      publicationRest,
      undefined,
      twitch,
      assets,
      memberEvents,
    );
    const membership = new MeetingMembership(modules.community, publicationRest);
    modules.community.setMembershipCheck((userId) => membership.check(userId));
    const filter = new AttachmentFilter(context);
    const rooms = context.control.rooms.categoryId
      ? discordRoomService(context, publicationRest)
      : null;
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
      modules,
      membership,
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
    const route = parseControlPath(path);
    if (!route) throw new ControlError(404, "not_found", "Nie znaleziono operacji.");
    if (!route.legacy) {
      const request = parseVersionedRequest(body, {
        mutation: controlOperations[route.operation].mutation,
      });
      const payload =
        request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
          ? (request.payload as Record<string, unknown>)
          : {};
      if (route.operation === "guilds.list") {
        const authorization = await authorizeControl(client, undefined, request);
        const candidates = payload.guildIds;
        if (
          !Array.isArray(candidates) ||
          candidates.length > 200 ||
          candidates.some((id) => typeof id !== "string" || !/^\d{17,20}$/.test(id))
        )
          throw new ControlError(400, "guilds", "Nieprawidłowa lista serwerów.");
        const guilds: string[] = [];
        for (const id of new Set(candidates as string[])) {
          const runtime = lookup(id);
          const guild = client.guilds.cache.get(id);
          if (!guild) continue;
          try {
            const { facts } = await freshMember(guild, authorization.actor);
            if (
              !facts.pending &&
              !facts.timedOut &&
              !facts.isBot &&
              (runtime || facts.owner || facts.manageGuild)
            )
              guilds.push(id);
          } catch (error) {
            // Revoked membership omits this guild; an outage cannot look like lost access.
            if (!(error instanceof ControlError && error.status === 403)) throw error;
          }
        }
        return versionedResponse({ guilds });
      }
      if (route.operation === "settings.save" && payload.configuration !== undefined) {
        const saved = await controlRequest(`/guilds/${route.guildId}/save`, {
          actor: request.actor,
          accessToken: request.accessToken,
          configuration: payload.configuration,
        });
        return versionedResponse(saved);
      }
      const authorization = await authorizeControl(client, route.guildId, request, {
        manage: false,
      });
      let runtime = lookup(route.guildId);
      if (
        !runtime &&
        authorization.guild &&
        authorization.member &&
        (authorization.guild.ownerId === authorization.actor ||
          authorization.member.permissions.has(P.ManageGuild))
      ) {
        await controlRequest(`/guilds/${route.guildId}`, {
          actor: request.actor,
          accessToken: request.accessToken,
        });
        runtime = lookup(route.guildId);
      }
      if (!runtime || !authorization.guild || !authorization.member)
        throw new ControlError(503, "not_ready", "Bot uruchamia ten serwer. Spróbuj za chwilę.");
      const data = await runtime.modules.request(
        memberFacts(authorization.guild, authorization.member),
        route.operation,
        request.payload,
        route.objectId,
        request.requestId,
      );
      if (route.operation === "settings.read")
        return versionedResponse({ ...(await snapshot(runtime)), ...(data as object) });
      return versionedResponse(data);
    }
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
          const { member } = await freshMember(guild, authorization.actor);
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
      if (process.env.PUBLIC_INSTALLS !== "1" || !publicInstallations || !authorization.guild)
        throw new ControlError(404, "not_configured", "Ten serwer nie ma jeszcze konfiguracji.");
      if (rulesJournalMode() !== "format2")
        throw new ControlError(
          503,
          "source_not_ready",
          "Dodawanie serwerów jest teraz niedostępne.",
        );
      if (uninstallRetention?.status(guildId) && !uninstallRetention.cancelPrepared(guildId))
        throw new ControlError(409, "busy", "Trwa usuwanie poprzednich danych tego serwera.");
      changing.add(guildId);
      bumpEpoch(guildId);
      const started = epoch(guildId);
      try {
        installation = publicInstallations.add(guildId, authorization.guild.ownerId);
        await openStore(installation, true);
        await deletionQueue.run(async () => {
          const port = rulesLifecycle(),
            scope = await port.classifyBeforeOpen(installation!);
          await port.admitPristine({
            guildId,
            store: stores.get(guildId)!,
            operationId: scope.operationId ?? randomUUID(),
            checkFence: () =>
              !stopping && epoch(guildId) === started && !purgingGuilds.has(guildId),
          });
        });
        if (stopping || epoch(guildId) !== started) throw rulesSourceError("operation_obsolete");
        configs.set(guildId, publicConfig());
        if (!installations.some((entry) => entry.guildId === guildId))
          installations.push(installation);
        runtime = await createRuntime(installation);
        registry.register(installation);
        registry.replace(guildId, runtime);
      } finally {
        changing.delete(guildId);
      }
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

  async function maintainRulesDeletionJournal(sources: readonly [string, Store][]): Promise<void> {
    try {
      const metadata = uninstallRetention?.pruneTerminalMetadata(),
        metadataBlocked = (metadata?.blocked ?? 0) > 0;
      const mode = rulesJournalMode();
      if (mode === "legacy") {
        if (sources.some(([, store]) => store.resource(rulesDeletionInstallationKey)))
          throw rulesSourceError("source_unavailable");
        const blocked =
          metadataBlocked ||
          sourceExists(join(dataRoot, "uninstall-retention", unverifiedRulesDeletionGapFile));
        deletionProofState = blocked ? "blocked" : "uninitialized";
        deletionProofCode = blocked ? "unverified_retention_gap" : "source_uninitialized";
        return;
      }
      // UUID expiry must continue even if a source DB has gone away or the Gateway is down.
      if (mode === "format2") await deletionQueue.run(() => rulesLifecycle().pruneExpired());
      else await pruneRulesDeletionJournal({ dataRoot });
      if (openingStores.size || changing.size) {
        deletionProofState = "blocked";
        deletionProofCode = "inventory_changing";
        return;
      }
      // A changed inventory fails closed; it must never reset coverage or omit prior decisions.
      const result =
        mode === "format2"
          ? await repairRulesSources(sources)
          : await drainRulesDeletionOutbox({
              dataRoot,
              stores: sources.map(([guildId, store]) => ({
                guildId,
                jobs: new JobStore(store.db),
              })),
            });
      const complete =
        !metadataBlocked && !result.pending && (!("complete" in result) || result.complete);
      deletionProofState = complete ? "ready" : "blocked";
      deletionProofCode = complete
        ? null
        : metadataBlocked
          ? "terminal_metadata_blocked"
          : "source_incomplete";
      if (result.pending) deletionProofAt = Date.now() + 5000;
    } catch (error) {
      deletionProofState = "blocked";
      deletionProofCode = errorCode(error);
    } finally {
      deletionProofBusy = false;
    }
  }

  const timer = setInterval(() => {
    if (stopping) return;
    // A slow guild API request must not suppress health signals or other guilds' maintenance.
    health();
    if (ownsDataRoot && !deletionProofBusy && Date.now() >= deletionProofAt) {
      deletionProofBusy = true;
      deletionProofAt = Date.now() + 60000;
      const sources = [...stores];
      const maintenance = maintainRulesDeletionJournal(sources);
      // Purge fences new work and drains every captured source before closing its SQLite handle.
      for (const [guildId] of sources) guildActivity.track(guildId, maintenance);
      track(maintenance);
    }
    // Local retention continues during a Gateway outage; it performs no Discord effects.
    const retentionIds = [...stores.keys()].filter(
      (id) => !changing.has(id) && !localRetentionBusy.has(id),
    );
    for (const guildId of retentionSchedule.take(
      retentionIds,
      Date.now(),
      5 - localRetentionBusy.size,
    )) {
      const store = stores.get(guildId)!;
      localRetentionBusy.add(guildId);
      track(
        (async () => {
          try {
            const jobs = new JobStore(store.db);
            pruneDomainData(jobs, guildId);
            await registry.get(guildId)?.modules.rules.sweepMemberships();
            new ServerRulesRetention(jobs, { guildId }).prune();
            const assetDirectory = join(dataRoot, "announcement-assets", guildId);
            if (
              existsSync(assetDirectory) ||
              store.db.prepare("SELECT 1 FROM announcement_assets LIMIT 1").get()
            ) {
              const assets =
                registry.get(guildId)?.modules.announcementAssets ??
                new AnnouncementAssetStore(
                  store.db,
                  guildId,
                  join(dataRoot, "announcement-assets"),
                );
              await assets.prune();
            }
          } catch (error) {
            retentionSchedule.retry(guildId, Date.now());
            console.error(`Data retention failed: ${guildId}; ${errorCode(error)}`);
          } finally {
            localRetentionBusy.delete(guildId);
          }
        })(),
        guildId,
      );
    }
    if (ownsDataRoot && integrationDatabase && Date.now() >= twitchHistoryAt) {
      twitchHistoryAt = Date.now() + 60000;
      try {
        if (twitchHistory?.db !== integrationDatabase)
          twitchHistory = new TwitchHistoryRetention(integrationDatabase, {
            resolveJobStore: (guildId) => {
              if (changing.has(guildId) || purgingGuilds.has(guildId)) return undefined;
              const store = stores.get(guildId);
              if (!store) return undefined;
              let jobs = twitchHistoryJobs.get(store);
              if (!jobs) {
                jobs = new JobStore(store.db);
                twitchHistoryJobs.set(store, jobs);
              }
              return jobs;
            },
          });
        twitchHistory.prune(100);
      } catch (error) {
        console.error(`Twitch history retention failed: ${errorCode(error)}`);
      }
    }
    if (!connected || !client.isReady()) return;
    if (!uninstallSweeping && Date.now() >= uninstallSweepAt) {
      uninstallSweeping = true;
      uninstallSweepAt = Date.now() + 60000;
      track(
        sweepUninstalled().finally(() => {
          uninstallSweeping = false;
        }),
      );
    }
    if (twitch) track(twitch.pump());
    for (const runtime of registry.values()) {
      track(runtime.modules.rules.sweepMemberships(), runtime.context.guild.id);
      try {
        runtime.modules.sync();
      } catch (error) {
        console.error(`Module sync failed: ${errorCode(error)}`);
      }
    }
    track(jobRunner.tick());
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
          registry.values().map((runtime) =>
            track(
              (async () => {
                if (!available(runtime) || changing.has(runtime.context.guild.id)) return;
                try {
                  await runtime.rooms?.reconcile();
                  await runtime.membership.sweep();
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
              })(),
              runtime.context.guild.id,
            ),
          ),
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
    observations?.close();
    controlServer?.close();
    twitch?.close();
    health();
    client.removeAllListeners(Events.VoiceStateUpdate);
    client.removeAllListeners(Events.MessageCreate);
    client.removeAllListeners(Events.MessageUpdate);
    client.removeAllListeners(Events.InteractionCreate);
    client.removeAllListeners(Events.MessageReactionAdd);
    client.removeAllListeners(Events.MessageReactionRemove);
    client.removeAllListeners(Events.GuildMemberRemove);
    client.removeAllListeners(Events.GuildMemberAdd);
    client.removeAllListeners(Events.GuildMemberUpdate);
    client.removeAllListeners(Events.GuildCreate);
    client.removeAllListeners(Events.GuildDelete);
    client.removeAllListeners(Events.ClientReady);
    shutdown = (async () => {
      try {
        await Promise.all(registry.values().map((runtime) => runtime.membership.stop()));
        await twitchIngress?.close();
        await jobRunner.stop();
        await Promise.all([...inFlight, ...controlTasks]);
        await Promise.allSettled([...openingStores.values()]);
        await deletionQueue.drain();
        await Promise.all(
          registry.values().map(async (runtime) => {
            await runtime.filter.drain();
            await runtime.rooms?.queue.drain();
            await runtime.roleSelection?.queue.drain();
            await runtime.membership.drain();
          }),
        );
      } finally {
        controlServer?.close();
        await client.destroy();
        for (const store of stores.values()) store.close();
        for (const release of guildReleases.values()) await release();
        integrationDatabase?.close();
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
    if (stopping) return;
    const startup = (async () => {
      if (client.user!.id !== credentials.clientId)
        throw Error("Bot identity differs from DISCORD_CLIENT_ID.");
      const application = await client.application!.fetch();
      if (stopping) return;
      const flags = ApplicationFlagsBitField.Flags;
      if (
        !application.flags.has(flags.GatewayMessageContent) &&
        !application.flags.has(flags.GatewayMessageContentLimited)
      )
        throw Error("Enable Message Content Intent in Developer Portal before starting.");
      if (publicInstallations) {
        await client.application!.commands.set(commands());
      }
      if (stopping) return;
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
      if (stopping) {
        controlServer?.close();
        return;
      }
      const known = new Map([...legacy, ...installations].map((entry) => [entry.guildId, entry]));
      for (const installation of known.values()) {
        if (!client.guilds.cache.has(installation.guildId)) {
          uninstalled.add(installation.guildId);
          registry.remove(installation.guildId);
        } else {
          await presentInstallation(installation.guildId);
        }
      }
      if (stopping) return;
      connected = true;
      console.log("Bot connected. Timezone: Europe/Warsaw.");
    })();
    track(startup);
    void startup.catch((error) => {
      if (stopping) return;
      console.error(`Startup failed: ${errorCode(error)}`);
      void stop().catch(() => {
        process.exitCode = 1;
      });
      process.exitCode = 1;
    });
  });
  // Losing access to one guild must not restart the other installations.
  client.on(Events.GuildCreate, (guild) => {
    if (stopping) return;
    bumpEpoch(guild.id);
    track(presentInstallation(guild.id), guild.id);
  });
  client.on(Events.GuildDelete, (guild) => {
    if (stopping) return;
    bumpEpoch(guild.id);
    uninstalled.add(guild.id);
    const runtime = registry.invalidate(guild.id);
    runtime?.modules.rules.stop();
    if (runtime) closingRuntimes.set(guild.id, runtime);
    if (installations.find((entry) => entry.guildId === guild.id)?.public)
      registry.remove(guild.id);
    if (runtime)
      track(
        Promise.all([
          runtime.filter.drain(),
          runtime.membership.stop(),
          runtime.rooms?.queue.drain(),
          runtime.roleSelection?.queue.drain(),
        ]).finally(() => {
          if (closingRuntimes.get(guild.id) === runtime) closingRuntimes.delete(guild.id);
        }),
        guild.id,
      );
    health();
  });
  if (memberEvents) {
    // Fresh REST membership also makes a delayed or duplicate event safe after rejoining.
    for (const event of [Events.GuildMemberRemove, Events.GuildMemberAdd] as const)
      client.on(event, (member) => {
        const runtime = lookup(member.guild.id);
        if (runtime) {
          track(runtime.membership.check(member.id), member.guild.id);
          track(runtime.modules.rules.memberChanged(member.id), member.guild.id);
        }
      });
    client.on(Events.GuildMemberUpdate, (_previous, member) => {
      const runtime = lookup(member.guild.id);
      if (runtime)
        track(
          Promise.resolve().then(() => runtime.modules.community.memberUpdated(member.id)),
          member.guild.id,
        );
      if (runtime) track(runtime.modules.rules.memberChanged(member.id), member.guild.id);
    });
  }
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
        track(message.delete(), message.guildId);
        return;
      }
      track(
        filter
          .handle(message, "create")
          .catch((error) => context?.alert("attachments", message.id, errorCode(error))),
        message.guildId,
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
        message.guildId,
      );
  });
  for (const [event, active] of [
    [Events.MessageReactionAdd, true],
    [Events.MessageReactionRemove, false],
  ] as const)
    client.on(event, (...args) => {
      const [reaction, user] = args;
      const runtime = lookup(reaction.message.guildId);
      if (!runtime || user.id === credentials.clientId || user.bot) return;
      track(
        runtime.modules.rules
          .reaction(
            user.id,
            reaction.message.channelId,
            reaction.message.id,
            reaction.emoji.id ? null : reaction.emoji.name,
            active,
          )
          .catch((error) => runtime.context.store.event("server-rules", user.id, errorCode(error))),
        reaction.message.guildId,
      );
      if (runtime.roleSelection)
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
          reaction.message.guildId,
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
      state.guild.id,
    );
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (stopping) return;
    const runtime = lookup(interaction.guildId);
    if (!runtime) {
      if (interaction.isRepliable())
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
        if (await serverRulesInteraction(runtime.modules.rules, interaction)) return;
        if (await announcementInteraction(runtime.modules, interaction)) return;
        if (await communityInteraction(runtime.modules, interaction)) return;
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
      interaction.guildId,
    );
  });
  client.on(Events.Error, (error) => console.error(`Discord error: ${errorCode(error)}`));
  try {
    releases.push(await acquireDataRootLease(dataRoot));
    ownsDataRoot = true;
    try {
      observations = new RuntimeObservations(() => jobRunner.observeQueues());
    } catch {
      // Optional measurements must not change readiness or lifecycle maintenance.
    }
    assertRestoreStartupAllowed(dataRoot);
    assertSourcePreparationComplete(dataRoot);
    health();
    uninstallRetention = new GuildUninstallRetention({
      dataRoot,
      databaseRoots: [
        ...new Set([
          dataRoot,
          resolve(process.env.CONTROL_DATA_DIR || join(dataRoot, "public-guilds")),
          ...installations.map((entry) => dirname(entry.databasePath)),
        ]),
      ],
      assetsRoot: join(dataRoot, "announcement-assets"),
      registry: publicInstallations,
      hub: () =>
        integrationDatabase ??
        (existsSync(
          resolve(process.env.INTEGRATIONS_DATABASE_PATH || join(dataRoot, "integrations.sqlite")),
        )
          ? undefined
          : null),
      rulesDeletion: {
        prepareRetirement: (installation) => rulesPurgeBridge(installation, false),
        confirmRetired: (installation) => rulesPurgeBridge(installation, true),
      },
    });
    let rulesStartupError: unknown;
    try {
      uninstallRetention.pruneTerminalMetadata();
      const mode = rulesJournalMode();
      if (mode === "format2") await deletionQueue.run(() => rulesLifecycle().pruneExpired());
      else if (mode === "format1") await pruneRulesDeletionJournal({ dataRoot });
    } catch (error) {
      rulesStartupError = error;
      deletionProofState = "blocked";
      deletionProofCode = errorCode(error);
    }
    for (const installation of [...installations]) {
      if (rulesStartupError) {
        registry.remove(installation.guildId);
        continue;
      }
      try {
        const pending = uninstallRetention.status(installation.guildId);
        if (pending && !pending.reopenable) {
          purgingGuilds.add(installation.guildId);
          changing.add(installation.guildId);
          registry.remove(installation.guildId);
          continue;
        }
        if (await deferPublicRulesReservation(installation)) continue;
        if (
          !existsSync(installation.databasePath) &&
          uninstallRetention.deletionLedger(installation.guildId)
        ) {
          registry.remove(installation.guildId);
          const index = installations.findIndex((entry) => entry === installation);
          if (index >= 0) installations.splice(index, 1);
          configs.delete(installation.guildId);
          const replacement = publicInstallations
            ?.values()
            .find((entry) => entry.guildId === installation.guildId);
          if (replacement && replacement.databasePath !== installation.databasePath) {
            installations.push(replacement);
            configs.set(replacement.guildId, publicConfig());
            await openStore(replacement);
            registry.register(replacement);
          }
          continue;
        }
        await openStore(installation);
      } catch (error) {
        rulesStartupError = error;
        deletionProofState = "blocked";
        deletionProofCode = errorCode(error);
        registry.remove(installation.guildId);
      }
    }
    if (!rulesStartupError && process.env.GILDIUSZ_BETA_MODULES === "1") {
      let integrationRelease: (() => Promise<void>) | undefined;
      try {
        const integration = twitchConfiguration(path);
        integrationRelease = await acquireLock(integration.databasePath);
        integrationDatabase = new DatabaseSync(integration.databasePath);
        integrationDatabase.exec(
          "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
        );
        twitch = new TwitchRuntime({
          db: integrationDatabase,
          configuration: integration.configuration,
          publicationRest,
          resolveGuild: (guildId) => {
            const runtime = lookup(guildId);
            return runtime
              ? {
                  context: runtime.context,
                  jobs: runtime.modules.jobs,
                  settings: runtime.modules.settings,
                }
              : undefined;
          },
          configuredGuildEnabled: (guildId) => {
            if (stopping) return undefined;
            if (uninstalled.has(guildId)) return false;
            if (!connected || !client.isReady()) return undefined;
            if (!client.guilds.cache.has(guildId)) return false;
            const store = stores.get(guildId);
            return store
              ? new ModuleSettingsStore(store.db, guildId).read().enabled.integrations
              : undefined;
          },
        });
        if (integration.configuration) {
          if (!twitch.configured) throw Error("Invalid private Twitch configuration.");
          twitchIngress = createTwitchIngress({
            receiver: twitch,
            proxySecret: integration.proxyKey!,
            forbiddenSecrets: [
              credentials.token,
              process.env.CONTROL_KEY ?? "",
              integration.configuration.webhookSecret,
              integration.configuration.clientSecret,
            ],
            port: integration.port,
          });
          await twitchIngress.listen();
        }
        releases.push(integrationRelease);
      } catch (error) {
        await twitchIngress?.close().catch(() => {});
        twitch?.close();
        integrationDatabase?.close();
        await integrationRelease?.();
        twitchIngress = undefined;
        twitch = undefined;
        integrationDatabase = undefined;
        console.error(`Twitch unavailable: ${errorCode(error)}`);
      }
    }
    // Turning a module off must not prevent deletion of its existing local data.
    const retentionHubPath = resolve(
      process.env.INTEGRATIONS_DATABASE_PATH || join(dataRoot, "integrations.sqlite"),
    );
    if (!integrationDatabase && existsSync(retentionHubPath)) {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireLock(retentionHubPath, { createTarget: false });
        integrationDatabase = new DatabaseSync(retentionHubPath);
        integrationDatabase.exec(
          "PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000",
        );
        verifySchema(schemaOf(integrationDatabase, "hub"), currentRecoverySchemaPolicy().hub);
        releases.push(release);
      } catch (error) {
        integrationDatabase?.close();
        integrationDatabase = undefined;
        await release?.();
        console.error(`Integration data retention unavailable: ${errorCode(error)}`);
      }
    }
    // A missing proof source may block activation, but never rolls back a committed privacy wipe.
    await finishCommittedUninstalls();
    if (rulesStartupError) throw rulesStartupError;
    if (rulesJournalMode() === "format2") {
      const proof = await repairRulesSources([...stores]);
      deletionProofState = proof.complete && !proof.pending ? "ready" : "blocked";
      deletionProofCode = proof.complete && !proof.pending ? null : "source_incomplete";
      for (const installation of installations) {
        if (stores.has(installation.guildId)) await assertRulesInstallationReady(installation);
      }
    }
    if (!stopping) await client.login(credentials.token);
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch((error) => {
  console.error(`Bot stopped: ${errorCode(error)}`);
  process.exitCode = 1;
});
