/**
 * The finisher: a loop that finds vaults whose waiting period has run out and finishes them.
 *
 * It holds one key, which pays fees, and can do nothing with it that a stranger could not do:
 * every instruction it sends is open to anyone and sends funds only where the vault's owner signed
 * for them to go. It never opens a waiting period. Stopping it stops nothing: an heir finishes a
 * release with the same code (`claim`), and so can anybody else.
 *
 * Anyone may run one. Lamport runs one as a convenience.
 */
import { ACCOUNT, decodeSuccessionBlock, decodeTombstone, SUCCESSION_BLOCK_OFFSET, SUCCESSION_BLOCK_SIZE, TOMBSTONE_ACCOUNT_SIZE } from "@lamport-robotics/vault";
import { type PublicKey, type Signer } from "@solana/web3.js";
import { base58, type Chain, clusterTime, COMMITMENT } from "./chain.ts";
import { type Programs } from "./programs.ts";
import { describeStep, finish, type FinishOptions, type Step } from "./release.ts";
import { holdingsOf } from "./tokens.ts";

/** Offset of `wait_open` in a vault account: the succession block, then its fields up to the flag. */
const WAIT_OPEN_OFFSET = SUCCESSION_BLOCK_OFFSET + 32 + 8 + 8 + 8 + 8 + 32 + 32 + 1 + 8;

/**
 * Vaults whose waiting period has run out by the cluster's clock: the ones `execute_succession`
 * will accept now. One RPC call, which asks the endpoint for vaults with a waiting period open and
 * fetches only their succession blocks.
 */
export async function releasableVaults(chain: Chain, programs: Programs): Promise<PublicKey[]> {
  const waiting = await chain.getProgramAccounts(programs.vault, {
    commitment: COMMITMENT,
    filters: [{ memcmp: { offset: 0, bytes: base58(ACCOUNT.vault) } }, { memcmp: { offset: WAIT_OPEN_OFFSET, bytes: base58(Uint8Array.of(1)) } }],
    dataSlice: { offset: SUCCESSION_BLOCK_OFFSET, length: SUCCESSION_BLOCK_SIZE },
  });
  if (waiting.length === 0) return [];
  const now = await clusterTime(chain);
  const due: PublicKey[] = [];
  for (const { pubkey, account } of waiting) {
    if (account.data.length !== SUCCESSION_BLOCK_SIZE) continue;
    const s = decodeSuccessionBlock(new Uint8Array(account.data));
    if (s.waitOpen && now >= s.waitStartedTs + s.waitSecs) due.push(pubkey);
  }
  return due;
}

/** Closed vaults of the program, with the address each released to. */
export async function closedVaults(chain: Chain, programs: Programs): Promise<{ vault: PublicKey; heir: PublicKey }[]> {
  const tombs = await chain.getProgramAccounts(programs.vault, {
    commitment: COMMITMENT,
    filters: [{ dataSize: TOMBSTONE_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: base58(ACCOUNT.tombstone) } }],
  });
  return tombs.map(({ pubkey, account }) => ({ vault: pubkey, heir: decodeTombstone(new Uint8Array(account.data)).heir }));
}

export interface FinisherOptions {
  /**
   * The most token accounts one pass may create for a vault's claim address. Each costs this
   * finisher about 0.002 SOL that it does not get back, and anyone can make a vault own token
   * accounts of worthless mints, so a finisher that pays for strangers needs a bound. What it
   * leaves, the heir's own claim sweeps. Default: 8.
   */
  maxNewTokenAccountsPerVault?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface VaultReport {
  vault: PublicKey;
  steps: Step[];
  /** something unexpected stopped work on this vault; the others went on */
  error?: string;
}

/**
 * A finisher that remembers, while it runs, which closed vaults have nothing left to do, so it
 * does not ask about their token accounts on every pass. It keeps nothing on disk: after a restart
 * it looks at each closed vault once more.
 */
export class Finisher {
  private readonly settled = new Set<string>();
  private readonly chain: Chain;
  private readonly payer: Signer;
  private readonly programs: Programs;
  private readonly opts: FinisherOptions;

  constructor(chain: Chain, payer: Signer, programs: Programs, opts: FinisherOptions = {}) {
    this.chain = chain;
    this.payer = payer;
    this.programs = programs;
    this.opts = opts;
  }

  private finishOptions(): FinishOptions {
    return {
      sweepEmpty: false,
      maxNewTokenAccounts: this.opts.maxNewTokenAccountsPerVault ?? 8,
      ...(this.opts.dryRun ? { dryRun: true } : {}),
    };
  }

  /**
   * One pass: finish every vault that is due, then deliver what closed vaults still hold.
   * A failure on one vault is reported and does not stop the pass.
   */
  async pass(): Promise<VaultReport[]> {
    const reports: VaultReport[] = [];
    const work = async (vault: PublicKey): Promise<VaultReport> => {
      try {
        const { steps } = await finish(this.chain, this.payer, vault, this.finishOptions());
        for (const s of steps) this.opts.log?.(`${vault.toBase58()} ${describeStep(s)}`);
        return { vault, steps };
      } catch (e) {
        this.opts.log?.(`${vault.toBase58()} error: ${(e as Error).message}`);
        return { vault, steps: [], error: (e as Error).message };
      }
    };

    const released = new Set<string>();
    for (const vault of await releasableVaults(this.chain, this.programs)) {
      reports.push(await work(vault));
      released.add(vault.toBase58());
    }
    for (const { vault } of await closedVaults(this.chain, this.programs)) {
      const key = vault.toBase58();
      if (released.has(key) || this.settled.has(key)) continue;
      const report = await work(vault);
      // Nothing sent and nothing refused: this vault has nothing left for a finisher. Tokens that
      // reach its address later are found by a restart, or swept by the heir's own claim.
      const idle = !report.error && report.steps.every((s) => s.skipped !== undefined);
      if (idle && !this.opts.dryRun && (await holdingsOf(this.chain, vault)).every((h) => h.amount === 0n && h.withheld === 0n)) this.settled.add(key);
      if (report.steps.length > 0 || report.error) reports.push(report);
    }
    return reports;
  }

  /**
   * Passes until `signal` aborts, `intervalMs` apart. An RPC error ends a pass early and the next
   * one starts on time; nothing here needs to be exactly-once, since every instruction it sends is
   * safe to try again.
   */
  async run(intervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.pass();
      } catch (e) {
        this.opts.log?.(`pass failed: ${(e as Error).message}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
