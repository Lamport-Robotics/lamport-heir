/**
 * The link between a Heir plan and Pincer1's own dead-man's switch.
 *
 * Pincer1 already has a switch for the robot's wallet: a transaction the controller signed and
 * keeps, released by the robot if nobody touches it for a set number of days. Heir does not
 * replace it, wrap it or add a second one. The link does three things: it asks the robot to arm
 * that switch with settings that match the owner's plan, it remembers what was armed, and it
 * compares that with what the robot and the chain say now.
 *
 * The rules it is built under (docs/design-note.md, 7.4):
 *
 * - the robot never fires before the vault could: its inactivity period is the vault's window
 *   plus the vault's waiting period, because the robot's release has no public waiting period
 *   and cannot be undone;
 * - the robot pays the primary heir's own address, the same person the vault's plan names first;
 * - a touch on the robot is not a check-in for the vault, and a check-in is not a touch;
 * - the link never clears, re-arms or releases anything on its own, and draws no conclusion from
 *   a refusal by the robot.
 */
import { NONCE_ACCOUNT_LENGTH, NonceAccount, PublicKey, SystemProgram } from "@solana/web3.js";
import { type Chain, COMMITMENT } from "../chain.ts";
import { holdingsOf } from "../tokens.ts";
import { type ArmBody, type RobotDaemon, type RobotSwitch } from "./daemon.ts";

/** The robot's limits (firmware and daemon, as read). */
export const ROBOT_LIMITS = Object.freeze({ maxInactivityDays: 65_535, maxWarnDays: 4, maxMints: 4 });
/** When the robot warns, in days before it would release. */
export const ROBOT_WARN_DAYS = [30, 14, 7, 1] as const;
/** What the robot keeps back for fees when it passes on "everything": 0.01 SOL. */
const ROBOT_SOL_RESERVE = 10_000_000n;

/** What the owner's plan asks of the robot. */
export interface RobotPlan {
  /** the primary heir's own address: an ordinary wallet address */
  heir: PublicKey;
  /** the vault's inactivity window and waiting period, in days */
  windowDays: number;
  waitDays: number;
  /** classic SPL token mints to pass on in full, at most four */
  mints: PublicKey[];
}

/** What was armed, kept on the robot's computer so that drift can be seen later. No secret is in it. */
export interface ArmRecord {
  version: 1;
  armedAt: string;
  /** the robot's wallet */
  owner: string;
  heir: string;
  inactivityDays: number;
  warnDays: number[];
  nonceAccount: string;
  /** the nonce the stored transaction was built on; if the account's nonce moves, that transaction is dead */
  nonceValue: string;
  /** lamports the stored transaction moves */
  solLamports: string;
  /** tokens the stored transaction moves: the balances at arming */
  tokens: { mint: string; amount: string }[];
  /** what the robot said it would do */
  summary: string;
}

/** The request the robot is sent for `plan`. Throws when the plan cannot be carried by the robot's switch. */
export function armBody(plan: RobotPlan, nonceAccount: PublicKey): ArmBody {
  if (!PublicKey.isOnCurve(plan.heir.toBytes())) {
    throw new Error("the robot pays an ordinary wallet address: a plan's address, or any address no key exists for, cannot be its heir. Use the primary heir's own address");
  }
  for (const [name, days] of [["window", plan.windowDays], ["waiting period", plan.waitDays]] as const) {
    if (!Number.isInteger(days) || days < 1) throw new Error(`the ${name} must be a whole number of days`);
  }
  // No public waiting period on the robot and no way back: it must not fire before the vault could.
  const inactivityDays = plan.windowDays + plan.waitDays;
  if (inactivityDays > ROBOT_LIMITS.maxInactivityDays) throw new Error(`the robot's timer holds at most ${ROBOT_LIMITS.maxInactivityDays} days; this plan needs ${inactivityDays}`);
  if (plan.mints.length > ROBOT_LIMITS.maxMints) throw new Error(`the robot's stored transaction has room for SOL and at most ${ROBOT_LIMITS.maxMints} tokens; this plan lists ${plan.mints.length}`);
  if (new Set(plan.mints.map((m) => m.toBase58())).size !== plan.mints.length) throw new Error("a token is listed twice");
  const warnDays = ROBOT_WARN_DAYS.filter((d) => d < inactivityDays).slice(0, ROBOT_LIMITS.maxWarnDays);
  return { heir: plan.heir.toBase58(), inactivityDays, warnDays: [...warnDays], mints: plan.mints.map((m) => m.toBase58()), nonceAccount: nonceAccount.toBase58() };
}

async function readNonce(chain: Chain, nonceAccount: PublicKey): Promise<{ nonce: string; authority: PublicKey } | undefined> {
  const info = await chain.getAccountInfo(nonceAccount, COMMITMENT);
  if (!info || !info.owner.equals(SystemProgram.programId) || info.data.length !== NONCE_ACCOUNT_LENGTH) return undefined;
  const n = NonceAccount.fromAccountData(info.data);
  return { nonce: n.nonce, authority: n.authorizedPubkey };
}

/**
 * Asks the robot to arm its switch for `plan`, and returns the record of what was armed. The
 * robot announces the arrangement and waits for the owner's three-second hold; this returns when
 * the robot answers. A refusal comes back as the robot gave it, with no record.
 *
 * The nonce account must be dedicated to the switch and its authority must be the robot's wallet.
 * Left out, the robot is asked to create one.
 */
export async function arm(daemon: RobotDaemon, chain: Chain, plan: RobotPlan, opts: { nonceAccount?: PublicKey; now?: Date } = {}): Promise<{ ok: true; record: ArmRecord } | { ok: false; reason: string }> {
  const nonceAccount = opts.nonceAccount ?? new PublicKey(await daemon.createNonceAccount());
  const body = armBody(plan, nonceAccount);
  const nonce = await readNonce(chain, nonceAccount);
  if (!nonce) throw new Error(`${nonceAccount.toBase58()} is not a durable-nonce account`);
  // The robot signs whatever durable-nonce transaction it is shown. If the nonce account answered
  // to another key, the transaction it kept could never run, and nobody would know until the day
  // it mattered. So this is checked here, before the robot is asked.
  const owner = new PublicKey(await daemon.wallet());
  if (!nonce.authority.equals(owner)) throw new Error(`the nonce account ${nonceAccount.toBase58()} does not answer to the wallet the robot reports: a transaction built on it could never run`);
  if (owner.equals(plan.heir)) throw new Error("the heir is the robot's own wallet");

  // What the stored transaction will move, read the way the robot reads it, for the record.
  const held = await holdingsOf(chain, owner);
  const tokens: ArmRecord["tokens"] = [];
  for (const mint of plan.mints) {
    const h = held.find((x) => x.mint.equals(mint) && x.amount > 0n);
    if (h) tokens.push({ mint: mint.toBase58(), amount: h.amount.toString() });
  }
  const balance = BigInt((await chain.getAccountInfo(owner, COMMITMENT))?.lamports ?? 0);
  const solLamports = balance > ROBOT_SOL_RESERVE ? balance - ROBOT_SOL_RESERVE : 0n;

  const outcome = await daemon.arm({ ...body, solLamports: solLamports.toString() });
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    record: {
      version: 1,
      armedAt: (opts.now ?? new Date()).toISOString(),
      owner: owner.toBase58(),
      heir: body.heir,
      inactivityDays: body.inactivityDays,
      warnDays: body.warnDays,
      nonceAccount: body.nonceAccount,
      nonceValue: nonce.nonce,
      solLamports: solLamports.toString(),
      tokens,
      summary: outcome.summary,
    },
  };
}

export interface Drift {
  /** what the robot reports, as it reports it */
  robot: RobotSwitch;
  /** the days left on the robot's timer, by its own count of powered days */
  daysLeft: number;
  /** everything that no longer matches what was armed or what the plan asks; empty when all is as armed */
  problems: string[];
}

/**
 * Compares what was armed with what the robot and the chain say now, and with the plan if given.
 * It reads only. Each problem is a sentence the owner can act on; none of them is acted on here.
 */
export async function drift(daemon: RobotDaemon, chain: Chain, record: ArmRecord, plan?: RobotPlan): Promise<Drift> {
  const robot = await daemon.switchStatus();
  const problems: string[] = [];
  const rearm = "Arm it again on the robot.";
  if (!robot.armed) {
    problems.push("The robot reports that its switch is not armed.");
  } else {
    if (robot.heir !== record.heir) problems.push(`The robot reports another heir (${robot.heir}) than the one that was armed (${record.heir}).`);
    if (robot.inactivityDays !== record.inactivityDays) problems.push(`The robot reports ${robot.inactivityDays} days of inactivity, not the ${record.inactivityDays} that were armed.`);
  }

  const nonce = await readNonce(chain, new PublicKey(record.nonceAccount));
  if (!nonce) problems.push(`The switch's nonce account ${record.nonceAccount} no longer exists, so the transaction the robot keeps can never run. ${rearm}`);
  else if (nonce.nonce !== record.nonceValue) problems.push(`The switch's nonce account was used for something else, so the transaction the robot keeps can never run. ${rearm}`);

  const owner = new PublicKey(record.owner);
  const balance = BigInt((await chain.getAccountInfo(owner, COMMITMENT))?.lamports ?? 0);
  const sol = BigInt(record.solLamports);
  if (balance < sol + 5_000n) problems.push(`The robot's wallet holds less SOL than the stored transaction sends (${balance} of ${sol} lamports), so the whole release would fail. ${rearm}`);
  else if (balance > sol + ROBOT_SOL_RESERVE * 2n) problems.push(`The robot's wallet holds ${balance - sol} lamports more than the stored transaction sends; the rest would stay in the wallet. ${rearm}`);

  const held = await holdingsOf(chain, owner);
  for (const t of record.tokens) {
    const now = held.find((h) => h.mint.toBase58() === t.mint)?.amount ?? 0n;
    const armed = BigInt(t.amount);
    if (now < armed) problems.push(`The robot's wallet holds less of token ${t.mint} than the stored transaction sends (${now} of ${armed}), so the whole release would fail. ${rearm}`);
    else if (now > armed) problems.push(`The robot's wallet holds ${now - armed} more of token ${t.mint} than the stored transaction sends; the rest would stay in the wallet. ${rearm}`);
  }
  const covered = new Set(record.tokens.map((t) => t.mint));
  const uncovered = held.filter((h) => h.amount > 0n && !covered.has(h.mint.toBase58()));
  if (uncovered.length > 0) problems.push(`The robot's wallet holds ${uncovered.length} kind(s) of token the stored transaction does not send: ${uncovered.map((h) => h.mint.toBase58()).join(", ")}.`);

  if (plan) {
    const want = armBody(plan, new PublicKey(record.nonceAccount));
    if (want.heir !== record.heir) problems.push(`The plan's primary heir is now ${want.heir}; the robot was armed for ${record.heir}. ${rearm}`);
    if (want.inactivityDays > record.inactivityDays) problems.push(`The plan now allows a release after ${want.inactivityDays} days at the soonest; the robot was armed for ${record.inactivityDays} and could fire before the vault. ${rearm}`);
    else if (want.inactivityDays < record.inactivityDays) problems.push(`The plan now allows a release after ${want.inactivityDays} days; the robot was armed for ${record.inactivityDays} and would fire later than it needs to. ${rearm}`);
  }
  return { robot, daysLeft: Math.max(0, robot.inactivityDays - robot.daysSinceTouch), problems };
}
