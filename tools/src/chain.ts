/**
 * The part of Solana's RPC these tools use, and how they send a transaction.
 *
 * Everything here works against any RPC endpoint: a web3.js `Connection` is a {@link Chain}. The
 * interface is spelled out so tests can stand in for the cluster, and so it is plain what the tools
 * ask of an endpoint: account reads, two list calls, simulate, send, confirm.
 */
import {
  type AccountInfo,
  type Commitment,
  ComputeBudgetProgram,
  type GetProgramAccountsFilter,
  PublicKey,
  type SendOptions,
  type Signer,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

export interface Chain {
  getAccountInfo(address: PublicKey, commitment?: Commitment): Promise<AccountInfo<Buffer> | null>;
  getMultipleAccountsInfo(addresses: PublicKey[], commitment?: Commitment): Promise<(AccountInfo<Buffer> | null)[]>;
  getProgramAccounts(
    programId: PublicKey,
    config: { commitment?: Commitment; filters?: GetProgramAccountsFilter[]; dataSlice?: { offset: number; length: number } },
  ): Promise<ReadonlyArray<{ pubkey: PublicKey; account: AccountInfo<Buffer> }>>;
  getTokenAccountsByOwner(owner: PublicKey, filter: { programId: PublicKey }, commitment?: Commitment): Promise<{ value: ReadonlyArray<{ pubkey: PublicKey; account: AccountInfo<Buffer> }> }>;
  getLatestBlockhash(commitment?: Commitment): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction(raw: Buffer | Uint8Array | number[], options?: SendOptions): Promise<string>;
  confirmTransaction(strategy: { signature: string; blockhash: string; lastValidBlockHeight: number }, commitment?: Commitment): Promise<{ value: { err: unknown } }>;
  simulateTransaction(
    transaction: VersionedTransaction,
    config?: { sigVerify?: boolean; replaceRecentBlockhash?: boolean; commitment?: Commitment },
  ): Promise<{ value: { err: unknown; logs?: string[] | null } }>;
  getMinimumBalanceForRentExemption(dataLength: number, commitment?: Commitment): Promise<number>;
}

/** The commitment every read and send here uses. */
export const COMMITMENT: Commitment = "confirmed";

/**
 * The cluster's clock, in unix seconds, as the programs read it (`Clock.unix_timestamp`). The
 * programs decide by this clock, never by the caller's, so the tools read it instead of trusting
 * the machine they run on.
 */
export async function clusterTime(chain: Chain): Promise<bigint> {
  const info = await chain.getAccountInfo(SYSVAR_CLOCK_PUBKEY, COMMITMENT);
  if (!info || info.data.length < 40) throw new Error("could not read the cluster clock");
  return info.data.readBigInt64LE(32);
}

/** Outcome of asking the cluster what a transaction would do, without sending it. */
export interface Simulation {
  ok: boolean;
  logs: string[];
  /** the cluster's error, as JSON, when `ok` is false */
  error?: string;
}

function withBudget(instructions: TransactionInstruction[], computeUnits: number | undefined): TransactionInstruction[] {
  return computeUnits === undefined ? instructions : [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), ...instructions];
}

/**
 * Simulates `instructions` as one transaction paid by `payer`. Nothing is signed and nothing is
 * sent: the cluster skips signature checks for this call, so no key is needed to ask.
 */
export async function simulate(chain: Chain, payer: PublicKey, instructions: TransactionInstruction[], computeUnits?: number): Promise<Simulation> {
  const { blockhash } = await chain.getLatestBlockhash(COMMITMENT);
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: withBudget(instructions, computeUnits) }).compileToLegacyMessage();
  const res = await chain.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: true, commitment: COMMITMENT });
  const logs = res.value.logs ?? [];
  return res.value.err ? { ok: false, logs, error: JSON.stringify(res.value.err) } : { ok: true, logs };
}

/** A transaction the cluster refused, with the logs that say why. */
export class TransactionFailed extends Error {
  readonly logs: string[];
  constructor(message: string, logs: string[]) {
    super(message);
    this.name = "TransactionFailed";
    this.logs = logs;
  }
}

/**
 * Signs `instructions` as one transaction (the first signer pays), sends it and waits for it to
 * confirm. Throws {@link TransactionFailed} if the cluster refuses it.
 */
export async function send(chain: Chain, signers: Signer[], instructions: TransactionInstruction[], computeUnits?: number): Promise<string> {
  const payer = signers[0];
  if (!payer) throw new Error("at least one signer is required");
  const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash(COMMITMENT);
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...withBudget(instructions, computeUnits));
  tx.sign(...signers);
  let signature: string;
  try {
    signature = await chain.sendRawTransaction(tx.serialize(), { preflightCommitment: COMMITMENT });
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs ?? [];
    throw new TransactionFailed(`the cluster refused the transaction: ${reasonFromLogs(logs) ?? (e as Error).message}`, logs);
  }
  const res = await chain.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, COMMITMENT);
  if (res.value.err) throw new TransactionFailed(`transaction ${signature} failed: ${JSON.stringify(res.value.err)}`, []);
  return signature;
}

/**
 * The most useful line of a failed transaction's logs: what a program said went wrong. Anchor
 * programs (the vault, the claim program) log `Error Code: Name. … Error Message: text.`; the token
 * programs log `Error: text`.
 */
export function reasonFromLogs(logs: readonly string[]): string | undefined {
  for (const line of logs) {
    const anchor = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/.exec(line);
    if (anchor) return `${anchor[1]} (${anchor[2]}): ${anchor[3]}`;
  }
  for (const line of logs) {
    const token = /^Program log: Error: (.*)$/.exec(line);
    if (token) return token[1];
  }
  for (const line of logs) {
    const failed = /^Program (\w+) failed: (.*)$/.exec(line);
    if (!failed) continue;
    // The first program to fail is the innermost one. When that is a token program, say what its
    // error number means: these are the refusals a release meets (lamport-vault, docs/SUCCESSION.md).
    const code = /^custom program error: 0x([0-9a-f]+)$/.exec(failed[2]!);
    const words = code && TOKEN_PROGRAM_IDS.has(failed[1]!) ? TOKEN_REFUSALS[parseInt(code[1]!, 16)] : undefined;
    return words ? `${words} (token program error 0x${code![1]})` : failed[2];
  }
  return undefined;
}

const TOKEN_PROGRAM_IDS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/** `TokenError` numbers of the token programs (spl-token-2022-interface 2.1, `error.rs`), in words. */
const TOKEN_REFUSALS: Record<number, string> = {
  1: "the token account holds less than the amount",
  17: "the token account is frozen; only the token's issuer can thaw it",
  35: "the token account still holds withheld transfer fees, which must be harvested to the mint first",
  36: "the receiving account requires a memo with every transfer; its owner has to switch that off",
  37: "this token is non-transferable: nobody can move it",
  67: "the token's issuer has paused all transfers of it",
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58, as RPC filters want their bytes. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
