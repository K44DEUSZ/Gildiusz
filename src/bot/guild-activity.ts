export class GuildActivity {
  private readonly work = new Map<string, Set<Promise<unknown>>>();

  track(guildId: string, task: Promise<unknown>): void {
    let tasks = this.work.get(guildId);
    if (!tasks) this.work.set(guildId, (tasks = new Set()));
    const current = tasks;
    current.add(task);
    const finished = () => {
      current.delete(task);
      if (!current.size) this.work.delete(guildId);
    };
    void task.then(finished, finished);
  }

  /** Call after fencing new work; the full promises include stages started after an await. */
  async drain(guildId: string, timeoutMs = 5000): Promise<boolean> {
    const tasks = [...(this.work.get(guildId) ?? [])];
    if (!tasks.length) return true;
    return new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => resolve(false), timeoutMs);
      void Promise.allSettled(tasks).then(() => {
        clearTimeout(deadline);
        resolve(true);
      });
    });
  }
}
