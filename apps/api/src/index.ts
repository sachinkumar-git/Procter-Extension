import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPgDb, migrate } from "./db.js";
import { jsonLogger as logger } from "./log.js";
import { sweepDisconnected } from "./sweep.js";

const SWEEP_INTERVAL_MS = 15_000;

const config = loadConfig();
const db = createPgDb(config.databaseUrl);
await migrate(db);

const now = () => new Date();
const server = createApp({ db, config, logger, now }).listen(
  config.port,
  () => {
    logger.info("api_listening", { port: config.port });
  },
);

// Longer than the 30-second heartbeat, so clients reuse their connections,
// and longer than typical reverse proxy idle timeouts.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const sweep = setInterval(() => {
  sweepDisconnected(db, now(), config.heartbeatGraceSeconds).catch(
    (error: Error) => logger.error("sweep_failed", { error: error.message }),
  );
}, SWEEP_INTERVAL_MS);

function shutdown() {
  clearInterval(sweep);
  server.close(() => {
    void db.close().then(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
