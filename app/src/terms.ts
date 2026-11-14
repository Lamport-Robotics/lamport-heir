/**
 * What a plan's address is made of, as a signing request carries it, and what the page and the
 * cold signer say about it.
 *
 * To the vault program the address a vault releases to is 32 bytes. When that address is a plan of
 * the claim program it is not arbitrary: it is derived from a hash of the plan's terms (the vault,
 * the heirs, the delay). So a request can carry the terms, and the signer, offline, can derive the
 * address again and compare. If it matches, the owner is told who inherits, not shown an address
 * to take on trust; if it does not, the signer refuses.
 *
 * This file is bundled into the cold signer. It reads no network and holds no state, and nothing
 * in it runs when the module loads.
 */
import { PublicKey } from "@solana/web3.js";
import { LAMPORT_VAULT_PROGRAM_ID } from "@lamport-robotics/vault";
import { checkTerms, planAddress, type HeirRef, type Terms } from "../../tools/src/claim.ts";
import { programsForVaultProgram, type Programs } from "../../tools/src/programs.ts";

/** an heir in a request: by address, or by the salted hash of one (64 hex digits) */
export type HeirJson = { address: string } | { hashed: string };

/** a plan's terms in a request. Every field is text, so the JSON is the same on every machine. */
export interface TermsJson {
  v: 1;
  vault: string;
  primary: HeirJson;
  contingent: HeirJson | null;
  /** decimal seconds; "0" when there is no contingent heir */
  contingentDelaySecs: string;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function heirToJson(h: HeirRef): HeirJson | null {
  if (h.kind === "address") return { address: h.address.toBase58() };
  if (h.kind === "hashed") return { hashed: hex(h.commitment) };
  return null;
}

export function termsToJson(t: Terms): TermsJson {
  const primary = heirToJson(t.primary);
  if (!primary) throw new RangeError("the terms name no primary heir");
  return { v: 1, vault: t.vault.toBase58(), primary, contingent: heirToJson(t.contingent), contingentDelaySecs: t.contingentDelaySecs.toString() };
}

function address(x: unknown, what: string): PublicKey {
  if (typeof x !== "string" || x !== x.trim()) throw new Error(`${what} is not an address`);
  try { return new PublicKey(x); } catch { throw new Error(`${what} is not an address`); }
}

function onlyKeys(x: object, allowed: string[], what: string): void {
  for (const k of Object.keys(x)) if (!allowed.includes(k)) throw new Error(`${what} has a field this build does not know: ${k}`);
}

function heirFromJson(x: unknown, what: string): HeirRef {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error(`${what} is missing`);
  const h = x as Record<string, unknown>;
  if (Object.hasOwn(h, "address") && !Object.hasOwn(h, "hashed")) { onlyKeys(h, ["address"], what); return { kind: "address", address: address(h.address, what) }; }
  if (Object.hasOwn(h, "hashed") && !Object.hasOwn(h, "address")) {
    onlyKeys(h, ["hashed"], what);
    if (typeof h.hashed !== "string" || !/^[0-9a-f]{64}$/.test(h.hashed)) throw new Error(`${what} is not a 32-byte hash in lowercase hex`);
    return { kind: "hashed", commitment: Uint8Array.from(h.hashed.match(/../g)!, (b) => parseInt(b, 16)) };
  }
  throw new Error(`${what} must be an address or a hash, one of the two`);
}

/**
 * Reads terms out of a request. Strict: an unknown field, a missing one or a value of another type
 * is an error, because whatever is not understood here would not be shown to the owner either.
 */
export function termsFromJson(x: unknown): Terms {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("the terms are not an object");
  const t = x as Record<string, unknown>;
  onlyKeys(t, ["v", "vault", "primary", "contingent", "contingentDelaySecs"], "the terms");
  if (t.v !== 1) throw new Error("the terms are of a version this build does not know");
  if (typeof t.contingentDelaySecs !== "string" || !/^(0|[1-9]\d{0,19})$/.test(t.contingentDelaySecs) || BigInt(t.contingentDelaySecs) > 0xffffffffffffffffn) throw new Error("the contingent delay is not a whole number of seconds");
  return {
    vault: address(t.vault, "the terms' vault"),
    primary: heirFromJson(t.primary, "the first heir"),
    contingent: t.contingent === null ? { kind: "none" } : heirFromJson(t.contingent, "the second heir"),
    contingentDelaySecs: BigInt(t.contingentDelaySecs),
  };
}

/** the two programs this build works with, found from the vault program it was built for */
export function buildPrograms(): Programs {
  const programs = programsForVaultProgram(LAMPORT_VAULT_PROGRAM_ID);
  if (!programs) throw new Error("this build was made for a vault program Lamport Heir does not know");
  return programs;
}

function durationInDays(secs: bigint, daySecs: bigint): string {
  if (secs % daySecs !== 0n) return `${secs} seconds`;
  const n = secs / daySecs;
  return `${n} day${n === 1n ? "" : "s"}`;
}

function sayHeir(h: HeirRef): string {
  if (h.kind === "address") return h.address.toBase58();
  // the whole fingerprint: a part of it could be matched by someone choosing their own address and salt
  if (h.kind === "hashed") return `NOT SHOWN. The plan holds only this fingerprint of an address and a salt: ${hex(h.commitment)}. This signer cannot tell whose address it is. Compare all 64 characters with the fingerprint printed on that heir's kit`;
  return "none";
}

export interface ClaimExplained {
  /** set when the request's terms cannot be read, are for another vault, or do not give its claim address */
  problem?: string;
  /** label and text, shown under the claim address */
  rows: [string, string][];
}

/**
 * Who is behind the claim address of a `SetSuccession` request. With no terms in the request this
 * build knows no more than the vault's own (null). With terms, the address is derived again from
 * them; anything short of an exact match is a problem, and the signer refuses the request.
 */
export function explainClaim(a: { claim: string; terms?: unknown }, vault: string): ClaimExplained | null {
  if (a.terms === undefined) return null;
  let terms: Terms, programs: Programs;
  try {
    programs = buildPrograms();
    terms = termsFromJson(a.terms);
    checkTerms(terms, programs);
  } catch (e) {
    return { problem: `the plan in this request cannot be used: ${String((e as Error).message ?? e)}`, rows: [] };
  }
  if (terms.vault.toBase58() !== vault) return { problem: `the plan in this request was made for another vault (${terms.vault.toBase58()}). What this vault released to it could never be claimed`, rows: [] };
  const derived = planAddress(terms, programs.claim).toBase58();
  if (derived !== a.claim) return { problem: `the heirs named in this request give the plan address ${derived}, but the request releases to ${a.claim}`, rows: [] };
  // with a private heir the derivation still proves the address is a plan for this vault with these terms, and
  // nothing about who is behind a fingerprint: whoever made the request may have made the fingerprint too
  const hidden = terms.primary.kind === "hashed" || terms.contingent.kind === "hashed";
  const rows: [string, string][] = [
    ["who that is", hidden
      ? "a Lamport Heir plan for this vault that keeps an heir private. Its address was derived here from the terms below and matches, but this signer cannot tell you who a private heir is. Do not sign unless each fingerprint below is, character for character, the one on the kit you printed for that heir"
      : "a Lamport Heir plan. Its address was derived here, from this vault and the heirs below, and it is the address above. The heirs cannot be changed without changing the address"],
    ["first heir", `${sayHeir(terms.primary)} · may claim as soon as the vault has been released`],
    ["second heir", terms.contingent.kind === "none" ? "none: only the first heir can ever claim" : `${sayHeir(terms.contingent)} · may claim if the first heir has not, from ${durationInDays(terms.contingentDelaySecs, programs.daySecs)} after the release`],
  ];
  return { rows };
}
