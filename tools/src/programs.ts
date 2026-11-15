/**
 * The two programs Heir runs on, and how long a day lasts on their clocks.
 *
 * They come in pairs. The claim program has one vault program's id compiled in and believes a
 * tombstone from that program only, so a claim program is never used with another vault program.
 *
 * docs/program-ids.md lists the ids and records what is deployed where. Local tests load the
 * programs at the same ids.
 */
import { LAMPORT_VAULT_HEIR_PROGRAM_ID, LAMPORT_VAULT_HEIR_SHORT_CLOCKS_PROGRAM_ID } from "@lamport-robotics/vault";
import { PublicKey } from "@solana/web3.js";

/** `programs/heir-claim`. */
export const HEIR_CLAIM_PROGRAM_ID = new PublicKey("cvxRorjDzekSCcAyiinzgALnBT1dTuUdVvEraPeDkUW");
/** `programs/heir-claim` built with `short-clocks`: a test build in which a day lasts a second. */
export const HEIR_CLAIM_SHORT_CLOCKS_PROGRAM_ID = new PublicKey("HxMZSdKeFP2zJzhYUVNHefqEEz3B87EdTRjKwwPG6UhE");

export interface Programs {
  /** the Heir-enabled vault: lamport-vault built with the `succession` feature */
  vault: PublicKey;
  /** the claim program that believes this vault program's tombstones */
  claim: PublicKey;
  /** seconds in one "day" of both programs' clocks */
  daySecs: bigint;
}

export const PROGRAMS: Programs = Object.freeze({ vault: LAMPORT_VAULT_HEIR_PROGRAM_ID, claim: HEIR_CLAIM_PROGRAM_ID, daySecs: 86_400n });

/** The `short-clocks` test builds, for local validators and devnet. Never the real programs. */
export const SHORT_CLOCKS_PROGRAMS: Programs = Object.freeze({
  vault: LAMPORT_VAULT_HEIR_SHORT_CLOCKS_PROGRAM_ID,
  claim: HEIR_CLAIM_SHORT_CLOCKS_PROGRAM_ID,
  daySecs: 1n,
});

/** The pair a vault program belongs to, or undefined for a program Heir does not know. */
export function programsForVaultProgram(vaultProgram: PublicKey): Programs | undefined {
  return [PROGRAMS, SHORT_CLOCKS_PROGRAMS].find((p) => p.vault.equals(vaultProgram));
}

/** The pair a claim program belongs to, or undefined for a program Heir does not know. */
export function programsForClaimProgram(claimProgram: PublicKey): Programs | undefined {
  return [PROGRAMS, SHORT_CLOCKS_PROGRAMS].find((p) => p.claim.equals(claimProgram));
}
