import {
  EXAM_EVENT_TYPES,
  REVIEW_LEVEL_LABELS,
  type ClientStatus,
  type ContestListItem,
  type ContestSummary,
  type EventSeverity,
  type TimelineEvent,
} from "@exam-guard/shared";
import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { newToken, sha256, verifyPassword } from "./crypto.js";
import { csvRow } from "./csv.js";
import { reviewLevel, type FlaggedEvent } from "./review.js";

const MAX_EXPORT_ROWS = 200_000;
// Verified against when the username is unknown, so that response time does
// not reveal which usernames exist.
const DUMMY_PASSWORD_HASH = `${"0".repeat(32)}:${"0".repeat(128)}`;

interface AdminAuth {
  admin_id: string;
  role: "admin" | "viewer";
}

interface ContestRow {
  id: string;
  name: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
}

interface EventRow {
  event_id: string;
  session_id: string;
  candidate_id: string;
  display_name: string | null;
  type: string;
  occurred_at: Date;
  received_at: Date;
  source: string;
  severity: EventSeverity;
  metadata: TimelineEvent["metadata"];
}

const filterSchema = z.object({
  candidate_id: z.string().max(64).optional(),
  type: z.enum(EXAM_EVENT_TYPES).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  offset: z.coerce.number().int().min(0).default(0),
});

type Filters = z.infer<typeof filterSchema>;

function contestItem(row: ContestRow): ContestListItem {
  return {
    ...row,
    starts_at: row.starts_at.toISOString(),
    ends_at: row.ends_at.toISOString(),
  };
}

function eventQuery(contestId: string, filters: Filters) {
  const params: unknown[] = [contestId];
  const where = ["e.contest_id = $1"];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };
  if (filters.candidate_id) add("s.candidate_id = ?", filters.candidate_id);
  if (filters.type) add("e.type = ?", filters.type);
  if (filters.from) add("e.occurred_at >= ?", filters.from);
  if (filters.to) add("e.occurred_at <= ?", filters.to);
  const sql = `SELECT e.event_id, e.session_id, s.candidate_id, c.display_name, e.type,
      e.occurred_at, e.received_at, e.source, e.severity, e.metadata
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    JOIN candidates c ON c.contest_id = s.contest_id AND c.candidate_id = s.candidate_id
    WHERE ${where.join(" AND ")}
    ORDER BY e.occurred_at, e.event_id`;
  return { sql, params };
}

export function adminRoutes({ db, config, now }: AppDeps): Router {
  const router = Router();

  const audit = (adminId: string, action: string, target: string | null) =>
    db.query(
      "INSERT INTO admin_audit_log (admin_id, action, target, at) VALUES ($1, $2, $3, $4)",
      [adminId, action, target, now()],
    );

  async function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const { rows } = await db.query<AdminAuth>(
      `SELECT t.admin_id, u.role FROM admin_tokens t
       JOIN admin_users u ON u.id = t.admin_id
       WHERE t.token_hash = $1 AND t.expires_at > $2`,
      [sha256(token), now()],
    );
    if (!rows[0]) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    res.locals.admin = rows[0];
    next();
  }

  function requireAdminRole(_req: Request, res: Response, next: NextFunction) {
    if ((res.locals.admin as AdminAuth).role !== "admin") {
      res.status(403).json({ error: "insufficient_role" });
      return;
    }
    next();
  }

  async function findContest(id: string, res: Response) {
    const { rows } = await db.query<ContestRow>(
      "SELECT id, name, starts_at, ends_at, status FROM contests WHERE id = $1",
      [id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "contest_not_found" });
      return null;
    }
    return rows[0];
  }

  router.post(
    "/login",
    rateLimit({
      windowMs: 15 * 60_000,
      limit: config.rateLimits.adminLogin,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    async (req, res) => {
      const body = z
        .object({
          username: z.string().min(1).max(128),
          password: z.string().min(1).max(1024),
        })
        .safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const { rows } = await db.query<{
        id: string;
        password_hash: string;
        role: AdminAuth["role"];
      }>(
        "SELECT id, password_hash, role FROM admin_users WHERE username = $1",
        [body.data.username],
      );
      const user = rows[0];
      const valid = await verifyPassword(
        body.data.password,
        user?.password_hash ?? DUMMY_PASSWORD_HASH,
      );
      if (!user || !valid) {
        res.status(401).json({ error: "invalid_credentials" });
        return;
      }
      const token = newToken();
      const expires = new Date(
        now().getTime() + config.adminTokenTtlSeconds * 1000,
      );
      await db.query(
        "INSERT INTO admin_tokens (token_hash, admin_id, expires_at) VALUES ($1, $2, $3)",
        [sha256(token), user.id, expires],
      );
      await audit(user.id, "login", null);
      res.json({ token, expires_at: expires.toISOString(), role: user.role });
    },
  );

  router.use(requireAdmin);

  router.get("/contests", async (_req, res) => {
    const { rows } = await db.query<ContestRow>(
      "SELECT id, name, starts_at, ends_at, status FROM contests ORDER BY starts_at DESC",
    );
    res.json({ contests: rows.map(contestItem) });
  });

  router.get("/contests/:id/summary", async (req, res) => {
    const contest = await findContest(String(req.params.id), res);
    if (!contest) {
      return;
    }
    const [registered, sessions, flagged] = await Promise.all([
      db.query<{ count: string | number }>(
        "SELECT count(*) AS count FROM candidates WHERE contest_id = $1",
        [contest.id],
      ),
      db.query<{
        id: string;
        candidate_id: string;
        display_name: string | null;
        started_at: Date;
        ended_at: Date | null;
        extension_status: ClientStatus;
        agent_status: ClientStatus;
      }>(
        `SELECT s.id, s.candidate_id, c.display_name, s.started_at, s.ended_at, s.extension_status, s.agent_status
         FROM sessions s
         JOIN candidates c ON c.contest_id = s.contest_id AND c.candidate_id = s.candidate_id
         WHERE s.contest_id = $1
         ORDER BY s.started_at DESC`,
        [contest.id],
      ),
      db.query<FlaggedEvent & { session_id: string }>(
        `SELECT session_id, type, occurred_at FROM events
         WHERE contest_id = $1 AND severity = 'needs_review'`,
        [contest.id],
      ),
    ]);

    const bySession = new Map<string, FlaggedEvent[]>();
    for (const event of flagged.rows) {
      const list = bySession.get(event.session_id) ?? [];
      list.push(event);
      bySession.set(event.session_id, list);
    }

    const rows = sessions.rows.map((session) => {
      const events = bySession.get(session.id) ?? [];
      const active = session.ended_at === null;
      return {
        session_id: session.id,
        candidate_id: session.candidate_id,
        display_name: session.display_name,
        started_at: session.started_at.toISOString(),
        ended_at: session.ended_at?.toISOString() ?? null,
        extension_status: session.extension_status,
        agent_status: session.agent_status,
        review_level: reviewLevel(events, config.thresholds),
        flagged_events: events.length,
        monitoring_unavailable:
          active &&
          (session.extension_status === "disconnected" ||
            session.agent_status === "disconnected"),
      };
    });

    const summary: ContestSummary = {
      contest: contestItem(contest),
      registered_candidates: Number(registered.rows[0]?.count ?? 0),
      active_sessions: rows.filter((row) => row.ended_at === null).length,
      disconnected_agents: rows.filter(
        (row) => row.ended_at === null && row.agent_status === "disconnected",
      ).length,
      sessions_requiring_review: rows.filter(
        (row) => row.review_level !== "information",
      ).length,
      thresholds: config.thresholds,
      sessions: rows,
    };
    res.json(summary);
  });

  router.get("/contests/:id/events", async (req, res) => {
    const filters = filterSchema.safeParse(req.query);
    if (!filters.success) {
      res.status(400).json({ error: "invalid_filters" });
      return;
    }
    const contest = await findContest(String(req.params.id), res);
    if (!contest) {
      return;
    }
    const { sql, params } = eventQuery(contest.id, filters.data);
    const { rows } = await db.query<EventRow>(
      `${sql} LIMIT ${filters.data.limit} OFFSET ${filters.data.offset}`,
      params,
    );
    if (filters.data.candidate_id) {
      await audit(
        (res.locals.admin as AdminAuth).admin_id,
        "view_timeline",
        `${contest.id}/${filters.data.candidate_id}`,
      );
    }
    const events: TimelineEvent[] = rows.map((row) => ({
      ...row,
      occurred_at: row.occurred_at.toISOString(),
      received_at: row.received_at.toISOString(),
    }));
    res.json({ events });
  });

  router.get("/contests/:id/export.csv", requireAdminRole, async (req, res) => {
    const filters = filterSchema.safeParse(req.query);
    if (!filters.success) {
      res.status(400).json({ error: "invalid_filters" });
      return;
    }
    const contest = await findContest(String(req.params.id), res);
    if (!contest) {
      return;
    }
    const { sql, params } = eventQuery(contest.id, filters.data);
    const { rows } = await db.query<EventRow>(
      `${sql} LIMIT ${MAX_EXPORT_ROWS}`,
      params,
    );
    await audit(
      (res.locals.admin as AdminAuth).admin_id,
      "export_csv",
      contest.id,
    );

    const t = config.thresholds;
    const rule = `High priority within ${t.window_minutes} min: ${t.focus_losses} focus losses, ${t.fullscreen_exits} fullscreen exits, or ${t.external_apps} external apps. Signals for human review only.`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="exam-guard-${contest.id}.csv"`,
    );
    res.write(
      csvRow([
        "occurred_at_utc",
        "received_at_utc",
        "candidate_id",
        "display_name",
        "session_id",
        "event_id",
        "type",
        "source",
        "review_label",
        "metadata",
        "review_rule",
      ]),
    );
    for (const row of rows) {
      res.write(
        csvRow([
          row.occurred_at.toISOString(),
          row.received_at.toISOString(),
          row.candidate_id,
          row.display_name,
          row.session_id,
          row.event_id,
          row.type,
          row.source,
          row.severity === "monitoring_unavailable"
            ? "Monitoring unavailable"
            : REVIEW_LEVEL_LABELS[row.severity],
          JSON.stringify(row.metadata),
          rule,
        ]),
      );
    }
    res.end();
  });

  return router;
}
