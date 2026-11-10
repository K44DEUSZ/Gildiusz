export class RetentionSchedule {
  private readonly next = new Map<string, number>();
  private cursor = 0;

  take(guildIds: readonly string[], now: number, capacity = 5): string[] {
    if (!guildIds.length || capacity <= 0) return [];
    const selected: string[] = [],
      start = this.cursor % guildIds.length;
    for (
      let index = 0;
      index < guildIds.length && selected.length < Math.min(5, capacity);
      index++
    ) {
      const position = (start + index) % guildIds.length,
        guildId = guildIds[position];
      if ((this.next.get(guildId) ?? 0) > now) continue;
      this.next.set(guildId, now + 3600000);
      this.cursor = (position + 1) % guildIds.length;
      selected.push(guildId);
    }
    return selected;
  }

  retry(guildId: string, now: number): void {
    this.next.set(guildId, now + 60000);
  }

  forget(guildId: string): void {
    this.next.delete(guildId);
  }
}
