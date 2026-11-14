/**
 * A stand-in for the cluster, for tests of what the tools read and of what they decide not to
 * send. It holds accounts and a clock, answers the two list calls by really applying their
 * filters, and counts every simulation and send. It does not execute programs: what transactions
 * do is tested against a validator (e2e/).
 */
import { type AccountInfo, type GetProgramAccountsFilter, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { type Chain } from "../src/chain.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function unbase58(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const d = ALPHABET.indexOf(c);
    if (d < 0) throw new Error(`not base58: ${text}`);
    n = n * 58n + BigInt(d);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export class FakeChain implements Chain {
  readonly accounts = new Map<string, { owner: PublicKey; lamports: number; data: Uint8Array }>();
  now = 1_800_000_000n;
  simulations = 0;
  sends = 0;
  /** every `getProgramAccounts` request, as it was asked */
  listed: { programId: PublicKey; filters: GetProgramAccountsFilter[]; dataSlice?: { offset: number; length: number } }[] = [];

  put(address: PublicKey, owner: PublicKey, data: Uint8Array, lamports = 5_000_000): void {
    this.accounts.set(address.toBase58(), { owner, lamports, data });
  }

  private info(a: { owner: PublicKey; lamports: number; data: Uint8Array }): AccountInfo<Buffer> {
    return { owner: a.owner, lamports: a.lamports, data: Buffer.from(a.data), executable: false, rentEpoch: 0 };
  }

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null> {
    if (address.equals(SYSVAR_CLOCK_PUBKEY)) {
      const data = Buffer.alloc(40);
      data.writeBigInt64LE(this.now, 32);
      return { owner: new PublicKey("Sysvar1111111111111111111111111111111111111"), lamports: 1, data, executable: false, rentEpoch: 0 };
    }
    const a = this.accounts.get(address.toBase58());
    return a ? this.info(a) : null;
  }

  async getMultipleAccountsInfo(addresses: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    return Promise.all(addresses.map((a) => this.getAccountInfo(a)));
  }

  async getProgramAccounts(programId: PublicKey, config: { filters?: GetProgramAccountsFilter[]; dataSlice?: { offset: number; length: number } }) {
    const filters = config.filters ?? [];
    this.listed.push({ programId, filters, ...(config.dataSlice ? { dataSlice: config.dataSlice } : {}) });
    const out: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] = [];
    for (const [key, a] of this.accounts) {
      if (!a.owner.equals(programId)) continue;
      const matches = filters.every((f) => {
        if ("dataSize" in f) return a.data.length === f.dataSize;
        const want = unbase58(f.memcmp.bytes);
        const at = a.data.subarray(f.memcmp.offset, f.memcmp.offset + want.length);
        return at.length === want.length && at.every((b, i) => b === want[i]);
      });
      if (!matches) continue;
      const data = config.dataSlice ? a.data.subarray(config.dataSlice.offset, config.dataSlice.offset + config.dataSlice.length) : a.data;
      out.push({ pubkey: new PublicKey(key), account: this.info({ ...a, data }) });
    }
    return out;
  }

  async getTokenAccountsByOwner(): Promise<{ value: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] }> {
    return { value: [] };
  }

  async getLatestBlockhash() {
    return { blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 1 };
  }

  async sendRawTransaction(_raw?: Buffer | Uint8Array | number[]): Promise<string> {
    this.sends += 1;
    throw new Error("the fake chain executes nothing: a test reached a send it should not have");
  }

  async confirmTransaction() {
    return { value: { err: null } };
  }

  async simulateTransaction(): Promise<{ value: { err: unknown; logs: string[] } }> {
    this.simulations += 1;
    return { value: { err: "the fake chain executes nothing", logs: [] } };
  }

  async getMinimumBalanceForRentExemption(dataLength: number): Promise<number> {
    return (dataLength + 128) * 6960;
  }
}
