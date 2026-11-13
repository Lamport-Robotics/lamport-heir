import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { buildClaimKat, encodePlanForTests } from "../scripts/claim-kat.ts";
import {
  acceptanceMessage,
  acceptanceProofInstruction,
  checkTerms,
  claimRole,
  claimSolInstruction,
  claimTokenInstruction,
  contingentDelayLimits,
  contingentOpensAt,
  decodePlan,
  decodeTerms,
  encodeTerms,
  hashedHeir,
  heirCommitment,
  heirMatches,
  isPlan,
  PLAN_ACCOUNT_SIZE,
  planAddress,
  type Terms,
  TERMS_SIZE,
  termsHash,
} from "../src/claim.ts";
import { HEIR_CLAIM_PROGRAM_ID, HEIR_CLAIM_SHORT_CLOCKS_PROGRAM_ID, PROGRAMS, programsForClaimProgram, programsForVaultProgram, SHORT_CLOCKS_PROGRAMS } from "../src/programs.ts";

const DAY = 86_400n;
const pk = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const vault = pk(0x11);
const primary = pk(0x22);
const contingent = pk(0x33);
const salt = new Uint8Array(32).fill(7);
const both: Terms = { vault, primary: { kind: "address", address: primary }, contingent: { kind: "address", address: contingent }, contingentDelaySecs: 365n * DAY };
const sole: Terms = { vault, primary: { kind: "address", address: primary }, contingent: { kind: "none" }, contingentDelaySecs: 0n };

describe("the shared vectors", () => {
  it("kat/claim_encoding.json is what this code produces", () => {
    // The Rust crate checks the same file against the program's own types (programs/heir-claim/tests/encoding.rs).
    const onDisk = JSON.parse(readFileSync(fileURLToPath(new URL("../../kat/claim_encoding.json", import.meta.url)), "utf8"));
    expect(JSON.parse(JSON.stringify(buildClaimKat())), "run `npm run kat` and commit the result").toEqual(onDisk);
  });
});

describe("terms", () => {
  it("encode to 106 bytes and decode back", () => {
    for (const t of [sole, both, { ...both, primary: hashedHeir(salt, primary) }, { ...both, contingent: hashedHeir(salt, contingent), contingentDelaySecs: 30n * DAY }]) {
      const bytes = encodeTerms(t);
      expect(bytes.length).toBe(TERMS_SIZE);
      expect(encodeTerms(decodeTerms(bytes))).toEqual(bytes);
    }
    expect(() => decodeTerms(new Uint8Array(105))).toThrow(/106 bytes/);
    const badKind = encodeTerms(both);
    badKind[32] = 3;
    expect(() => decodeTerms(badKind)).toThrow(/unknown heir kind/);
  });

  it("any change to the terms is another plan, and another program is another address", () => {
    const base = planAddress(both);
    const changed: Terms[] = [
      { ...both, vault: pk(0x12) },
      { ...both, primary: { kind: "address", address: pk(0x23) } },
      { ...both, contingent: { kind: "address", address: pk(0x34) } },
      { ...both, contingentDelaySecs: both.contingentDelaySecs + 1n },
      { ...both, primary: hashedHeir(salt, primary) },
      sole,
    ];
    const seen = new Set([base.toBase58()]);
    for (const t of changed) seen.add(planAddress(t).toBase58());
    expect(seen.size).toBe(changed.length + 1);
    expect(planAddress(both, HEIR_CLAIM_SHORT_CLOCKS_PROGRAM_ID).equals(base)).toBe(false);
    expect(planAddress(both, HEIR_CLAIM_PROGRAM_ID).equals(base)).toBe(true);
    expect(termsHash(both).length).toBe(32);
  });

  it("checkTerms refuses what the program refuses, naming its error", () => {
    expect(() => checkTerms(sole)).not.toThrow();
    expect(() => checkTerms(both)).not.toThrow();
    expect(() => checkTerms({ ...both, contingentDelaySecs: 30n * DAY })).not.toThrow();
    expect(() => checkTerms({ ...both, contingentDelaySecs: 36_500n * DAY })).not.toThrow();
    expect(() => checkTerms({ ...both, primary: hashedHeir(salt, primary), contingent: hashedHeir(salt, contingent) })).not.toThrow();

    expect(() => checkTerms({ ...both, vault: PublicKey.default })).toThrow(/InvalidTerms/);
    expect(() => checkTerms({ ...both, primary: { kind: "none" } })).toThrow(/InvalidTerms/);
    expect(() => checkTerms({ ...both, primary: { kind: "address", address: PublicKey.default } })).toThrow(/InvalidTerms/);
    expect(() => checkTerms({ ...both, contingent: { kind: "address", address: PublicKey.default } })).toThrow(/InvalidTerms/);
    expect(() => checkTerms({ ...sole, contingentDelaySecs: 1n })).toThrow(/InvalidContingentDelay/);
    expect(() => checkTerms({ ...both, contingentDelaySecs: 30n * DAY - 1n })).toThrow(/InvalidContingentDelay/);
    expect(() => checkTerms({ ...both, contingentDelaySecs: 36_500n * DAY + 1n })).toThrow(/InvalidContingentDelay/);
    expect(() => checkTerms({ ...both, contingent: both.primary })).toThrow(/SameHeirTwice/);
    const h = hashedHeir(salt, primary);
    expect(() => checkTerms({ ...both, primary: h, contingent: h })).toThrow(/SameHeirTwice/);
  });

  it("the short-clocks pair has its own limits", () => {
    expect(contingentDelayLimits(PROGRAMS)).toEqual({ min: 30n * DAY, max: 36_500n * DAY });
    expect(contingentDelayLimits(SHORT_CLOCKS_PROGRAMS)).toEqual({ min: 30n, max: 36_500n });
    expect(() => checkTerms({ ...both, contingentDelaySecs: 30n }, SHORT_CLOCKS_PROGRAMS)).not.toThrow();
    expect(() => checkTerms({ ...both, contingentDelaySecs: 30n }, PROGRAMS)).toThrow(/InvalidContingentDelay/);
  });

  it("a program is known by the pair it belongs to", () => {
    expect(programsForVaultProgram(PROGRAMS.vault)).toBe(PROGRAMS);
    expect(programsForVaultProgram(SHORT_CLOCKS_PROGRAMS.vault)).toBe(SHORT_CLOCKS_PROGRAMS);
    expect(programsForClaimProgram(SHORT_CLOCKS_PROGRAMS.claim)).toBe(SHORT_CLOCKS_PROGRAMS);
    expect(programsForVaultProgram(PROGRAMS.claim)).toBeUndefined();
    expect(programsForClaimProgram(pk(9))).toBeUndefined();
    // the plain vault program is not a Heir program
    expect(programsForVaultProgram(new PublicKey("B7dNdVV8shrKgqx7A5JvBQBp7vsTyQTLrdAdeiLKwXqH"))).toBeUndefined();
  });
});

describe("heirs", () => {
  it("a named heir is matched by address, a hashed heir only with its salt", () => {
    expect(heirMatches({ kind: "address", address: primary }, primary)).toBe(true);
    expect(heirMatches({ kind: "address", address: primary }, contingent)).toBe(false);
    expect(heirMatches({ kind: "none" }, primary)).toBe(false);
    const h = hashedHeir(salt, primary);
    expect(heirMatches(h, primary, salt)).toBe(true);
    expect(heirMatches(h, primary)).toBe(false);
    expect(heirMatches(h, primary, new Uint8Array(32).fill(8))).toBe(false);
    expect(heirMatches(h, contingent, salt)).toBe(false);
    expect(heirMatches(h, primary, salt.subarray(0, 31))).toBe(false);
    expect(() => heirCommitment(new Uint8Array(31), primary)).toThrow(RangeError);
  });

  it("the acceptance message names the plan, and its proof is an Ed25519 instruction about itself", () => {
    const plan = planAddress(both);
    expect(acceptanceMessage(plan)).toBe(`Lamport Heir: I control this address and accept being named an heir in plan ${plan.toBase58()}.`);
    const heir = Keypair.generate(); // a throwaway key for this test
    const message = new TextEncoder().encode(acceptanceMessage(plan));
    const ix = acceptanceProofInstruction(heir.publicKey, new Uint8Array(64).fill(1), message);
    expect(ix.programId.toBase58()).toBe("Ed25519SigVerify111111111111111111111111111");
    expect(ix.keys).toEqual([]);
    // one signature, and all three instruction indexes say "this instruction" (0xffff): the form init_plan accepts
    expect(ix.data[0]).toBe(1);
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    expect([view.getUint16(4, true), view.getUint16(8, true), view.getUint16(14, true)]).toEqual([0xffff, 0xffff, 0xffff]);
    expect(Buffer.from(ix.data.subarray(view.getUint16(6, true), view.getUint16(6, true) + 32)).equals(heir.publicKey.toBuffer())).toBe(true);
    expect(Buffer.from(ix.data.subarray(view.getUint16(10, true))).equals(Buffer.from(message))).toBe(true);
  });
});

describe("the plan account", () => {
  const T0 = 1_800_000_000n;
  const fresh = { bump: 254, terms: both, createdTs: T0, activated: false, activatedTs: 0n, closedSlot: 0n, contingentClockTs: 0n };
  const active = { ...fresh, activated: true, activatedTs: T0 + 5n, closedSlot: 99n, contingentClockTs: T0 + 5n };

  it("decodes, and refuses what is not a plan", () => {
    const bytes = encodePlanForTests(active);
    expect(bytes.length).toBe(PLAN_ACCOUNT_SIZE);
    const p = decodePlan(bytes);
    expect(p).toMatchObject({ version: 1, bump: 254, createdTs: T0, activated: true, activatedTs: T0 + 5n, closedSlot: 99n, contingentClockTs: T0 + 5n });
    expect(encodeTerms(p.terms)).toEqual(encodeTerms(both));
    expect(p.termsHash).toEqual(termsHash(both));

    expect(isPlan(bytes.subarray(0, 180))).toBe(false);
    const otherAccount = Uint8Array.from(bytes);
    otherAccount[0] = otherAccount[0]! ^ 1;
    expect(isPlan(otherAccount)).toBe(false);
    expect(() => decodePlan(otherAccount)).toThrow(/not a Plan/);
    const v2 = Uint8Array.from(bytes);
    v2[8] = 2;
    expect(() => decodePlan(v2)).toThrow(/version 2/);
    const badBool = Uint8Array.from(bytes);
    badBool[156] = 2;
    expect(() => decodePlan(badBool)).toThrow(/bool/);
  });

  it("the primary may always claim; the contingent heir waits out a clock the primary restarts", () => {
    const stranger = pk(0x44);
    expect(claimRole(decodePlan(encodePlanForTests(fresh)), primary, undefined, T0)).toEqual({ ok: false, reason: "NotActivated" });
    const p = decodePlan(encodePlanForTests(active));
    const opens = T0 + 5n + 365n * DAY;
    expect(contingentOpensAt(p)).toBe(opens);
    expect(claimRole(p, primary, undefined, T0 + 5n)).toEqual({ ok: true, role: "primary" });
    expect(claimRole(p, primary, undefined, opens + DAY)).toEqual({ ok: true, role: "primary" });
    expect(claimRole(p, contingent, undefined, opens - 1n)).toEqual({ ok: false, reason: "ContingentTooEarly", opensAt: opens });
    expect(claimRole(p, contingent, undefined, opens)).toEqual({ ok: true, role: "contingent" });
    expect(claimRole(p, stranger, undefined, opens)).toEqual({ ok: false, reason: "NotAnHeir" });
    // a claim by the primary moved the clock: the contingent heir waits again from there
    const later = decodePlan(encodePlanForTests({ ...active, contingentClockTs: T0 + 300n * DAY }));
    expect(claimRole(later, contingent, undefined, opens)).toMatchObject({ ok: false, reason: "ContingentTooEarly", opensAt: T0 + 665n * DAY });
    // no contingent heir: nobody but the primary, ever
    const alone = decodePlan(encodePlanForTests({ ...active, terms: sole }));
    expect(contingentOpensAt(alone)).toBeUndefined();
    expect(claimRole(alone, contingent, undefined, opens * 2n)).toEqual({ ok: false, reason: "NotAnHeir" });
  });
});

describe("instructions", () => {
  it("only the heir signs a claim, and a salt must be 32 bytes", () => {
    const plan = planAddress(both);
    const sol = claimSolInstruction({ plan, heir: primary });
    expect(sol.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [false, true],
      [true, true],
    ]);
    expect(sol.data.length).toBe(9);
    expect(claimSolInstruction({ plan, heir: primary, salt }).data.length).toBe(8 + 33);
    expect(() => claimSolInstruction({ plan, heir: primary, salt: new Uint8Array(31) })).toThrow(RangeError);
    const token = claimTokenInstruction({ plan, heir: primary, planTokenAccount: pk(1), destination: pk(2), mint: pk(3), tokenProgram: pk(4), closeAccount: false });
    expect(token.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([primary.toBase58()]);
    expect(token.data[token.data.length - 1]).toBe(0);
  });
});
