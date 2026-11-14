/**
 * Reading where a vault stands, and finishing what the chain already allows.
 *
 * Nothing in this file can move funds anywhere but where the vault's owner signed for them to go,
 * and nothing in it needs a particular key: `execute_succession`, `activate`, `sweep_closed` and
 * `sweep_closed_sol` are open to anyone, and each sends funds only to the address in the vault's
 * plan or tombstone. The key passed in pays fees and, where an heir has no token account for a
 * mint yet, that account's rent.
 *
 * `finish` never opens a waiting period. Opening one is a person's decision ({@link start}).
 */
import {
  associatedTokenAddress,
  decodeTombstone,
  decodeVault,
  executeSuccessionInstruction,
  isLiveVault,
  isTombstone,
  startSuccessionInstruction,
  type SuccessionState,
  type SuccessionStatus,
  successionStatus,
  sweepClosedInstruction,
  sweepClosedSolInstruction,
  TOMBSTONE_ACCOUNT_SIZE,
} from "@lamport-robotics/vault";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { type AnySigner, type Chain, clusterTime, COMMITMENT, reasonFromLogs, send, simulate } from "./chain.ts";
import { activateInstruction, decodePlan, isPlan, type PlanAccount } from "./claim.ts";
import { type Programs, programsForClaimProgram, programsForVaultProgram } from "./programs.ts";
import { harvestInstruction, type Holding, holdingsOf, hookAccounts, type MintFacts, mintFacts } from "./tokens.ts";

/** Where a vault stands. */
export interface Situation {
  programs: Programs;
  vault: PublicKey;
  /** `open`: a live vault. `released`: a tombstone, left by a release or by the owner's own `Close`. */
  state: "open" | "released";
  /** the cluster's clock when this was read, unix seconds */
  now: bigint;
  /** open vaults: the plan and its clock */
  succession?: SuccessionState;
  /** open vaults: the phase and the dates, at `now` */
  status?: SuccessionStatus;
  /** released vaults: the slot the vault closed at */
  closedSlot?: bigint;
  /** where the vault releases to, or released to. Absent for an open vault with no plan. */
  claim?: PublicKey;
  /** the claim address, when it is a plan of the claim program */
  plan?: { address: PublicKey; account: PlanAccount; lamports: number };
  /**
   * The claim address is a plan made for a different vault. Such a plan can never be activated by
   * this vault's release, so nothing sent to it for this vault could be claimed.
   */
  planNamesAnotherVault?: boolean;
  /**
   * Nothing a program set up is at the claim address, and no key exists for it either (it is off
   * the curve, as every program-derived address is). If it is the address of a plan, the plan was
   * never created. What the vault releases there cannot be claimed until `init_plan` creates the
   * plan, which the claim program allows before the release and after it.
   */
  claimHasNoKeyAndNoAccount?: boolean;
  /** lamports at the vault's address */
  vaultLamports: number;
}

/**
 * Reads the vault at `address`, or the vault a plan at `address` is for. Throws when the address
 * holds neither.
 */
export async function inspect(chain: Chain, address: PublicKey): Promise<Situation> {
  let info = await chain.getAccountInfo(address, COMMITMENT);
  if (!info) throw new Error(`there is no account at ${address.toBase58()}`);
  let vault = address;
  if (programsForClaimProgram(info.owner) && isPlan(new Uint8Array(info.data))) {
    vault = decodePlan(new Uint8Array(info.data)).terms.vault;
    info = await chain.getAccountInfo(vault, COMMITMENT);
    if (!info) throw new Error(`the plan at ${address.toBase58()} is for vault ${vault.toBase58()}, and there is no account there`);
  }
  const programs = programsForVaultProgram(info.owner);
  if (!programs) throw new Error(`${vault.toBase58()} is not an account of a Heir-enabled vault program (it is owned by ${info.owner.toBase58()})`);
  const data = new Uint8Array(info.data);
  const now = await clusterTime(chain);

  const base = { programs, vault, now, vaultLamports: info.lamports };
  let situation: Situation;
  if (isTombstone(data)) {
    const tomb = decodeTombstone(data);
    situation = { ...base, state: "released", closedSlot: tomb.closedSlot, claim: tomb.heir };
  } else if (isLiveVault(data)) {
    const succession = decodeVault(data).succession;
    if (!succession) throw new Error(`${vault.toBase58()} is a vault with no succession block`);
    const armed = !succession.claim.equals(PublicKey.default);
    situation = { ...base, state: "open", succession, status: successionStatus(succession, now, { daySecs: programs.daySecs }), ...(armed ? { claim: succession.claim } : {}) };
  } else {
    throw new Error(`${vault.toBase58()} is an account of the vault program, but neither a vault nor a tombstone`);
  }

  if (situation.claim) {
    const claimInfo = await chain.getAccountInfo(situation.claim, COMMITMENT);
    if (claimInfo && claimInfo.owner.equals(programs.claim) && isPlan(new Uint8Array(claimInfo.data))) {
      const account = decodePlan(new Uint8Array(claimInfo.data));
      situation.plan = { address: situation.claim, account, lamports: claimInfo.lamports };
      if (!account.terms.vault.equals(vault)) situation.planNamesAnotherVault = true;
    } else if ((!claimInfo || (claimInfo.owner.equals(SystemProgram.programId) && claimInfo.data.length === 0)) && !PublicKey.isOnCurve(situation.claim.toBytes())) {
      situation.claimHasNoKeyAndNoAccount = true;
    }
  }
  return situation;
}

/** One thing done, or not done, on the way to finishing a release or a claim. */
export interface Step {
  kind: "start_succession" | "execute_succession" | "activate" | "sweep" | "sweep_sol" | "claim_sol" | "claim_token";
  /** the token account concerned */
  account?: PublicKey;
  mint?: PublicKey;
  /** tokens (base units) or lamports concerned */
  amount?: bigint;
  /** sent and confirmed */
  signature?: string;
  /** the cluster would accept it; not sent because this was a dry run */
  wouldSend?: true;
  /** not attempted, and why */
  skipped?: string;
  /** the cluster refuses it, and why: these funds did not move */
  failed?: string;
}

export interface FinishOptions {
  /** Ask the cluster what would happen and send nothing. */
  dryRun?: boolean;
  /**
   * Also sweep token accounts that hold nothing. Sweeping one closes it and sends its rent to the
   * claim address, and creates the claim address's own account for that mint if it has none.
   * Default: true.
   */
  sweepEmpty?: boolean;
  /**
   * The most token accounts this run may create for the claim address. Each costs the payer about
   * 0.002 SOL of rent that goes to the heirs, not back to the payer. A service that pays for
   * strangers sets a limit; an heir finishing their own release does not. Default: no limit.
   */
  maxNewTokenAccounts?: number;
  /** Called with a line of progress as each step is decided. */
  log?: (line: string) => void;
}

/** Empty token accounts `execute_succession` closes in passing. More fit in later sweeps. */
const MAX_CLOSED_IN_RELEASE = 12;
/** Compute budget for a transaction that may create a token account, move tokens through extensions, and close. */
const SWEEP_COMPUTE_UNITS = 400_000;

async function attempt(chain: Chain, payer: AnySigner, extraSigners: AnySigner[], instructions: TransactionInstruction[], step: Step, opts: { dryRun?: boolean | undefined; computeUnits?: number }): Promise<Step> {
  const sim = await simulate(chain, payer.publicKey, instructions, opts.computeUnits);
  if (!sim.ok) return { ...step, failed: reasonFromLogs(sim.logs) ?? sim.error ?? "the cluster refused it" };
  if (opts.dryRun) return { ...step, wouldSend: true };
  return { ...step, signature: await send(chain, [payer, ...extraSigners], instructions, opts.computeUnits) };
}

export { attempt as attemptStep };

function describe(step: Step): string {
  const what = [step.kind, step.mint ? `mint ${step.mint.toBase58()}` : "", step.account ? `account ${step.account.toBase58()}` : "", step.amount !== undefined ? `amount ${step.amount}` : ""].filter(Boolean).join(" ");
  if (step.signature) return `${what}: done (${step.signature})`;
  if (step.wouldSend) return `${what}: would be sent`;
  if (step.failed) return `${what}: NOT DONE, the cluster refuses it: ${step.failed}`;
  return `${what}: skipped, ${step.skipped}`;
}

export { describe as describeStep };

/**
 * Opens the waiting period of an overdue vault. Anyone may, and it moves nothing: it starts a
 * public clock that the owner cancels with any signature or check-in.
 *
 * This is the one step that is a person's decision ("I believe the owner is gone"), which is why
 * it is its own call and {@link finish} never makes it.
 */
export async function start(chain: Chain, payer: AnySigner, vault: PublicKey, opts: { dryRun?: boolean } = {}): Promise<{ situation: Situation; step: Step }> {
  const situation = await inspect(chain, vault);
  const step: Step = { kind: "start_succession" };
  if (situation.state !== "open") return { situation, step: { ...step, skipped: "the vault has already been released" } };
  const phase = situation.status?.phase;
  if (phase !== "overdue") {
    const why =
      phase === "unarmed" ? "the vault has no succession plan" : phase === "quiet" ? `the owner was active within the window; a waiting period can open after ${situation.status?.deadline}` : "a waiting period is already open";
    return { situation, step: { ...step, skipped: why } };
  }
  const ix = startSuccessionInstruction({ programId: situation.programs.vault, vault: situation.vault });
  return { situation, step: await attempt(chain, payer, [], [ix], step, opts) };
}

/**
 * Does every permissionless thing a vault is ready for, in order:
 *
 * 1. `execute_succession`, when the waiting period has run out;
 * 2. `activate`, when the vault released to a plan of the claim program;
 * 3. `sweep_closed` for each token account the vault still owns, harvesting withheld transfer
 *    fees first where an account has them;
 * 4. `sweep_closed_sol`, when SOL reached the vault's address after it closed.
 *
 * Each transaction is simulated first. One the cluster refuses is reported with the reason and the
 * rest go on: a token that cannot move never holds back the SOL or the other tokens.
 *
 * For a vault that is not ready (no plan, the owner active, a waiting period still running) it
 * does nothing and says so in `situation`.
 */
export async function finish(chain: Chain, payer: AnySigner, address: PublicKey, opts: FinishOptions = {}): Promise<{ situation: Situation; steps: Step[] }> {
  const steps: Step[] = [];
  const record = (s: Step) => {
    steps.push(s);
    opts.log?.(describe(s));
  };
  let situation = await inspect(chain, address);
  const { programs, vault } = situation;

  if (situation.state === "open") {
    if (situation.status?.phase !== "releasable" || !situation.claim) return { situation, steps };
    const claim = situation.claim;
    const empties = (await holdingsOf(chain, vault)).filter((h) => h.amount === 0n && h.withheld === 0n).slice(0, MAX_CLOSED_IN_RELEASE);
    const build = (close: Holding[]) =>
      executeSuccessionInstruction({ programId: programs.vault, vault, claim, closeTokenAccounts: close.map((h) => ({ account: h.address, tokenProgram: h.tokenProgram })) });
    // An account that cannot be closed after all must not hold the release back: try without them.
    let ix = build(empties);
    if (empties.length > 0 && !(await simulate(chain, payer.publicKey, [ix], SWEEP_COMPUTE_UNITS)).ok) ix = build([]);
    const released = await attempt(chain, payer, [], [ix], { kind: "execute_succession", amount: BigInt(situation.vaultLamports) }, { dryRun: opts.dryRun, computeUnits: SWEEP_COMPUTE_UNITS });
    record(released);
    // Everything after this needs the tombstone, which a dry run does not leave.
    if (!released.signature) return { situation, steps };
    situation = await inspect(chain, vault);
  }

  const claim = situation.claim!;
  if (situation.plan && !situation.plan.account.activated) {
    if (situation.planNamesAnotherVault) {
      record({ kind: "activate", skipped: `the plan at ${claim.toBase58()} is for another vault (${situation.plan.account.terms.vault.toBase58()}) and cannot be activated by this one` });
    } else {
      const ix = activateInstruction({ claimProgram: programs.claim, plan: claim, vault });
      const activated = await attempt(chain, payer, [], [ix], { kind: "activate" }, { dryRun: opts.dryRun });
      record(activated);
      if (activated.signature) situation = await inspect(chain, vault);
    }
  }

  let created = 0;
  const mints = new Map<string, MintFacts>();
  for (const h of await holdingsOf(chain, vault)) {
    const step: Step = { kind: "sweep", account: h.address, mint: h.mint, amount: h.amount };
    if (h.amount === 0n && h.withheld === 0n && opts.sweepEmpty === false) {
      record({ ...step, skipped: "the account is empty" });
      continue;
    }
    try {
      const key = h.mint.toBase58();
      const mint = mints.get(key) ?? (await mintFacts(chain, h.mint));
      mints.set(key, mint);
      const destination = associatedTokenAddress(claim, h.mint, h.tokenProgram);
      const exists = (await chain.getAccountInfo(destination, COMMITMENT)) !== null;
      if (!exists && opts.maxNewTokenAccounts !== undefined && created >= opts.maxNewTokenAccounts) {
        record({ ...step, skipped: `the claim address has no account for this mint and this run's limit of ${opts.maxNewTokenAccounts} new token accounts is used up; anyone can sweep it later` });
        continue;
      }
      const extraAccounts = await hookAccounts(chain, mint, { source: h.address, destination, authority: vault, amount: h.amount });
      const sweep = sweepClosedInstruction({ programId: programs.vault, payer: payer.publicKey, vault, heir: claim, mint: h.mint, vaultTokenAccount: h.address, tokenProgram: h.tokenProgram, extraAccounts });
      const instructions = h.withheld > 0n ? [harvestInstruction(h), sweep.instruction] : [sweep.instruction];
      const done = await attempt(chain, payer, [], instructions, step, { dryRun: opts.dryRun, computeUnits: SWEEP_COMPUTE_UNITS });
      if (!exists && (done.signature || done.wouldSend)) created += 1;
      record(done);
    } catch (e) {
      record({ ...step, failed: (e as Error).message });
    }
  }

  const tombstoneRent = await chain.getMinimumBalanceForRentExemption(TOMBSTONE_ACCOUNT_SIZE, COMMITMENT);
  const late = (await chain.getAccountInfo(vault, COMMITMENT))?.lamports ?? 0;
  if (late > tombstoneRent) {
    const ix = sweepClosedSolInstruction({ programId: programs.vault, vault, heir: claim });
    record(await attempt(chain, payer, [], [ix], { kind: "sweep_sol", amount: BigInt(late - tombstoneRent) }, { dryRun: opts.dryRun }));
  }
  return { situation: steps.some((s) => s.signature) ? await inspect(chain, vault) : situation, steps };
}
