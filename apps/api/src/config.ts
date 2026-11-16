import type { ReviewThresholds } from "@exam-guard/shared";
import { z } from "zod";

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  API_PORT: positiveInt(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_TOKEN_TTL_SECONDS: positiveInt(14400),
  ADMIN_TOKEN_TTL_SECONDS: positiveInt(28800),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  HEARTBEAT_GRACE_SECONDS: positiveInt(90),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_CLIENT_PER_MINUTE: positiveInt(240),
  RATE_LIMIT_SESSION_START_PER_MINUTE: positiveInt(3000),
  RATE_LIMIT_ADMIN_LOGIN_PER_15_MINUTES: positiveInt(30),
  REVIEW_WINDOW_MINUTES: positiveInt(10),
  REVIEW_HIGH_FOCUS_LOSSES: positiveInt(3),
  REVIEW_HIGH_FULLSCREEN_EXITS: positiveInt(2),
  REVIEW_HIGH_EXTERNAL_APPS: positiveInt(2),
});

export interface Config {
  port: number;
  databaseUrl: string;
  sessionTokenTtlSeconds: number;
  adminTokenTtlSeconds: number;
  corsOrigins: string[];
  heartbeatGraceSeconds: number;
  trustProxyHops: number;
  rateLimits: { client: number; sessionStart: number; adminLogin: number };
  thresholds: ReviewThresholds;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  return {
    port: parsed.API_PORT,
    databaseUrl: parsed.DATABASE_URL,
    sessionTokenTtlSeconds: parsed.SESSION_TOKEN_TTL_SECONDS,
    adminTokenTtlSeconds: parsed.ADMIN_TOKEN_TTL_SECONDS,
    corsOrigins: parsed.CORS_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    heartbeatGraceSeconds: parsed.HEARTBEAT_GRACE_SECONDS,
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    rateLimits: {
      client: parsed.RATE_LIMIT_CLIENT_PER_MINUTE,
      sessionStart: parsed.RATE_LIMIT_SESSION_START_PER_MINUTE,
      adminLogin: parsed.RATE_LIMIT_ADMIN_LOGIN_PER_15_MINUTES,
    },
    thresholds: {
      window_minutes: parsed.REVIEW_WINDOW_MINUTES,
      focus_losses: parsed.REVIEW_HIGH_FOCUS_LOSSES,
      fullscreen_exits: parsed.REVIEW_HIGH_FULLSCREEN_EXITS,
      external_apps: parsed.REVIEW_HIGH_EXTERNAL_APPS,
    },
  };
}
