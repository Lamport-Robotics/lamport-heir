/**
 * The summary an owner reads before they sign.
 *
 * It is built from the plan's fields by template. No model writes it, rephrases it or sees it
 * first: what the owner reads is a function of the fields that are about to go on chain, and of
 * nothing else. The same fields always give the same text.
 */
import { checkFields, type PlanFields } from "./fields.ts";

function days(n: number): string {
  if (n % 365 === 0 && n >= 365) {
    const years = n / 365;
    return `${n} days (${years} year${years === 1 ? "" : "s"})`;
  }
  return `${n} days`;
}

/**
 * The plan in plain sentences, one fact per line. Throws when the fields would not be accepted on
 * chain: a summary is only ever shown for a plan that can be signed.
 */
export function planSummary(f: PlanFields): string[] {
  const problems = checkFields(f);
  if (problems.length > 0) throw new Error(`the plan cannot be summarised until it is valid: ${problems.map((p) => `${p.field} ${p.problem}`).join("; ")}`);
  const total = f.windowDays + f.waitDays;
  const lines = [
    `This plan is for vault ${f.vault}.`,
    `If you sign nothing with this vault and do not check in for ${days(f.windowDays)}, anyone may open a public waiting period.`,
    `The waiting period lasts ${days(f.waitDays)}. Any signature with the vault, or one check-in, cancels it.`,
    `If it runs out, anyone may release everything in the vault to your heirs. That cannot be undone.`,
    `The soonest that can happen is ${days(total)} after your last signature, and each signature starts that count again.`,
    f.primary.private
      ? `Primary heir: ${f.primary.address}. Their address stays off the chain until they claim; they will need the salt printed in their claim kit.`
      : `Primary heir: ${f.primary.address}. This address will be public from the day you sign.`,
  ];
  if (f.contingent === null) {
    lines.push("There is no contingent heir. If the primary heir never claims, the funds stay where the release put them.");
  } else {
    lines.push(
      f.contingent.private
        ? `Contingent heir: ${f.contingent.address}. Their address stays off the chain until they claim; they will need the salt printed in their claim kit.`
        : `Contingent heir: ${f.contingent.address}. This address will be public from the day you sign.`,
      `The contingent heir may claim if the primary heir has not claimed for ${days(f.contingentDelayDays)} after the release.`,
    );
  }
  lines.push(
    "Whoever holds an heir's key at that time receives the funds. Nobody, Lamport included, can redirect, pause or reverse a release.",
    "You can change or clear this plan at any time with one vault signature.",
  );
  return lines;
}
