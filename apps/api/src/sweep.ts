import type { Db } from "./db.js";

const CLIENTS = [
  {
    status: "extension_status",
    seen: "extension_last_seen_at",
    type: "EXTENSION_DISCONNECTED",
  },
  {
    status: "agent_status",
    seen: "agent_last_seen_at",
    type: "AGENT_DISCONNECTED",
  },
] as const;

/**
 * Marks clients whose heartbeat is overdue and records a server event, because
 * a stopped client cannot report itself. Safe to run repeatedly: only rows
 * still marked connected are affected.
 */
export async function sweepDisconnected(
  db: Db,
  now: Date,
  graceSeconds: number,
): Promise<void> {
  const cutoff = new Date(now.getTime() - graceSeconds * 1000);
  for (const client of CLIENTS) {
    await db.query(
      `WITH stale AS (
         UPDATE sessions SET ${client.status} = 'disconnected'
         WHERE ended_at IS NULL AND ${client.status} = 'connected' AND ${client.seen} < $1
         RETURNING id, contest_id
       )
       INSERT INTO events (event_id, session_id, contest_id, type, occurred_at, received_at, source, severity, metadata)
       SELECT gen_random_uuid(), id, contest_id, $2, $3::timestamptz, $3::timestamptz, 'server', 'monitoring_unavailable',
              jsonb_build_object('grace_seconds', $4::int)
       FROM stale`,
      [cutoff, client.type, now, graceSeconds],
    );
  }
}
