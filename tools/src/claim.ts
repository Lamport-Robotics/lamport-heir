/**
 * Client for the claim program (`programs/heir-claim`): a plan's terms and address, the plan
 * account, the four instructions, and the rule that decides who may claim.
 *
 * This file is a second statement of the program's wire formats. `kat/claim_encoding.json` holds
 * the bytes both sides must agree on; this side writes it and the Rust tests read it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { type AccountMeta, Ed25519Program, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { HEIR_CLAIM_PROGRAM_ID, PROGRAMS, type Programs } from "./programs.ts";

const utf8 = new TextEncoder();

/** Domain of the terms hash: `terms_hash = sha256(TERMS_DOMAIN || borsh(terms))`. */
export const TERMS_DOMAIN = "lamport-heir/plan/v1";
/** Domain of a hashed heir: `sha256(HEIR_DOMAIN || salt[32] || address[32])`. */
export const HEIR_DOMAIN = "lamport-heir/heir/v1";
/** Seed prefix of the plan's address: `["plan", terms_hash]`. */
export const PLAN_SEED = "plan";

/** Borsh size of `Terms`: vault, two heirs of 33 bytes, the delay. */
export const TERMS_SIZE = 32 + 33 + 33 + 8;
/** Size of a `Plan` account, discriminator included. */
export const PLAN_ACCOUNT_SIZE = 8 + 1 + 1 + 32 + TERMS_SIZE + 8 + 1 + 8 + 8 + 8;
/** Layout version the program writes. */
export const PLAN_VERSION = 1;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u64le(x: bigint): Uint8Array {
  if (x < 0n || x >= 1n << 64n) throw new RangeError(`u64 out of range: ${x}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, x, true);
  return out;
}

/** Anchor's discriminators: the first 8 bytes of `sha256("<namespace>:<name>")`. */
function discriminator(namespace: "global" | "account", name: string): Uint8Array {
  return sha256(utf8.encode(`${namespace}:${name}`)).slice(0, 8);
}

export const CLAIM_IX = Object.freeze({
  initPlan: discriminator("global", "init_plan"),
  activate: discriminator("global", "activate"),
  claimSol: discriminator("global", "claim_sol"),
  claimToken: discriminator("global", "claim_token"),
});
export const PLAN_DISCRIMINATOR = discriminator("account", "Plan");

/** `ClaimError` codes, in the program's declaration order from 6000. */
export const CLAIM_ERROR = Object.freeze({
  InvalidTerms: 6000,
  TermsHashMismatch: 6001,
  InvalidContingentDelay: 6002,
  SameHeirTwice: 6003,
  NotALiveVault: 6004,
  HeirNotProven: 6005,
  WrongInstructionsSysvar: 6006,
  WrongVault: 6007,
  VaultNotClosed: 6008,
  NotATombstone: 6009,
  TombstoneNamesAnother: 6010,
  NotActivated: 6011,
  NotAnHeir: 6012,
  ContingentTooEarly: 6013,
  NothingToClaim: 6014,
  InvalidTokenProgram: 6015,
  NotPlanTokenAccount: 6016,
  WrongMint: 6017,
  DestinationNotHeirs: 6018,
  Overflow: 6019,
});

// ---- heirs and terms ----

/**
 * Who an heir is: nobody (the contingent position only), an address, or the salted hash of one.
 * A hashed heir stays private until they claim, and the claim needs the salt: a lost salt blocks
 * it for good.
 */
export type HeirRef = { kind: "none" } | { kind: "address"; address: PublicKey } | { kind: "hashed"; commitment: Uint8Array };

const KIND = { none: 0, address: 1, hashed: 2 } as const;

/** `sha256(HEIR_DOMAIN || salt || address)`: what a plan stores for a hashed heir. */
export function heirCommitment(salt: Uint8Array, address: PublicKey): Uint8Array {
  if (salt.length !== 32) throw new RangeError(`a salt is 32 bytes, got ${salt.length}`);
  return sha256(concat(utf8.encode(HEIR_DOMAIN), salt, address.toBytes()));
}

/** A hashed heir for `address`, committed with `salt`. */
export function hashedHeir(salt: Uint8Array, address: PublicKey): HeirRef {
  return { kind: "hashed", commitment: heirCommitment(salt, address) };
}

function heirValue(h: HeirRef): Uint8Array {
  if (h.kind === "address") return h.address.toBytes();
  if (h.kind === "hashed") {
    if (h.commitment.length !== 32) throw new RangeError(`a commitment is 32 bytes, got ${h.commitment.length}`);
    return h.commitment;
  }
  return new Uint8Array(32);
}

/** True when `signer` is this heir. A hashed heir needs the salt it was committed with. */
export function heirMatches(h: HeirRef, signer: PublicKey, salt?: Uint8Array): boolean {
  if (h.kind === "address") return h.address.equals(signer);
  if (h.kind === "hashed") return salt !== undefined && salt.length === 32 && equal(h.commitment, heirCommitment(salt, signer));
  return false;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * What a plan promises. The plan's address is derived from a hash of these, so none of them can
 * change after the plan exists: other terms are another plan.
 */
export interface Terms {
  /** the vault whose release this plan receives */
  vault: PublicKey;
  /** may claim from the moment the plan is activated */
  primary: HeirRef;
  /** may claim once the primary has not claimed for `contingentDelaySecs`; `{ kind: "none" }` for none */
  contingent: HeirRef;
  /** how long the contingent heir waits; 0 when there is none */
  contingentDelaySecs: bigint;
}

/** Borsh encoding of the terms, 106 bytes. */
export function encodeTerms(t: Terms): Uint8Array {
  return concat(t.vault.toBytes(), Uint8Array.of(KIND[t.primary.kind]), heirValue(t.primary), Uint8Array.of(KIND[t.contingent.kind]), heirValue(t.contingent), u64le(t.contingentDelaySecs));
}

function decodeHeir(kind: number, value: Uint8Array): HeirRef {
  if (kind === KIND.none) return { kind: "none" };
  if (kind === KIND.address) return { kind: "address", address: new PublicKey(value) };
  if (kind === KIND.hashed) return { kind: "hashed", commitment: Uint8Array.from(value) };
  throw new Error(`decode: unknown heir kind ${kind}`);
}

export function decodeTerms(bytes: Uint8Array): Terms {
  if (bytes.length !== TERMS_SIZE) throw new Error(`decode: terms are ${TERMS_SIZE} bytes, got ${bytes.length}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    vault: new PublicKey(bytes.subarray(0, 32)),
    primary: decodeHeir(bytes[32]!, bytes.subarray(33, 65)),
    contingent: decodeHeir(bytes[65]!, bytes.subarray(66, 98)),
    contingentDelaySecs: view.getBigUint64(98, true),
  };
}

/** `sha256(TERMS_DOMAIN || borsh(terms))`, the seed of the plan's address. */
export function termsHash(t: Terms): Uint8Array {
  return sha256(concat(utf8.encode(TERMS_DOMAIN), encodeTerms(t)));
}

/** The plan's address: PDA `["plan", terms_hash]` of the claim program. */
export function planAddress(t: Terms, claimProgram: PublicKey = HEIR_CLAIM_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode(PLAN_SEED), termsHash(t)], claimProgram)[0];
}

/** Shortest and longest contingent delay the program accepts: 30 days and 100 years. */
export function contingentDelayLimits(programs: Programs = PROGRAMS): { min: bigint; max: bigint } {
  return { min: 30n * programs.daySecs, max: 100n * 365n * programs.daySecs };
}

/**
 * The rules the program applies to a plan's terms (`Terms::validate`), for a client to check
 * before paying for a plan. Throws a RangeError that names the program's error.
 */
export function checkTerms(t: Terms, programs: Programs = PROGRAMS): void {
  const zero = (h: HeirRef) => h.kind === "address" && h.address.equals(PublicKey.default);
  if (t.vault.equals(PublicKey.default)) throw new RangeError("the terms name no vault (InvalidTerms)");
  if (t.primary.kind === "none") throw new RangeError("the terms name no primary heir (InvalidTerms)");
  if (zero(t.primary)) throw new RangeError("the primary heir is the all-zero address (InvalidTerms)");
  if (t.contingent.kind === "none") {
    if (t.contingentDelaySecs !== 0n) throw new RangeError("the contingent delay must be 0 with no contingent heir (InvalidContingentDelay)");
    return;
  }
  if (zero(t.contingent)) throw new RangeError("the contingent heir is the all-zero address (InvalidTerms)");
  if (t.contingent.kind === t.primary.kind && equal(heirValue(t.contingent), heirValue(t.primary))) {
    throw new RangeError("the primary and the contingent heir are the same (SameHeirTwice)");
  }
  const { min, max } = contingentDelayLimits(programs);
  if (t.contingentDelaySecs < min || t.contingentDelaySecs > max) {
    throw new RangeError(`the contingent delay must be between ${min} and ${max} seconds, got ${t.contingentDelaySecs} (InvalidContingentDelay)`);
  }
}

// ---- the plan account ----

/** Released funds held for named heirs. Never closed: sweeps can reach it at any later time. */
export interface PlanAccount {
  version: number;
  bump: number;
  termsHash: Uint8Array;
  terms: Terms;
  /** unix seconds */
  createdTs: bigint;
  /** whether `activate` has seen the vault's tombstone naming this plan */
  activated: boolean;
  activatedTs: bigint;
  /** `closed_slot` of the vault's tombstone, for the record */
  closedSlot: bigint;
  /** the moment the contingent delay counts from: activation, then every claim by the primary heir */
  contingentClockTs: bigint;
}

export function isPlan(data: Uint8Array): boolean {
  return data.length === PLAN_ACCOUNT_SIZE && equal(data.subarray(0, 8), PLAN_DISCRIMINATOR);
}

export function decodePlan(data: Uint8Array): PlanAccount {
  if (!isPlan(data)) throw new Error(`decode: not a Plan account (${data.length} bytes)`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = data[8]!;
  if (version !== PLAN_VERSION) throw new Error(`decode: plan layout version ${version}, this code knows ${PLAN_VERSION}`);
  const termsAt = 8 + 1 + 1 + 32;
  const after = termsAt + TERMS_SIZE;
  const activatedByte = data[after + 8]!;
  if (activatedByte > 1) throw new Error(`decode: bool byte is ${activatedByte}`);
  return {
    version,
    bump: data[9]!,
    termsHash: data.slice(10, 42),
    terms: decodeTerms(data.subarray(termsAt, after)),
    createdTs: view.getBigInt64(after, true),
    activated: activatedByte === 1,
    activatedTs: view.getBigInt64(after + 9, true),
    closedSlot: view.getBigUint64(after + 17, true),
    contingentClockTs: view.getBigInt64(after + 25, true),
  };
}

/** The moment from which the contingent heir may claim, for an activated plan that has one. */
export function contingentOpensAt(plan: PlanAccount): bigint | undefined {
  if (!plan.activated || plan.terms.contingent.kind === "none") return undefined;
  return plan.contingentClockTs + plan.terms.contingentDelaySecs;
}

export type ClaimRole =
  | { ok: true; role: "primary" | "contingent" }
  | { ok: false; reason: "NotActivated" | "NotAnHeir" }
  | { ok: false; reason: "ContingentTooEarly"; opensAt: bigint };

/**
 * Whether `signer` may claim from `plan` at `now`, and as whom: the program's `claim_role`.
 *
 * The primary heir may always claim. The contingent heir may claim once `now` reaches
 * `contingentClockTs + contingentDelaySecs`; that clock starts at activation and restarts every
 * time the primary claims.
 */
export function claimRole(plan: PlanAccount, signer: PublicKey, salt: Uint8Array | undefined, now: bigint): ClaimRole {
  if (!plan.activated) return { ok: false, reason: "NotActivated" };
  if (heirMatches(plan.terms.primary, signer, salt)) return { ok: true, role: "primary" };
  if (heirMatches(plan.terms.contingent, signer, salt)) {
    const opensAt = plan.contingentClockTs + plan.terms.contingentDelaySecs;
    return now >= opensAt ? { ok: true, role: "contingent" } : { ok: false, reason: "ContingentTooEarly", opensAt };
  }
  return { ok: false, reason: "NotAnHeir" };
}

// ---- proof of control ----

/**
 * The text an heir signs to accept a place in `plan`. `init_plan` accepts it bare, or inside an
 * off-chain message envelope, signed by the heir's address and carried by an Ed25519 program
 * instruction in the same transaction.
 */
export function acceptanceMessage(plan: PublicKey): string {
  return `Lamport Heir: I control this address and accept being named an heir in plan ${plan.toBase58()}.`;
}

/**
 * The Ed25519 program instruction that carries an heir's signature over `message` (the bytes they
 * actually signed: the acceptance message, bare or in its envelope). The signature is checked by
 * the cluster; `init_plan` then reads this instruction to learn that the heir signed.
 */
export function acceptanceProofInstruction(heir: PublicKey, signature: Uint8Array, message: Uint8Array): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({ publicKey: heir.toBytes(), message, signature });
}

// ---- instructions ----

const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const ws = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });
const rs = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });

function optionSalt(salt: Uint8Array | undefined): Uint8Array {
  if (salt === undefined) return Uint8Array.of(0);
  if (salt.length !== 32) throw new RangeError(`a salt is 32 bytes, got ${salt.length}`);
  return concat(Uint8Array.of(1), salt);
}

/**
 * `init_plan`: creates the plan for `terms`. Anyone may pay; nobody controls the plan afterwards.
 * Every heir named by address must prove control in this transaction: by signing it (the payer, or
 * an address listed in `signingHeirs`), or through an {@link acceptanceProofInstruction} placed in
 * the same transaction. Hashed heirs prove nothing here.
 */
export function initPlanInstruction(p: { claimProgram?: PublicKey; payer: PublicKey; terms: Terms; signingHeirs?: PublicKey[] }): { instruction: TransactionInstruction; plan: PublicKey } {
  const claimProgram = p.claimProgram ?? HEIR_CLAIM_PROGRAM_ID;
  const hash = termsHash(p.terms);
  const plan = PublicKey.findProgramAddressSync([utf8.encode(PLAN_SEED), hash], claimProgram)[0];
  return {
    plan,
    instruction: new TransactionInstruction({
      programId: claimProgram,
      keys: [ws(p.payer), w(plan), r(p.terms.vault), r(SYSVAR_INSTRUCTIONS_PUBKEY), r(SystemProgram.programId), ...(p.signingHeirs ?? []).map(rs)],
      data: Buffer.from(concat(CLAIM_IX.initPlan, hash, encodeTerms(p.terms))),
    }),
  };
}

/** `activate`: records that the vault has released to this plan. Anyone may call it; again changes nothing. */
export function activateInstruction(p: { claimProgram?: PublicKey; plan: PublicKey; vault: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({ programId: p.claimProgram ?? HEIR_CLAIM_PROGRAM_ID, keys: [w(p.plan), r(p.vault)], data: Buffer.from(CLAIM_IX.activate) });
}

/** `claim_sol`: every lamport the plan holds above its own rent goes to the claiming heir, who signs. */
export function claimSolInstruction(p: { claimProgram?: PublicKey; plan: PublicKey; heir: PublicKey; salt?: Uint8Array | undefined }): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.claimProgram ?? HEIR_CLAIM_PROGRAM_ID,
    keys: [w(p.plan), ws(p.heir)],
    data: Buffer.from(concat(CLAIM_IX.claimSol, optionSalt(p.salt))),
  });
}

/**
 * `claim_token`: the whole balance of one token account the plan owns goes to `destination`, a
 * token account of the same mint that the claiming heir owns. With `closeAccount`, the plan's
 * account is closed and its rent goes to the heir; leave it unset for an account that cannot be
 * closed yet (withheld transfer fees). `extraAccounts` go to the token program as they are: a mint
 * with a transfer hook needs its accounts there.
 */
export function claimTokenInstruction(p: {
  claimProgram?: PublicKey;
  plan: PublicKey;
  heir: PublicKey;
  planTokenAccount: PublicKey;
  destination: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  salt?: Uint8Array | undefined;
  closeAccount: boolean;
  extraAccounts?: AccountMeta[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.claimProgram ?? HEIR_CLAIM_PROGRAM_ID,
    keys: [w(p.plan), ws(p.heir), w(p.planTokenAccount), w(p.destination), r(p.mint), r(p.tokenProgram), ...(p.extraAccounts ?? [])],
    data: Buffer.from(concat(CLAIM_IX.claimToken, optionSalt(p.salt), Uint8Array.of(p.closeAccount ? 1 : 0))),
  });
}
