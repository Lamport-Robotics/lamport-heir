/**
 * An heir's acceptance, as it travels from the heir to the owner.
 *
 * A plan names heirs by address, and an address with a typo in it is an heir nobody is. So before
 * a plan is created, each named heir signs a sentence that names the plan (`acceptanceMessage`),
 * with the key of the address the owner wrote down. The claim program checks the signature when
 * the plan is created (programs/heir-claim/src/proof.rs). What the heir sends back to the owner is
 * the small piece of text made here; the owner's page checks it before paying for anything.
 *
 * It is not a secret and gives nobody any power: it says "this key exists and its holder has seen
 * this plan". Nothing here runs when the module loads.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import { acceptanceMessage } from "../../tools/src/claim.ts";

/** what a wallet puts in front of a message it signs under Solana's off-chain message format */
const OFFCHAIN_DOMAIN = Uint8Array.from([0xff, ...new TextEncoder().encode("solana offchain")]);
/** the most the claim program lets an envelope put in front of the sentence */
const MAX_ENVELOPE_LEN = 128;

export interface Acceptance {
  v: 1;
  plan: string;
  heir: string;
  /** base64: the bytes the wallet signed, which are the sentence, bare or inside an off-chain envelope */
  signed: string;
  /** base64: the 64-byte Ed25519 signature */
  signature: string;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** the sentence an heir signs for `plan`, as bytes */
export function acceptanceBytes(plan: PublicKey): Uint8Array {
  return new TextEncoder().encode(acceptanceMessage(plan));
}

/** the rule of the claim program (`proof::message_accepted`): the sentence itself, or the sentence at the end of an off-chain envelope */
export function isAcceptanceOf(signed: Uint8Array, plan: PublicKey): boolean {
  const expected = acceptanceBytes(plan);
  if (same(signed, expected)) return true;
  const extra = signed.length - expected.length;
  return extra > 0 && extra <= MAX_ENVELOPE_LEN && same(signed.subarray(0, OFFCHAIN_DOMAIN.length), OFFCHAIN_DOMAIN) && same(signed.subarray(extra), expected);
}

/** the text an heir sends back: one line of JSON */
export function writeAcceptance(plan: PublicKey, heir: PublicKey, signed: Uint8Array, signature: Uint8Array): string {
  const a: Acceptance = { v: 1, plan: plan.toBase58(), heir: heir.toBase58(), signed: b64(signed), signature: b64(signature) };
  return JSON.stringify(a);
}

/**
 * Reads what an heir sent back and checks all of it: that it is for this plan and this heir, that
 * what was signed is the sentence, and that the signature is the heir's. Throws in words.
 */
export function readAcceptance(text: string, expect: { plan: PublicKey; heir: PublicKey }): { heir: PublicKey; signed: Uint8Array; signature: Uint8Array } {
  let a: Partial<Acceptance>;
  try { a = JSON.parse(text.trim()); } catch { throw new Error("That is not an acceptance: it should be the one line of text the heir's page gave them."); }
  if (!a || typeof a !== "object" || a.v !== 1 || typeof a.plan !== "string" || typeof a.heir !== "string" || typeof a.signed !== "string" || typeof a.signature !== "string") throw new Error("That is not an acceptance: it should be the one line of text the heir's page gave them.");
  if (a.plan !== expect.plan.toBase58()) throw new Error(`That acceptance is for another plan (${a.plan}). The heirs or the delay changed since it was signed, or it was meant for another vault. Ask for a new one.`);
  if (a.heir !== expect.heir.toBase58()) throw new Error(`That acceptance was signed by ${a.heir}, not by the address named here (${expect.heir.toBase58()}).`);
  let signed: Uint8Array, signature: Uint8Array;
  try { signed = unb64(a.signed); signature = unb64(a.signature); } catch { throw new Error("That acceptance is damaged: it does not decode."); }
  if (signature.length !== 64) throw new Error("That acceptance is damaged: the signature is not 64 bytes.");
  if (!isAcceptanceOf(signed, expect.plan)) throw new Error("What was signed is not the acceptance sentence for this plan.");
  let ok = false;
  try { ok = ed25519.verify(signature, signed, expect.heir.toBytes()); } catch { ok = false; }
  if (!ok) throw new Error("The signature does not belong to that address. The heir should sign again with the wallet of the address named here.");
  return { heir: expect.heir, signed, signature };
}
