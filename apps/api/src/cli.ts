// Organiser command line: npm run cli -w @exam-guard/api -- <command> [args]
import { readFile, writeFile } from "node:fs/promises";
import { resetAdminPassword } from "./admin-accounts.js";
import { loadConfig } from "./config.js";
import { hashAccessCode, hashPassword, newCode } from "./crypto.js";
import { createPgDb, migrate, type Db } from "./db.js";

const USAGE = `Commands:
  migrate
  create-admin <username> <admin|viewer>   (password from ADMIN_PASSWORD)
  reset-admin <username>   (new password from ADMIN_PASSWORD)
  create-contest <id> <name> <startISO> <endISO>
  set-contest-status <id> <draft|active|closed>
  import-candidates <contestId> <input.csv> <codes-output.csv>
      input lines: candidate_id,display_name
  purge-contest <id>   (permanently deletes the contest and its events)`;

const ID = /^[A-Za-z0-9._-]{1,64}$/;

function fail(message: string): never {
  throw new Error(message);
}

async function importCandidates(
  db: Db,
  contestId: string,
  input: string,
  output: string,
) {
  const lines = (await readFile(input, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out = ["candidate_id,display_name,access_code"];
  for (const line of lines) {
    const [candidateId = "", ...rest] = line.split(",");
    const displayName = rest.join(",").trim();
    if (!ID.test(candidateId.trim())) {
      fail(`Invalid candidate ID: ${candidateId}`);
    }
    const id = candidateId.trim();
    const code = newCode(10);
    await db.query(
      `INSERT INTO candidates (contest_id, candidate_id, display_name, access_code_hash)
       VALUES ($1, $2, $3, $4)`,
      [contestId, id, displayName || null, hashAccessCode(contestId, id, code)],
    );
    out.push(`${id},"${displayName.replaceAll('"', '""')}",${code}`);
  }
  // Codes exist in plain text only in this file; "wx" refuses to overwrite one.
  await writeFile(output, `${out.join("\r\n")}\r\n`, { flag: "wx" });
  console.log(
    `Imported ${lines.length} candidates; codes written to ${output}`,
  );
}

async function run(db: Db, command: string | undefined, args: string[]) {
  const [a = "", b = "", c = "", d = ""] = args;
  switch (command) {
    case "migrate":
      await migrate(db);
      break;
    case "create-admin": {
      const password = process.env.ADMIN_PASSWORD ?? "";
      if (password.length < 12) {
        fail("Set ADMIN_PASSWORD to at least 12 characters.");
      }
      if (b !== "admin" && b !== "viewer") {
        fail(USAGE);
      }
      await db.query(
        "INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3)",
        [a, await hashPassword(password), b],
      );
      break;
    }
    case "reset-admin":
      if (!a) {
        fail(USAGE);
      }
      await resetAdminPassword(db, a, process.env.ADMIN_PASSWORD ?? "");
      break;
    case "create-contest":
      if (!ID.test(a) || !b || !c || !d) {
        fail(USAGE);
      }
      await db.query(
        "INSERT INTO contests (id, name, starts_at, ends_at) VALUES ($1, $2, $3, $4)",
        [a, b, c, d],
      );
      break;
    case "set-contest-status":
      await db.query("UPDATE contests SET status = $2 WHERE id = $1", [a, b]);
      break;
    case "import-candidates":
      await importCandidates(db, a, b, c);
      break;
    case "purge-contest":
      await db.query("DELETE FROM events WHERE contest_id = $1", [a]);
      await db.query("DELETE FROM contests WHERE id = $1", [a]);
      break;
    default:
      fail(USAGE);
  }
}

const db = createPgDb(loadConfig().databaseUrl);
try {
  const [command, ...args] = process.argv.slice(2);
  await run(db, command, args);
  console.log("Done.");
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
