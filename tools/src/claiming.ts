/**
 * An heir taking what a vault released.
 *
 * `claim` needs nothing from Lamport: it finishes the release itself if nobody has (everything in
 * `release.ts` is open to anyone), then signs the withdrawals from the plan as the heir.
 *
 * The heir's key signs exactly two kinds of instruction here, `claim_sol` and `claim_token`, plus
 * the creation of the heir's own token accounts, and pays the fees. It is used in memory and never
 * written, logged or sent anywhere.
 */
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type Signer } from "@solana/web3.js";
import { type Chain, clusterTime, COMMITMENT } from "./chain.ts";
import { claimRole, claimSolInstruction, claimTokenInstruction, heirMatches, PLAN_ACCOUNT_SIZE } from "./claim.ts";
import { attemptStep, describeStep, finish, inspect, type Situation, type Step } from "./release.ts";
import { harvestInstruction, holdingsOf, hookAccounts, type MintFacts, mintFacts } from "./tokens.ts";

export interface ClaimOptions {
  /** The salt a hashed heir was committed with (32 bytes). The claim kit prints it. */
  salt?: Uint8Array;
  /** Ask the cluster what would happen and send nothing. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

/** Why nothing, or not everything, could be claimed. Absent when the claim ran. */
export type ClaimVerdict =
  | { kind: "not_released"; phase: string; earliestRelease?: bigint }
  | { kind: "released_to_address"; address: PublicKey; yours: boolean }
  | { kind: "plan_not_created"; address: PublicKey }
  | { kind: "plan_for_another_vault"; plan: PublicKey }
  | { kind: "not_activated" }
  | { kind: "not_an_heir"; hashedHeirs: boolean; saltGiven: boolean }
  | { kind: "contingent_too_early"; opensAt: bigint }
  | { kind: "claimed"; role: "primary" | "contingent" };

const COMPUTE_UNITS = 400_000;

/**
 * Brings everything a released vault held to the heir who signs.
 *
 * `address` is the vault's or the plan's. A key the vault's owner did not name is told so before
 * anything is sent or paid for. Otherwise, in order: whatever of the release is still undone
 * (`finish`), then, when the vault released to a plan, `claim_sol` and one `claim_token` per token
 * account the plan holds, each into the heir's own associated token account, which is created if
 * missing. When the vault released straight to an address there is nothing to claim: the sweeps
 * already delivered to that address.
 *
 * Tokens the cluster refuses to move are reported in `steps` with the reason, and the rest are
 * claimed regardless.
 */
export async function claim(chain: Chain, heir: Signer, address: PublicKey, opts: ClaimOptions = {}): Promise<{ situation: Situation; steps: Step[]; verdict: ClaimVerdict }> {
  // First, without spending anything: is this key the one the vault's owner named?
  const before = await inspect(chain, address);
  if (before.plan) {
    if (before.planNamesAnotherVault) return { situation: before, steps: [], verdict: { kind: "plan_for_another_vault", plan: before.plan.address } };
    const terms = before.plan.account.terms;
    if (!heirMatches(terms.primary, heir.publicKey, opts.salt) && !heirMatches(terms.contingent, heir.publicKey, opts.salt)) {
      const hashedHeirs = terms.primary.kind === "hashed" || terms.contingent.kind === "hashed";
      return { situation: before, steps: [], verdict: { kind: "not_an_heir", hashedHeirs, saltGiven: opts.salt !== undefined } };
    }
  } else if (before.claim && before.claimHasNoKeyAndNoAccount) {
    return { situation: before, steps: [], verdict: { kind: "plan_not_created", address: before.claim } };
  } else if (before.claim && !before.claim.equals(heir.publicKey)) {
    return { situation: before, steps: [], verdict: { kind: "released_to_address", address: before.claim, yours: false } };
  }

  const finished = await finish(chain, heir, before.vault, { ...(opts.dryRun ? { dryRun: true } : {}), ...(opts.log ? { log: opts.log } : {}) });
  const steps = [...finished.steps];
  const record = (s: Step) => {
    steps.push(s);
    opts.log?.(describeStep(s));
  };
  let situation = finished.situation;

  if (situation.state === "open") {
    const status = situation.status;
    return { situation, steps, verdict: { kind: "not_released", phase: status?.phase ?? "unarmed", ...(status?.earliestRelease !== undefined ? { earliestRelease: status.earliestRelease } : {}) } };
  }
  const claimAddress = situation.claim!;
  if (!situation.plan) return { situation, steps, verdict: { kind: "released_to_address", address: claimAddress, yours: claimAddress.equals(heir.publicKey) } };

  const plan = situation.plan.account;
  const role = claimRole(plan, heir.publicKey, opts.salt, await clusterTime(chain));
  if (!role.ok) {
    if (role.reason === "ContingentTooEarly") return { situation, steps, verdict: { kind: "contingent_too_early", opensAt: role.opensAt } };
    // the key is one of the plan's heirs (checked above), so what is left is a plan not activated yet
    return { situation, steps, verdict: { kind: "not_activated" } };
  }

  const programs = situation.programs;
  const planRent = await chain.getMinimumBalanceForRentExemption(PLAN_ACCOUNT_SIZE, COMMITMENT);
  const lamports = (await chain.getAccountInfo(claimAddress, COMMITMENT))?.lamports ?? 0;
  if (lamports > planRent) {
    const ix = claimSolInstruction({ claimProgram: programs.claim, plan: claimAddress, heir: heir.publicKey, salt: opts.salt });
    record(await attemptStep(chain, heir, [], [ix], { kind: "claim_sol", amount: BigInt(lamports - planRent) }, { dryRun: opts.dryRun }));
  }

  const mints = new Map<string, MintFacts>();
  for (const h of await holdingsOf(chain, claimAddress)) {
    const step: Step = { kind: "claim_token", account: h.address, mint: h.mint, amount: h.amount };
    try {
      const key = h.mint.toBase58();
      const mint = mints.get(key) ?? (await mintFacts(chain, h.mint));
      mints.set(key, mint);
      const destination = getAssociatedTokenAddressSync(h.mint, heir.publicKey, true, h.tokenProgram);
      const extraAccounts = await hookAccounts(chain, mint, { source: h.address, destination, authority: claimAddress, amount: h.amount });
      const instructions = [
        createAssociatedTokenAccountIdempotentInstruction(heir.publicKey, destination, heir.publicKey, h.mint, h.tokenProgram),
        // an account with withheld transfer fees cannot be closed until they are harvested to the mint
        ...(h.withheld > 0n ? [harvestInstruction(h)] : []),
        claimTokenInstruction({ claimProgram: programs.claim, plan: claimAddress, heir: heir.publicKey, planTokenAccount: h.address, destination, mint: h.mint, tokenProgram: h.tokenProgram, salt: opts.salt, closeAccount: true, extraAccounts }),
      ];
      record(await attemptStep(chain, heir, [], instructions, step, { dryRun: opts.dryRun, computeUnits: COMPUTE_UNITS }));
    } catch (e) {
      record({ ...step, failed: (e as Error).message });
    }
  }
  if (steps.some((s) => s.signature)) situation = await inspect(chain, situation.vault);
  return { situation, steps, verdict: { kind: "claimed", role: role.role } };
}
