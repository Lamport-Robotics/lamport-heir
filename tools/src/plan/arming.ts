/**
 * From the owner's fields to what goes on chain, and the checks that stand between a plan and a
 * signature.
 *
 * Arming takes two steps, in this order:
 *
 * 1. the plan is created in the claim program (`init_plan`), with each named heir proving control;
 * 2. the owner signs a `SetSuccession` that names the plan's address, with the vault's own
 *    signing flow.
 *
 * Step 2 is the one that matters, and the vault program cannot check what it is pointed at: it
 * does not know the claim program. So `checkBeforeArming` does, and whatever asks an owner to sign
 * has to refuse while it reports a problem. It covers the two ways a release can end up where
 * nobody can claim it: a plan that was never created, and a plan made for another vault.
 */
import { decodeVault, isLiveVault, VAULT_SUCCESSION_ACCOUNT_VERSION } from "@lamport-robotics/vault";
import { PublicKey } from "@solana/web3.js";
import { type Chain, COMMITMENT } from "../chain.ts";
import { checkTerms, decodePlan, encodeTerms, hashedHeir, type HeirRef, isPlan, planAddress, type Terms } from "../claim.ts";
import { type Programs } from "../programs.ts";
import { checkFields, type HeirField, type PlanFields } from "./fields.ts";

/** A plan ready to be created and armed. */
export interface PlanBuild {
  programs: Programs;
  vault: PublicKey;
  terms: Terms;
  /** the plan's address: what the vault will name as its claim address */
  plan: PublicKey;
  /** the salts of heirs kept private. Each goes into that heir's claim kit and nowhere else. */
  salts: { primary?: Uint8Array; contingent?: Uint8Array };
  /** the fields of the `SetSuccession` the owner signs */
  succession: { claim: PublicKey; windowSecs: bigint; waitSecs: bigint; checkinKey: PublicKey; contactKey: PublicKey };
}

function heirRef(h: HeirField, salt: Uint8Array | undefined, who: string): HeirRef {
  const address = new PublicKey(h.address);
  if (!h.private) return { kind: "address", address };
  if (!salt || salt.length !== 32) throw new Error(`the ${who} heir is kept private, which needs a 32-byte salt made on the owner's device`);
  return hashedHeir(salt, address);
}

/**
 * Turns the owner's fields into the plan's terms, its address and the `SetSuccession` to sign.
 * Pure: the same fields, salts and keys always give the same plan. Throws on fields the chain
 * would refuse.
 *
 * `salts` are needed only for heirs marked private, and must come from the owner's device: 32
 * random bytes each. `checkinKey` and `contactKey` are public keys; pass the default address for
 * none.
 */
export function buildPlan(
  fields: PlanFields,
  opts: { programs: Programs; checkinKey?: PublicKey; contactKey?: PublicKey; salts?: { primary?: Uint8Array; contingent?: Uint8Array } },
): PlanBuild {
  const problems = checkFields(fields);
  if (problems.length > 0) throw new Error(`the plan is not valid: ${problems.map((p) => `${p.field} ${p.problem}`).join("; ")}`);
  const { programs } = opts;
  const vault = new PublicKey(fields.vault);
  const salts: PlanBuild["salts"] = {};
  if (fields.primary.private && opts.salts?.primary) salts.primary = opts.salts.primary;
  if (fields.contingent?.private && opts.salts?.contingent) salts.contingent = opts.salts.contingent;
  if (salts.primary && salts.contingent && Buffer.from(salts.primary).equals(Buffer.from(salts.contingent))) throw new Error("two private heirs need two different salts");
  const terms: Terms = {
    vault,
    primary: heirRef(fields.primary, salts.primary, "primary"),
    contingent: fields.contingent ? heirRef(fields.contingent, salts.contingent, "contingent") : { kind: "none" },
    contingentDelaySecs: BigInt(fields.contingentDelayDays) * programs.daySecs,
  };
  checkTerms(terms, programs);
  const plan = planAddress(terms, programs.claim);
  return {
    programs,
    vault,
    terms,
    plan,
    salts,
    succession: {
      claim: plan,
      windowSecs: BigInt(fields.windowDays) * programs.daySecs,
      waitSecs: BigInt(fields.waitDays) * programs.daySecs,
      checkinKey: opts.checkinKey ?? PublicKey.default,
      contactKey: opts.contactKey ?? PublicKey.default,
    },
  };
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Everything that must be true on chain before the owner is asked to sign the `SetSuccession` of
 * `build`. An empty list means go ahead. Any entry means do not sign: the words say why.
 */
export async function checkBeforeArming(chain: Chain, build: PlanBuild): Promise<string[]> {
  const problems: string[] = [];
  const { programs, vault, plan, terms } = build;
  if (!build.succession.claim.equals(plan)) problems.push("the SetSuccession does not name this plan's address");
  if (!terms.vault.equals(vault)) problems.push("the plan's terms are for another vault");

  const vaultInfo = await chain.getAccountInfo(vault, COMMITMENT);
  if (!vaultInfo) problems.push(`there is no account at the vault's address ${vault.toBase58()}`);
  else if (!vaultInfo.owner.equals(programs.vault)) problems.push(`${vault.toBase58()} is not a vault of the Heir-enabled vault program`);
  else if (!isLiveVault(new Uint8Array(vaultInfo.data))) problems.push(`the vault at ${vault.toBase58()} is closed`);
  else if (decodeVault(new Uint8Array(vaultInfo.data)).version !== VAULT_SUCCESSION_ACCOUNT_VERSION) problems.push(`the vault at ${vault.toBase58()} has no succession block`);

  const planInfo = await chain.getAccountInfo(plan, COMMITMENT);
  if (!planInfo || planInfo.data.length === 0) {
    problems.push(`the plan has not been created at ${plan.toBase58()}: create it first (init_plan). A vault armed to an address with no plan would release to a place nobody can claim from`);
  } else if (!planInfo.owner.equals(programs.claim) || !isPlan(new Uint8Array(planInfo.data))) {
    problems.push(`the account at ${plan.toBase58()} is not a plan of the claim program`);
  } else {
    const onChain = decodePlan(new Uint8Array(planInfo.data));
    if (!onChain.terms.vault.equals(vault)) problems.push(`the plan at ${plan.toBase58()} was made for another vault (${onChain.terms.vault.toBase58()}): it could never be activated by this one`);
    else if (!equal(encodeTerms(onChain.terms), encodeTerms(terms))) problems.push(`the plan at ${plan.toBase58()} does not hold these terms`);
    if (onChain.activated) problems.push(`the plan at ${plan.toBase58()} has already been activated by a release`);
  }
  return problems;
}
