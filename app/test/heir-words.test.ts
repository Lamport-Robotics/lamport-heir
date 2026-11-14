import { Keypair, PublicKey } from "@solana/web3.js";
import { successionStatus, type SuccessionState } from "@lamport-robotics/vault";
import { describe, expect, it } from "vitest";
import type { PlanAccount, Terms } from "../../tools/src/claim.ts";
import { PROGRAMS } from "../../tools/src/programs.ts";
import type { Situation } from "../../tools/src/release.ts";
import { contactWords, placeInTerms, situationWords, stepWords, verdictWords, when } from "../src/heir-words.ts";

const DAY = 86_400n, T0 = 1_800_000_000n;
const vault = Keypair.generate().publicKey, first = Keypair.generate().publicKey, second = Keypair.generate().publicKey, stranger = Keypair.generate().publicKey;
const planAt = Keypair.generate().publicKey;
const terms: Terms = { vault, primary: { kind: "address", address: first }, contingent: { kind: "address", address: second }, contingentDelaySecs: 365n * DAY };
const state = (over: Partial<SuccessionState> = {}): SuccessionState => ({ claim: planAt, windowSecs: 365n * DAY, waitSecs: 60n * DAY, lastSignedTs: T0, lastCheckinTs: 0n, checkinKey: PublicKey.default, contactKey: PublicKey.default, contactUsed: false, extendedUntilTs: 0n, waitOpen: false, waitStartedTs: 0n, ...over } as SuccessionState);
const account = (over: Partial<PlanAccount> = {}): PlanAccount => ({ version: 1, bump: 255, termsHash: new Uint8Array(32), terms, createdTs: T0, activated: false, activatedTs: 0n, closedSlot: 0n, contingentClockTs: 0n, ...over });
const open = (s: SuccessionState, now: bigint, over: Partial<Situation> = {}): Situation => ({ programs: PROGRAMS, vault, state: "open", now, succession: s, status: successionStatus(s, now), claim: s.claim, plan: { address: planAt, account: account(), lamports: 2_000_000 }, vaultLamports: 5_000_000_000, ...over });
const released = (now: bigint, a: Partial<PlanAccount> = {}, over: Partial<Situation> = {}): Situation => ({ programs: PROGRAMS, vault, state: "released", now, closedSlot: 123n, claim: planAt, plan: { address: planAt, account: account(a), lamports: 5_000_000_000 }, vaultLamports: 0, ...over });

describe("where a vault stands, in words", () => {
  it("offers nothing while the owner is within their time", () => {
    const w = situationWords(open(state(), T0 + 10n * DAY), first);
    expect(w.next).toBe("nothing");
    expect(w.headline).toMatch(/within their time/);
    expect(w.lines.join(" ")).toMatch(/You are the first heir/);
  });

  it("offers the waiting period once the deadline has passed, and says what opening it means", () => {
    const w = situationWords(open(state(), T0 + 366n * DAY), second);
    expect(w.next).toBe("start");
    expect(w.lines.join(" ")).toMatch(/You are the second heir/);
    expect(w.lines.join(" ")).toMatch(/lasts 60 days/);
    expect(w.lines.join(" ")).toMatch(/any signature or check-in from the owner cancels it/);
  });

  it("offers nothing during the waiting period", () => {
    const s = state({ waitOpen: true, waitStartedTs: T0 + 366n * DAY });
    expect(situationWords(open(s, T0 + 380n * DAY), first).next).toBe("nothing");
  });

  it("offers the release once the waiting period is over, to anyone", () => {
    const s = state({ waitOpen: true, waitStartedTs: T0 + 366n * DAY });
    expect(situationWords(open(s, T0 + 430n * DAY), first).next).toBe("release");
    expect(situationWords(open(s, T0 + 430n * DAY), stranger).next).toBe("release");
    expect(situationWords(open(s, T0 + 430n * DAY)).next).toBe("release");
  });

  it("offers collecting after the release to the named, and tells a stranger they are not named", () => {
    const now = T0 + 500n * DAY;
    const done = { activated: true, activatedTs: now - DAY, contingentClockTs: now - DAY };
    expect(situationWords(released(now, done), first).next).toBe("collect");
    const stranger_ = situationWords(released(now, done), stranger);
    expect(stranger_.next).toBe("nothing");
    expect(stranger_.lines.join(" ")).toMatch(/not named by this vault/);
    const waiting = situationWords(released(now, done), second);
    expect(waiting.lines.join(" ")).toMatch(/As the second heir you may claim from/);
  });

  it("warns about an arrangement that cannot pay out, and then offers no release", () => {
    const s = state({ waitOpen: true, waitStartedTs: T0 + 366n * DAY });
    const wrong = situationWords(open(s, T0 + 430n * DAY, { planNamesAnotherVault: true }), first);
    expect(wrong.warning).toMatch(/made for a different vault/);
    expect(wrong.next).toBe("nothing");
    const { plan: _plan, ...noPlan } = open(s, T0 + 430n * DAY, { claimHasNoKeyAndNoAccount: true });
    expect(situationWords(noPlan as Situation, first).warning).toMatch(/no key exists for it/);
  });

  it("says a vault with no plan has none", () => {
    const s = state({ claim: PublicKey.default, windowSecs: 0n, waitSecs: 0n });
    const { plan: _plan, claim: _claim, ...bare } = open(s, T0);
    expect(situationWords(bare as Situation).headline).toMatch(/no inheritance plan/);
  });

  it("knows a vault that releases straight to an address", () => {
    const s = state({ claim: first, waitOpen: true, waitStartedTs: T0 + 366n * DAY });
    const { plan: _plan, ...direct } = open(s, T0 + 430n * DAY);
    expect(situationWords(direct as Situation, first).lines.join(" ")).toMatch(/straight to your wallet/);
    expect(situationWords(direct as Situation, stranger).lines.join(" ")).toMatch(/not named/);
  });
});

describe("the trusted contact", () => {
  const contact = Keypair.generate().publicKey;
  it("is offered their one extension, and told what it does and does not do", () => {
    const c = contactWords(open(state({ contactKey: contact }), T0 + 10n * DAY), contact, 90n)!;
    expect(c.canExtend).toBe(true);
    expect(c.text).toMatch(/push their deadline back by 90 days/);
    expect(c.text).toMatch(/moves nothing, it gives you nothing/);
    // also while a waiting period is open: that is when it matters
    expect(contactWords(open(state({ contactKey: contact, waitOpen: true, waitStartedTs: T0 + 366n * DAY }), T0 + 370n * DAY), contact, 90n)!.canExtend).toBe(true);
  });

  it("is told when the extension is spent, and nobody else is offered anything", () => {
    const used = contactWords(open(state({ contactKey: contact, contactUsed: true }), T0 + 10n * DAY), contact, 90n)!;
    expect(used.canExtend).toBe(false);
    expect(used.text).toMatch(/used your extension/);
    expect(contactWords(open(state({ contactKey: contact }), T0), first, 90n)).toBeNull();
    expect(contactWords(open(state({ contactKey: contact }), T0), undefined, 90n)).toBeNull();
    expect(contactWords(open(state(), T0), PublicKey.default, 90n)).toBeNull(); // no contact named: the default address is nobody
    expect(contactWords(released(T0 + 500n * DAY), contact, 90n)).toBeNull();
  });
});

describe("an heir's place, before the plan exists", () => {
  it("tells each heir which they are, and anyone else that they are not named", () => {
    expect(placeInTerms(terms, first, DAY)).toMatchObject({ named: true });
    expect(placeInTerms(terms, second, DAY).text).toMatch(/second heir.*from 365 days after/);
    expect(placeInTerms(terms, stranger, DAY)).toMatchObject({ named: false });
  });
});

describe("what came of it", () => {
  it("has a sentence for every verdict", () => {
    const now = T0;
    expect(verdictWords({ kind: "claimed", role: "primary" }, now)).toMatch(/first heir/);
    expect(verdictWords({ kind: "claimed", role: "contingent" }, now)).toMatch(/second heir/);
    expect(verdictWords({ kind: "not_released", phase: "quiet", earliestRelease: now + 10n * DAY }, now)).toMatch(/in 10 days/);
    expect(verdictWords({ kind: "released_to_address", address: first, yours: true }, now)).toMatch(/delivered to you/);
    expect(verdictWords({ kind: "released_to_address", address: first, yours: false }, now)).toContain(first.toBase58());
    expect(verdictWords({ kind: "plan_not_created", address: planAt }, now)).toMatch(/can still be created/);
    expect(verdictWords({ kind: "plan_for_another_vault", plan: planAt }, now)).toMatch(/another vault/);
    expect(verdictWords({ kind: "not_activated" }, now)).toMatch(/Try again/);
    expect(verdictWords({ kind: "not_an_heir", hashedHeirs: false, saltGiven: false }, now)).toMatch(/not an heir/);
    expect(verdictWords({ kind: "not_an_heir", hashedHeirs: true, saltGiven: false }, now)).toMatch(/command-line tool/);
    expect(verdictWords({ kind: "contingent_too_early", opensAt: now + 3n * DAY }, now)).toMatch(/in 3 days/);
  });

  it("says of each step whether it was done, left or not needed, and never calls a refusal done", () => {
    expect(stepWords({ kind: "claim_sol", signature: "5sig" })).toMatchObject({ outcome: "done", detail: "5sig" });
    const left = stepWords({ kind: "claim_token", mint: first, failed: "this token is non-transferable" });
    expect(left.outcome).toBe("left");
    expect(left.detail).toMatch(/not moved: this token is non-transferable/);
    expect(stepWords({ kind: "sweep_sol", skipped: "nothing arrived" })).toMatchObject({ outcome: "skipped" });
  });

  it("gives a moment with how far off it is", () => {
    expect(when(T0 + 3n * DAY, T0)).toMatch(/\(in 3 days\)$/);
    expect(when(T0 - 7_200n, T0)).toMatch(/\(2 hours ago\)$/);
  });
});
