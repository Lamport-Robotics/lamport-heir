import { TOKEN_PROGRAM_ID } from "@lamport-robotics/vault";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { type ArmBody, RobotDaemon } from "../src/pincer/daemon.ts";
import { arm, armBody, type ArmRecord, drift, type RobotPlan } from "../src/pincer/link.ts";
import { type Message } from "../src/reminders/messages.ts";
import { type Channel, MemoryStore, ReminderService } from "../src/reminders/service.ts";
import { FakeChain } from "./fake-chain.ts";

const pk = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
// ordinary addresses: an heir, the robot's wallet, a nonce account. Throwaway keys; only the public halves are used.
const heir = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;
const nonceAccount = Keypair.generate().publicKey;
const mintA = pk(0x61);
const mintB = pk(0x62);
const plan: RobotPlan = { heir, windowDays: 365, waitDays: 60, mints: [mintA] };

function nonceData(authority: PublicKey, nonce: PublicKey): Uint8Array {
  const d = Buffer.alloc(80);
  d.writeUInt32LE(1, 0); // version
  d.writeUInt32LE(1, 4); // initialized
  authority.toBuffer().copy(d, 8);
  nonce.toBuffer().copy(d, 40);
  d.writeBigUInt64LE(5000n, 72);
  return d;
}
function tokenData(mint: PublicKey, holder: PublicKey, amount: bigint): Uint8Array {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0);
  holder.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1;
  return d;
}

/** The daemon's three routes, as a stand-in that records what it was asked. */
function robot(over: { status?: Record<string, unknown>; armAnswer?: { status: number; body: unknown }; nonce?: { status: number; body: unknown }; wallet?: PublicKey } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    const path = new URL(url).pathname;
    calls.push({ method: init?.method ?? "GET", path, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    const answer =
      path === "/status" ? { status: 200, body: { pubkey: (over.wallet ?? owner).toBase58() } }
      : path === "/inheritance" ? { status: 200, body: over.status ?? { armed: true, inactivity_days: 425, days_since_touch: 3.5, heir: heir.toBase58() } }
      : path === "/inheritance/arm" ? (over.armAnswer ?? { status: 200, body: { ok: true, summary: "1.5 SOL to the heir after 425 days" } })
      : path === "/offline/nonce/create" ? (over.nonce ?? { status: 200, body: { nonceAccount: nonceAccount.toBase58(), signature: "sig" } })
      : { status: 404, body: {} };
    return { status: answer.status, json: async () => answer.body };
  };
  return { daemon: new RobotDaemon("http://127.0.0.1:7401", fetchImpl), calls };
}

function chainWith(balance = 1_510_000_000, tokens: [PublicKey, bigint][] = [[mintA, 500n]], nonce = pk(0x70)) {
  const chain = new FakeChain();
  chain.put(nonceAccount, SystemProgram.programId, nonceData(owner, nonce), 1_500_000);
  chain.put(owner, SystemProgram.programId, new Uint8Array(0), balance);
  tokens.forEach(([mint, amount], i) => chain.put(pk(0x80 + i), TOKEN_PROGRAM_ID, tokenData(mint, owner, amount)));
  return chain;
}

describe("the link talks to the robot's own daemon and to nothing else", () => {
  it("refuses any address that is not the robot itself", () => {
    for (const base of ["http://192.168.1.20:7401", "https://127.0.0.1:7401", "http://robot.local:7401", "http://127.0.0.1.evil.example:7401", "http://example.com"]) {
      expect(() => new RobotDaemon(base), base).toThrow(/on the robot itself/);
    }
    for (const base of ["http://127.0.0.1:7401", "http://localhost:7401/", "http://[::1]:7401"]) expect(() => new RobotDaemon(base)).not.toThrow();
  });

  it("has no way to clear or release the switch", () => {
    const methods = Object.getOwnPropertyNames(RobotDaemon.prototype).filter((m) => m !== "constructor" && m !== "call");
    expect(methods.sort()).toEqual(["arm", "createNonceAccount", "switchStatus", "wallet"]);
  });
});

describe("what the robot is asked to arm", () => {
  it("is the vault's window plus its waiting period, for the primary heir's own address", () => {
    const b = armBody(plan, nonceAccount);
    expect(b).toEqual({ heir: heir.toBase58(), inactivityDays: 425, warnDays: [30, 14, 7, 1], mints: [mintA.toBase58()], nonceAccount: nonceAccount.toBase58() });
    // the floors: 90 + 30 days, with every warning still inside the period
    expect(armBody({ ...plan, windowDays: 90, waitDays: 30 }, nonceAccount)).toMatchObject({ inactivityDays: 120, warnDays: [30, 14, 7, 1] });
  });

  it("is refused for what the robot's switch cannot carry", () => {
    const offCurve = PublicKey.findProgramAddressSync([Buffer.from("plan")], pk(0x99))[0];
    expect(() => armBody({ ...plan, heir: offCurve }, nonceAccount)).toThrow(/ordinary wallet address/);
    expect(() => armBody({ ...plan, windowDays: 36_500, waitDays: 36_500 }, nonceAccount)).toThrow(/at most 65535 days/);
    expect(() => armBody({ ...plan, mints: [pk(1), pk(2), pk(3), pk(4), pk(5)] }, nonceAccount)).toThrow(/at most 4 tokens/);
    expect(() => armBody({ ...plan, mints: [mintA, mintA] }, nonceAccount)).toThrow(/listed twice/);
    expect(() => armBody({ ...plan, waitDays: 0 }, nonceAccount)).toThrow(/whole number of days/);
  });
});

describe("arming", () => {
  it("sends the robot one request and records exactly what the stored transaction will move", async () => {
    const { daemon, calls } = robot();
    const res = await arm(daemon, chainWith(), plan, { nonceAccount, now: new Date("2026-11-13T00:00:00Z") });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ method: "GET", path: "/status" }, { method: "POST", path: "/inheritance/arm", body: { ...armBody(plan, nonceAccount), solLamports: "1500000000" } as ArmBody }]);
    expect(res.ok && res.record).toEqual({
      version: 1,
      armedAt: "2026-11-13T00:00:00.000Z",
      owner: owner.toBase58(),
      heir: heir.toBase58(),
      inactivityDays: 425,
      warnDays: [30, 14, 7, 1],
      nonceAccount: nonceAccount.toBase58(),
      nonceValue: pk(0x70).toBase58(),
      solLamports: "1500000000",
      tokens: [{ mint: mintA.toBase58(), amount: "500" }],
      summary: "1.5 SOL to the heir after 425 days",
    });
  });

  it("asks the robot for a nonce account when none is given, and says why if the robot will not make one", async () => {
    const ok = robot();
    await arm(ok.daemon, chainWith(), plan);
    expect(ok.calls.map((c) => c.path)).toEqual(["/offline/nonce/create", "/status", "/inheritance/arm"]);
    const off = robot({ nonce: { status: 403, body: { error: "offline_payments_disabled" } } });
    await expect(arm(off.daemon, chainWith(), plan)).rejects.toThrow(/offline-payments setting is off/);
    expect(off.calls.map((c) => c.path)).toEqual(["/offline/nonce/create"]);
  });

  it("passes a refusal on as the robot gave it, and keeps no record", async () => {
    const { daemon } = robot({ armAnswer: { status: 403, body: { ok: false, reason: "timeout" } } });
    expect(await arm(daemon, chainWith(), plan, { nonceAccount })).toEqual({ ok: false, reason: "timeout" });
  });

  it("refuses, before the robot is asked to arm: no nonce account, one that answers to another key, the robot as its own heir", async () => {
    const { daemon, calls } = robot();
    await expect(arm(daemon, chainWith(), plan, { nonceAccount: pk(0x55) })).rejects.toThrow(/not a durable-nonce account/);
    await expect(arm(daemon, chainWith(), { ...plan, heir: owner }, { nonceAccount })).rejects.toThrow(/robot's own wallet/);
    // The robot signs any durable-nonce transaction it is shown. One built on a nonce account that
    // answers to another key could never run, so the link checks the authority against the robot's wallet.
    const elsewhere = robot({ wallet: Keypair.generate().publicKey });
    await expect(arm(elsewhere.daemon, chainWith(), plan, { nonceAccount })).rejects.toThrow(/does not answer to the wallet the robot reports.*could never run/);
    for (const c of [...calls, ...elsewhere.calls]) expect(c.path).not.toBe("/inheritance/arm");
  });
});

describe("drift", () => {
  const record: ArmRecord = { version: 1, armedAt: "2026-11-13T00:00:00.000Z", owner: owner.toBase58(), heir: heir.toBase58(), inactivityDays: 425, warnDays: [30, 14, 7, 1], nonceAccount: nonceAccount.toBase58(), nonceValue: pk(0x70).toBase58(), solLamports: "1500000000", tokens: [{ mint: mintA.toBase58(), amount: "500" }], summary: "" };

  it("is silent while everything is as it was armed, and never asks the robot for anything but its status", async () => {
    const { daemon, calls } = robot();
    const d = await drift(daemon, chainWith(), record, plan);
    expect(d.problems).toEqual([]);
    expect(d.robot).toEqual({ armed: true, inactivityDays: 425, daysSinceTouch: 3.5, heir: heir.toBase58() });
    expect(d.daysLeft).toBe(421.5);
    expect(calls).toEqual([{ method: "GET", path: "/inheritance" }]);
  });

  it("says in words what no longer matches", async () => {
    const problems = async (chain: FakeChain, status?: Record<string, unknown>, p: RobotPlan = plan) => (await drift(robot(status ? { status } : {}).daemon, chain, record, p)).problems;
    expect(await problems(chainWith(), { armed: false, inactivity_days: 0, days_since_touch: 0, heir: null })).toEqual(["The robot reports that its switch is not armed."]);
    expect((await problems(chainWith(), { armed: true, inactivity_days: 90, days_since_touch: 1, heir: pk(0x45).toBase58() })).join(" ")).toMatch(/another heir .* 90 days of inactivity, not the 425/);
    // the nonce was used: the stored transaction is dead
    expect((await problems(chainWith(1_510_000_000, [[mintA, 500n]], pk(0x71))))[0]).toMatch(/nonce account was used for something else.*can never run/);
    // less than the stored transaction sends: it would fail whole
    expect((await problems(chainWith(1_000_000_000)))[0]).toMatch(/holds less SOL .* whole release would fail/);
    expect((await problems(chainWith(1_510_000_000, [[mintA, 499n]])))[0]).toMatch(/holds less of token .* whole release would fail/);
    // more: the rest would stay behind
    expect((await problems(chainWith(9_000_000_000)))[0]).toMatch(/lamports more than the stored transaction sends/);
    expect((await problems(chainWith(1_510_000_000, [[mintA, 900n]])))[0]).toMatch(/holds 400 more of token/);
    expect((await problems(chainWith(1_510_000_000, [[mintA, 500n], [mintB, 7n]])))[0]).toMatch(/1 kind\(s\) of token the stored transaction does not send/);
    // the plan moved on
    expect((await problems(chainWith(), undefined, { ...plan, heir: Keypair.generate().publicKey }))[0]).toMatch(/plan's primary heir is now/);
    expect((await problems(chainWith(), undefined, { ...plan, windowDays: 730 }))[0]).toMatch(/could fire before the vault/);
    expect((await problems(chainWith(), undefined, { ...plan, windowDays: 90 }))[0]).toMatch(/would fire later than it needs to/);
  });
});

describe("the robot's own warnings reach the owner as reminders", () => {
  class Inbox implements Channel {
    readonly got: { to: string; message: Message }[] = [];
    async send(to: string, message: Message): Promise<void> {
      this.got.push({ to, message });
    }
  }
  const secret = "c3VwZXItc2VjcmV0LXBhdGgtcGFydA";
  async function world() {
    const { createHash } = await import("node:crypto");
    const store = new MemoryStore();
    store.subs.push({ vault: pk(0x11).toBase58(), owner: [{ channel: "email", to: "owner@example.org" }], contacts: [{ channel: "email", to: "friend@example.org" }], robotHookHash: createHash("sha256").update(secret).digest("hex") });
    const email = new Inbox();
    const chain = new FakeChain();
    chain.put(pk(0x11), pk(0x12), new Uint8Array(1)); // the vault itself is not read for a robot event
    return { service: new ReminderService(chain, store, { email }), store, email };
  }

  it("a warning becomes one reminder, however often it is posted; contacts hear from seven days", async () => {
    const w = await world();
    expect(await w.service.robotEvent(secret, { event: "inheritance_warning", daysLeft: 30, at: 1 })).toBe(true);
    expect(await w.service.robotEvent(secret, { event: "inheritance_warning", daysLeft: 30, at: 2 })).toBe(false);
    expect((await w.store.outbox()).map((d) => d.recipient.to)).toEqual(["owner@example.org"]);
    expect(await w.service.robotEvent(secret, { event: "inheritance_warning", daysLeft: 7, at: 3 })).toBe(true);
    const out = await w.store.outbox();
    expect(out.map((d) => d.recipient.to).sort()).toEqual(["friend@example.org", "owner@example.org", "owner@example.org"]);
    expect(out.every((d) => d.notice.kind === "robot_warning")).toBe(true);
  });

  it("a forged call can only cause a reminder, and a wrong address or a malformed body causes nothing", async () => {
    const w = await world();
    expect(await w.service.robotEvent("wrong-secret", { event: "inheritance_warning", daysLeft: 1, at: 1 })).toBe(false);
    for (const body of [null, "text", {}, { event: "inheritance_warning" }, { event: "inheritance_warning", daysLeft: -1 }, { event: "inheritance_warning", daysLeft: 1.5 }, { event: "inheritance_released", signature: "<script>" }, { event: "set_plan", heir: "attacker" }, { event: "inheritance_cleared" }]) {
      expect(await w.service.robotEvent(secret, body), JSON.stringify(body)).toBe(false);
    }
    expect(await w.store.outbox()).toEqual([]);
    expect(await w.service.robotEvent(secret, { event: "inheritance_released", signature: "5".repeat(88), at: 9 })).toBe(true);
    expect((await w.store.outbox()).every((d) => d.notice.kind === "robot_released")).toBe(true);
    // the store learned nothing else from any of it
    expect(w.store.subs).toHaveLength(1);
    expect(await w.store.snapshot(pk(0x11).toBase58())).toBeUndefined();
  });
});

// ---- the two commands, on the robot ----

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySuccession, encodeVault } from "@lamport-robotics/vault";
import { afterAll } from "vitest";
import { encodePlanForTests } from "../scripts/claim-kat.ts";
import { hashedHeir, planAddress, type Terms } from "../src/claim.ts";
import { main, UsageError } from "../src/cli.ts";
import { PROGRAMS } from "../src/programs.ts";

describe("pincer-arm and pincer-status", () => {
  const home = mkdtempSync(join(tmpdir(), "lamport-heir-robot-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const vault = pk(0x11);
  const DAY = 86_400n;
  const H5 = Uint8Array.from([0, 0, 0, 5, 0, 0, 0, 3, ...new Uint8Array(48).fill(0xab)]);
  const vaultData = (claim: PublicKey) =>
    encodeVault({ version: 3, bump: 255, vaultId: new Uint8Array(32).fill(1), lmsPubkey: H5, spent: 0, generation: 0, createdSlot: 1n, succession: { ...emptySuccession(), claim, windowSecs: 365n * DAY, waitSecs: 60n * DAY, lastSignedTs: 1_800_000_000n }, used: new Uint8Array(4), usedKeys: [] });
  const run = async (chain: FakeChain, daemon: RobotDaemon, ...argv: string[]) => {
    const lines: string[] = [];
    const code = await main(argv, { out: (l) => lines.push(l), env: { HOME: home }, chain, daemon });
    return { code, text: lines.join("\n") };
  };

  it("arm for the plan's named primary heir, record it, and report no drift", async () => {
    const terms: Terms = { vault, primary: { kind: "address", address: heir }, contingent: { kind: "address", address: Keypair.generate().publicKey }, contingentDelaySecs: 365n * DAY };
    const chain = chainWith();
    chain.put(vault, PROGRAMS.vault, vaultData(planAddress(terms)));
    chain.put(planAddress(terms), PROGRAMS.claim, encodePlanForTests({ bump: 255, terms, createdTs: 1n, activated: false, activatedTs: 0n, closedSlot: 0n, contingentClockTs: 0n }));
    const { daemon, calls } = robot();

    const armed = await run(chain, daemon, "pincer-arm", vault.toBase58(), "--nonce-account", nonceAccount.toBase58(), "--mints", mintA.toBase58());
    expect(armed.code).toBe(0);
    expect(armed.text).toContain(`425 days without a touch, then its wallet goes to ${heir.toBase58()}`);
    expect(armed.text).toContain("Hold your hand on it for three seconds");
    expect(armed.text).toContain("not a check-in for the vault");
    expect(armed.text).toContain("contingent heir does not cover the robot's wallet");
    expect(calls.at(-1)).toMatchObject({ path: "/inheritance/arm", body: { heir: heir.toBase58(), inactivityDays: 425 } });
    const file = join(home, ".lamport-heir", `pincer-${vault.toBase58()}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    expect(record).toMatchObject({ heir: heir.toBase58(), inactivityDays: 425, owner: owner.toBase58() });
    expect(JSON.stringify(record)).not.toMatch(/secret|private/i);

    const status = await run(chain, daemon, "pincer-status", vault.toBase58());
    expect(status.code).toBe(0);
    expect(status.text).toContain("everything is as it was armed");

    // the robot's wallet gains a token nobody armed: said, and the exit code says so
    chain.put(pk(0x90), TOKEN_PROGRAM_ID, tokenData(mintB, owner, 3n));
    const drifted = await run(chain, daemon, "pincer-status", vault.toBase58(), "--mints", mintA.toBase58());
    expect(drifted.code).toBe(1);
    expect(drifted.text).toContain("1 kind(s) of token the stored transaction does not send");
  });

  it("asks for the heir's address when the plan keeps it private, and refuses a vault with no plan", async () => {
    const terms: Terms = { vault, primary: hashedHeir(new Uint8Array(32).fill(5), heir), contingent: { kind: "none" }, contingentDelaySecs: 0n };
    const chain = chainWith();
    chain.put(vault, PROGRAMS.vault, vaultData(planAddress(terms)));
    chain.put(planAddress(terms), PROGRAMS.claim, encodePlanForTests({ bump: 255, terms, createdTs: 1n, activated: false, activatedTs: 0n, closedSlot: 0n, contingentClockTs: 0n }));
    const { daemon, calls } = robot();
    await expect(run(chain, daemon, "pincer-arm", vault.toBase58(), "--nonce-account", nonceAccount.toBase58())).rejects.toThrow(/keeps its primary heir private.*--heir/);
    expect((await run(chain, daemon, "pincer-arm", vault.toBase58(), "--nonce-account", nonceAccount.toBase58(), "--heir", heir.toBase58(), "--record", join(home, "r.json"))).code).toBe(0);

    chain.put(vault, PROGRAMS.vault, vaultData(PublicKey.default));
    await expect(run(chain, daemon, "pincer-arm", vault.toBase58())).rejects.toThrow(UsageError);
    await expect(run(chain, daemon, "pincer-status", pk(0x12).toBase58())).rejects.toThrow(/no account at/);
    expect(calls.filter((c) => c.path === "/inheritance/arm")).toHaveLength(1);
  });
});
