import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import { adminRoutes } from "./admin-routes.js";
import { candidateRoutes } from "./candidate-routes.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";

export interface AppDeps {
  db: Db;
  config: Config;
  logger: Logger;
  now: () => Date;
}

export function createApp(deps: AppDeps) {
  const { db, config, logger } = deps;
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, maxAge: 600 }));
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      logger.info("request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });
    next();
  });

  app.use("/v1/admin", adminRoutes(deps));
  app.use("/v1", candidateRoutes(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use(
    (
      error: Error & { status?: number; type?: string },
      req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      void _next;
      if (error.type === "entity.too.large") {
        res.status(413).json({ error: "payload_too_large" });
      } else if (error.type === "entity.parse.failed") {
        res.status(400).json({ error: "invalid_json" });
      } else {
        logger.error("unhandled_error", {
          path: req.path,
          error: error.message,
        });
        res.status(500).json({ error: "internal_error" });
      }
    },
  );

  return app;
}
