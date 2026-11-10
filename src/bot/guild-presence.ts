import { Routes, type REST } from "discord.js";
import type { MembershipProof } from "../storage/uninstall-retention.js";

/** A missing cache entry or a denied guild endpoint cannot establish an uninstall. */
export async function freshBotGuildPresence(
  rest: Pick<REST, "get">,
  guildId: string,
  options: { clock?: () => number; signal?: AbortSignal } = {},
): Promise<MembershipProof> {
  const now = options.clock ?? Date.now;
  const proof = (state: MembershipProof["state"]): MembershipProof => ({
    state,
    observedAt: now(),
    source: "discord-rest",
  });
  if (!/^\d{17,20}$/.test(guildId)) return proof("unknown");
  const signal = AbortSignal.any([
    AbortSignal.timeout(15000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let after = "0";
  try {
    for (let page = 0; page < 50; page++) {
      signal.throwIfAborted();
      const rows = await rest.get(Routes.userGuilds(), {
        query: new URLSearchParams({ limit: "200", after }),
        signal,
      });
      signal.throwIfAborted();
      if (
        !Array.isArray(rows) ||
        rows.length > 200 ||
        new Set(rows.map((row) => row?.id)).size !== rows.length ||
        rows.some(
          (row) =>
            !row ||
            typeof row !== "object" ||
            typeof row.id !== "string" ||
            !/^\d{17,20}$/.test(row.id) ||
            BigInt(row.id) <= BigInt(after),
        )
      )
        return proof("unknown");
      if (rows.some((row) => row.id === guildId)) return proof("present");
      if (rows.length < 200) return proof("absent");
      // The API sorts by snowflake when paginating with after. Reject a stalled page.
      after = rows.reduce((last, row) => (BigInt(row.id) > BigInt(last) ? row.id : last), after);
    }
  } catch {
    // Includes rate limits, denied requests, outages and interrupted responses.
  }
  return proof("unknown");
}
