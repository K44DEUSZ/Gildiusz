import type { Config } from "../config.js";
import type { Store, Room } from "../storage/store.js";
import { SerialQueue, safeName, errorCode } from "../shared/utils.js";

export interface RoomMember {
  id: string;
  name: string;
  bot: boolean;
}
export interface RoomPort {
  ready(): boolean;
  members(channelId: string): Promise<RoomMember[] | null>;
  eligible(id: string): Promise<boolean>;
  atEntrance(id: string): boolean;
  capacity(maximum: number): boolean;
  definitiveNoCreate?(error: unknown): boolean;
  create(name: string, operation: string): Promise<string>;
  move(member: string, channel: string): Promise<boolean>;
  remove(channel: string): Promise<void>;
  permissions(room: Room): Promise<void>;
  rename(channel: string, name: string): Promise<void>;
}

export class RoomService {
  readonly queue = new SerialQueue();
  constructor(
    private store: Store,
    private settings: Config["rooms"],
    private port: RoomPort,
    private now: () => number = Date.now,
  ) {}

  recordPresence(
    member: string,
    previous: string | null,
    next: string | null,
    at = this.now(),
  ): Promise<void> {
    return this.queue.run(async () => {
      if (previous === next) return;
      if (previous) {
        const room = this.store.room(previous);
        if (room) {
          delete room.arrivals[member];
          if (room.owner === member) room.ownerAbsentSince = at;
          this.store.putRoom(room);
        }
      }
      if (next) {
        const room = this.store.room(next);
        if (room) {
          room.arrivals[member] = at;
          room.emptySince = null;
          if (room.owner === member) room.ownerAbsentSince = null;
          this.store.putRoom(room);
        }
      }
    });
  }

  enter(member: RoomMember): Promise<string> {
    return this.queue.run(async () => {
      if (!this.port.ready() || member.bot || !(await this.port.eligible(member.id)))
        throw new Error("pending");
      const existing = this.store.rooms().find((room) => room.owner === member.id);
      if (existing) {
        if (!(await this.port.members(existing.id)))
          throw new Error("Existing room is missing. Wait for reconciliation.");
        await this.port.move(member.id, existing.id);
        return existing.id;
      }
      if (
        this.store
          .operations()
          .some((entry) => String((entry as { key: string }).key).startsWith("room-create:"))
      )
        throw new Error("Unfinished configuration or channel creation requires reconciliation.");
      if (
        !this.store.cooldown(
          `create:${member.id}`,
          this.settings.creationCooldownSeconds * 1000,
          this.now(),
        )
      )
        throw new Error("cooldown");
      if (!this.port.capacity(this.settings.maximum)) throw new Error("Room capacity reached.");
      if (!this.port.atEntrance(member.id)) throw new Error("Member left the entrance.");
      const operation = `room-create:${member.id}`;
      this.store.beginOperation(operation, { owner: member.id });
      let channel: string | undefined;
      try {
        channel = await this.port.create(`Pokój ${safeName(member.name, 70)}`, operation);
        const room: Room = {
          id: channel,
          owner: member.id,
          locked: false,
          allowed: [],
          arrivals: { [member.id]: this.now() },
          emptySince: this.now(),
          ownerAbsentSince: null,
        };
        this.store.transaction(() => {
          this.store.putRoom(room);
          this.store.endOperation(operation);
        });
        if (
          !this.port.atEntrance(member.id) ||
          !(await this.port.eligible(member.id)) ||
          !(await this.port.move(member.id, channel))
        ) {
          const present = await this.port.members(channel);
          if (present && present.length === 0) {
            await this.port.remove(channel);
            this.store.deleteRoom(channel);
          }
          throw new Error("Room move failed.");
        }
        room.emptySince = null;
        this.store.putRoom(room);
        return channel;
      } catch (error) {
        if (
          !channel &&
          (["50013", "50001", "10003", "403", "400"].includes(errorCode(error)) ||
            this.port.definitiveNoCreate?.(error))
        )
          this.store.endOperation(operation);
        if (channel) {
          const present = await this.port.members(channel);
          if (present && !present.length) {
            await this.port.remove(channel);
            this.store.deleteRoom(channel);
          }
        }
        throw error;
      }
    });
  }

  control(
    channel: string,
    actor: string,
    moderator: boolean,
    action: "name" | "close" | "open" | "invite",
    argument?: string,
  ): Promise<void> {
    return this.queue.run(async () => {
      if (!this.port.ready() || !(await this.port.eligible(actor))) throw new Error("timeout");
      const room = this.store.room(channel);
      if (!room || (room.owner !== actor && !moderator)) throw new Error("roomDenied");
      const present = await this.port.members(channel);
      if (!present || (!moderator && !present.some((member) => member.id === actor)))
        throw new Error("roomDenied");
      if (action === "name") {
        await this.port.rename(channel, safeName(argument ?? ""));
        return;
      }
      if (action === "invite") {
        if (!argument || !(await this.port.eligible(argument)))
          throw new Error("Nie można teraz udzielić dostępu tej osobie.");
        room.allowed = [...new Set([...room.allowed, argument])];
      }
      if (action === "close") {
        room.locked = true;
        const eligible: string[] = [];
        for (const member of present)
          if (!member.bot && (await this.port.eligible(member.id))) eligible.push(member.id);
        room.allowed = [...new Set([...room.allowed, ...eligible, room.owner])];
      }
      if (action === "open") {
        room.locked = false;
        room.allowed = [];
      }
      await this.port.permissions(room);
      this.store.putRoom(room);
    });
  }

  reconcile(): Promise<void> {
    return this.queue.run(async () => {
      if (!this.port.ready()) return;
      for (const room of this.store.rooms()) {
        const members = await this.port.members(room.id);
        if (members === null) {
          this.store.deleteRoom(room.id);
          continue;
        }
        const now = this.now();
        const humans = members.filter((member) => !member.bot);
        for (const member of humans) room.arrivals[member.id] ??= now;
        for (const id of Object.keys(room.arrivals))
          if (!humans.some((member) => member.id === id)) delete room.arrivals[id];
        if (!humans.length) {
          room.emptySince ??= now;
          if (now - room.emptySince >= this.settings.emptySeconds * 1000) {
            const checked = await this.port.members(room.id);
            if (this.port.ready() && checked && checked.length === 0) {
              await this.port.remove(room.id);
              this.store.deleteRoom(room.id);
              continue;
            }
          }
        } else room.emptySince = null;
        if (humans.some((member) => member.id === room.owner)) room.ownerAbsentSince = null;
        else {
          room.ownerAbsentSince ??= now;
          if (now - room.ownerAbsentSince >= this.settings.transferSeconds * 1000) {
            for (const member of humans.sort(
              (a, b) => room.arrivals[a.id] - room.arrivals[b.id] || a.id.localeCompare(b.id),
            )) {
              if (
                !(await this.port.eligible(member.id)) ||
                this.store
                  .rooms()
                  .some((other) => other.id !== room.id && other.owner === member.id)
              )
                continue;
              const checked = await this.port.members(room.id);
              if (checked?.some((present) => present.id === room.owner)) {
                room.ownerAbsentSince = null;
                break;
              }
              if (!checked?.some((present) => present.id === member.id)) continue;
              const old = room.owner;
              room.owner = member.id;
              room.ownerAbsentSince = null;
              room.allowed = [
                ...new Set(room.allowed.filter((id) => id !== old).concat(member.id)),
              ];
              await this.port.permissions(room);
              this.store.putRoom(room);
              this.store.event("room-owner", room.id, "transferred");
              break;
            }
          }
        }
        if (room.locked) {
          const allowed: string[] = [];
          for (const id of room.allowed) if (await this.port.eligible(id)) allowed.push(id);
          if (allowed.length !== room.allowed.length) {
            room.allowed = allowed;
            await this.port.permissions(room);
          }
        }
        this.store.putRoom(room);
      }
    });
  }
}
