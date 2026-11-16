import {
  createHash,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
) => Promise<Buffer>;

// Excludes characters that are easily confused when read from a printed slip.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newCode(length: number): string {
  return Array.from(
    { length },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join("");
}

/** Suitable only for high-entropy generated values, not for passwords. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashAccessCode(
  contestId: string,
  candidateId: string,
  code: string,
): string {
  return sha256(`${contestId}:${candidateId}:${code.trim().toUpperCase()}`);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt = "", expected = ""] = stored.split(":");
  const derived = await scryptAsync(password, Buffer.from(salt, "hex"), 64);
  return safeEqual(derived.toString("hex"), expected);
}
