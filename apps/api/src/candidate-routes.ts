import { randomUUID } from "node:crypto";
import { EXAM_EVENT_TYPES, type ExamEventType } from "@exam-guard/shared";
import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import {
  hashAccessCode,
  newCode,
  newToken,
  safeEqual,
  sha256,
} from "./crypto.js";
import { severityFor } from "./review.js";

const PAIRING_TTL_MS = 10 * 60_000;
const MAX_BATCH = 200;

const id = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const code = z.string().trim().min(4).max(32);

const FORBIDDEN_METADATA_KEY =
  /password|token|secret|url|href|title|clipboard|keystroke|source_code/i;

const metadata = z
  .record(
    z.string().max(64),
    z.union([z.string().max(256), z.number(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 20, "too_many_keys")
  .refine(
    (value) => !Object.keys(value).some((k) => FORBIDDEN_METADATA_KEY.test(k)),
    "forbidden_metadata_key",
  );

const eventSchema = z.object({
  event_id: z.uuid(),
  contest_id: id,
  session_id: z.uuid(),
  type: z.enum(EXAM_EVENT_TYPES),
  occurred_at: z.iso.datetime(),
  source: z.enum(["extension", "windows-agent"]),
  metadata: metadata.optional(),
});

const ALLOWED_TYPES: Record<Scope, ReadonlySet<ExamEventType>> = {
  extension: new Set<ExamEventType>([
    "SESSION_STARTED",
    "SESSION_ENDED",
    "TAB_ACTIVATED",
    "TAB_CREATED",
    "BROWSER_FOCUS_LOST",
    "BROWSER_FOCUS_RETURNED",
    "FULLSCREEN_EXITED",
    "FULLSCREEN_ENTERED",
    "NETWORK_RECONNECTED",
  ]),
  "windows-agent": new Set<ExamEventType>([
    "FOREGROUND_APP_CHANGED",
    "AGENT_HEARTBEAT",
    "NETWORK_RECONNECTED",
  ]),
};

type Scope = "extension" | "windows-agent";

interface ClientAuth {
  token_hash: string;
  session_id: string;
  contest_id: string;
  scope: Scope;
}

const COLUMNS: Record<Scope, { status: string; seen: string }> = {
  extension: {
    status: "extension_status",
    seen: "extension_last_seen_at",
  },
  "windows-agent": { status: "agent_status", seen: "agent_last_seen_at" },
};

export function candidateRoutes({ db, config, now }: AppDeps): Router {
  const router = Router();

  async function issueToken(sessionId: string, scope: Scope) {
    const token = newToken();
    const expires = new Date(
      now().getTime() + config.sessionTokenTtlSeconds * 1000,
    );
    await db.query(
      "INSERT INTO session_tokens (token_hash, session_id, scope, expires_at) VALUES ($1, $2, $3, $4)",
      [sha256(token), sessionId, scope, expires],
    );
    return { token, expires_at: expires.toISOString() };
  }

  async function requireClient(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const { rows } = await db.query<ClientAuth>(
      `SELECT t.token_hash, t.session_id, t.scope, s.contest_id
       FROM session_tokens t JOIN sessions s ON s.id = t.session_id
       WHERE t.token_hash = $1 AND t.expires_at > $2`,
      [sha256(token), now()],
    );
    if (!rows[0]) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    res.locals.client = rows[0];
    next();
  }

  const clientLimit = rateLimit({
    windowMs: 60_000,
    limit: config.rateLimits.client,
    // Per token: a whole lab can share one public IP address.
    keyGenerator: (_req, res) => (res.locals.client as ClientAuth).token_hash,
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const client = [requireClient, clientLimit];

  async function closeSession(sessionId: string, at: Date) {
    await db.query(
      "UPDATE sessions SET ended_at = $2 WHERE id = $1 AND ended_at IS NULL",
      [sessionId, at],
    );
  }

  router.post(
    "/sessions",
    rateLimit({
      windowMs: 60_000,
      limit: config.rateLimits.sessionStart,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    async (req, res) => {
      const body = z
        .object({ contest_id: id, candidate_id: id, access_code: code })
        .safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const { contest_id, candidate_id, access_code } = body.data;
      const { rows } = await db.query<{
        access_code_hash: string;
        status: string;
      }>(
        `SELECT c.access_code_hash, co.status FROM candidates c
         JOIN contests co ON co.id = c.contest_id
         WHERE c.contest_id = $1 AND c.candidate_id = $2`,
        [contest_id, candidate_id],
      );
      const candidate = rows[0];
      if (
        !candidate ||
        !safeEqual(
          candidate.access_code_hash,
          hashAccessCode(contest_id, candidate_id, access_code),
        )
      ) {
        res.status(401).json({ error: "invalid_credentials" });
        return;
      }
      if (candidate.status !== "active") {
        res.status(403).json({ error: "contest_not_active" });
        return;
      }

      const at = now();
      // A candidate has one active session; a restart closes the previous one
      // and leaves a visible record of having done so.
      await db.query(
        `WITH closed AS (
           UPDATE sessions SET ended_at = $3
           WHERE contest_id = $1 AND candidate_id = $2 AND ended_at IS NULL
           RETURNING id
         )
         INSERT INTO events (event_id, session_id, contest_id, type, occurred_at, received_at, source, severity, metadata)
         SELECT gen_random_uuid(), id, $1, 'SESSION_ENDED', $3::timestamptz, $3::timestamptz, 'server', 'information',
                '{"reason":"superseded_by_new_session"}'::jsonb
         FROM closed`,
        [contest_id, candidate_id, at],
      );

      const sessionId = randomUUID();
      await db.query(
        `INSERT INTO sessions (id, contest_id, candidate_id, started_at, extension_last_seen_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [sessionId, contest_id, candidate_id, at],
      );
      const issued = await issueToken(sessionId, "extension");
      res.status(201).json({ session_id: sessionId, ...issued });
    },
  );

  router.post("/sessions/end", ...client, async (_req, res) => {
    const auth = res.locals.client as ClientAuth;
    if (auth.scope !== "extension") {
      res.status(403).json({ error: "wrong_scope" });
      return;
    }
    await closeSession(auth.session_id, now());
    res.json({ ended: true });
  });

  router.post("/sessions/pairing-code", ...client, async (_req, res) => {
    const auth = res.locals.client as ClientAuth;
    if (auth.scope !== "extension") {
      res.status(403).json({ error: "wrong_scope" });
      return;
    }
    const pairingCode = newCode(8);
    const expires = new Date(now().getTime() + PAIRING_TTL_MS);
    await db.query(
      "INSERT INTO pairing_codes (code_hash, session_id, expires_at) VALUES ($1, $2, $3)",
      [sha256(pairingCode), auth.session_id, expires],
    );
    res
      .status(201)
      .json({ pairing_code: pairingCode, expires_at: expires.toISOString() });
  });

  router.post(
    "/agent/pair",
    rateLimit({
      windowMs: 60_000,
      limit: config.rateLimits.sessionStart,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    async (req, res) => {
      const body = z.object({ pairing_code: code }).safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const at = now();
      // A single UPDATE makes the code single-use even under concurrent calls.
      const { rows } = await db.query<{
        session_id: string;
        contest_id: string;
      }>(
        `UPDATE pairing_codes p SET used_at = $2
         FROM sessions s
         WHERE p.code_hash = $1 AND p.used_at IS NULL AND p.expires_at > $2
           AND s.id = p.session_id AND s.ended_at IS NULL
         RETURNING p.session_id, s.contest_id`,
        [sha256(body.data.pairing_code.toUpperCase()), at],
      );
      const paired = rows[0];
      if (!paired) {
        res.status(401).json({ error: "invalid_pairing_code" });
        return;
      }
      await db.query(
        "UPDATE sessions SET agent_status = 'connected', agent_last_seen_at = $2 WHERE id = $1",
        [paired.session_id, at],
      );
      const issued = await issueToken(paired.session_id, "windows-agent");
      res.status(201).json({
        session_id: paired.session_id,
        contest_id: paired.contest_id,
        ...issued,
      });
    },
  );

  router.post("/heartbeat", ...client, async (_req, res) => {
    const auth = res.locals.client as ClientAuth;
    const column = COLUMNS[auth.scope];
    const at = now();
    const { rows } = await db.query(
      `UPDATE sessions SET ${column.seen} = $2, ${column.status} = 'connected'
       WHERE id = $1 AND ended_at IS NULL RETURNING id`,
      [auth.session_id, at],
    );
    res.json({
      session_active: rows.length > 0,
      server_time: at.toISOString(),
    });
  });

  router.post("/events/batch", ...client, async (req, res) => {
    const auth = res.locals.client as ClientAuth;
    const envelope = z
      .object({ events: z.array(z.unknown()).min(1).max(MAX_BATCH) })
      .safeParse(req.body);
    if (!envelope.success) {
      res.status(400).json({ error: "invalid_batch" });
      return;
    }

    // Invalid events are reported individually, so one bad event cannot block
    // the client's retry queue forever.
    const rejected: { event_id: string | null; reason: string }[] = [];
    const valid: z.infer<typeof eventSchema>[] = [];
    for (const raw of envelope.data.events) {
      const parsed = eventSchema.safeParse(raw);
      if (!parsed.success) {
        const rawId = (raw as { event_id?: unknown } | null)?.event_id;
        rejected.push({
          event_id: typeof rawId === "string" ? rawId.slice(0, 64) : null,
          reason: "invalid_event",
        });
      } else if (
        parsed.data.session_id !== auth.session_id ||
        parsed.data.contest_id !== auth.contest_id ||
        parsed.data.source !== auth.scope ||
        !ALLOWED_TYPES[auth.scope].has(parsed.data.type)
      ) {
        rejected.push({
          event_id: parsed.data.event_id,
          reason: "outside_token_scope",
        });
      } else {
        valid.push(parsed.data);
      }
    }

    let accepted = 0;
    if (valid.length > 0) {
      const at = now();
      const { rows } = await db.query<{ event_id: string }>(
        `INSERT INTO events (event_id, session_id, contest_id, type, occurred_at, received_at, source, severity, metadata)
         SELECT e.event_id, $1::uuid, $2, e.type, e.occurred_at, $3::timestamptz, e.source, e.severity, e.metadata::jsonb
         FROM unnest($4::uuid[], $5::text[], $6::timestamptz[], $7::text[], $8::text[], $9::text[])
           AS e(event_id, type, occurred_at, source, severity, metadata)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [
          auth.session_id,
          auth.contest_id,
          at,
          valid.map((e) => e.event_id),
          valid.map((e) => e.type),
          valid.map((e) => e.occurred_at),
          valid.map((e) => e.source),
          valid.map((e) => severityFor(e.type, e.metadata)),
          valid.map((e) => JSON.stringify(e.metadata ?? {})),
        ],
      );
      accepted = rows.length;

      const ended = valid.find((e) => e.type === "SESSION_ENDED");
      if (ended) {
        await closeSession(auth.session_id, new Date(ended.occurred_at));
      }
    }

    res.json({
      accepted,
      duplicates: valid.length - accepted,
      rejected,
    });
  });

  return router;
}
