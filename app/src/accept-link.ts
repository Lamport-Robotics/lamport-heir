/**
 * The link an owner sends an heir to accept their place in a plan.
 *
 *   claim.html#accept=<terms>               for an heir named by address
 *   claim.html#accept=<terms>&salt=<salt>   for an heir kept private: their own link, with their salt
 *
 * The terms are the plan's, so the heir's page can say what they are accepting and work out the
 * plan's address. An heir kept private appears in the terms as a fingerprint, which their page can
 * match to their wallet only with the salt; and the salt is theirs to keep, since collecting needs
 * it. So their link carries it, and they have it before the plan exists.
 *
 * Whoever sees a link with a salt in it can tell which address is behind that fingerprint. They
 * can take nothing with it.
 *
 * Pure. Nothing here runs when the module loads.
 */
import type { Terms } from "../../tools/src/claim.ts";
import { termsFromJson, termsToJson } from "./terms.ts";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** `origin` is the site's, as in `location.origin` */
export function writeAcceptLink(origin: string, terms: Terms, salt?: Uint8Array): string {
  if (salt && salt.length !== 32) throw new RangeError("a salt is 32 bytes");
  const b64 = btoa(JSON.stringify(termsToJson(terms))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${origin}/heir/claim.html#accept=${b64}${salt ? `&salt=${hex(salt)}` : ""}`;
}

/** Reads what follows `#accept=`. Throws when it is not a link this page made. */
export function readAcceptLink(arg: string): { terms: Terms; salt?: Uint8Array } {
  const m = /^([A-Za-z0-9_-]+)(?:&salt=([0-9a-f]{64}))?$/.exec(arg);
  if (!m) throw new Error("the link is damaged");
  const b64 = m[1]!.replaceAll("-", "+").replaceAll("_", "/");
  const terms = termsFromJson(JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))));
  return m[2] ? { terms, salt: Uint8Array.from(m[2].match(/../g)!, (b) => parseInt(b, 16)) } : { terms };
}
