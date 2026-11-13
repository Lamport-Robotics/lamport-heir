/**
 * The claim program's byte layouts, as known answers: `kat/claim_encoding.json`.
 *
 * Built here from the TypeScript client, written by `write-kat.ts`, and read back by the Rust
 * crate (`programs/heir-claim/tests/encoding.rs`), which rebuilds every value with the program's
 * own types. Two implementations, one file: neither can drift without a test failing.
 */
import { LAMPORT_VAULT_HEIR_PROGRAM_ID, LAMPORT_VAULT_HEIR_SHORT_CLOCKS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@lamport-robotics/vault";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  acceptanceMessage,
  activateInstruction,
  CLAIM_ERROR,
  CLAIM_IX,
  claimRole,
  claimSolInstruction,
  claimTokenInstruction,
  decodePlan,
  encodeTerms,
  hashedHeir,
  heirCommitment,
  type HeirRef,
  initPlanInstruction,
  PLAN_DISCRIMINATOR,
  planAddress,
  type Terms,
  termsHash,
} from "../src/claim.ts";
import { HEIR_CLAIM_PROGRAM_ID, HEIR_CLAIM_SHORT_CLOCKS_PROGRAM_ID } from "../src/programs.ts";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** A fixed, obviously artificial address: 32 copies of one byte. No key for it is known to anyone. */
const pk = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const DAY = 86_400n;

function heirJson(h: HeirRef) {
  return h.kind === "none" ? { kind: 0, value_hex: "00".repeat(32) } : h.kind === "address" ? { kind: 1, value_hex: hex(h.address.toBytes()) } : { kind: 2, value_hex: hex(h.commitment) };
}

function termsJson(name: string, t: Terms) {
  return {
    name,
    vault: t.vault.toBase58(),
    primary: heirJson(t.primary),
    contingent: heirJson(t.contingent),
    contingent_delay_secs: t.contingentDelaySecs.toString(),
    encoded_hex: hex(encodeTerms(t)),
    terms_hash_hex: hex(termsHash(t)),
    plan_address: planAddress(t, HEIR_CLAIM_PROGRAM_ID).toBase58(),
    plan_address_short_clocks: planAddress(t, HEIR_CLAIM_SHORT_CLOCKS_PROGRAM_ID).toBase58(),
  };
}

/** A `Plan` account's bytes, written out field by field (the library only ever reads one). */
export function encodePlanForTests(p: { bump: number; terms: Terms; createdTs: bigint; activated: boolean; activatedTs: bigint; closedSlot: bigint; contingentClockTs: bigint }): Uint8Array {
  const out = new Uint8Array(181);
  const view = new DataView(out.buffer);
  out.set(PLAN_DISCRIMINATOR, 0);
  out[8] = 1;
  out[9] = p.bump;
  out.set(termsHash(p.terms), 10);
  out.set(encodeTerms(p.terms), 42);
  view.setBigInt64(148, p.createdTs, true);
  out[156] = p.activated ? 1 : 0;
  view.setBigInt64(157, p.activatedTs, true);
  view.setBigUint64(165, p.closedSlot, true);
  view.setBigInt64(173, p.contingentClockTs, true);
  return out;
}

function ixJson(name: string, ix: TransactionInstruction) {
  return {
    name,
    program_id: ix.programId.toBase58(),
    data_hex: hex(ix.data),
    accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })),
  };
}

export function buildClaimKat() {
  const vault = pk(0x11);
  const primary = pk(0x22);
  const contingent = pk(0x33);
  const stranger = pk(0x44);
  const payer = pk(0x55);
  const saltA = new Uint8Array(32).fill(0xa1);
  const saltB = new Uint8Array(32).fill(0xb2);

  const sole: Terms = { vault, primary: { kind: "address", address: primary }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
  const both: Terms = { vault, primary: { kind: "address", address: primary }, contingent: { kind: "address", address: contingent }, contingentDelaySecs: 365n * DAY };
  const hashed: Terms = { vault, primary: hashedHeir(saltA, primary), contingent: hashedHeir(saltB, contingent), contingentDelaySecs: 30n * DAY };
  const mixed: Terms = { vault, primary: { kind: "address", address: primary }, contingent: hashedHeir(saltB, contingent), contingentDelaySecs: 36_500n * DAY };

  const T0 = 1_800_000_000n;
  const fresh = { bump: 254, terms: both, createdTs: T0, activated: false, activatedTs: 0n, closedSlot: 0n, contingentClockTs: 0n };
  const active = { bump: 253, terms: both, createdTs: T0, activated: true, activatedTs: T0 + 200n * DAY, closedSlot: 305_397_760n, contingentClockTs: T0 + 230n * DAY };
  const activeHashed = { bump: 255, terms: hashed, createdTs: T0, activated: true, activatedTs: T0 + 10n, closedSlot: 77n, contingentClockTs: T0 + 10n };
  const plans = { fresh, active, active_hashed: activeHashed };

  const opens = active.contingentClockTs + both.contingentDelaySecs;
  const roleCases: { name: string; plan: keyof typeof plans; signer: PublicKey; salt?: Uint8Array; now: bigint }[] = [
    { name: "nobody claims from a plan that is not activated", plan: "fresh", signer: primary, now: T0 + 1n },
    { name: "the primary heir, at once", plan: "active", signer: primary, now: active.activatedTs },
    { name: "the contingent heir one second early", plan: "active", signer: contingent, now: opens - 1n },
    { name: "the contingent heir on the second the delay ends", plan: "active", signer: contingent, now: opens },
    { name: "a stranger", plan: "active", signer: stranger, now: opens + DAY },
    { name: "a hashed primary heir with the salt", plan: "active_hashed", signer: primary, salt: saltA, now: T0 + 11n },
    { name: "a hashed primary heir without the salt", plan: "active_hashed", signer: primary, now: T0 + 11n },
    { name: "a hashed primary heir with the other heir's salt", plan: "active_hashed", signer: primary, salt: saltB, now: T0 + 11n },
    { name: "a hashed contingent heir, too early", plan: "active_hashed", signer: contingent, salt: saltB, now: T0 + 10n + 30n * DAY - 1n },
    { name: "a hashed contingent heir, in time", plan: "active_hashed", signer: contingent, salt: saltB, now: T0 + 10n + 30n * DAY },
  ];

  const planOfBoth = planAddress(both);
  const mint = pk(0x66);
  const source = pk(0x77);
  const destination = pk(0x78);
  const extra = pk(0x79);

  return {
    source: "lamport-heir, tools/scripts/claim-kat.ts",
    note: "Byte layouts of programs/heir-claim. The program ids are placeholders with no private key until a deployment exists. Addresses made of one repeated byte are artificial.",
    program_ids: {
      heir_claim: HEIR_CLAIM_PROGRAM_ID.toBase58(),
      heir_claim_short_clocks: HEIR_CLAIM_SHORT_CLOCKS_PROGRAM_ID.toBase58(),
      vault: LAMPORT_VAULT_HEIR_PROGRAM_ID.toBase58(),
      vault_short_clocks: LAMPORT_VAULT_HEIR_SHORT_CLOCKS_PROGRAM_ID.toBase58(),
    },
    discriminators: {
      init_plan: hex(CLAIM_IX.initPlan),
      activate: hex(CLAIM_IX.activate),
      claim_sol: hex(CLAIM_IX.claimSol),
      claim_token: hex(CLAIM_IX.claimToken),
      plan_account: hex(PLAN_DISCRIMINATOR),
    },
    errors: CLAIM_ERROR,
    terms: [termsJson("a sole heir", sole), termsJson("a primary and a contingent heir", both), termsJson("two hashed heirs", hashed), termsJson("a named primary and a hashed contingent heir, the longest delay", mixed)],
    heir_commitments: [
      { salt_hex: hex(saltA), address: primary.toBase58(), commitment_hex: hex(heirCommitment(saltA, primary)) },
      { salt_hex: hex(saltB), address: contingent.toBase58(), commitment_hex: hex(heirCommitment(saltB, contingent)) },
      { salt_hex: "00".repeat(32), address: primary.toBase58(), commitment_hex: hex(heirCommitment(new Uint8Array(32), primary)) },
    ],
    acceptance_message: { plan: planOfBoth.toBase58(), text: acceptanceMessage(planOfBoth) },
    plan_accounts: Object.entries(plans).map(([name, p]) => ({
      name,
      hex: hex(encodePlanForTests(p)),
      bump: p.bump,
      terms: p.terms === both ? "a primary and a contingent heir" : "two hashed heirs",
      created_ts: p.createdTs.toString(),
      activated: p.activated,
      activated_ts: p.activatedTs.toString(),
      closed_slot: p.closedSlot.toString(),
      contingent_clock_ts: p.contingentClockTs.toString(),
    })),
    claim_role: roleCases.map((c) => {
      const r = claimRole(decodePlan(encodePlanForTests(plans[c.plan])), c.signer, c.salt, c.now);
      return { name: c.name, plan: c.plan, signer: c.signer.toBase58(), salt_hex: c.salt ? hex(c.salt) : null, now: c.now.toString(), result: r.ok ? r.role : r.reason };
    }),
    instructions: [
      ixJson("init_plan, the payer is the primary heir", initPlanInstruction({ payer: primary, terms: sole }).instruction),
      ixJson("init_plan, both heirs sign beside the payer", initPlanInstruction({ payer, terms: both, signingHeirs: [primary, contingent] }).instruction),
      ixJson("activate", activateInstruction({ plan: planOfBoth, vault })),
      ixJson("claim_sol, no salt", claimSolInstruction({ plan: planOfBoth, heir: primary })),
      ixJson("claim_sol, with a salt", claimSolInstruction({ plan: planAddress(hashed), heir: primary, salt: saltA })),
      ixJson("claim_token, close the account", claimTokenInstruction({ plan: planOfBoth, heir: primary, planTokenAccount: source, destination, mint, tokenProgram: TOKEN_PROGRAM_ID, closeAccount: true })),
      ixJson(
        "claim_token, Token-2022, with a salt, keep the account, one extra account",
        claimTokenInstruction({ plan: planAddress(hashed), heir: contingent, planTokenAccount: source, destination, mint, tokenProgram: TOKEN_2022_PROGRAM_ID, salt: saltB, closeAccount: false, extraAccounts: [{ pubkey: extra, isSigner: false, isWritable: false }] }),
      ),
    ],
  };
}
