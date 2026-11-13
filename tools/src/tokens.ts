/**
 * Token accounts, as a release has to deal with them: which ones an address owns, under both token
 * programs, and what stands in the way of moving or closing each.
 *
 * What the vault's tests established (lamport-vault, docs/SUCCESSION.md section 7):
 * an account with withheld transfer fees cannot be closed until they are harvested to the mint,
 * which anyone may do; a mint with a transfer hook needs the hook's accounts passed along; frozen,
 * paused and non-transferable tokens fail cleanly and stay where they are. Nothing here decides
 * those last cases in advance. The tools ask the cluster (a simulation) and report what it says.
 */
import {
  addExtraAccountMetasForExecute,
  createHarvestWithheldTokensToMintInstruction,
  createTransferCheckedInstruction,
  getTransferFeeAmount,
  getTransferHook,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@lamport-robotics/vault";
import { type AccountMeta, type Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { type Chain, COMMITMENT } from "./chain.ts";

export const TOKEN_PROGRAMS: readonly PublicKey[] = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

/** One token account. */
export interface Holding {
  address: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  /** Token or Token-2022 */
  tokenProgram: PublicKey;
  amount: bigint;
  frozen: boolean;
  /** Token-2022 transfer fees withheld in this account. It cannot be closed while this is above zero. */
  withheld: bigint;
}

/** Every token account `owner` owns, under both token programs, in a fixed order (by address). */
export async function holdingsOf(chain: Chain, owner: PublicKey): Promise<Holding[]> {
  const out: Holding[] = [];
  for (const tokenProgram of TOKEN_PROGRAMS) {
    const { value } = await chain.getTokenAccountsByOwner(owner, { programId: tokenProgram }, COMMITMENT);
    for (const { pubkey, account } of value) {
      const a = unpackAccount(pubkey, account, tokenProgram);
      out.push({
        address: pubkey,
        owner: a.owner,
        mint: a.mint,
        tokenProgram,
        amount: a.amount,
        frozen: a.isFrozen,
        withheld: getTransferFeeAmount(a)?.withheldAmount ?? 0n,
      });
    }
  }
  return out.sort((x, y) => (x.address.toBase58() < y.address.toBase58() ? -1 : 1));
}

export interface MintFacts {
  address: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  /** the program a Token-2022 transfer hook calls on every transfer, when the mint has one */
  hookProgram?: PublicKey;
}

/** What a transfer of this mint needs to know. Throws when the address is not a mint of either token program. */
export async function mintFacts(chain: Chain, mint: PublicKey): Promise<MintFacts> {
  const info = await chain.getAccountInfo(mint, COMMITMENT);
  if (!info) throw new Error(`mint ${mint.toBase58()} does not exist`);
  const tokenProgram = TOKEN_PROGRAMS.find((p) => p.equals(info.owner));
  if (!tokenProgram) throw new Error(`${mint.toBase58()} is not a mint of Token or Token-2022`);
  const m = unpackMint(mint, info, tokenProgram);
  const hook = getTransferHook(m)?.programId;
  return { address: mint, tokenProgram, decimals: m.decimals, ...(hook && !hook.equals(PublicKey.default) ? { hookProgram: hook } : {}) };
}

/** `HarvestWithheldTokensToMint` for one account: moves its withheld transfer fees to the mint. Needs no signer. */
export function harvestInstruction(holding: Pick<Holding, "address" | "mint">): TransactionInstruction {
  return createHarvestWithheldTokensToMintInstruction(holding.mint, [holding.address], TOKEN_2022_PROGRAM_ID);
}

/**
 * The accounts a transfer hook wants on top of a plain transfer, in the order the token program
 * expects them. `sweep_closed` and `claim_token` pass whatever follows their own accounts to the
 * token program untouched, so these go there. Empty for a mint with no hook.
 */
export async function hookAccounts(
  chain: Chain,
  mint: MintFacts,
  transfer: { source: PublicKey; destination: PublicKey; authority: PublicKey; amount: bigint },
): Promise<AccountMeta[]> {
  if (!mint.hookProgram) return [];
  const plain = createTransferCheckedInstruction(transfer.source, mint.address, transfer.destination, transfer.authority, transfer.amount, mint.decimals, [], mint.tokenProgram);
  const base = plain.keys.length;
  // The helper reads one account (the hook's list of extra accounts) and nothing else of a Connection.
  await addExtraAccountMetasForExecute(chain as unknown as Connection, plain, mint.hookProgram, transfer.source, mint.address, transfer.destination, transfer.authority, transfer.amount, COMMITMENT);
  return plain.keys.slice(base);
}
