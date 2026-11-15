/**
 * Tokens of a mint with a Token-2022 transfer hook, as the tools build their transactions: the
 * hook's accounts are resolved from the chain and put after `claim_token`'s and `sweep_closed`'s
 * own, always unsigned, and a hook whose list names a key that signs the transaction is not
 * served. What the programs do with these accounts is tested where the programs run
 * (tests/svm/tests/hook.rs, and lamport-vault's tests/svm/tests/transfer_hook.rs).
 */
import { associatedTokenAddress, encodeTombstone, extraAccountMetasAddress, IX, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TOMBSTONE_ACCOUNT_VERSION } from "@lamport-robotics/vault";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { type AccountMeta, Keypair, PublicKey, SystemProgram, type VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { encodePlanForTests } from "../scripts/claim-kat.ts";
import { claim } from "../src/claiming.ts";
import { CLAIM_IX, claimTokenInstruction, PLAN_ACCOUNT_SIZE, planAddress, type Terms } from "../src/claim.ts";
import { PROGRAMS } from "../src/programs.ts";
import { finish } from "../src/release.ts";
import { hookAccounts, mintFacts } from "../src/tokens.ts";
import { FakeChain } from "./fake-chain.ts";

const T0 = 1_800_000_000n;
const text = (s: string) => [...new TextEncoder().encode(s)];
const key = () => Keypair.generate().publicKey;
// throwaway keys: they only ever sign transactions the fake chain refuses to run
const heir = Keypair.generate();
const payer = Keypair.generate();

// ---- accounts, written out by hand from the on-chain layouts ----

/** A Token-2022 mint whose transfer hook is `program` (null: the extension is there, no program is set). */
function hookMintData(program: PublicKey | null): Uint8Array {
  const out = new Uint8Array(166 + 4 + 64);
  out[44] = 6; // decimals
  out[45] = 1; // initialised
  out[165] = 1; // account type: mint
  out.set([14, 0, 64, 0], 166); // extension 14 (transfer hook), 64 bytes: authority, program
  if (program) out.set(program.toBytes(), 166 + 4 + 32);
  return out;
}

function plainMintData(): Uint8Array {
  const out = new Uint8Array(82);
  out[44] = 6;
  out[45] = 1;
  return out;
}

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  const d = Buffer.alloc(165);
  d.set(mint.toBytes(), 0);
  d.set(owner.toBytes(), 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1; // initialised
  return d;
}

interface Entry {
  kind: number;
  config: number[];
  signer?: boolean;
  writable?: boolean;
}
const fixed = (k: PublicKey, flags: { signer?: boolean; writable?: boolean } = {}): Entry => ({ kind: 0, config: [...k.toBytes()], ...flags });
/** an address of the hook program from the literal seed "counter" and the mint's key (account 1 of the hook's call) */
const counterEntry: Entry = { kind: 1, config: [1, 7, ...text("counter"), 3, 1], writable: true };
/** an address of the hook program from the literal seed "by-amount" and the amount in the hook's instruction data */
const byAmountEntry: Entry = { kind: 1, config: [1, 9, ...text("by-amount"), 2, 8, 8] };

/** A hook's validation account: one entry of type `Execute` holding a count and 35-byte entries. */
function validationData(entries: Entry[]): Uint8Array {
  const body = entries.flatMap((e) => {
    const config = new Uint8Array(32);
    config.set(e.config);
    return [e.kind, ...config, e.signer ? 1 : 0, e.writable ? 1 : 0];
  });
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  return Uint8Array.from([105, 37, 101, 197, 75, 251, 102, 26, ...u32(4 + body.length), ...u32(entries.length), ...body]);
}

const counterOf = (mint: PublicKey, hookProgram: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("counter"), mint.toBytes()], hookProgram)[0];
const byAmount = (amount: bigint, hookProgram: PublicKey) => {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(amount);
  return PublicKey.findProgramAddressSync([Buffer.from("by-amount"), le], hookProgram)[0];
};

/** The fake chain, remembering the instructions of every transaction it is asked to simulate. */
class RecordingChain extends FakeChain {
  simulated: { programId: PublicKey; keys: AccountMeta[]; data: Buffer; signers: string[] }[] = [];
  override async simulateTransaction(tx?: VersionedTransaction): Promise<{ value: { err: unknown; logs: string[] } }> {
    if (tx) {
      const m = tx.message;
      const keys = m.staticAccountKeys;
      const signers = keys.filter((_, i) => m.isAccountSigner(i)).map((k) => k.toBase58());
      for (const ix of m.compiledInstructions) {
        this.simulated.push({
          programId: keys[ix.programIdIndex]!,
          keys: ix.accountKeyIndexes.map((i) => ({ pubkey: keys[i]!, isSigner: m.isAccountSigner(i), isWritable: m.isAccountWritable(i) })),
          data: Buffer.from(ix.data),
          signers,
        });
      }
    }
    return super.simulateTransaction();
  }
  /** the simulated instructions of `program` whose data starts with `discriminator` */
  sent(program: PublicKey, discriminator: Uint8Array) {
    return this.simulated.filter((ix) => ix.programId.equals(program) && ix.data.subarray(0, 8).equals(Buffer.from(discriminator)));
  }
}

/** A hook mint on the chain: the mint, and the hook's validation account with `entries`. */
function hookMint(chain: FakeChain, entries: Entry[]) {
  const mint = key();
  const hookProgram = key();
  chain.put(mint, TOKEN_2022_PROGRAM_ID, hookMintData(hookProgram));
  const validation = extraAccountMetasAddress(mint, hookProgram);
  chain.put(validation, hookProgram, validationData(entries));
  return { mint, hookProgram, validation };
}

const show = (metas: AccountMeta[]) => metas.map((m) => `${m.pubkey.toBase58()} ${m.isSigner ? "s" : "-"}${m.isWritable ? "w" : "-"}`);

describe("hookAccounts", () => {
  it("is empty for a mint without a hook, under either token program", async () => {
    const chain = new FakeChain();
    const transfer = { source: key(), destination: key(), authority: key(), amount: 5n };
    for (const [program, data] of [[TOKEN_PROGRAM_ID, plainMintData()], [TOKEN_2022_PROGRAM_ID, plainMintData()], [TOKEN_2022_PROGRAM_ID, hookMintData(null)]] as const) {
      const mint = key();
      chain.put(mint, program, data);
      const facts = await mintFacts(chain, mint);
      expect(facts.hookProgram).toBeUndefined();
      expect(await hookAccounts(chain, facts, transfer, [payer.publicKey])).toEqual([]);
    }
  });

  it("resolves the hook's list, then its validation account and the hook program, all unsigned", async () => {
    const chain = new FakeChain();
    const wanted = key();
    const { mint, hookProgram, validation } = hookMint(chain, [counterEntry, byAmountEntry, fixed(wanted, { signer: true, writable: true })]);
    const facts = await mintFacts(chain, mint);
    expect(facts.hookProgram!.equals(hookProgram)).toBe(true);
    const got = await hookAccounts(chain, facts, { source: key(), destination: key(), authority: key(), amount: 700n }, [payer.publicKey]);
    expect(show(got)).toEqual(show([
      { pubkey: counterOf(mint, hookProgram), isSigner: false, isWritable: true },
      { pubkey: byAmount(700n, hookProgram), isSigner: false, isWritable: false },
      // the list asks for this one as a signer: it is added, and not as one
      { pubkey: wanted, isSigner: false, isWritable: true },
      { pubkey: validation, isSigner: false, isWritable: false },
      { pubkey: hookProgram, isSigner: false, isWritable: false },
    ]));
  });

  it("refuses a hook whose list names a key that signs the transaction, however it asks for it", async () => {
    for (const flags of [{ signer: true, writable: true }, { writable: true }, {}]) {
      const chain = new FakeChain();
      const { mint } = hookMint(chain, [counterEntry, fixed(payer.publicKey, flags)]);
      const facts = await mintFacts(chain, mint);
      const transfer = { source: key(), destination: key(), authority: key(), amount: 1n };
      await expect(hookAccounts(chain, facts, transfer, [payer.publicKey])).rejects.toThrow(new RegExp(`${payer.publicKey.toBase58()}, which signs this transaction`));
      await expect(hookAccounts(chain, facts, transfer, [key(), payer.publicKey])).rejects.toThrow(/never handed to one/);
      // somebody else signing: the same list is served, and the key goes in unsigned
      const got = await hookAccounts(chain, facts, transfer, [key()]);
      expect(got[1]).toEqual({ pubkey: payer.publicKey, isSigner: false, isWritable: flags.writable === true });
    }
  });
});

describe("claim_token", () => {
  it("the builder adds a hook's accounts unsigned, whatever the caller marked", () => {
    const extra: AccountMeta[] = [
      { pubkey: key(), isSigner: false, isWritable: true },
      { pubkey: key(), isSigner: true, isWritable: true },
      { pubkey: key(), isSigner: true, isWritable: false },
    ];
    const ix = claimTokenInstruction({ plan: key(), heir: heir.publicKey, planTokenAccount: key(), destination: key(), mint: key(), tokenProgram: TOKEN_2022_PROGRAM_ID, closeAccount: true, extraAccounts: extra });
    expect(ix.keys.slice(6)).toEqual(extra.map((m) => ({ ...m, isSigner: false })));
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([heir.publicKey.toBase58()]);
    const bare = claimTokenInstruction({ plan: key(), heir: heir.publicKey, planTokenAccount: key(), destination: key(), mint: key(), tokenProgram: TOKEN_PROGRAM_ID, closeAccount: false });
    expect(bare.keys.length).toBe(6);
  });
});

/** A vault that has released to an activated plan whose primary heir is `heir`. Both hold exactly their rent. */
async function released(chain: FakeChain) {
  const vault = key();
  const terms: Terms = { vault, primary: { kind: "address", address: heir.publicKey }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
  const plan = planAddress(terms);
  chain.put(vault, PROGRAMS.vault, encodeTombstone({ version: TOMBSTONE_ACCOUNT_VERSION, vaultId: new Uint8Array(32).fill(1), closedSlot: 4242n, heir: plan }), await chain.getMinimumBalanceForRentExemption(81));
  chain.put(plan, PROGRAMS.claim, encodePlanForTests({ bump: 255, terms, createdTs: T0, activated: true, activatedTs: T0, closedSlot: 4242n, contingentClockTs: T0 }), await chain.getMinimumBalanceForRentExemption(PLAN_ACCOUNT_SIZE));
  return { vault, plan };
}

describe("the heir's claim of a hook mint", () => {
  it("carries the hook's accounts after claim_token's own six, resolved for that account's balance, and only the heir signs", async () => {
    const chain = new RecordingChain();
    const { vault, plan } = await released(chain);
    const { mint, hookProgram, validation } = hookMint(chain, [counterEntry, byAmountEntry]);
    const source = associatedTokenAddress(plan, mint, TOKEN_2022_PROGRAM_ID);
    chain.put(source, TOKEN_2022_PROGRAM_ID, tokenAccountData(mint, plan, 700n));

    const res = await claim(chain, heir, vault);
    expect(res.verdict).toEqual({ kind: "claimed", role: "primary" });
    const [ix] = chain.sent(PROGRAMS.claim, CLAIM_IX.claimToken);
    expect(ix).toBeDefined();
    const destination = getAssociatedTokenAddressSync(mint, heir.publicKey, true, TOKEN_2022_PROGRAM_ID);
    expect(ix!.keys.slice(0, 6).map((k) => k.pubkey.toBase58())).toEqual([plan, heir.publicKey, source, destination, mint, TOKEN_2022_PROGRAM_ID].map((k) => k.toBase58()));
    expect(show(ix!.keys.slice(6))).toEqual(show([
      { pubkey: counterOf(mint, hookProgram), isSigner: false, isWritable: true },
      { pubkey: byAmount(700n, hookProgram), isSigner: false, isWritable: false },
      { pubkey: validation, isSigner: false, isWritable: false },
      { pubkey: hookProgram, isSigner: false, isWritable: false },
    ]));
    expect(ix!.signers).toEqual([heir.publicKey.toBase58()]);
    expect(chain.sends).toBe(0);
  });

  it("a hook whose list names the heir is not served: that token is reported and left, and the others are still claimed", async () => {
    const chain = new RecordingChain();
    const { vault, plan } = await released(chain);
    const hostile = hookMint(chain, [counterEntry, fixed(heir.publicKey, { signer: true, writable: true })]);
    const hostileAccount = associatedTokenAddress(plan, hostile.mint, TOKEN_2022_PROGRAM_ID);
    chain.put(hostileAccount, TOKEN_2022_PROGRAM_ID, tokenAccountData(hostile.mint, plan, 9n));
    const plain = key();
    chain.put(plain, TOKEN_PROGRAM_ID, plainMintData());
    const plainAccount = associatedTokenAddress(plan, plain, TOKEN_PROGRAM_ID);
    chain.put(plainAccount, TOKEN_PROGRAM_ID, tokenAccountData(plain, plan, 3n));

    const res = await claim(chain, heir, vault);
    const step = res.steps.find((s) => s.kind === "claim_token" && s.mint!.equals(hostile.mint))!;
    expect(step.failed).toMatch(new RegExp(`transfer hook asks for the account ${heir.publicKey.toBase58()}, which signs this transaction`));
    // nothing was built for that token, let alone simulated or sent
    const claims = chain.sent(PROGRAMS.claim, CLAIM_IX.claimToken);
    expect(claims.map((ix) => ix.keys[2]!.pubkey.toBase58())).toEqual([plainAccount.toBase58()]);
    expect(claims[0]!.keys.length).toBe(6);
    expect(chain.simulated.some((ix) => ix.keys.some((k) => k.pubkey.equals(hostile.hookProgram)))).toBe(false);
    expect(chain.sends).toBe(0);
  });
});

describe("the sweep of a hook mint out of a released vault", () => {
  it("carries the hook's accounts after sweep_closed's own nine, and only the payer signs", async () => {
    const chain = new RecordingChain();
    const { vault, plan } = await released(chain);
    const { mint, hookProgram, validation } = hookMint(chain, [counterEntry, byAmountEntry]);
    const account = associatedTokenAddress(vault, mint, TOKEN_2022_PROGRAM_ID);
    chain.put(account, TOKEN_2022_PROGRAM_ID, tokenAccountData(mint, vault, 250n));

    await finish(chain, payer, vault);
    const [ix] = chain.sent(PROGRAMS.vault, IX.sweepClosed);
    expect(ix).toBeDefined();
    expect(ix!.keys.length).toBe(13);
    expect(ix!.keys[3]!.pubkey.equals(associatedTokenAddress(plan, mint, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(show(ix!.keys.slice(9))).toEqual(show([
      { pubkey: counterOf(mint, hookProgram), isSigner: false, isWritable: true },
      { pubkey: byAmount(250n, hookProgram), isSigner: false, isWritable: false },
      { pubkey: validation, isSigner: false, isWritable: false },
      { pubkey: hookProgram, isSigner: false, isWritable: false },
    ]));
    expect(ix!.signers).toEqual([payer.publicKey.toBase58()]);
  });

  it("a hook whose list names whoever pays for the sweep is not served; another payer can sweep it", async () => {
    const chain = new RecordingChain();
    const { vault } = await released(chain);
    const { mint } = hookMint(chain, [counterEntry, fixed(payer.publicKey, { signer: true, writable: true }), fixed(SystemProgram.programId)]);
    const account = associatedTokenAddress(vault, mint, TOKEN_2022_PROGRAM_ID);
    chain.put(account, TOKEN_2022_PROGRAM_ID, tokenAccountData(mint, vault, 250n));

    const res = await finish(chain, payer, vault);
    expect(res.steps.find((s) => s.kind === "sweep")!.failed).toMatch(/which signs this transaction/);
    expect(chain.sent(PROGRAMS.vault, IX.sweepClosed)).toEqual([]);

    const other = Keypair.generate();
    await finish(chain, other, vault);
    const [ix] = chain.sent(PROGRAMS.vault, IX.sweepClosed);
    // the first payer's key is there because the list names it: unsigned, like every hook account
    expect(ix!.keys.find((k) => k.pubkey.equals(payer.publicKey))).toEqual({ pubkey: payer.publicKey, isSigner: false, isWritable: true });
    expect(ix!.signers).toEqual([other.publicKey.toBase58()]);
  });
});
