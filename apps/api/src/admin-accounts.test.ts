import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAdminPassword } from "./admin-accounts.js";
import { hashPassword, verifyPassword } from "./crypto.js";
import { migrate, type Db } from "./db.js";

const OLD_PASSWORD = "original password";
const NEW_PASSWORD = "replacement password";

let pglite: PGlite;
let db: Db;
let otherHash: string;

async function account(username: string) {
  const { rows } = await db.query<{
    id: string;
    password_hash: string;
    role: string;
  }>("SELECT id, password_hash, role FROM admin_users WHERE username = $1", [
    username,
  ]);
  return rows[0]!;
}

function runCli(args: string[], password?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Nothing listens here: these cases must fail before connecting.
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  };
  delete env.ADMIN_PASSWORD;
  if (password !== undefined) {
    env.ADMIN_PASSWORD = password;
  }
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    { env, encoding: "utf8" },
  );
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
  otherHash = await hashPassword("other admin password");
});

afterAll(() => db.close());

beforeEach(async () => {
  await db.exec("TRUNCATE admin_users CASCADE; TRUNCATE contests CASCADE");
  await db.query(
    `INSERT INTO admin_users (username, password_hash, role)
     VALUES ('root', $1, 'admin'), ('other', $2, 'viewer')`,
    [await hashPassword(OLD_PASSWORD), otherHash],
  );
});

describe("resetAdminPassword", () => {
  it("replaces the password while keeping the same account and role", async () => {
    const before = await account("root");

    await resetAdminPassword(db, "root", NEW_PASSWORD);

    const after = await account("root");
    expect(after.id).toBe(before.id);
    expect(after.role).toBe("admin");
    expect(await verifyPassword(NEW_PASSWORD, after.password_hash)).toBe(true);
    expect(await verifyPassword(OLD_PASSWORD, after.password_hash)).toBe(false);
  });

  it("stores a hash, not the password", async () => {
    await resetAdminPassword(db, "root", NEW_PASSWORD);
    expect((await account("root")).password_hash).not.toContain(NEW_PASSWORD);
  });

  it("changes no other admin or contest", async () => {
    await db.query(
      "INSERT INTO contests (id, name, starts_at, ends_at, status) VALUES ('c1', 'Mock', now(), now(), 'active')",
    );

    await resetAdminPassword(db, "root", NEW_PASSWORD);

    expect((await account("other")).password_hash).toBe(otherHash);
    const { rows } = await db.query("SELECT status FROM contests");
    expect(rows).toEqual([{ status: "active" }]);
  });

  it("reports an unknown username without changing anything", async () => {
    const before = await account("root");
    await expect(resetAdminPassword(db, "ghost", NEW_PASSWORD)).rejects.toThrow(
      "Admin user not found: ghost",
    );
    expect((await account("root")).password_hash).toBe(before.password_hash);
  });

  it("treats a username as data, not SQL", async () => {
    const before = await account("root");
    await expect(
      resetAdminPassword(db, "root' OR '1'='1", NEW_PASSWORD),
    ).rejects.toThrow("Admin user not found");
    expect((await account("root")).password_hash).toBe(before.password_hash);
  });

  it("rejects a short password without changing it, and does not echo it", async () => {
    const before = await account("root");
    const attempt = resetAdminPassword(db, "root", "elevenchars");
    await expect(attempt).rejects.toThrow("at least 12 characters");
    await expect(attempt).rejects.not.toThrow("elevenchars");
    expect((await account("root")).password_hash).toBe(before.password_hash);
  });

  it("accepts a password of exactly 12 characters", async () => {
    await expect(
      resetAdminPassword(db, "root", "twelve-chars"),
    ).resolves.toBeUndefined();
  });

  it("fails unless exactly one account was updated", async () => {
    const twoRows: Db = {
      ...db,
      query: async <T>() => ({ rows: [{}, {}] as T[] }),
    };
    await expect(
      resetAdminPassword(twoRows, "root", NEW_PASSWORD),
    ).rejects.toThrow("updated 2");
  });
});

describe("reset-admin command", () => {
  it("is listed in the usage text", () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reset-admin <username>");
    expect(result.stderr).toContain("create-admin <username>");
  });

  it("requires a username", () => {
    const result = runCli(["reset-admin"], NEW_PASSWORD);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Commands:");
    expect(result.stderr).not.toContain(NEW_PASSWORD);
  });

  it("rejects a missing or short password and never prints it", () => {
    expect(runCli(["reset-admin", "root"]).stderr).toContain(
      "at least 12 characters",
    );

    const short = runCli(["reset-admin", "root"], "elevenchars");
    expect(short.status).toBe(1);
    expect(short.stderr).toContain("at least 12 characters");
    expect(`${short.stdout}${short.stderr}`).not.toContain("elevenchars");
  });
});
