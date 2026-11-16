import { hashPassword } from "./crypto.js";
import type { Db } from "./db.js";

export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/** Error messages must never include the password. */
export async function resetAdminPassword(
  db: Db,
  username: string,
  password: string,
): Promise<void> {
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(
      `Set ADMIN_PASSWORD to at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const { rows } = await db.query<{ id: string }>(
    "UPDATE admin_users SET password_hash = $1 WHERE username = $2 RETURNING id",
    [await hashPassword(password), username],
  );

  if (rows.length === 0) {
    throw new Error(`Admin user not found: ${username}`);
  }
  if (rows.length !== 1) {
    throw new Error(
      `Expected to update one admin account but updated ${rows.length}.`,
    );
  }
}
