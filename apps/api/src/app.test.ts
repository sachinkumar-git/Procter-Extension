import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import type {
  ContestSummary,
  StartSessionResponse,
  TimelineEvent,
} from "@exam-guard/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { hashAccessCode, hashPassword } from "./crypto.js";
import { migrate, type Db } from "./db.js";
import { sweepDisconnected } from "./sweep.js";

const CONTEST = "contest-1";
let pglite: PGlite;
let db: Db;
let server: Server;
let base: string;
let clock: Date;

const config = loadConfig({
  DATABASE_URL: "unused",
  CORS_ALLOWED_ORIGINS: "https://admin.example",
  RATE_LIMIT_ADMIN_LOGIN_PER_15_MINUTES: "1000",
  SESSION_TOKEN_TTL_SECONDS: "3600",
});

async function call(
  path: string,
  options: { token?: string; body?: unknown; raw?: string } = {},
) {
  const hasBody = options.body !== undefined || options.raw !== undefined;
  const response = await fetch(`${base}${path}`, {
    method: hasBody ? "POST" : "GET",
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.raw ?? (hasBody ? JSON.stringify(options.body) : undefined),
  });
  const text = await response.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    // CSV responses are read from `text`.
  }
  return { status: response.status, json, text, headers: response.headers };
}

const start = async (candidate = "alice", code = "ALICECODE") => {
  const res = await call("/v1/sessions", {
    body: { contest_id: CONTEST, candidate_id: candidate, access_code: code },
  });
  return res.json as StartSessionResponse;
};

function event(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    contest_id: CONTEST,
    session_id: sessionId,
    type: "BROWSER_FOCUS_LOST",
    occurred_at: "2026-11-09T10:00:00.000Z",
    source: "extension",
    metadata: { focus_target: "outside_chrome" },
    ...overrides,
  };
}

const send = (token: string, events: unknown[]) =>
  call("/v1/events/batch", { token, body: { events } });

const login = async (username = "root") =>
  (
    await call("/v1/admin/login", {
      body: { username, password: "correct horse battery" },
    })
  ).json.token as string;

async function pairAgent(token: string) {
  const code = await call("/v1/sessions/pairing-code", { token, body: {} });
  return call("/v1/agent/pair", {
    body: { pairing_code: code.json.pairing_code },
  });
}

beforeAll(async () => {
  pglite = new PGlite();
  db = {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const result = await pglite.query<T>(sql, params);
      return { rows: result.rows };
    },
    exec: async (sql) => {
      await pglite.exec(sql);
    },
    close: () => pglite.close(),
  };
  await migrate(db);
  const hash = await hashPassword("correct horse battery");
  await db.query(
    "INSERT INTO admin_users (username, password_hash, role) VALUES ('root', $1, 'admin'), ('watch', $1, 'viewer')",
    [hash],
  );
  server = createApp({
    db,
    config,
    logger: { info: () => undefined, error: () => undefined },
    now: () => clock,
  }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await db.close();
});

beforeEach(async () => {
  clock = new Date("2026-11-09T10:00:00.000Z");
  await db.exec("TRUNCATE contests CASCADE");
  await db.query(
    "INSERT INTO contests (id, name, starts_at, ends_at, status) VALUES ($1, 'Mock', now(), now(), 'active')",
    [CONTEST],
  );
  for (const [id, code] of [
    ["alice", "ALICECODE"],
    ["bob", "BOBCODE1"],
  ] as const) {
    await db.query(
      "INSERT INTO candidates (contest_id, candidate_id, display_name, access_code_hash) VALUES ($1, $2, $3, $4)",
      [CONTEST, id, id.toUpperCase(), hashAccessCode(CONTEST, id, code)],
    );
  }
});

describe("health", () => {
  it("reports liveness and database readiness", async () => {
    expect((await call("/healthz")).status).toBe(200);
    expect((await call("/readyz")).status).toBe(200);
  });
});

describe("sessions", () => {
  it("issues a token for valid credentials", async () => {
    const session = await start();
    expect(session.session_id).toBeTruthy();
    expect(session.token.length).toBeGreaterThan(30);
  });

  it("rejects wrong codes and unknown candidates identically", async () => {
    const bad = await call("/v1/sessions", {
      body: {
        contest_id: CONTEST,
        candidate_id: "alice",
        access_code: "WRONG",
      },
    });
    const unknown = await call("/v1/sessions", {
      body: {
        contest_id: CONTEST,
        candidate_id: "nobody",
        access_code: "WRONG",
      },
    });
    expect(bad.status).toBe(401);
    expect(unknown.json).toEqual(bad.json);
  });

  it("rejects malformed input and a contest that is not active", async () => {
    expect(
      (await call("/v1/sessions", { body: { contest_id: "a b" } })).status,
    ).toBe(400);
    await db.query("UPDATE contests SET status = 'closed'");
    const res = await call("/v1/sessions", {
      body: {
        contest_id: CONTEST,
        candidate_id: "alice",
        access_code: "ALICECODE",
      },
    });
    expect(res.status).toBe(403);
  });

  it("closes the previous session and records why", async () => {
    const first = await start();
    await start();
    const { rows } = await db.query<{ metadata: unknown }>(
      "SELECT metadata FROM events WHERE session_id = $1 AND type = 'SESSION_ENDED'",
      [first.session_id],
    );
    expect(rows[0]?.metadata).toEqual({ reason: "superseded_by_new_session" });
  });

  it("ends a session through the endpoint or a SESSION_ENDED event", async () => {
    const a = await start();
    await call("/v1/sessions/end", { token: a.token, body: {} });
    const beat = await call("/v1/heartbeat", { token: a.token, body: {} });
    expect(beat.json.session_active).toBe(false);

    const b = await start("bob", "BOBCODE1");
    await send(b.token, [event(b.session_id, { type: "SESSION_ENDED" })]);
    const after = await call("/v1/heartbeat", { token: b.token, body: {} });
    expect(after.json.session_active).toBe(false);
  });
});

describe("event ingestion", () => {
  it("stores a repeated event_id once", async () => {
    const { token, session_id } = await start();
    const repeated = event(session_id);

    const first = await send(token, [repeated, event(session_id)]);
    const retry = await send(token, [repeated]);

    expect(first.json).toMatchObject({ accepted: 2, duplicates: 0 });
    expect(retry.json).toMatchObject({ accepted: 0, duplicates: 1 });
    const { rows } = await db.query(
      "SELECT 1 FROM events WHERE event_id = $1",
      [repeated.event_id],
    );
    expect(rows).toHaveLength(1);
  });

  it("records severity and a server receipt time, ignoring client claims", async () => {
    const { token, session_id } = await start();
    clock = new Date("2026-11-09T10:05:00.000Z");
    const sent = event(session_id, { severity: "information" });
    await send(token, [sent]);

    const { rows } = await db.query<{ severity: string; received_at: Date }>(
      "SELECT severity, received_at FROM events WHERE event_id = $1",
      [sent.event_id],
    );
    expect(rows[0]?.severity).toBe("needs_review");
    expect(rows[0]?.received_at.toISOString()).toBe(clock.toISOString());
  });

  it("rejects invalid tokens and expired tokens", async () => {
    const { token, session_id } = await start();
    expect((await send("nonsense", [event(session_id)])).status).toBe(401);
    clock = new Date(clock.getTime() + 3601_000);
    expect((await send(token, [event(session_id)])).status).toBe(401);
  });

  it("will not let a candidate write to another session or forge a source", async () => {
    const alice = await start();
    const bob = await start("bob", "BOBCODE1");

    const res = await send(alice.token, [
      event(bob.session_id),
      event(alice.session_id, { source: "windows-agent" }),
      event(alice.session_id, { source: "server" }),
      event(alice.session_id, { type: "AGENT_DISCONNECTED" }),
    ]);

    expect(res.json.accepted).toBe(0);
    expect(res.json.rejected).toHaveLength(4);
  });

  it("rejects bad events individually and accepts the rest", async () => {
    const { token, session_id } = await start();
    const res = await send(token, [
      event(session_id, { occurred_at: "yesterday" }),
      event(session_id, { metadata: { page_url: "https://x" } }),
      { junk: true },
      event(session_id),
    ]);
    expect(res.json.accepted).toBe(1);
    expect(res.json.rejected).toHaveLength(3);
  });

  it("enforces batch and body size limits", async () => {
    const { token, session_id } = await start();
    const big = Array.from({ length: 201 }, () => event(session_id));
    expect((await send(token, big)).status).toBe(400);
    const huge = "x".repeat(300 * 1024);
    expect(
      (await call("/v1/events/batch", { token, raw: `{"a":"${huge}"}` }))
        .status,
    ).toBe(413);
    expect(
      (await call("/v1/events/batch", { token, raw: "{bad" })).status,
    ).toBe(400);
  });
});

describe("agent pairing", () => {
  it("pairs once and scopes the agent to agent events", async () => {
    const { token, session_id } = await start();
    const code = await call("/v1/sessions/pairing-code", { token, body: {} });
    const body = { pairing_code: code.json.pairing_code };

    const paired = await call("/v1/agent/pair", { body });
    expect(paired.status).toBe(201);
    expect(paired.json.session_id).toBe(session_id);
    expect((await call("/v1/agent/pair", { body })).status).toBe(401);

    const res = await send(paired.json.token, [
      event(session_id, {
        source: "windows-agent",
        type: "FOREGROUND_APP_CHANGED",
        metadata: { process_name: "notepad", is_approved_browser: false },
      }),
      event(session_id, { source: "windows-agent", type: "TAB_CREATED" }),
    ]);
    expect(res.json.accepted).toBe(1);
    expect(res.json.rejected).toHaveLength(1);
  });

  it("rejects an expired pairing code", async () => {
    const { token } = await start();
    const code = await call("/v1/sessions/pairing-code", { token, body: {} });
    clock = new Date(clock.getTime() + 11 * 60_000);
    const res = await call("/v1/agent/pair", {
      body: { pairing_code: code.json.pairing_code },
    });
    expect(res.status).toBe(401);
  });
});

describe("heartbeat timeout", () => {
  it("records one disconnect after the grace period and recovers", async () => {
    const { token, session_id } = await start();
    const paired = await pairAgent(token);
    clock = new Date(clock.getTime() + 60_000);
    await call("/v1/heartbeat", { token, body: {} });

    clock = new Date(clock.getTime() + 60_000);
    await sweepDisconnected(db, clock, 90);
    let types = await db.query<{ type: string }>(
      "SELECT type FROM events WHERE session_id = $1",
      [session_id],
    );
    expect(types.rows.map((r) => r.type)).toEqual(["AGENT_DISCONNECTED"]);

    await sweepDisconnected(db, clock, 90);
    types = await db.query("SELECT type FROM events WHERE session_id = $1", [
      session_id,
    ]);
    expect(types.rows).toHaveLength(1);

    await call("/v1/heartbeat", { token: paired.json.token, body: {} });
    const admin = await login();
    const summary = (
      await call(`/v1/admin/contests/${CONTEST}/summary`, { token: admin })
    ).json as ContestSummary;
    expect(summary.disconnected_agents).toBe(0);
    expect(summary.sessions[0]?.monitoring_unavailable).toBe(false);
  });

  it("does not report an agent that never paired", async () => {
    await start();
    clock = new Date(clock.getTime() + 600_000);
    await sweepDisconnected(db, clock, 90);
    const { rows } = await db.query<{ type: string }>(
      "SELECT type FROM events",
    );
    expect(rows.map((r) => r.type)).toEqual(["EXTENSION_DISCONNECTED"]);
  });
});

describe("admin", () => {
  it("requires authentication, and refuses candidate tokens", async () => {
    const path = `/v1/admin/contests/${CONTEST}/events`;
    expect((await call(path)).status).toBe(401);
    const { token } = await start();
    expect((await call(path, { token })).status).toBe(401);
  });

  it("rejects bad passwords and unknown users", async () => {
    for (const username of ["root", "ghost"]) {
      const res = await call("/v1/admin/login", {
        body: { username, password: "wrong password" },
      });
      expect(res.status).toBe(401);
    }
  });

  it("summarises sessions with transparent review levels", async () => {
    const alice = await start();
    await start("bob", "BOBCODE1");
    await send(alice.token, [
      event(alice.session_id),
      event(alice.session_id),
      event(alice.session_id),
    ]);

    const summary = (
      await call(`/v1/admin/contests/${CONTEST}/summary`, {
        token: await login(),
      })
    ).json as ContestSummary;

    expect(summary).toMatchObject({
      registered_candidates: 2,
      active_sessions: 2,
      sessions_requiring_review: 1,
    });
    expect(summary.thresholds.focus_losses).toBe(3);
    const row = summary.sessions.find((s) => s.candidate_id === "alice");
    expect(row?.review_level).toBe("high_review_priority");
  });

  it("returns ordered timelines and applies filters", async () => {
    const alice = await start();
    const bob = await start("bob", "BOBCODE1");
    await send(alice.token, [
      event(alice.session_id, { occurred_at: "2026-11-09T10:02:00.000Z" }),
      event(alice.session_id, {
        occurred_at: "2026-11-09T10:01:00.000Z",
        type: "TAB_CREATED",
      }),
    ]);
    await send(bob.token, [event(bob.session_id)]);
    const token = await login();
    const url = `/v1/admin/contests/${CONTEST}/events`;

    const timeline = (await call(`${url}?candidate_id=alice`, { token })).json
      .events as TimelineEvent[];
    expect(timeline.map((e) => e.type)).toEqual([
      "TAB_CREATED",
      "BROWSER_FOCUS_LOST",
    ]);

    const byType = await call(`${url}?type=TAB_CREATED`, { token });
    expect(byType.json.events).toHaveLength(1);
    const byTime = await call(`${url}?from=2026-11-09T10:01:30.000Z`, {
      token,
    });
    expect(byTime.json.events).toHaveLength(1);
    expect((await call(`${url}?type=NOPE`, { token })).status).toBe(400);
  });

  it("exports CSV for admins only, and audits it", async () => {
    const alice = await start();
    await send(alice.token, [event(alice.session_id)]);
    const path = `/v1/admin/contests/${CONTEST}/export.csv`;

    expect((await call(path, { token: await login("watch") })).status).toBe(
      403,
    );
    const res = await call(path, { token: await login() });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.text).toContain("Needs review");
    expect(res.text).toContain("High priority within 10 min");
    expect(res.text.trim().split("\r\n")).toHaveLength(2);
    const { rows } = await db.query(
      "SELECT 1 FROM admin_audit_log WHERE action = 'export_csv'",
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("returns 404 for a missing contest", async () => {
    const res = await call("/v1/admin/contests/none/summary", {
      token: await login(),
    });
    expect(res.status).toBe(404);
  });
});
