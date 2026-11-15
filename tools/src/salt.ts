/**
 * A private heir's salt, as it is printed and typed.
 *
 * A plan can name an heir by `sha256(domain || salt || address)` instead of by address. The salt
 * is on that heir's kit and nowhere else, and their claim has to show it. It is typed from paper,
 * so it carries four check digits.
 *
 * Apart from the kit so that the heirs' page can read a salt without carrying the kit's printer.
 */
import { sha256 } from "@noble/hashes/sha2.js";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * A salt as the kit prints it: 64 hex digits, a dash, and 4 check digits (the first two bytes of
 * its SHA-256). The check lets the claim tool catch a mistyped salt before it looks like "you are
 * not an heir".
 */
export function formatSalt(salt: Uint8Array): string {
  if (salt.length !== 32) throw new RangeError(`a salt is 32 bytes, got ${salt.length}`);
  return `${hex(salt)}-${hex(sha256(salt).slice(0, 2))}`;
}

/** Reads a salt as printed by {@link formatSalt}, with or without spaces and the check digits. */
export function parseSalt(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "").toLowerCase();
  const m = /^([0-9a-f]{64})(?:-([0-9a-f]{4}))?$/.exec(clean);
  if (!m) throw new Error("a salt is 64 hex digits, optionally followed by a dash and 4 check digits");
  const salt = Uint8Array.from(m[1]!.match(/../g)!, (b) => parseInt(b, 16));
  if (m[2] !== undefined && m[2] !== hex(sha256(salt).slice(0, 2))) throw new Error("the salt's check digits do not match: one of its digits is mistyped");
  return salt;
}
