#!/usr/bin/env node
/**
 * lamport-heir: the command-line tool for heirs, and for anyone who wants to finish a release.
 *
 *   status   <vault or plan>                      where the vault stands; reads public data, needs no key
 *   start    <vault> --keypair FILE               open the waiting period of a vault whose owner has gone quiet
 *   finish   <vault or plan> --keypair FILE       release a vault whose waiting period is over, and sweep its tokens
 *   claim    <vault or plan> --keypair FILE       everything `finish` does, then withdraw as the heir
 *   kit      <vault> --heir ADDRESS               print an heir's claim kit (an HTML page) for an armed vault
 *   finisher --keypair FILE                       keep finishing every vault that is due
 *   pincer-arm    <vault>                         on the robot: arm Pincer1's own switch to match the vault's plan
 *   pincer-status <vault>                         on the robot: compare what was armed with the robot and the chain
 *
 * Common options:  --rpc URL   any Solana RPC endpoint (default: $LAMPORT_HEIR_RPC, else devnet)
 *                  --dry-run   ask the cluster what would happen and send nothing
 *
 * A key file is a Solana CLI keypair file. It is read to sign and pay fees; it is never printed,
 * copied or sent. The tool never asks for a seed phrase, and has no option that takes one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { type Chain, COMMITMENT } from "./chain.ts";
import { claim, type ClaimVerdict } from "./claiming.ts";
import { contingentOpensAt, type HeirRef } from "./claim.ts";
import { Finisher } from "./finisher.ts";
import { parseSalt, renderKit } from "./kit.ts";
import { RobotDaemon } from "./pincer/daemon.ts";
import { arm as armRobot, type ArmRecord, drift, type RobotPlan } from "./pincer/link.ts";
import { PROGRAMS, SHORT_CLOCKS_PROGRAMS } from "./programs.ts";
import { describeStep, finish, inspect, type Situation, start, type Step } from "./release.ts";
import { holdingsOf } from "./tokens.ts";

const DEVNET = "https://api.devnet.solana.com";
const REPOSITORY = "https://github.com/Lamport-Robotics/lamport-heir";

export class UsageError extends Error {}

export interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["rpc", "keypair", "salt", "salt-file", "heir", "label", "out", "cluster", "interval", "max-new-token-accounts", "commit", "daemon", "nonce-account", "mints", "record"]);
const BOOLEAN_FLAGS = new Set(["dry-run", "once", "short-clocks", "help"]);

/** Splits a command line into the command, its positional arguments and its `--flags`. */
export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? rest[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  return { command, positional, flags };
}

function address(text: string | undefined, what: string): PublicKey {
  if (!text) throw new UsageError(`${what} is missing`);
  try {
    return new PublicKey(text);
  } catch {
    throw new UsageError(`${what} is not a Solana address: ${text}`);
  }
}

/**
 * Reads a Solana CLI keypair file. On any problem the message names the file and never its
 * contents.
 */
export function loadKeypair(path: string | true | undefined): Keypair {
  if (typeof path !== "string") throw new UsageError("--keypair FILE is required: the key file that signs and pays the fees");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UsageError(`could not read a key file at ${path}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new UsageError(`${path} is not a Solana CLI key file (a JSON list of 64 numbers)`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  } catch {
    throw new UsageError(`${path} does not hold a valid key`);
  }
}

function salt(args: Args): Uint8Array | undefined {
  const inline = args.flags.get("salt");
  const file = args.flags.get("salt-file");
  if (typeof inline === "string" && typeof file === "string") throw new UsageError("give the salt once: --salt or --salt-file");
  if (typeof inline === "string") return parseSalt(inline);
  if (typeof file === "string") return parseSalt(readFileSync(file, "utf8"));
  return undefined;
}

function when(ts: bigint, now: bigint): string {
  const date = new Date(Number(ts) * 1000).toISOString().replace(".000Z", "Z");
  const delta = ts - now;
  const abs = delta < 0n ? -delta : delta;
  const span = abs >= 172_800n ? `${abs / 86_400n} days` : abs >= 7_200n ? `${abs / 3_600n} hours` : abs >= 120n ? `${abs / 60n} minutes` : `${abs} seconds`;
  return `${date} (${delta < 0n ? `${span} ago` : `in ${span}`})`;
}

function heirText(h: HeirRef): string {
  return h.kind === "address" ? h.address.toBase58() : h.kind === "hashed" ? "kept private (a salted hash)" : "none";
}

/** A situation in words. */
export async function statusLines(chain: Chain, s: Situation): Promise<string[]> {
  const out: string[] = [`vault    ${s.vault.toBase58()}`, `clock    ${when(s.now, s.now).split(" (")[0]}  (the cluster's clock; the programs decide by it)`];
  if (s.programs.daySecs !== 86_400n) out.push("build    TEST BUILD: a day lasts one second here");
  if (s.state === "open") {
    const st = s.status!;
    out.push(`state    open, holding ${s.vaultLamports} lamports`);
    if (st.phase === "unarmed") {
      out.push("plan     none: this vault has no succession plan");
    } else {
      out.push(`releases to  ${s.claim!.toBase58()}`);
      if (st.phase === "quiet") {
        out.push("phase    quiet: the owner has been active within the window", `         a waiting period can be opened after ${when(st.deadline!, s.now)}`);
      } else if (st.phase === "overdue") {
        out.push(`phase    overdue: the owner's window ran out at ${when(st.deadline!, s.now)}`, "         anyone may open the waiting period now (`start`); the owner can still cancel it");
      } else if (st.phase === "waiting") {
        out.push(`phase    waiting: a waiting period is open; the vault can be released at ${when(st.releaseAt!, s.now)}`, "         any signature or check-in by the owner cancels it");
      } else {
        out.push(`phase    releasable: the waiting period ended at ${when(st.releaseAt!, s.now)}`, "         anyone may release the vault now (`finish` or `claim`)");
      }
      if (st.earliestRelease !== undefined && st.phase !== "releasable") out.push(`         the soonest it could be released: ${when(st.earliestRelease, s.now)}`);
    }
  } else {
    out.push(`state    released (closed at slot ${s.closedSlot})`, `released to  ${s.claim!.toBase58()}`);
    const left = (await holdingsOf(chain, s.vault)).filter((h) => h.amount > 0n || h.withheld > 0n);
    out.push(left.length === 0 ? "tokens still at the vault's address: none" : `tokens still at the vault's address: ${left.length} account(s); \`finish\` or \`claim\` sweeps them`);
  }
  if (s.plan) {
    const p = s.plan.account;
    out.push(`plan     ${s.plan.address.toBase58()}`, `  primary heir     ${heirText(p.terms.primary)}`, `  contingent heir  ${heirText(p.terms.contingent)}`);
    if (s.planNamesAnotherVault) out.push(`  WARNING: this plan was made for another vault (${p.terms.vault.toBase58()}). It cannot be activated by this vault's release.`);
    if (p.activated) {
      out.push(`  activated        ${when(p.activatedTs, s.now)}`);
      const opens = contingentOpensAt(p);
      if (opens !== undefined) out.push(`  contingent heir may claim from ${when(opens, s.now)} (later if the primary heir claims in between)`);
      const held = (await holdingsOf(chain, s.plan.address)).filter((h) => h.amount > 0n);
      out.push(`  holds            ${s.plan.lamports} lamports (some of it the plan's own rent) and ${held.length} kind(s) of token`);
    } else {
      out.push("  not activated: the vault has not released to it yet");
    }
  } else if (s.claimHasNoKeyAndNoAccount) {
    out.push(
      "WARNING: nothing is set up at that address and no key exists for it (it is a program's address, not a wallet's).",
      "         If it is a plan's address, the plan was never created. What the vault releases there cannot be claimed",
      "         until the plan is created with exactly the terms the owner chose (init_plan), before the release or after it.",
    );
  } else if (s.claim && s.state === "open") {
    out.push("the claim address is a plain address: what the vault releases goes straight there");
  }
  return out;
}

function verdictLines(v: ClaimVerdict, now: bigint): string[] {
  switch (v.kind) {
    case "claimed":
      return [`claimed as the ${v.role} heir`];
    case "not_released":
      return [
        `nothing to claim yet: the vault has not been released (${v.phase})`,
        ...(v.earliestRelease !== undefined ? [`the soonest it could be released: ${when(v.earliestRelease, now)}`] : []),
        ...(v.phase === "overdue" ? ["the owner's window has run out; `start` opens the waiting period"] : []),
      ];
    case "released_to_address":
      return v.yours ? ["this vault releases straight to your address: there is nothing to withdraw, the sweeps deliver to you"] : [`this vault releases to ${v.address.toBase58()}, which is not the address of this key`];
    case "plan_not_created":
      return [
        `this vault releases to ${v.address.toBase58()}, where nothing is set up and for which no key exists.`,
        "If that is a plan's address, the plan was never created. It can still be created, with exactly the terms the owner chose (init_plan); then run this again.",
      ];
    case "plan_for_another_vault":
      return [`the plan at ${v.plan.toBase58()} was made for another vault and cannot be claimed through this one`];
    case "not_activated":
      return ["the plan is not activated yet; run this again"];
    case "not_an_heir":
      return v.hashedHeirs
        ? [v.saltGiven ? "this key, with this salt, is not an heir of the plan: check both against your claim kit" : "this key is not named in the plan. The plan keeps heirs private: pass your salt with --salt (it is printed in your claim kit)"]
        : ["this key is not an heir of the plan"];
    case "contingent_too_early":
      return [`you are the contingent heir and may claim from ${when(v.opensAt, now)}, unless the primary heir claims before then`];
  }
}

function summary(steps: Step[]): string[] {
  const stuck = steps.filter((s) => s.failed);
  if (stuck.length === 0) return [];
  return ["", `${stuck.length} item(s) could not be moved:`, ...stuck.map((s) => `  ${describeStep(s)}`), "They stay where they are and can be tried again later."];
}

const HELP = `lamport-heir: collect what a Lamport Vault leaves its heirs, with no help from Lamport

  status   <vault or plan>                 where the vault stands (needs no key)
  start    <vault> --keypair FILE          open the waiting period of a vault whose owner has gone quiet
  finish   <vault or plan> --keypair FILE  release a vault whose waiting period is over; sweep its tokens
  claim    <vault or plan> --keypair FILE [--salt SALT | --salt-file FILE]
                                           everything finish does, then withdraw as the heir
  kit      <vault> --heir ADDRESS [--salt SALT | --salt-file FILE] [--label NAME] [--out FILE]
                                           write an heir's claim kit (HTML to print)
  finisher --keypair FILE [--interval SECONDS] [--once] [--max-new-token-accounts N] [--short-clocks]
                                           keep finishing every vault that is due

  On the robot's own computer, for a Pincer1 (they talk to its daemon on 127.0.0.1 and need no key):
  pincer-arm    <vault> [--heir ADDRESS] [--mints MINT,MINT] [--nonce-account ADDRESS]
                                           arm the robot's own switch to match the vault's plan;
                                           you confirm with a three-second hold on the robot
  pincer-status <vault>                    compare what was armed with the robot and the chain

  --rpc URL    a Solana RPC endpoint (default: $LAMPORT_HEIR_RPC, else ${DEVNET})
  --dry-run    ask the cluster what would happen; send nothing

A key file is a Solana CLI keypair file. It signs and pays fees. It is never printed or sent.
This tool never asks for a seed phrase.`;

export interface Io {
  out: (line: string) => void;
  env: Record<string, string | undefined>;
  /** stands in for the cluster in tests */
  chain?: Chain;
  /** stands in for the robot's daemon in tests */
  daemon?: RobotDaemon;
  signal?: AbortSignal;
}

/** Runs one command. Returns the process exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.command === "--help" || args.flags.has("help")) {
    io.out(HELP);
    return 0;
  }
  const rpcFlag = args.flags.get("rpc");
  const rpc = typeof rpcFlag === "string" ? rpcFlag : (io.env.LAMPORT_HEIR_RPC ?? DEVNET);
  const chain: Chain = io.chain ?? new Connection(rpc, COMMITMENT);
  const dryRun = args.flags.has("dry-run");
  const log = (line: string) => io.out(line);

  switch (args.command) {
    case "status": {
      const s = await inspect(chain, address(args.positional[0], "the vault or plan address"));
      for (const line of await statusLines(chain, s)) io.out(line);
      return 0;
    }
    case "start": {
      const payer = loadKeypair(args.flags.get("keypair"));
      const { step } = await start(chain, payer, address(args.positional[0], "the vault address"), { dryRun });
      io.out(describeStep(step));
      return step.failed ? 1 : 0;
    }
    case "finish": {
      const payer = loadKeypair(args.flags.get("keypair"));
      const { situation, steps } = await finish(chain, payer, address(args.positional[0], "the vault or plan address"), { dryRun, log });
      if (steps.length === 0) {
        io.out("nothing to do:");
        for (const line of await statusLines(chain, situation)) io.out(`  ${line}`);
      }
      for (const line of summary(steps)) io.out(line);
      return steps.some((s) => s.failed) ? 1 : 0;
    }
    case "claim": {
      const heir = loadKeypair(args.flags.get("keypair"));
      const s = salt(args);
      const { situation, steps, verdict } = await claim(chain, heir, address(args.positional[0], "the vault or plan address"), { dryRun, log, ...(s ? { salt: s } : {}) });
      for (const line of verdictLines(verdict, situation.now)) io.out(line);
      for (const line of summary(steps)) io.out(line);
      return verdict.kind === "claimed" || (verdict.kind === "released_to_address" && verdict.yours) ? (steps.some((x) => x.failed) ? 1 : 0) : 2;
    }
    case "kit": {
      const s = await inspect(chain, address(args.positional[0], "the vault address"));
      if (s.state !== "open" || !s.claim || !s.succession) throw new UsageError("a kit is printed for an open vault with a succession plan");
      const label = args.flags.get("label");
      const cluster = args.flags.get("cluster");
      const commit = args.flags.get("commit");
      const heirSalt = salt(args);
      const html = renderKit({
        ...(typeof label === "string" ? { heirLabel: label } : {}),
        cluster: typeof cluster === "string" ? cluster : rpc.includes("devnet") ? "devnet" : rpc.includes("mainnet") ? "mainnet-beta" : rpc,
        rpcUrl: rpc,
        programs: s.programs,
        vault: s.vault,
        claim: s.claim,
        ...(s.plan ? { terms: s.plan.account.terms } : {}),
        heirAddress: address(typeof args.flags.get("heir") === "string" ? (args.flags.get("heir") as string) : undefined, "--heir ADDRESS"),
        ...(heirSalt ? { salt: heirSalt } : {}),
        windowSecs: s.succession.windowSecs,
        waitSecs: s.succession.waitSecs,
        printedAt: new Date(),
        source: { repository: REPOSITORY, commit: typeof commit === "string" ? commit : "unknown" },
      });
      const out = args.flags.get("out");
      if (typeof out === "string") {
        writeFileSync(out, html);
        io.out(`wrote ${out}`);
      } else {
        io.out(html);
      }
      return 0;
    }
    case "finisher": {
      const payer = loadKeypair(args.flags.get("keypair"));
      const programs = args.flags.has("short-clocks") ? SHORT_CLOCKS_PROGRAMS : PROGRAMS;
      const max = args.flags.get("max-new-token-accounts");
      const interval = args.flags.get("interval");
      const maxNew = typeof max === "string" ? Number(max) : undefined;
      const seconds = typeof interval === "string" ? Number(interval) : 60;
      if (maxNew !== undefined && (!Number.isInteger(maxNew) || maxNew < 0)) throw new UsageError("--max-new-token-accounts takes a whole number");
      if (!Number.isFinite(seconds) || seconds < 1) throw new UsageError("--interval takes a number of seconds, 1 or more");
      const finisher = new Finisher(chain, payer, programs, { dryRun, log, ...(maxNew !== undefined ? { maxNewTokenAccountsPerVault: maxNew } : {}) });
      io.out(`finisher: vault program ${programs.vault.toBase58()}, fees from ${payer.publicKey.toBase58()}. It releases vaults whose waiting period is over and never opens one.`);
      if (args.flags.has("once")) {
        const reports = await finisher.pass();
        if (reports.length === 0) io.out("nothing is due");
        return reports.some((r) => r.error) ? 1 : 0;
      }
      await finisher.run(seconds * 1000, io.signal ?? new AbortController().signal);
      return 0;
    }
    case "pincer-arm":
    case "pincer-status": {
      const s = await inspect(chain, address(args.positional[0], "the vault address"));
      const daemonFlag = args.flags.get("daemon");
      const daemon = io.daemon ?? new RobotDaemon(typeof daemonFlag === "string" ? daemonFlag : undefined);
      const recordFlag = args.flags.get("record");
      const recordPath = typeof recordFlag === "string" ? recordFlag : join(io.env.HOME ?? homedir(), ".lamport-heir", `pincer-${s.vault.toBase58()}.json`);
      // The robot pays the primary heir's own address: the plan's primary heir when it is named, or
      // the address the vault releases to when that is a plain address. A private heir is not on
      // chain, so the owner has to give the address.
      const heirFlag = args.flags.get("heir");
      const named = s.plan?.account.terms.primary.kind === "address" ? s.plan.account.terms.primary.address : !s.plan && s.claim ? s.claim : undefined;
      const heir = typeof heirFlag === "string" ? address(heirFlag, "--heir ADDRESS") : named;
      if (s.state !== "open" || !s.succession || !s.claim) throw new UsageError("the robot's switch is armed to match an open vault that has a succession plan");
      if (!heir) throw new UsageError("the plan keeps its primary heir private: pass their own address with --heir ADDRESS");
      const mintsFlag = args.flags.get("mints");
      const plan: RobotPlan = {
        heir,
        windowDays: Number(s.succession.windowSecs / s.programs.daySecs),
        waitDays: Number(s.succession.waitSecs / s.programs.daySecs),
        mints: typeof mintsFlag === "string" ? mintsFlag.split(",").filter(Boolean).map((m) => address(m, "a mint in --mints")) : [],
      };
      if (args.command === "pincer-arm") {
        const nonceFlag = args.flags.get("nonce-account");
        io.out(`asking the robot to arm its switch: ${plan.windowDays + plan.waitDays} days without a touch, then its wallet goes to ${heir.toBase58()}.`);
        io.out("The robot will say what it is about to arm. Hold your hand on it for three seconds to confirm.");
        const res = await armRobot(daemon, chain, plan, typeof nonceFlag === "string" ? { nonceAccount: address(nonceFlag, "--nonce-account ADDRESS") } : {});
        if (!res.ok) {
          io.out(`the robot answered: ${res.reason}`);
          return 1;
        }
        mkdirSync(dirname(recordPath), { recursive: true });
        writeFileSync(recordPath, `${JSON.stringify(res.record, null, 2)}\n`, { mode: 0o600 });
        io.out(`armed. The robot said: ${res.record.summary}`);
        io.out(`what was armed is recorded in ${recordPath} (no secret is in it).`);
        io.out("A touch on the robot resets its timer. It is not a check-in for the vault, and a check-in is not a touch.");
        if (s.plan && s.plan.account.terms.contingent.kind !== "none") io.out("The robot pays the primary heir only: the contingent heir does not cover the robot's wallet.");
        return 0;
      }
      if (!existsSync(recordPath)) throw new UsageError(`there is no record of an arming at ${recordPath}: run pincer-arm first, or pass --record FILE`);
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as ArmRecord;
      const d = await drift(daemon, chain, record, plan);
      io.out(d.robot.armed ? `the robot reports its switch armed: ${d.robot.inactivityDays} days, ${d.daysLeft.toFixed(1)} left, heir ${d.robot.heir}` : "the robot reports that its switch is not armed");
      if (d.problems.length === 0) {
        io.out("everything is as it was armed, and it matches the vault's plan.");
        return 0;
      }
      for (const p of d.problems) io.out(`- ${p}`);
      return 1;
    }
    default:
      throw new UsageError(`unknown command: ${args.command}`);
  }
}

// Run when invoked directly (not when imported by the tests).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());
  main(process.argv.slice(2), { out: (line) => console.log(line), env: process.env, signal: stop.signal }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      if (e instanceof UsageError) {
        console.error(`${e.message}\n\n${HELP}`);
        process.exit(64);
      }
      console.error((e as Error).message);
      process.exit(1);
    },
  );
}
