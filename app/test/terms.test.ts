import { Keypair, PublicKey } from "@solana/web3.js";
import { LAMPORT_VAULT_HEIR_PROGRAM_ID, LAMPORT_VAULT_PROGRAM_ID } from "@lamport-robotics/vault";
import { describe, expect, it } from "vitest";
import { hashedHeir, planAddress, type Terms } from "../../tools/src/claim.ts";
import { HEIR_CLAIM_PROGRAM_ID } from "../../tools/src/programs.ts";
import { buildPrograms, explainClaim, termsFromJson, termsToJson } from "../src/terms.ts";

const DAY = 86_400n;
const vault = Keypair.generate().publicKey, first = Keypair.generate().publicKey, second = Keypair.generate().publicKey;
const terms = (over: Partial<Terms> = {}): Terms => ({ vault, primary: { kind: "address", address: first }, contingent: { kind: "address", address: second }, contingentDelaySecs: 365n * DAY, ...over });
const request = (t: Terms, over: Record<string, unknown> = {}) => ({ claim: planAddress(t, HEIR_CLAIM_PROGRAM_ID).toBase58(), terms: termsToJson(t) as unknown, ...over });

describe("the build this runs as", () => {
  it("is the Heir build: the SDK names the Heir-enabled program, and the claim program is its pair", () => {
    expect(LAMPORT_VAULT_PROGRAM_ID.equals(LAMPORT_VAULT_HEIR_PROGRAM_ID)).toBe(true);
    expect(buildPrograms().claim.equals(HEIR_CLAIM_PROGRAM_ID)).toBe(true);
    expect(buildPrograms().daySecs).toBe(DAY);
  });
});

describe("terms in a request", () => {
  it("survive the trip through JSON unchanged, whatever kind of heir", () => {
    const salt = new Uint8Array(32).fill(7);
    for (const t of [terms(), terms({ contingent: { kind: "none" }, contingentDelaySecs: 0n }), terms({ primary: hashedHeir(salt, first) }), terms({ contingent: hashedHeir(salt, second) })]) {
      const back = termsFromJson(JSON.parse(JSON.stringify(termsToJson(t))));
      expect(planAddress(back).equals(planAddress(t))).toBe(true);
    }
  });

  it("are read strictly: what is not understood is not accepted", () => {
    const good = termsToJson(terms());
    const bad = (x: unknown, why: RegExp) => expect(() => termsFromJson(x)).toThrow(why);
    expect(() => termsFromJson(good)).not.toThrow();
    bad(null, /not an object/);
    bad([good], /not an object/);
    bad({ ...good, v: 2 }, /version/);
    bad({ ...good, note: "also pay 9xQe…" }, /does not know: note/);
    bad({ ...good, vault: 5 }, /vault is not an address/);
    bad({ ...good, vault: ` ${good.vault}` }, /vault is not an address/);
    bad({ ...good, primary: null }, /first heir is missing/);
    bad({ ...good, primary: { address: first.toBase58(), hashed: "00".repeat(32) } }, /one of the two/);
    bad({ ...good, primary: { address: first.toBase58(), share: "50%" } }, /does not know: share/);
    bad({ ...good, primary: { hashed: "AB".repeat(32) } }, /lowercase hex/);
    bad({ ...good, primary: { hashed: "ab".repeat(31) } }, /lowercase hex/);
    bad({ ...good, contingent: undefined }, /second heir is missing/);
    bad({ ...good, contingentDelaySecs: 31536000 }, /whole number of seconds/);
    bad({ ...good, contingentDelaySecs: "1e7" }, /whole number of seconds/);
    bad({ ...good, contingentDelaySecs: "007" }, /whole number of seconds/);
    bad({ ...good, contingentDelaySecs: "18446744073709551616" }, /whole number of seconds/);
  });
});

describe("who is behind a claim address", () => {
  it("says nothing more than the vault's build when the request carries no terms", () => {
    expect(explainClaim({ claim: first.toBase58() }, vault.toBase58())).toBeNull();
  });

  it("names the heirs when the terms give exactly the claim address", () => {
    const x = explainClaim(request(terms()), vault.toBase58())!;
    expect(x.problem).toBeUndefined();
    const rows = new Map(x.rows);
    expect(rows.get("who that is")).toMatch(/derived here/);
    expect(rows.get("first heir")).toContain(first.toBase58());
    expect(rows.get("second heir")).toContain(second.toBase58());
    expect(rows.get("second heir")).toMatch(/from 365 days after the release/);
    const alone = new Map(explainClaim(request(terms({ contingent: { kind: "none" }, contingentDelaySecs: 0n })), vault.toBase58())!.rows);
    expect(alone.get("second heir")).toMatch(/^none/);
  });

  it("says a private heir is private, and shows no address for them", () => {
    const t = terms({ primary: hashedHeir(new Uint8Array(32).fill(9), first) });
    const rows = new Map(explainClaim(request(t), vault.toBase58())!.rows);
    expect(rows.get("first heir")).toMatch(/^private/);
    expect(rows.get("first heir")).not.toContain(first.toBase58());
  });

  it("refuses a claim address the named heirs do not give", () => {
    // the attack this exists for: the heirs shown are the owner's, the address is someone else's plan
    const theirs = planAddress(terms({ primary: { kind: "address", address: Keypair.generate().publicKey } }), HEIR_CLAIM_PROGRAM_ID).toBase58();
    expect(explainClaim(request(terms(), { claim: theirs }), vault.toBase58())!.problem).toMatch(/give the plan address .* but the request releases to/);
    expect(explainClaim(request(terms(), { claim: Keypair.generate().publicKey.toBase58() }), vault.toBase58())!.problem).toMatch(/but the request releases to/);
    // one heir swapped, the delay changed by a second, the heirs in the other order: each is another plan
    const claim = request(terms()).claim;
    for (const other of [terms({ contingent: { kind: "address", address: Keypair.generate().publicKey } }), terms({ contingentDelaySecs: 365n * DAY + 1n }), terms({ primary: { kind: "address", address: second }, contingent: { kind: "address", address: first } })]) {
      expect(explainClaim({ claim, terms: termsToJson(other) }, vault.toBase58())!.problem).toBeDefined();
    }
  });

  it("refuses a plan made for another vault", () => {
    const other = Keypair.generate().publicKey;
    expect(explainClaim(request(terms()), other.toBase58())!.problem).toMatch(/made for another vault/);
  });

  it("refuses terms the claim program would refuse, and terms it cannot read", () => {
    const twice = terms({ contingent: { kind: "address", address: first } });
    expect(explainClaim({ claim: planAddress(twice).toBase58(), terms: termsToJson(twice) }, vault.toBase58())!.problem).toMatch(/SameHeirTwice/);
    const soon = terms({ contingentDelaySecs: 29n * DAY });
    expect(explainClaim({ claim: planAddress(soon).toBase58(), terms: termsToJson(soon) }, vault.toBase58())!.problem).toMatch(/InvalidContingentDelay/);
    expect(explainClaim({ claim: first.toBase58(), terms: "heirs: everyone" }, vault.toBase58())!.problem).toMatch(/cannot be used/);
    expect(explainClaim({ claim: first.toBase58(), terms: null }, vault.toBase58())!.problem).toMatch(/cannot be used/);
    expect(explainClaim({ claim: PublicKey.default.toBase58(), terms: {} }, vault.toBase58())!.problem).toMatch(/cannot be used/);
  });
});
