/**
 * The vault's own code for a `SetSuccession` request (vendor/lamport-vault/web/src/heir-plan.ts),
 * with this repository's module in its seam, the way the shipped signer is built. The other tests
 * take terms.ts on its own; this one asks the question an owner's safety hangs on of the code the
 * signer actually runs: is a request refused when the heirs it shows are not the heirs it pays?
 */
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { planAddress, type Terms } from "../../tools/src/claim.ts";
import { HEIR_CLAIM_PROGRAM_ID } from "../../tools/src/programs.ts";
import { NO_ADDRESS, planLines, planProblem, type PlanRequest } from "../../vendor/lamport-vault/web/src/heir-plan.ts";
import { termsToJson } from "../src/terms.ts";

const DAY = 86_400n;
const vault = Keypair.generate().publicKey, first = Keypair.generate().publicKey, second = Keypair.generate().publicKey, thief = Keypair.generate().publicKey;
const terms = (primary = first): Terms => ({ vault, primary: { kind: "address", address: primary }, contingent: { kind: "address", address: second }, contingentDelaySecs: 365n * DAY });
const request = (claim: string, t?: Terms): PlanRequest => ({ kind: "SetSuccession", claim, windowSecs: String(365n * DAY), waitSecs: String(60n * DAY), checkinKey: NO_ADDRESS, contactKey: NO_ADDRESS, ...(t ? { terms: termsToJson(t) } : {}) });
const address = (t: Terms) => planAddress(t, HEIR_CLAIM_PROGRAM_ID).toBase58();

describe("the signer's request code, with Heir's module in the seam", () => {
  it("names the heirs of a request whose heirs give its claim address", () => {
    const good = request(address(terms()), terms());
    expect(planProblem(good, vault.toBase58())).toBeNull();
    const lines = new Map(planLines(good, vault.toBase58()));
    expect(lines.get("releases to")).toBe(address(terms()));
    expect(lines.get("who that is")).toMatch(/a Lamport Heir plan/);
    expect(lines.get("first heir")).toContain(first.toBase58());
    expect(lines.get("second heir")).toContain(second.toBase58());
    expect(lines.get("soonest release")).toBe("425 days after your last signature");
  });

  it("refuses a request that shows the owner's heirs and pays somebody else's plan, and describes nothing", () => {
    // the claim address is the thief's plan; the terms shown are the owner's
    const forged = request(address(terms(thief)), terms());
    expect(planProblem(forged, vault.toBase58())).toMatch(/give the plan address .* but the request releases to/);
    expect(() => planLines(forged, vault.toBase58())).toThrow(/give the plan address/);
    // and the other way round: the owner's plan address, with terms that would show the thief
    expect(planProblem(request(address(terms()), terms(thief)), vault.toBase58())).toMatch(/give the plan address/);
  });

  it("refuses a plan made for another vault, and terms it cannot read", () => {
    const other = Keypair.generate().publicKey;
    expect(planProblem(request(address(terms()), terms()), other.toBase58())).toMatch(/made for another vault/);
    expect(planProblem({ ...request(address(terms())), terms: { heirs: "everyone" } } as PlanRequest, vault.toBase58())).toMatch(/cannot be used/);
  });

  it("says it only sees an address when the request carries no terms", () => {
    const plain = request(first.toBase58());
    expect(planProblem(plain, vault.toBase58())).toBeNull();
    expect(new Map(planLines(plain, vault.toBase58())).get("who that is")).toMatch(/only sees an address/);
  });
});
