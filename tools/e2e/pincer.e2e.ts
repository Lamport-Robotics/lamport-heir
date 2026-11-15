/**
 * The Pincer1 link against Pincer1's own daemon, in simulator mode.
 *
 * The daemon's real classes run in this process, from the pinned copy of the robot's repository
 * (vendor/pincer1): its API server on a loopback port, its Inheritance module, and its simulated
 * controller, which holds the robot's key and the dead-man's timer as the firmware does. Nothing
 * in them is changed or patched. The chain is the local validator the other end-to-end run uses.
 *
 * A running daemon never advances the simulated controller's clock, so the test does, with the
 * simulator's own `tick`, and calls the daemon's hourly check itself.
 *
 * Covered: arming through the daemon with the owner's hold, the record and the drift check, a
 * touch resetting the timer, the robot's warnings reaching the reminder service through the
 * webhook, and the release: the transaction the controller kept is broadcast by the daemon and
 * the heir is paid on chain.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMint, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, NONCE_ACCOUNT_LENGTH, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RobotDaemon } from "../src/pincer/daemon.ts";
import { arm, type ArmRecord, drift, type RobotPlan } from "../src/pincer/link.ts";
import { robotHookServer } from "../src/reminders/http.ts";
import { type Message } from "../src/reminders/messages.ts";
import { type Channel, MemoryStore, ReminderService } from "../src/reminders/service.ts";
import { RPC_URL } from "./validator.ts";

const connection = new Connection(RPC_URL, "confirmed");
const funder = Keypair.generate();
const heir = Keypair.generate().publicKey;
const DAY = 86_400;
const dataDir = mkdtempSync(join(tmpdir(), "lamport-heir-pincer-"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The daemon's modules, loaded from the pinned copy as they are. */
async function daemonModule(path: string): Promise<any> {
  return import(/* @vite-ignore */ new URL(`../../vendor/pincer1/daemon/src/${path}`, import.meta.url).href);
}

class Inbox implements Channel {
  readonly got: { to: string; message: Message }[] = [];
  async send(to: string, message: Message): Promise<void> {
    this.got.push({ to, message });
  }
}

let sim: any;
let robot: any;
let inheritance: any;
let api: any;
let daemon: RobotDaemon;
let owner: PublicKey;
let mint: PublicKey;
let nonceAccount: PublicKey;
let plan: RobotPlan;
let record: ArmRecord;
let hook: ReturnType<typeof robotHookServer>;
const store = new MemoryStore();
const email = new Inbox();
const secret = randomBytes(24).toString("base64url");

async function until(what: string, ok: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  const sig = await connection.requestAirdrop(funder.publicKey, 20 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) });

  const { SimController } = await daemonModule("controller/sim.ts");
  const { MockRobot } = await daemonModule("presence/client.ts");
  const { Signer } = await daemonModule("sign.ts");
  const { Intel } = await daemonModule("risk/intel.ts");
  const { Inheritance } = await daemonModule("inheritance/index.ts");
  const { ApiServer } = await daemonModule("api/server.ts");

  // The simulated controller holds the robot's key. `autoTouch` stands in for the owner's hand:
  // every hold the controller asks for is given.
  sim = new SimController({ seed: randomBytes(32), autoTouch: true });
  owner = new PublicKey(sim.realPublicKey);
  robot = new MockRobot();

  // The robot's wallet: 2 SOL and 500 units of one token.
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: owner, lamports: 2 * LAMPORTS_PER_SOL })), [funder]);
  mint = await createMint(connection, funder, funder.publicKey, null, 0, undefined, undefined, TOKEN_PROGRAM_ID);
  const ownerTokens = await getOrCreateAssociatedTokenAccount(connection, funder, mint, owner);
  await mintTo(connection, funder, mint, ownerTokens.address, funder, 500n);

  // A nonce account for the switch and nothing else, with the robot's wallet as its authority.
  const nonce = Keypair.generate();
  nonceAccount = nonce.publicKey;
  const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.createNonceAccount({ fromPubkey: funder.publicKey, noncePubkey: nonceAccount, authorizedPubkey: owner, lamports: rent })), [funder, nonce]);

  // The reminder service, with the address the robot posts its warnings to.
  const service = new ReminderService(connection, store, { email });
  store.subs.push({ vault: Keypair.generate().publicKey.toBase58(), label: "savings", owner: [{ channel: "email", to: "owner@example.org" }], contacts: [{ channel: "email", to: "friend@example.org" }], robotHookHash: createHash("sha256").update(secret).digest("hex") });
  hook = robotHookServer(service);
  await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/robot/${secret}`;

  // The daemon, as its own main.ts wires it: NOTIFY_WEBHOOK_URL is the last argument of Inheritance.
  const intel = new Intel(connection, 50);
  const cfg = { PINCER_MODE: "dev", addressBook: {}, originAllowlist: [], dailyLimitLamports: 2_000_000_000n };
  const signer = new Signer(cfg, sim, robot, connection, () => sim.publicKey, intel);
  inheritance = new Inheritance(sim, robot, connection, () => sim.realPublicKey, hookUrl);
  api = new ApiServer({ signer, controller: sim, robot, agent: null, inheritance, conn: connection, getOwner: () => sim.realPublicKey, dataDir, bind: "127.0.0.1", port: 0 });
  await api.listen();
  daemon = new RobotDaemon(`http://127.0.0.1:${(api.address as AddressInfo).port}`);
  plan = { heir, windowDays: 90, waitDays: 30, mints: [mint] };
});

afterAll(() => {
  api?.close();
  hook?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the Pincer1 link, against the daemon in simulator mode", () => {
  it("before arming, the robot reports no switch", async () => {
    expect(await daemon.switchStatus()).toMatchObject({ armed: false, heir: null });
  });

  it("arms the robot's own switch through the daemon, with the owner's hold on the robot", async () => {
    const res = await arm(daemon, connection, plan, { nonceAccount });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    record = res.record;
    // the vault's 90-day window plus its 30-day wait: the robot cannot fire before the vault could
    expect(record).toMatchObject({ owner: owner.toBase58(), heir: heir.toBase58(), inactivityDays: 120, warnDays: [30, 14, 7, 1], tokens: [{ mint: mint.toBase58(), amount: "500" }] });
    expect(BigInt(record.solLamports)).toBe(BigInt(2 * LAMPORTS_PER_SOL) - 10_000_000n);
    // the robot said what it would do and asked for the hold; the controller, not the daemon, keeps the signed transaction
    expect(robot.spoken.some((s: string) => /Hold your hand on me for three seconds/.test(s))).toBe(true);
    expect(robot.spoken.at(-1)).toMatch(/^Armed/);
    expect(await daemon.switchStatus()).toMatchObject({ armed: true, inactivityDays: 120, heir: heir.toBase58() });

    const d = await drift(daemon, connection, record, plan);
    expect(d.problems).toEqual([]);
    expect(d.daysLeft).toBeCloseTo(120, 3);
  });

  it("will not have the robot arm a transaction that could never run", async () => {
    // The robot signs any durable-nonce transaction it is shown. A nonce account that answers to
    // another key would make the stored transaction worthless, silently. The link refuses before
    // the robot is asked, and the switch that is armed stays as it is.
    const other = Keypair.generate();
    const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
    await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.createNonceAccount({ fromPubkey: funder.publicKey, noncePubkey: other.publicKey, authorizedPubkey: funder.publicKey, lamports: rent })), [funder, other]);
    const spokenBefore = robot.spoken.length;
    await expect(arm(daemon, connection, plan, { nonceAccount: other.publicKey })).rejects.toThrow(/does not answer to the wallet the robot reports/);
    expect(robot.spoken.length).toBe(spokenBefore); // the robot was never asked
    expect(await daemon.switchStatus()).toMatchObject({ armed: true, inactivityDays: 120, heir: heir.toBase58() });
    expect((await drift(daemon, connection, record, plan)).problems).toEqual([]);
  });

  it("warnings from the robot reach the owner through the reminder service; a touch resets the robot's timer", async () => {
    sim.tick(95 * DAY); // 25 days left: the robot's 30-day warning
    await until("the 30-day warning to be queued", async () => (await store.outbox()).some((x) => x.notice.kind === "robot_warning" && x.notice.days === 30));
    expect((await store.outbox()).map((x) => x.recipient.to)).toEqual(["owner@example.org"]);
    expect(robot.spoken.at(-1)).toMatch(/30 days until I pass your wallet to your heir/);
    expect((await drift(daemon, connection, record, plan)).daysLeft).toBeCloseTo(25, 3);

    // the owner touches the robot: its timer starts again. This is not a check-in for any vault.
    sim.touch();
    const after = await drift(daemon, connection, record, plan);
    expect(after.daysLeft).toBeCloseTo(120, 3);
    expect(after.problems).toEqual([]);

    // silence again, down to a week: now the trusted contact hears too
    sim.tick(114 * DAY);
    await until("the 7-day warning to reach the contact", async () => (await store.outbox()).some((x) => x.notice.kind === "robot_warning" && x.notice.days === 7 && x.recipient.to === "friend@example.org"));
    // nothing has been released: the daemon's own check says so
    expect(await inheritance.tick()).toBeNull();
    expect(await connection.getBalance(heir)).toBe(0);
  });

  it("when the robot's timer runs out, the daemon broadcasts what the controller kept, and the heir is paid on chain", async () => {
    sim.tick(7 * DAY); // 121 days since the touch
    const released = await inheritance.tick(); // the daemon's hourly check
    expect(released).toMatchObject({ ok: true });
    await until("the release to confirm", async () => (await connection.getBalance(heir)) > 0);

    expect(await connection.getBalance(heir)).toBe(Number(record.solLamports));
    const heirTokens = await getAccount(connection, getAssociatedTokenAddressSync(mint, heir));
    expect(heirTokens.amount).toBe(500n);
    expect(robot.spoken.at(-1)).toMatch(/passed the wallet to your heir/);

    await until("the release to be queued as a reminder", async () => (await store.outbox()).some((x) => x.notice.kind === "robot_released"));
    const notice = (await store.outbox()).find((x) => x.notice.kind === "robot_released")!.notice;
    expect(notice.signature).toBe(released.signature);

    // the link sees it afterwards: the nonce was used, the stored transaction is spent
    const d = await drift(daemon, connection, record, plan);
    expect(d.problems.join(" ")).toMatch(/nonce account was used for something else.*can never run/);
  });

  it("every reminder that came of it names the robot, carries no link, and asks for nothing", async () => {
    const service = new ReminderService(connection, store, { email });
    await service.tick().catch(() => undefined); // the subscription's vault does not exist here; the outbox is delivered all the same
    const subjects = email.got.map((g) => g.message.subject);
    expect(subjects.filter((s) => /has not been touched/.test(s)).length).toBeGreaterThanOrEqual(2);
    expect(subjects).toContain("Lamport Heir: your Pincer1 has passed on its wallet");
    for (const g of email.got) {
      expect(g.message.body).not.toMatch(/https?:|www\./i);
      expect(g.message.body).toContain("contains no link");
    }
  });
});
