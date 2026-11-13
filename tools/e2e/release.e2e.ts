/**
 * A release from end to end, on a local validator, with nothing but this repository's tools.
 *
 * Both programs run as their `short-clocks` test builds, in which a "day" lasts one second, so the
 * 90 days of silence, the 30 days of waiting and the 30-day contingent delay all pass during the
 * run (e2e/validator.ts). Every transaction here is a real one through the validator's RPC.
 *
 * Four vaults are armed together and go quiet together:
 *
 *   A  releases to a plan with a named primary and a named contingent heir.
 *      The finisher releases it; the primary heir claims with the command printed in their kit.
 *   B  releases straight to an heir's address. No finisher touches it: the heir's own `claim`
 *      releases it, sweeps it and ends with everything at their address.
 *   C  releases to a plan whose heirs are kept private (salted hashes). The primary never claims;
 *      the contingent heir claims once the delay has passed, with the salt from their kit.
 *   D  has an owner who is alive: a check-in cancels the waiting period, and nothing is released.
 *
 * Each vault holds SOL, an SPL token, a Token-2022 token with a transfer fee (received by transfer,
 * so its account carries withheld fees), a non-transferable Token-2022 token, and an empty token
 * account. The non-transferable token is the one thing that must stay behind, reported as such.
 *
 * Every key is generated here and dropped at the end; key files live in a temporary directory that
 * is removed.
 */
import { createPrivateKey, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LMS_SHA256_M32_H5, LmsPrivateKey, randomKeyMaterial } from "@lamport-robotics/lms";
import { checkinInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, VaultSigner } from "@lamport-robotics/vault";
import {
  createInitializeMintInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMint,
  ExtensionType,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transferCheckedWithFee,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clusterTime, send } from "../src/chain.ts";
import { acceptanceMessage, acceptanceProofInstruction, decodePlan, hashedHeir, initPlanInstruction, type Terms } from "../src/claim.ts";
import { claim } from "../src/claiming.ts";
import { main } from "../src/cli.ts";
import { Finisher, releasableVaults } from "../src/finisher.ts";
import { formatSalt } from "../src/kit.ts";
import { SHORT_CLOCKS_PROGRAMS as programs } from "../src/programs.ts";
import { finish, inspect, start } from "../src/release.ts";
import { holdingsOf } from "../src/tokens.ts";
import { RPC_URL } from "./validator.ts";

const WINDOW = 90n; // 90 test-days
const WAIT = 30n;
const CONTINGENT_DELAY = 30n;
const SOL_IN_VAULT = 0.3 * LAMPORTS_PER_SOL;
const TOKEN_A = 1_000_000n;
const FEE_SENT = 2_000_000n; // 1% is withheld on arrival: the vault's account shows 1 980 000
const FEE_IN_VAULT = 1_980_000n;
const NON_TRANSFERABLE = 5n;

const connection = new Connection(RPC_URL, "confirmed");
const dir = mkdtempSync(join(tmpdir(), "lamport-heir-e2e-keys-"));
const funder = Keypair.generate();
const finisherKey = Keypair.generate();
const stranger = Keypair.generate();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the cluster's own clock has reached `ts`. */
async function until(ts: bigint): Promise<void> {
  while ((await clusterTime(connection)) < ts) await sleep(400);
}

function keyFile(name: string, key: Keypair): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(Array.from(key.secretKey)), { mode: 0o600 });
  return path;
}

/** Runs the command-line tool in this process, as `node src/cli.ts <argv>` would. */
async function cli(...argv: string[]): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await main([...argv, "--rpc", RPC_URL], { out: (l) => lines.push(l), env: {} });
  return { code, text: lines.join("\n") };
}

async function airdrop(to: PublicKey, sol: number): Promise<void> {
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latest });
}

async function pay(to: PublicKey, lamports: number): Promise<void> {
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports })), [funder]);
}

const balance = async (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): Promise<bigint | undefined> => {
  try {
    return (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner, true, tokenProgram), "confirmed", tokenProgram)).amount;
  } catch {
    return undefined; // no such account
  }
};

interface Mints {
  tokenA: PublicKey;
  fee: PublicKey;
  nonTransferable: PublicKey;
  empty: PublicKey;
}
let mints: Mints;

async function token2022Mint(extension: "fee" | "non-transferable"): Promise<PublicKey> {
  const mint = Keypair.generate();
  const types = [extension === "fee" ? ExtensionType.TransferFeeConfig : ExtensionType.NonTransferable];
  const space = getMintLen(types);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: mint.publicKey, space, lamports: await connection.getMinimumBalanceForRentExemption(space), programId: TOKEN_2022_PROGRAM_ID }),
    extension === "fee"
      ? createInitializeTransferFeeConfigInstruction(mint.publicKey, funder.publicKey, funder.publicKey, 100, 1_000_000_000n, TOKEN_2022_PROGRAM_ID) // 1%
      : createInitializeNonTransferableMintInstruction(mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, 6, funder.publicKey, null, TOKEN_2022_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, tx, [funder, mint]);
  return mint.publicKey;
}

interface Vault {
  name: string;
  address: PublicKey;
  signer: VaultSigner;
  checkinKey: Keypair;
}

/** A new vault with everything in it that a release has to deal with. */
async function fundedVault(name: string): Promise<Vault> {
  const key = LmsPrivateKey.generate(randomKeyMaterial(LMS_SHA256_M32_H5));
  const signer = new VaultSigner({ rpc: connection, programId: programs.vault, key, payer: funder, journal: "ephemeral", commitment: "confirmed" });
  const { vault } = await signer.createVault();
  const address = new PublicKey(vault.toBase58());
  await pay(address, SOL_IN_VAULT);

  const a = await getOrCreateAssociatedTokenAccount(connection, funder, mints.tokenA, address, true, "confirmed", undefined, TOKEN_PROGRAM_ID);
  await mintTo(connection, funder, mints.tokenA, a.address, funder, TOKEN_A, [], undefined, TOKEN_PROGRAM_ID);

  // The fee-bearing token arrives by transfer, so the vault's account ends up with fees withheld in it.
  const from = await getOrCreateAssociatedTokenAccount(connection, funder, mints.fee, funder.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
  await mintTo(connection, funder, mints.fee, from.address, funder, FEE_SENT, [], undefined, TOKEN_2022_PROGRAM_ID);
  const f = await getOrCreateAssociatedTokenAccount(connection, funder, mints.fee, address, true, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
  await transferCheckedWithFee(connection, funder, from.address, mints.fee, f.address, funder, FEE_SENT, 6, FEE_SENT / 100n, [], undefined, TOKEN_2022_PROGRAM_ID);

  const n = await getOrCreateAssociatedTokenAccount(connection, funder, mints.nonTransferable, address, true, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
  await mintTo(connection, funder, mints.nonTransferable, n.address, funder, NON_TRANSFERABLE, [], undefined, TOKEN_2022_PROGRAM_ID);

  await getOrCreateAssociatedTokenAccount(connection, funder, mints.empty, address, true, "confirmed", undefined, TOKEN_PROGRAM_ID);
  return { name, address, signer, checkinKey: Keypair.generate() };
}

async function arm(v: Vault, claimAddress: PublicKey): Promise<void> {
  await v.signer.execute({ kind: "SetSuccession", claim: claimAddress, windowSecs: WINDOW, waitSecs: WAIT, checkinKey: v.checkinKey.publicKey, contactKey: PublicKey.default });
}

/** An Ed25519 signature by `key` over `message`, as a wallet's "sign message" would produce. */
function signMessage(key: Keypair, message: Uint8Array): Uint8Array {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(key.secretKey.subarray(0, 32))]);
  return new Uint8Array(edSign(null, Buffer.from(message), createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })));
}

// the people
const a = { primary: Keypair.generate(), contingent: Keypair.generate() };
const b = { heir: Keypair.generate() };
const c = { primary: Keypair.generate(), contingent: Keypair.generate(), saltPrimary: Uint8Array.from({ length: 32 }, (_, i) => 200 - i), saltContingent: Uint8Array.from({ length: 32 }, (_, i) => i + 9) };
const d = { heir: Keypair.generate() };

let vaultA: Vault, vaultB: Vault, vaultC: Vault, vaultD: Vault;
let planA: PublicKey, planC: PublicKey;
let kitA = "";
let kitC = "";
/** the latest moment any of the vaults was signed for: their windows have all run out `WINDOW` after it */
let lastSigned = 0n;
let waitStarted = 0n;

beforeAll(async () => {
  await airdrop(funder.publicKey, 200);
  for (const k of [finisherKey, stranger, a.primary, a.contingent, b.heir, c.primary, c.contingent, d.heir]) await pay(k.publicKey, 0.2 * LAMPORTS_PER_SOL);

  mints = {
    tokenA: await createMint(connection, funder, funder.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID),
    fee: await token2022Mint("fee"),
    nonTransferable: await token2022Mint("non-transferable"),
    empty: await createMint(connection, funder, funder.publicKey, null, 0, undefined, undefined, TOKEN_PROGRAM_ID),
  };
  [vaultA, vaultB, vaultC, vaultD] = await Promise.all([fundedVault("A"), fundedVault("B"), fundedVault("C"), fundedVault("D")]);

  // Plan A: both heirs named. The primary signs the transaction; the contingent heir proves control
  // with a signed message instead, as someone would who is not at the keyboard when the plan is made.
  const termsA: Terms = { vault: vaultA.address, primary: { kind: "address", address: a.primary.publicKey }, contingent: { kind: "address", address: a.contingent.publicKey }, contingentDelaySecs: CONTINGENT_DELAY };
  const initA = initPlanInstruction({ claimProgram: programs.claim, payer: funder.publicKey, terms: termsA, signingHeirs: [a.primary.publicKey] });
  planA = initA.plan;
  const message = new TextEncoder().encode(acceptanceMessage(planA));
  await send(connection, [funder, a.primary], [acceptanceProofInstruction(a.contingent.publicKey, signMessage(a.contingent, message), message), initA.instruction]);

  // Plan C: both heirs are salted hashes. Nothing on chain says who they are, and nobody proves anything.
  const termsC: Terms = { vault: vaultC.address, primary: hashedHeir(c.saltPrimary, c.primary.publicKey), contingent: hashedHeir(c.saltContingent, c.contingent.publicKey), contingentDelaySecs: CONTINGENT_DELAY };
  const initC = initPlanInstruction({ claimProgram: programs.claim, payer: funder.publicKey, terms: termsC });
  planC = initC.plan;
  await send(connection, [funder], [initC.instruction]);

  await Promise.all([arm(vaultA, planA), arm(vaultB, b.heir.publicKey), arm(vaultC, planC), arm(vaultD, d.heir.publicKey)]);
  for (const v of [vaultA, vaultB, vaultC, vaultD]) {
    const s = await inspect(connection, v.address);
    if (s.succession!.lastSignedTs > lastSigned) lastSigned = s.succession!.lastSignedTs;
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a release, from an armed vault to the heirs' hands", () => {
  it("while the owner is within the window: the plan is public, kits can be printed, and nobody can start anything", async () => {
    const s = await inspect(connection, vaultA.address);
    expect(s.state).toBe("open");
    expect(s.status?.phase).toBe("quiet");
    expect(s.claim?.equals(planA)).toBe(true);
    expect(s.plan?.account.activated).toBe(false);
    expect(s.planNamesAnotherVault).toBeUndefined();

    const status = await cli("status", vaultA.address.toBase58());
    expect(status.code).toBe(0);
    expect(status.text).toContain("TEST BUILD");
    expect(status.text).toContain("quiet");
    expect(status.text).toContain(a.primary.publicKey.toBase58());

    // kits: one for a named heir, one for a private heir with their salt
    const outA = join(dir, "kit-a.html");
    expect((await cli("kit", vaultA.address.toBase58(), "--heir", a.primary.publicKey.toBase58(), "--label", "the primary heir of A", "--out", outA)).code).toBe(0);
    kitA = readFileSync(outA, "utf8");
    expect(kitA).toContain("Test kit");
    expect(kitA).toContain("You are the primary heir");
    const outC = join(dir, "kit-c.html");
    expect((await cli("kit", vaultC.address.toBase58(), "--heir", c.contingent.publicKey.toBase58(), "--salt", formatSalt(c.saltContingent), "--out", outC)).code).toBe(0);
    kitC = readFileSync(outC, "utf8");
    expect(kitC).toContain("You are the contingent heir");
    expect(kitC).toContain(formatSalt(c.saltContingent));
    // a kit for someone the plan does not name is refused
    await expect(cli("kit", vaultA.address.toBase58(), "--heir", stranger.publicKey.toBase58())).rejects.toThrow(/do not name this address/);
    await expect(cli("kit", vaultC.address.toBase58(), "--heir", c.contingent.publicKey.toBase58())).rejects.toThrow(/with this salt/);

    // too early for everything
    const early = await start(connection, stranger, vaultA.address);
    expect(early.step.skipped).toMatch(/active within the window/);
    expect((await finish(connection, stranger, vaultA.address)).steps).toEqual([]);
    expect(await releasableVaults(connection, programs)).toEqual([]);
    const claimEarly = await cli("claim", vaultB.address.toBase58(), "--keypair", keyFile("b-heir", b.heir));
    expect(claimEarly.code).toBe(2);
    expect(claimEarly.text).toContain("has not been released");
  });

  it("once the window has run out, anyone may open the waiting period; the finisher never does", async () => {
    await until(lastSigned + WINDOW + 1n);
    for (const v of [vaultA, vaultB, vaultC, vaultD]) expect((await inspect(connection, v.address)).status?.phase, v.name).toBe("overdue");

    // a finisher pass over four overdue vaults: it opens nothing and sends nothing
    const before = await connection.getBalance(finisherKey.publicKey);
    expect(await new Finisher(connection, finisherKey, programs).pass()).toEqual([]);
    expect(await connection.getBalance(finisherKey.publicKey)).toBe(before);
    for (const v of [vaultA, vaultB, vaultC, vaultD]) expect((await inspect(connection, v.address)).status?.phase, v.name).toBe("overdue");

    // people open them: an heir with the command from the kit, and a stranger, who may too
    const started = await cli("start", vaultA.address.toBase58(), "--keypair", keyFile("a-primary", a.primary));
    expect(started.code).toBe(0);
    expect(started.text).toContain("done");
    for (const v of [vaultB, vaultC, vaultD]) expect((await start(connection, stranger, v.address)).step.signature, v.name).toBeDefined();

    for (const v of [vaultA, vaultB, vaultC, vaultD]) {
      const s = await inspect(connection, v.address);
      expect(s.status?.phase, v.name).toBe("waiting");
      if (s.succession!.waitStartedTs > waitStarted) waitStarted = s.succession!.waitStartedTs;
    }
    // a second start is refused in words, not sent
    expect((await start(connection, stranger, vaultA.address)).step.skipped).toMatch(/already open/);
    // and nothing can be finished during the wait
    expect((await finish(connection, stranger, vaultB.address)).steps).toEqual([]);
  });

  it("D: the owner is alive. One check-in cancels the waiting period, and D is never released", async () => {
    const ix = checkinInstruction({ programId: programs.vault, vault: vaultD.address, checkinKey: vaultD.checkinKey.publicKey });
    await send(connection, [funder, vaultD.checkinKey], [ix]); // somebody else pays the fee; the check-in key only signs
    const s = await inspect(connection, vaultD.address);
    expect(s.status?.phase).toBe("quiet");
    expect(s.succession!.waitOpen).toBe(false);
  });

  it("B: with no finisher anywhere, the heir's own claim releases the vault and brings everything home", async () => {
    await until(waitStarted + WAIT);
    const heir = b.heir.publicKey;
    const solBefore = await connection.getBalance(heir);

    // first, a dry run: it says what it would do and changes nothing
    const dry = await cli("claim", vaultB.address.toBase58(), "--keypair", keyFile("b-heir", b.heir), "--dry-run");
    expect(dry.text).toContain("execute_succession");
    expect(dry.text).toContain("would be sent");
    expect((await inspect(connection, vaultB.address)).state).toBe("open");
    expect(await connection.getBalance(heir)).toBe(solBefore);

    const res = await cli("claim", vaultB.address.toBase58(), "--keypair", keyFile("b-heir", b.heir));
    console.log(`\n--- B: the heir's claim ---\n${res.text}\n`);
    const after = await inspect(connection, vaultB.address);
    expect(after.state).toBe("released");
    expect(after.claim?.equals(heir)).toBe(true);
    expect(res.text).toContain("releases straight to your address");

    // the SOL, less what the heir paid in fees and for their own token accounts
    expect(await connection.getBalance(heir)).toBeGreaterThan(solBefore + SOL_IN_VAULT - 0.02 * LAMPORTS_PER_SOL);
    // every token that can move
    expect(await balance(heir, mints.tokenA, TOKEN_PROGRAM_ID)).toBe(TOKEN_A);
    expect(await balance(heir, mints.fee, TOKEN_2022_PROGRAM_ID)).toBe(FEE_IN_VAULT - FEE_IN_VAULT / 100n);
    // the one that cannot: still at the vault's address, reported, and the exit code says so
    const left = await holdingsOf(connection, vaultB.address);
    expect(left.map((h) => [h.mint.toBase58(), h.amount])).toEqual([[mints.nonTransferable.toBase58(), NON_TRANSFERABLE]]);
    expect(res.code).toBe(1);
    expect(res.text).toContain("1 item(s) could not be moved");
    expect(res.text).toContain(mints.nonTransferable.toBase58());

    // running it again is safe and finds nothing new to move
    const again = await cli("claim", vaultB.address.toBase58(), "--keypair", keyFile("b-heir", b.heir));
    expect(again.code).toBe(1);
    expect(await balance(heir, mints.tokenA, TOKEN_PROGRAM_ID)).toBe(TOKEN_A);
  });

  it("the finisher releases what is due, activates the plans and sweeps the tokens; it leaves D alone", async () => {
    const due = (await releasableVaults(connection, programs)).map((k) => k.toBase58()).sort();
    expect(due).toEqual([vaultA.address.toBase58(), vaultC.address.toBase58()].sort());

    const lines: string[] = [];
    const finisher = new Finisher(connection, finisherKey, programs, { log: (l) => lines.push(l) });
    const reports = await finisher.pass();
    console.log(`\n--- the finisher's pass ---\n${lines.join("\n")}\n`);
    expect(reports.every((r) => !r.error)).toBe(true);

    for (const [v, plan] of [
      [vaultA, planA],
      [vaultC, planC],
    ] as const) {
      const s = await inspect(connection, v.address);
      expect(s.state, v.name).toBe("released");
      expect(s.claim?.equals(plan), v.name).toBe(true);
      expect(s.plan?.account.activated, v.name).toBe(true);
      // the plan holds the vault's SOL and every token that can move
      expect(s.plan!.lamports, v.name).toBeGreaterThan(SOL_IN_VAULT);
      expect(await balance(plan, mints.tokenA, TOKEN_PROGRAM_ID), v.name).toBe(TOKEN_A);
      expect(await balance(plan, mints.fee, TOKEN_2022_PROGRAM_ID), v.name).toBe(FEE_IN_VAULT - FEE_IN_VAULT / 100n);
      // left at the vault's address: only the non-transferable token. The empty account was
      // closed by the release itself, its rent going to the plan.
      const left = (await holdingsOf(connection, v.address)).map((h) => h.mint.toBase58());
      expect(left, v.name).toEqual([mints.nonTransferable.toBase58()]);
    }
    const report = reports.find((r) => r.vault.equals(vaultA.address))!;
    expect(report.steps.map((s) => s.kind)).toEqual(["execute_succession", "activate", "sweep", "sweep", "sweep"]);
    expect(report.steps.filter((s) => s.failed).map((s) => s.mint?.toBase58())).toEqual([mints.nonTransferable.toBase58()]);
    expect(report.steps.filter((s) => s.failed)[0]!.failed).toMatch(/non-transferable|NonTransferable|not transferable|disabled/i);

    // D was checked in: still open, still the owner's
    expect((await inspect(connection, vaultD.address)).state).toBe("open");
    expect(await connection.getBalance(vaultD.address)).toBeGreaterThan(SOL_IN_VAULT);
    // B was already finished by its heir: the finisher found nothing to do there but the stuck token
    const b2 = reports.find((r) => r.vault.equals(vaultB.address));
    expect(b2?.steps.filter((s) => s.signature) ?? []).toEqual([]);

    // Anyone can make a closed vault's address own one more token account. An empty one costs a
    // finisher rent to sweep and brings the heirs nothing, so the finisher leaves it for the heir.
    await getOrCreateAssociatedTokenAccount(connection, funder, mints.empty, vaultA.address, true, "confirmed", undefined, TOKEN_PROGRAM_ID);
    const spent = await connection.getBalance(finisherKey.publicKey);
    const second = await finisher.pass();
    expect(second.flatMap((r) => r.steps).filter((s) => s.signature)).toEqual([]);
    const emptyStep = second.find((r) => r.vault.equals(vaultA.address))!.steps.find((s) => s.mint?.equals(mints.empty))!;
    expect(emptyStep.skipped).toMatch(/empty/);
    expect(await connection.getBalance(finisherKey.publicKey)).toBe(spent);
  });

  it("A: the primary heir claims with the command printed in their kit", async () => {
    const heir = a.primary.publicKey;
    const solBefore = await connection.getBalance(heir);
    // the command as the kit prints it, with the key file filled in
    const printed = /node src\/cli\.ts (claim \S+ --keypair YOUR-KEY-FILE[^<\n]*)/.exec(kitA)![1]!;
    const argv = printed.replace("YOUR-KEY-FILE", keyFile("a-primary", a.primary)).split(" ").filter((x) => x !== "--rpc" && x !== RPC_URL && x !== "");
    expect(argv[1]).toBe(vaultA.address.toBase58());

    // a stranger and the contingent heir try first
    const no = await cli("claim", vaultA.address.toBase58(), "--keypair", keyFile("stranger", stranger));
    expect(no.code).toBe(2);
    expect(no.text).toContain("not an heir");
    const early = await claim(connection, a.contingent, vaultA.address);
    expect(early.verdict.kind).toBe("contingent_too_early");

    const res = await cli(...argv);
    console.log(`\n--- A: the primary heir's claim ---\n${res.text}\n`);
    expect(res.text).toContain("claimed as the primary heir");
    expect(await connection.getBalance(heir)).toBeGreaterThan(solBefore + SOL_IN_VAULT - 0.02 * LAMPORTS_PER_SOL);
    expect(await balance(heir, mints.tokenA, TOKEN_PROGRAM_ID)).toBe(TOKEN_A);
    // the fee-bearing token paid its 1% twice on the way: vault to plan, plan to heir
    const inPlan = FEE_IN_VAULT - FEE_IN_VAULT / 100n;
    expect(await balance(heir, mints.fee, TOKEN_2022_PROGRAM_ID)).toBe(inPlan - inPlan / 100n);
    // the plan is emptied and its token accounts are closed, the one that held withheld fees included
    expect(await holdingsOf(connection, planA)).toEqual([]);
    const planInfo = (await connection.getAccountInfo(planA))!;
    expect(planInfo.lamports).toBe(await connection.getMinimumBalanceForRentExemption(planInfo.data.length));
    // what stays behind is the non-transferable token, at the vault's address, and it was said so
    expect((await holdingsOf(connection, vaultA.address)).map((h) => h.mint.toBase58())).toEqual([mints.nonTransferable.toBase58()]);
    expect(res.code).toBe(1);
    expect(res.text).toContain("1 item(s) could not be moved");

    // SOL that reaches the vault's old address later still finds the heir
    await pay(vaultA.address, 0.05 * LAMPORTS_PER_SOL);
    const mid = await connection.getBalance(heir);
    await cli(...argv);
    expect(await connection.getBalance(heir)).toBeGreaterThan(mid + 0.04 * LAMPORTS_PER_SOL);
  });

  it("C: the primary never claims; after the delay the contingent heir does, with the salt from their kit", async () => {
    const heir = c.contingent.publicKey;
    const file = keyFile("c-contingent", c.contingent);
    const plan = decodePlan(new Uint8Array((await connection.getAccountInfo(planC))!.data));
    const opens = plan.contingentClockTs + CONTINGENT_DELAY;

    // without the salt nobody is recognised, the heirs included
    const noSalt = await cli("claim", vaultC.address.toBase58(), "--keypair", file);
    expect(noSalt.code).toBe(2);
    expect(noSalt.text).toContain("pass your salt");
    // a mistyped salt is caught by its check digits before it reaches the chain
    const salt = formatSalt(c.saltContingent);
    await expect(cli("claim", vaultC.address.toBase58(), "--keypair", file, "--salt", (salt[0] === "0" ? "1" : "0") + salt.slice(1))).rejects.toThrow(/mistyped/);

    if ((await clusterTime(connection)) < opens) {
      const early = await cli("claim", vaultC.address.toBase58(), "--keypair", file, "--salt", salt);
      expect(early.code).toBe(2);
      expect(early.text).toContain("you are the contingent heir and may claim from");
      expect(await balance(heir, mints.tokenA, TOKEN_PROGRAM_ID)).toBeUndefined();
    }
    await until(opens);

    const solBefore = await connection.getBalance(heir);
    const printed = /node src\/cli\.ts (claim \S+ --keypair YOUR-KEY-FILE[^<\n]*)/.exec(kitC)![1]!;
    const argv = printed.replace("YOUR-KEY-FILE", file).split(" ").filter((x) => x !== "--rpc" && x !== RPC_URL && x !== "");
    expect(argv).toContain("--salt");
    const res = await cli(...argv);
    console.log(`\n--- C: the contingent heir's claim ---\n${res.text}\n`);
    expect(res.text).toContain("claimed as the contingent heir");
    expect(await connection.getBalance(heir)).toBeGreaterThan(solBefore + SOL_IN_VAULT - 0.02 * LAMPORTS_PER_SOL);
    expect(await balance(heir, mints.tokenA, TOKEN_PROGRAM_ID)).toBe(TOKEN_A);
    const inPlan = FEE_IN_VAULT - FEE_IN_VAULT / 100n;
    expect(await balance(heir, mints.fee, TOKEN_2022_PROGRAM_ID)).toBe(inPlan - inPlan / 100n);
    expect(await holdingsOf(connection, planC)).toEqual([]);
    // the primary heir, who never came, got nothing and paid nothing
    expect(await balance(c.primary.publicKey, mints.tokenA, TOKEN_PROGRAM_ID)).toBeUndefined();
  });

  it("at the end: no token account of a released vault holds anything that could have moved", async () => {
    for (const v of [vaultA, vaultB, vaultC]) {
      const left = await holdingsOf(connection, v.address);
      expect(left.map((h) => h.mint.toBase58()), v.name).toEqual([mints.nonTransferable.toBase58()]);
      expect(left[0]!.amount, v.name).toBe(NON_TRANSFERABLE);
    }
    // and the vault whose owner checked in is exactly as it was
    const dLeft = (await holdingsOf(connection, vaultD.address)).map((h) => [h.mint.toBase58(), h.amount]);
    expect(dLeft).toHaveLength(4);
    expect(dLeft).toContainEqual([mints.tokenA.toBase58(), TOKEN_A]);
    expect(dLeft).toContainEqual([mints.fee.toBase58(), FEE_IN_VAULT]);
  });
});
