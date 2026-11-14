/**
 * One whole cycle, start to finish, against a cluster that has the `short-clocks` test programs
 * deployed (a day lasts a second in them): the gate of milestone 4.
 *
 *   arm        a new vault with SOL and a token in it; a plan with two heirs, each of whom proves
 *              their address; the owner's signature that arms it, with a check-in key
 *   go quiet   one check-in, then nothing
 *   warn       the reminder service, reading the chain, warns the owner and then the contact
 *   start      a stranger opens the waiting period
 *   release    the finisher releases the vault, activates the plan
 *   sweep      and sweeps the token to the plan
 *   claim      the first heir withdraws everything
 *
 *   node scripts/cycle.ts --rpc URL --keypair FILE [--out report.json]
 *
 * The key file pays for it: about 0.1 SOL of fees and rent on devnet. What it puts in the vault
 * comes back to it at the end. Every other key is made here and thrown away; none is printed or
 * written anywhere. Nothing is sent by email: the reminder service is given a channel that keeps
 * the messages, and the report lists them.
 *
 * Runs the same against a local validator (tools/e2e/cycle.e2e.ts does, in CI).
 */
import { createPrivateKey, sign as edSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { LMS_SHA256_M32_H5, LmsPrivateKey, randomKeyMaterial } from "@lamport-robotics/lms";
import { TOKEN_PROGRAM_ID, VaultSigner } from "@lamport-robotics/vault";
import { createMint, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { clusterTime, send } from "../src/chain.ts";
import { checkin, type CheckinSigner } from "../src/checkin.ts";
import { acceptanceMessage, acceptanceProofInstruction, initPlanInstruction, type Terms } from "../src/claim.ts";
import { claim } from "../src/claiming.ts";
import { Finisher } from "../src/finisher.ts";
import { type Programs, SHORT_CLOCKS_PROGRAMS } from "../src/programs.ts";
import { describeStep, inspect, start } from "../src/release.ts";
import { type Message } from "../src/reminders/messages.ts";
import { MemoryStore, ReminderService } from "../src/reminders/service.ts";

export interface CycleOptions {
  rpcUrl: string;
  /** pays fees and rent, and plays the stranger who opens the waiting period and the finisher */
  payer: Keypair;
  programs?: Programs;
  log?: (line: string) => void;
}

export interface CycleReport {
  rpcUrl: string;
  genesisHash: string;
  programs: { vault: string; claim: string };
  vault: string;
  plan: string;
  firstHeir: string;
  secondHeir: string;
  mint: string;
  /** what happened, in order: the step, the cluster's clock when it was done, and the transactions */
  steps: { step: string; at: string; what: string; signatures: string[] }[];
  /** what the reminder service sent, in order */
  reminders: { at: string; to: string; subject: string }[];
  /** what the first heir held at the end, of what the vault held */
  delivered: { lamportsInVault: string; lamportsClaimed: string; tokensInVault: string; tokensClaimed: string };
}

const WINDOW = 90n; // days of the test clock: the shortest window the program accepts
const WAIT = 30n; //   and the shortest waiting period
const CONTINGENT_DELAY = 30n;
const SOL_IN_VAULT = 50_000_000; // 0.05 SOL
const TOKENS_IN_VAULT = 1_000_000n;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (ts: bigint) => new Date(Number(ts) * 1000).toISOString().replace(".000Z", "Z");

/** an Ed25519 signature by `key` over `message`, as a wallet's "sign message" gives */
function signBytes(key: Keypair, message: Uint8Array): Uint8Array {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(key.secretKey.subarray(0, 32))]);
  return new Uint8Array(edSign(null, Buffer.from(message), createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })));
}

export async function runCycle(opts: CycleOptions): Promise<CycleReport> {
  const programs = opts.programs ?? SHORT_CLOCKS_PROGRAMS;
  const log = opts.log ?? (() => {});
  const { payer } = opts;
  const chain = new Connection(opts.rpcUrl, "confirmed");

  for (const [name, id] of [["vault", programs.vault], ["claim", programs.claim]] as const) {
    const info = await chain.getAccountInfo(id, "confirmed");
    if (!info?.executable) throw new Error(`the ${name} program ${id.toBase58()} is not deployed on ${opts.rpcUrl}`);
  }
  if (programs.daySecs !== 1n) throw new Error("this run needs the short-clocks test programs: with real durations it would take four months");
  const before = await chain.getBalance(payer.publicKey, "confirmed");
  if (before < 300_000_000) throw new Error(`the paying key ${payer.publicKey.toBase58()} holds ${before / 1e9} SOL; the run needs 0.3 to be safe`);

  const report: CycleReport = {
    rpcUrl: opts.rpcUrl, genesisHash: await chain.getGenesisHash(), programs: { vault: programs.vault.toBase58(), claim: programs.claim.toBase58() },
    vault: "", plan: "", firstHeir: "", secondHeir: "", mint: "", steps: [], reminders: [],
    delivered: { lamportsInVault: String(SOL_IN_VAULT), lamportsClaimed: "0", tokensInVault: TOKENS_IN_VAULT.toString(), tokensClaimed: "0" },
  };
  const done = async (step: string, what: string, signatures: string[] = []) => {
    const at = iso(await clusterTime(chain));
    report.steps.push({ step, at, what, signatures });
    log(`${at}  ${step.padEnd(8)} ${what}${signatures.length ? `\n${" ".repeat(30)}${signatures.join(`\n${" ".repeat(30)}`)}` : ""}`);
  };
  const until = async (ts: bigint) => { while ((await clusterTime(chain)) < ts) await sleep(1_000); };

  // ---- the people. every key but the payer's is made here and gone when the run ends ----
  const first = Keypair.generate(), second = Keypair.generate(), checkinKey = Keypair.generate();
  const checkinSigner: CheckinSigner = { publicKey: checkinKey.publicKey, sign: async (m) => signBytes(checkinKey, m) };
  report.firstHeir = first.publicKey.toBase58();
  report.secondHeir = second.publicKey.toBase58();

  // ---- arm ----
  const key = LmsPrivateKey.generate(randomKeyMaterial(LMS_SHA256_M32_H5));
  const owner = new VaultSigner({ rpc: chain, programId: programs.vault, key, payer, journal: "ephemeral", commitment: "confirmed" });
  const created = await owner.createVault();
  const vault = new PublicKey(created.vault.toBase58());
  report.vault = vault.toBase58();
  const funded = await send(chain, [payer], [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: SOL_IN_VAULT }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: first.publicKey, lamports: 20_000_000 }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: checkinKey.publicKey, lamports: 1_000_000 }),
  ]);
  const mint = await createMint(chain, payer, payer.publicKey, null, 6, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
  report.mint = mint.toBase58();
  const held = await getOrCreateAssociatedTokenAccount(chain, payer, mint, vault, true, "confirmed", { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
  const minted = await mintTo(chain, payer, mint, held.address, payer, TOKENS_IN_VAULT, [], { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
  await done("arm", `a vault ${vault.toBase58()} holding 0.05 SOL and 1 000 000 units of a token`, [created.signature, funded, minted]);

  const terms: Terms = { vault, primary: { kind: "address", address: first.publicKey }, contingent: { kind: "address", address: second.publicKey }, contingentDelaySecs: CONTINGENT_DELAY * programs.daySecs };
  const init = initPlanInstruction({ claimProgram: programs.claim, payer: payer.publicKey, terms });
  const sentence = new TextEncoder().encode(acceptanceMessage(init.plan));
  const planned = await send(chain, [payer], [
    acceptanceProofInstruction(first.publicKey, signBytes(first, sentence), sentence),
    acceptanceProofInstruction(second.publicKey, signBytes(second, sentence), sentence),
    init.instruction,
  ]);
  report.plan = init.plan.toBase58();
  await done("arm", `a plan ${init.plan.toBase58()} naming two heirs, each of whom signed their acceptance`, [planned]);

  // the reminder service, as it would run on a server: it reads the chain and is told nothing
  const store = new MemoryStore();
  store.subs.push({ vault: vault.toBase58(), label: "cycle", owner: [{ channel: "email", to: "owner@example.invalid" }], contacts: [{ channel: "email", to: "contact@example.invalid" }] });
  const reminders = new ReminderService(chain, store, {
    email: { send: async (to: string, message: Message) => { const at = iso(await clusterTime(chain)); report.reminders.push({ at, to, subject: message.subject }); log(`${at}  ${"warn".padEnd(8)} to ${to}: ${message.subject}`); } },
  });
  await reminders.tick(); // the vault as it is before the plan: what the next tick is compared with

  const armed = await owner.execute({ kind: "SetSuccession", claim: init.plan, windowSecs: WINDOW * programs.daySecs, waitSecs: WAIT * programs.daySecs, checkinKey: checkinKey.publicKey, contactKey: PublicKey.default });
  await done("arm", `the owner's signature: release to the plan after ${WINDOW} days of silence and a ${WAIT}-day waiting period (one-time key ${armed.q})`, (armed as { signatures?: string[] }).signatures ?? []);
  await reminders.tick();

  // ---- go quiet ----
  await sleep(5_000);
  const c = await checkin(chain, checkinSigner, vault);
  if (!c.sent) throw new Error(`the check-in was not sent: ${c.readiness.ok ? "no reason given" : c.readiness.detail}`);
  await done("quiet", "one check-in, with the check-in key alone, which moves the deadline; then nothing more from the owner", [c.signature]);

  // ---- warn ----
  const deadline = (await inspect(chain, vault)).status!.deadline!;
  log(`${" ".repeat(22)}the owner's window runs out at ${iso(deadline)}`);
  while ((await clusterTime(chain)) <= deadline) { await reminders.tick(); await sleep(1_500); }
  await reminders.tick();
  // the service ticks every second or two here, and a "day" lasts one: a stage that falls between two ticks is skipped
  const said = (to: string) => report.reminders.filter((r) => r.to.startsWith(to)).map((r) => r.subject.replace("Lamport Heir: ", "")).join("; ");
  await done("warn", `the reminder service warned the owner (${said("owner")}) and the trusted contact (${said("contact")})`);

  // ---- start ----
  const opened = await start(chain, payer, vault);
  if (!opened.step.signature) throw new Error(`the waiting period could not be opened: ${describeStep(opened.step)}`);
  await done("start", "a stranger opens the waiting period; it moves nothing", [opened.step.signature]);
  const releaseAt = (await inspect(chain, vault)).status!.releaseAt!;
  while ((await clusterTime(chain)) < releaseAt) { await reminders.tick(); await sleep(1_500); }

  // ---- release, sweep ----
  await until(releaseAt);
  const finisher = new Finisher(chain, payer, programs, {});
  const passes = (await finisher.pass()).filter((r) => r.vault.equals(vault));
  const finished = passes.flatMap((r) => r.steps);
  if (passes.some((r) => r.error) || !finished.some((s) => s.kind === "execute_succession" && s.signature)) throw new Error(`the finisher did not release the vault: ${passes.map((r) => r.error ?? r.steps.map(describeStep).join("; ")).join(" | ")}`);
  await done("release", "the finisher releases the vault to the plan and the plan records it", finished.filter((s) => (s.kind === "execute_succession" || s.kind === "activate") && s.signature).map((s) => s.signature!));
  await done("sweep", "the finisher moves the token from the vault's address to the plan", finished.filter((s) => s.kind === "sweep" && s.signature).map((s) => s.signature!));
  await reminders.tick();

  // ---- claim ----
  const heirBefore = await chain.getBalance(first.publicKey, "confirmed");
  const claimed = await claim(chain, first, vault);
  if (claimed.verdict.kind !== "claimed") throw new Error(`the first heir could not claim: ${claimed.verdict.kind}`);
  const heirAfter = await chain.getBalance(first.publicKey, "confirmed");
  const tokens = (await getAccount(chain, getAssociatedTokenAddressSync(mint, first.publicKey, false, TOKEN_PROGRAM_ID), "confirmed", TOKEN_PROGRAM_ID)).amount;
  report.delivered.lamportsClaimed = String(heirAfter - heirBefore);
  report.delivered.tokensClaimed = tokens.toString();
  await done("claim", `the first heir withdraws: ${(heirAfter - heirBefore) / 1e9} SOL more than before (the vault's SOL and rent, less the fees of claiming) and ${tokens} units of the token`, claimed.steps.filter((s) => s.signature).map((s) => s.signature!));
  if (tokens !== TOKENS_IN_VAULT) throw new Error(`the heir holds ${tokens} units of the token, the vault held ${TOKENS_IN_VAULT}`);
  if (heirAfter - heirBefore < SOL_IN_VAULT) throw new Error(`the heir gained ${heirAfter - heirBefore} lamports, the vault held ${SOL_IN_VAULT}`);

  // test SOL is scarce: what the heir holds goes back to the key that paid
  const back = heirAfter - 5_000;
  if (back > 0) await send(chain, [first], [SystemProgram.transfer({ fromPubkey: first.publicKey, toPubkey: payer.publicKey, lamports: back })]);
  const after = await chain.getBalance(payer.publicKey, "confirmed");
  log(`\nthe run cost the paying key ${(before - after) / 1e9} SOL`);
  return report;
}

async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const rpcUrl = flag("rpc"), keyFile = flag("keypair"), out = flag("out");
  if (!rpcUrl || !keyFile) { console.error("usage: node scripts/cycle.ts --rpc URL --keypair FILE [--out report.json]"); return 2; }
  let payer: Keypair;
  try { payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8")))); }
  catch { console.error(`${keyFile} is not a readable Solana key file`); return 2; }
  const report = await runCycle({ rpcUrl, payer, log: (l) => console.log(l) });
  if (out) { writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`); console.log(`\nwrote ${out}`); }
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`\nthe cycle stopped: ${(e as Error).message}`); process.exit(1); });
}
