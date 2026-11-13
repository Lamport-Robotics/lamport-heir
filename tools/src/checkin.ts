/**
 * The check-in key, and a check-in.
 *
 * A check-in tells the vault its owner is alive without the vault's own key: one small
 * transaction, signed by a key that can do nothing else. It restarts the inactivity window and
 * cancels an open waiting period, for at most two years past the owner's last vault signature.
 * It can only ever delay a release.
 *
 * The key is made where it will be used and never leaves: in a browser or on a phone it is a
 * WebCrypto key created as non-extractable, so no script, export or backup can read it; it can
 * only be asked to sign. This module never sees its bytes either. Losing it loses nothing: the
 * owner names a new one with a vault signature.
 *
 * The key pays its own fee (0.000005 SOL a time), from a few cents of SOL the owner sends its
 * address when they arm. Nobody else has to be online for an owner to check in.
 */
import { checkinCountsUntil, checkinInstruction, type SuccessionState } from "@lamport-robotics/vault";
import { PublicKey, Transaction } from "@solana/web3.js";
import { type Chain, COMMITMENT, reasonFromLogs, TransactionFailed } from "./chain.ts";
import { type Programs } from "./programs.ts";
import { inspect } from "./release.ts";

/** Something that can sign as the check-in key. The private key stays behind this. */
export interface CheckinSigner {
  publicKey: PublicKey;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** The fee of one check-in, in lamports: one signature. */
export const CHECKIN_FEE_LAMPORTS = 5_000;

/**
 * Makes a new check-in key with WebCrypto. The private half is created non-extractable: it can
 * sign, and nothing can read it out, this code included. `handle` is what a browser stores (in
 * IndexedDB) to use the key again; it is not the key's bytes.
 */
export async function generateCheckinKey(): Promise<CheckinSigner & { handle: CryptoKeyPair }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  return { ...(await checkinSignerFrom(pair)), handle: pair };
}

/** A signer for a key pair made by {@link generateCheckinKey} and kept by the browser. */
export async function checkinSignerFrom(pair: CryptoKeyPair): Promise<CheckinSigner> {
  if (pair.privateKey.extractable) throw new Error("a check-in key must be non-extractable");
  const publicKey = new PublicKey(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return {
    publicKey,
    sign: async (message) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message as BufferSource)),
  };
}

/** Whether a check-in would count right now, and if not, why. Reads only. */
export type CheckinReadiness =
  | { ok: true; countsUntil: bigint }
  | { ok: false; reason: "released" | "no_plan" | "not_the_check_in_key" | "past_cap" | "needs_fee"; detail: string };

export function checkinCounts(s: SuccessionState, signer: PublicKey, now: bigint, programs: Programs): CheckinReadiness {
  if (s.claim.equals(PublicKey.default)) return { ok: false, reason: "no_plan", detail: "the vault has no succession plan" };
  if (s.checkinKey.equals(PublicKey.default) || !s.checkinKey.equals(signer)) {
    return { ok: false, reason: "not_the_check_in_key", detail: "this is not the vault's check-in key: the owner names it with a vault signature" };
  }
  const until = checkinCountsUntil(s, { daySecs: programs.daySecs });
  if (now > until) return { ok: false, reason: "past_cap", detail: "check-ins no longer count for this vault: two years have passed since the last vault signature, and one is due now" };
  return { ok: true, countsUntil: until };
}

/**
 * Checks in for `vault`. The check-in key signs and pays the fee. Before anything is sent, the
 * vault is read: a check-in that would not count (no plan, another key, past the two-year cap, a
 * released vault) or that the key cannot pay for is refused in words instead of costing a fee.
 */
export async function checkin(chain: Chain, signer: CheckinSigner, vault: PublicKey): Promise<{ sent: true; signature: string; countsUntil: bigint } | { sent: false; readiness: CheckinReadiness }> {
  const situation = await inspect(chain, vault);
  if (situation.state !== "open" || !situation.succession) return { sent: false, readiness: { ok: false, reason: "released", detail: "the vault has been released: there is nothing left to check in for" } };
  const readiness = checkinCounts(situation.succession, signer.publicKey, situation.now, situation.programs);
  if (!readiness.ok) return { sent: false, readiness };
  const balance = (await chain.getAccountInfo(signer.publicKey, COMMITMENT))?.lamports ?? 0;
  if (balance < CHECKIN_FEE_LAMPORTS) {
    return { sent: false, readiness: { ok: false, reason: "needs_fee", detail: `the check-in key's address ${signer.publicKey.toBase58()} holds too little SOL to pay the fee of a check-in: send it a little` } };
  }

  const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash(COMMITMENT);
  const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(checkinInstruction({ programId: situation.programs.vault, vault: situation.vault, checkinKey: signer.publicKey }));
  tx.addSignature(signer.publicKey, Buffer.from(await signer.sign(tx.serializeMessage())));
  let signature: string;
  try {
    signature = await chain.sendRawTransaction(tx.serialize(), { preflightCommitment: COMMITMENT });
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs ?? [];
    throw new TransactionFailed(`the check-in was refused: ${reasonFromLogs(logs) ?? (e as Error).message}`, logs);
  }
  const res = await chain.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, COMMITMENT);
  if (res.value.err) throw new TransactionFailed(`check-in ${signature} failed: ${JSON.stringify(res.value.err)}`, []);
  return { sent: true, signature, countsUntil: readiness.countsUntil };
}
