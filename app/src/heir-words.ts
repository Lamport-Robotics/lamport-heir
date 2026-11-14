/**
 * What the heirs' page says. Kept apart from the page so it can be read and tested as text: an
 * heir reads this at a bad time, and every sentence has to be true of the chain as it stands.
 *
 * Pure: a situation in, words out.
 */
import type { PublicKey } from "@solana/web3.js";
import { claimRole, contingentOpensAt, type HeirRef, type Terms } from "../../tools/src/claim.ts";
import type { ClaimVerdict } from "../../tools/src/claiming.ts";
import type { Situation, Step } from "../../tools/src/release.ts";

/** what the page offers to do next */
export type NextStep = "nothing" | "start" | "release" | "collect";

export interface Words {
  headline: string;
  lines: string[];
  /** set when something is wrong with the arrangement itself, whoever is asking */
  warning?: string;
  next: NextStep;
}

/** a moment of the cluster's clock, with how far off it is */
export function when(ts: bigint, now: bigint, daySecs = 86_400n): string {
  const date = new Date(Number(ts) * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: daySecs === 86_400n ? "short" : "medium" });
  const delta = ts - now, abs = delta < 0n ? -delta : delta;
  const span = abs >= 172_800n ? `${abs / 86_400n} days` : abs >= 7_200n ? `${abs / 3_600n} hours` : abs >= 120n ? `${abs / 60n} minutes` : `${abs} seconds`;
  return `${date} (${delta < 0n ? `${span} ago` : `in ${span}`})`;
}

export function durationInDays(secs: bigint, daySecs: bigint): string {
  if (secs % daySecs !== 0n) return `${secs} seconds`;
  const n = secs / daySecs;
  return `${n} day${n === 1n ? "" : "s"}`;
}

function isHeir(h: HeirRef, me: PublicKey): boolean {
  return h.kind === "address" && h.address.equals(me);
}

/** an heir's place in a plan's terms: for the acceptance, before any plan exists */
export function placeInTerms(terms: Terms, me: PublicKey, daySecs: bigint): { named: boolean; text: string } {
  if (isHeir(terms.primary, me)) return { named: true, text: "You are the first heir. Once the vault has been released, you may claim everything in it." };
  if (isHeir(terms.contingent, me)) return { named: true, text: `You are the second heir. You may claim if the first heir has not, from ${durationInDays(terms.contingentDelaySecs, daySecs)} after the vault is released.` };
  return { named: false, text: "The wallet you connected is not one of the addresses this plan names. Connect the wallet whose address you gave the owner." };
}

/** where a vault stands, for whoever is looking, and for `me` when a wallet is connected */
export function situationWords(s: Situation, me?: PublicKey): Words {
  const day = s.programs.daySecs;
  const lines: string[] = [];
  let warning: string | undefined;
  if (s.planNamesAnotherVault) warning = "The plan this vault releases to was made for a different vault. What this vault releases to it could never be claimed. The owner has to sign a new plan.";
  else if (s.claimHasNoKeyAndNoAccount) warning = "Nothing has been set up at the address this vault releases to, and no key exists for it. If it is a plan that was never created, it can still be created with exactly the heirs the owner chose; until then nothing released there can be claimed.";

  // who is asking
  let mine: "sole" | "primary" | "contingent" | "not_named" | "unknown" = "unknown";
  if (me) {
    if (s.plan) mine = isHeir(s.plan.account.terms.primary, me) ? "primary" : isHeir(s.plan.account.terms.contingent, me) ? "contingent" : "not_named";
    else if (s.claim) mine = s.claim.equals(me) ? "sole" : "not_named";
  }
  const place = mine === "sole" ? "This vault releases straight to your wallet." : mine === "primary" ? "You are the first heir of this vault's plan." : mine === "contingent" ? "You are the second heir of this vault's plan." : mine === "not_named" ? (s.plan && (s.plan.account.terms.primary.kind === "hashed" || s.plan.account.terms.contingent.kind === "hashed") ? "The wallet you connected is not named openly. This plan keeps heirs private: such an heir claims with the command-line tool and the salt printed in their kit." : "The wallet you connected is not named by this vault. You can still look, and anyone may finish a release, but only the named heirs receive anything.") : "";

  if (s.state === "open") {
    const st = s.status!;
    if (st.phase === "unarmed") return { headline: "This vault has no inheritance plan.", lines: ["Nothing in it is released to anyone."], next: "nothing" };
    if (place) lines.push(place);
    if (st.phase === "quiet") {
      lines.push(`The owner has signed or checked in recently enough. Nothing can happen before ${when(st.deadline!, s.now, day)}, and every sign of life from them moves that date.`);
      if (st.earliestRelease !== undefined) lines.push(`The soonest the vault could be released is ${when(st.earliestRelease, s.now, day)}.`);
      return { headline: "The owner is within their time. There is nothing to do.", lines, ...(warning ? { warning } : {}), next: "nothing" };
    }
    if (st.phase === "overdue") {
      lines.push(`The owner's time ran out on ${when(st.deadline!, s.now, day)}. Nothing has been released and nothing is released by itself.`,
        `Anyone may now open the waiting period, which lasts ${durationInDays(s.succession!.waitSecs, day)}. It is public, the owner and the people they chose are warned, and any signature or check-in from the owner cancels it.`);
      return { headline: "The owner has been silent past their deadline.", lines, ...(warning ? { warning } : {}), next: "start" };
    }
    if (st.phase === "waiting") {
      lines.push(`A waiting period is open. The vault can be released from ${when(st.releaseAt!, s.now, day)}.`, "Until then, any signature or check-in from the owner cancels it.");
      return { headline: "The waiting period is running.", lines, ...(warning ? { warning } : {}), next: "nothing" };
    }
    lines.push(`The waiting period ended on ${when(st.releaseAt!, s.now, day)}. Anyone may release the vault now; it can only go where the owner's plan says.`);
    return { headline: "The vault can be released.", lines, ...(warning ? { warning } : {}), next: warning ? "nothing" : "release" };
  }

  // released
  if (place) lines.push(place);
  lines.push(`The vault was released to ${s.claim!.toBase58()}.`);
  if (s.plan) {
    const p = s.plan.account;
    if (!p.activated) lines.push("The plan has not recorded the release yet. Collecting does that first.");
    else if (me) {
      const role = claimRole(p, me, undefined, s.now);
      if (!role.ok && role.reason === "ContingentTooEarly") lines.push(`As the second heir you may claim from ${when(role.opensAt, s.now, day)}, unless the first heir claims before then.`);
    }
    const opens = contingentOpensAt(p);
    if (opens !== undefined && mine !== "contingent") lines.push(`The second heir may claim from ${when(opens, s.now, day)} if the first has not.`);
  }
  return { headline: "This vault has been released.", lines, ...(warning ? { warning } : {}), next: warning || mine === "not_named" ? "nothing" : "collect" };
}

/**
 * For the owner's trusted contact: the one thing their key can do. Null when `me` is not the
 * contact of an open, armed vault.
 */
export function contactWords(s: Situation, me: PublicKey | undefined, extensionDays: bigint): { text: string; canExtend: boolean } | null {
  const plan = s.succession;
  // the default address in the plan means "no contact": it is nobody's, whoever is asking
  if (!me || s.state !== "open" || !plan || !s.status || s.status.phase === "unarmed" || plan.contactKey.toBase58() === "11111111111111111111111111111111" || !plan.contactKey.equals(me)) return null;
  if (plan.contactUsed) return { canExtend: false, text: "You are this vault's trusted contact, and you have used your extension. Only the owner can give you another, by signing their plan again." };
  return {
    canExtend: true,
    text: `You are this vault's trusted contact. If you believe the owner is alive but cannot sign or check in, you can push their deadline back by ${extensionDays} days. You can do it once. It moves nothing, it gives you nothing, and it cancels a waiting period that is open.`,
  };
}

/** what came of a claim, in a sentence */
export function verdictWords(v: ClaimVerdict, now: bigint, daySecs = 86_400n): string {
  switch (v.kind) {
    case "claimed": return `Collected, as the ${v.role === "primary" ? "first" : "second"} heir. What could be moved is in your wallet.`;
    case "not_released": return `Nothing to collect yet: the vault has not been released.${v.earliestRelease !== undefined ? ` The soonest it could be is ${when(v.earliestRelease, now, daySecs)}.` : ""}`;
    case "released_to_address": return v.yours ? "This vault releases straight to your wallet: there is nothing to withdraw, it was delivered to you." : `This vault releases to ${v.address.toBase58()}, which is not your wallet's address.`;
    case "plan_not_created": return `This vault releases to ${v.address.toBase58()}, where nothing is set up. If that is a plan that was never created, it can still be created with exactly the heirs the owner chose.`;
    case "plan_for_another_vault": return "The plan was made for another vault and cannot be claimed through this one.";
    case "not_activated": return "The plan has not recorded the release yet. Try again.";
    case "not_an_heir": return v.hashedHeirs ? "This wallet is not named openly in the plan. The plan keeps heirs private: such an heir claims with the command-line tool and the salt in their kit." : "This wallet is not an heir of the plan.";
    case "contingent_too_early": return `You are the second heir and may claim from ${when(v.opensAt, now, daySecs)}, unless the first heir claims before then.`;
  }
}

const STEP_NAMES: Record<Step["kind"], string> = {
  start_succession: "Open the waiting period",
  execute_succession: "Release the vault",
  activate: "Record the release in the plan",
  sweep: "Move a token out of the vault",
  sweep_sol: "Move SOL that arrived later",
  claim_sol: "Withdraw the SOL",
  claim_token: "Withdraw a token",
};

/** one step of a release or a claim: what it was and what came of it */
export function stepWords(step: Step): { name: string; outcome: "done" | "left" | "skipped"; detail: string } {
  const name = `${STEP_NAMES[step.kind]}${step.mint ? ` · ${step.mint.toBase58().slice(0, 6)}…` : ""}`;
  if (step.signature) return { name, outcome: "done", detail: step.signature };
  if (step.failed) return { name, outcome: "left", detail: `not moved: ${step.failed}. It stays where it is and can be tried again.` };
  return { name, outcome: "skipped", detail: step.skipped ?? "not needed" };
}
