import { JobStore } from "../core/jobs/store.js";

const day = 86400000;
export const domainRetentionPolicy = Object.freeze({
  privateClosedCasesMs: 90 * day,
  finishedMeetingsMs: 90 * day,
  terminalJobHistoryMs: 30 * day,
});

export interface DomainRetentionResult {
  casesRemoved: number;
  meetingsRemoved: number;
  jobsRetired: number;
  deferredCases: number;
  deferredMeetings: number;
}

/** Removes local content only. Discord channels/messages and minimal delivery fences remain. */
export function pruneDomainData(
  jobs: JobStore,
  guildId: string,
  options: { now?: number; limit?: number } = {},
): DomainRetentionResult {
  const now = options.now ?? Date.now(),
    limit = options.limit ?? 100,
    db = jobs.db;
  if (
    !/^[0-9]{17,20}$/.test(guildId) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error("Invalid domain retention input.");
  if (db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !== guildId)
    throw new Error("Domain retention guild mismatch.");
  db.exec("PRAGMA secure_delete=ON");
  return jobs.transaction(() => {
    jobs.recover();
    const result: DomainRetentionResult = {
      casesRemoved: 0,
      meetingsRemoved: 0,
      jobsRetired: 0,
      deferredCases: 0,
      deferredMeetings: 0,
    };
    db.prepare("DELETE FROM case_actions WHERE guild_id=? AND created_at<=?").run(
      guildId,
      now - 60000,
    );
    db.prepare("DELETE FROM announcement_actions WHERE created_at<=?").run(now - 60000);
    const sending = (objectId: string) =>
      !!db
        .prepare(
          `SELECT 1 FROM jobs j WHERE j.guild_id=? AND j.object_id=? AND
          (j.state='running' OR EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.job_id=j.id AND a.state='sending')) LIMIT 1`,
        )
        .get(guildId, objectId);
    const retireObject = (kind: "case" | "meeting", objectId: string) => {
      db.prepare("INSERT OR IGNORE INTO domain_retired VALUES (?,?,?,?)").run(
        guildId,
        kind,
        objectId,
        now,
      );
      db.prepare(
        `UPDATE jobs SET state='cancelled',cancel_requested=1,revision=revision+1,updated_at=?
        WHERE guild_id=? AND object_id=? AND state IN ('pending','retry')`,
      ).run(now, guildId, objectId);
      // Unknown work keeps its uncertainty and target proof, never an obsolete content snapshot.
      db.prepare(
        `UPDATE jobs SET payload=CASE
          WHEN type='meeting.publish' THEN json_object('meetingId',object_id)
          WHEN type='case.notify' THEN json_object('caseId',object_id)
          ELSE '{}' END,result=NULL,last_error=CASE WHEN state='unknown' THEN 'retention_unresolved' ELSE NULL END
        WHERE guild_id=? AND object_id=?`,
      ).run(guildId, objectId);
      db.prepare(
        `UPDATE delivery_attempts SET result=NULL,nonce=NULL,
          error=CASE WHEN state='unknown' THEN 'retention_unresolved' ELSE NULL END
        WHERE job_id IN (SELECT id FROM jobs WHERE guild_id=? AND object_id=?)`,
      ).run(guildId, objectId);
    };
    for (const row of db
      .prepare(
        `SELECT id FROM cases WHERE guild_id=? AND visibility='private' AND status='closed'
        AND closed_at IS NOT NULL AND closed_at<=? ORDER BY closed_at,id LIMIT ?`,
      )
      .all(guildId, now - domainRetentionPolicy.privateClosedCasesMs, limit)) {
      const objectId = String(row.id);
      if (sending(objectId)) {
        result.deferredCases++;
        continue;
      }
      retireObject("case", objectId);
      db.prepare(
        `UPDATE idempotency_keys SET result=json_object('retiredCaseId',?)
        WHERE scope LIKE ? AND json_extract(result,'$.case.id')=? AND json_extract(result,'$.case.guildId')=?`,
      ).run(objectId, `case:${guildId}:%`, objectId, guildId);
      for (const table of ["case_messages", "case_votes", "case_events"])
        db.prepare(`DELETE FROM ${table} WHERE guild_id=? AND case_id=?`).run(guildId, objectId);
      db.prepare("DELETE FROM cases WHERE guild_id=? AND id=?").run(guildId, objectId);
      result.casesRemoved++;
    }
    // Domain transitions write this audit atomically. Later card receipts may change updated_at.
    // Historical/system rows without that audit use their last recorded terminal update.
    for (const row of db
      .prepare(
        `SELECT id FROM meetings m WHERE guild_id=? AND state IN ('completed','cancelled')
        AND COALESCE((SELECT MIN(created_at) FROM meeting_audit a WHERE a.meeting_id=m.id
          AND a.action IN ('complete','cancel')),m.updated_at)<=?
        ORDER BY m.updated_at,m.id LIMIT ?`,
      )
      .all(guildId, now - domainRetentionPolicy.finishedMeetingsMs, limit)) {
      const objectId = String(row.id);
      if (sending(objectId)) {
        result.deferredMeetings++;
        continue;
      }
      retireObject("meeting", objectId);
      db.prepare(
        `UPDATE idempotency_keys SET result=json_quote(?) WHERE scope LIKE 'meeting:%'
        AND json_extract(result,'$.meeting.id')=? AND json_extract(result,'$.meeting.guildId')=?`,
      ).run(objectId, objectId, guildId);
      for (const table of [
        "meeting_participants",
        "meeting_invites",
        "meeting_audit",
        "meeting_effect_receipts",
      ])
        db.prepare(`DELETE FROM ${table} WHERE meeting_id=?`).run(objectId);
      db.prepare("DELETE FROM meetings WHERE guild_id=? AND id=?").run(guildId, objectId);
      result.meetingsRemoved++;
    }
    for (const row of db
      .prepare(
        `SELECT j.id FROM jobs j WHERE j.guild_id=? AND j.state IN ('succeeded','failed','cancelled','expired')
        AND j.updated_at<=? AND NOT EXISTS(SELECT 1 FROM job_history_retired h WHERE h.job_id=j.id)
        AND NOT EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.job_id=j.id AND a.state IN ('sending','unknown'))
        AND NOT EXISTS(SELECT 1 FROM schedules s WHERE s.active_job_id=j.id)
        AND NOT(j.type='announcement.send' AND EXISTS(SELECT 1 FROM announcements n WHERE n.id=j.object_id)
          AND NOT EXISTS(SELECT 1 FROM announcement_job_receipts r WHERE r.job_id=j.id))
        ORDER BY j.updated_at,j.id LIMIT ?`,
      )
      .all(guildId, now - domainRetentionPolicy.terminalJobHistoryMs, limit)) {
      const jobId = String(row.id);
      db.prepare("INSERT INTO job_history_retired VALUES (?,?)").run(jobId, now);
      db.prepare(
        `UPDATE jobs SET payload=CASE
          WHEN type='meeting.publish' AND object_id IS NOT NULL THEN json_object('meetingId',object_id)
          WHEN type='announcement.send' AND object_id IS NOT NULL THEN json_object('announcementId',object_id,'test',json_extract(payload,'$.test'))
          ELSE '{}' END,result=NULL,last_error=NULL WHERE id=?`,
      ).run(jobId);
      db.prepare(
        "UPDATE delivery_attempts SET nonce=NULL,error=NULL,result=NULL WHERE job_id=?",
      ).run(jobId);
      result.jobsRetired++;
    }
    return result;
  });
}
