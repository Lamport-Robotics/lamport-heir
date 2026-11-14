/**
 * The plan as its owner fills it in, and the rules its fields must meet.
 *
 * These are the fields of the form, in the form's own units (days, addresses as text). They map
 * onto two things on chain: the terms of a claim-program plan (who inherits, and the contingent
 * heir's delay) and a `SetSuccession` (the window, the waiting period, the keys). `checkFields`
 * applies the same limits the two programs apply, so a plan the form accepts is one the chain
 * accepts.
 */
import { PublicKey } from "@solana/web3.js";

export interface HeirField {
  /** the heir's own address, typed or pasted by the owner, or taken from the heir's signed proof */
  address: string;
  /** keep the address off chain until the heir claims (a salted hash is stored instead) */
  private: boolean;
}

export interface PlanFields {
  /** the vault this plan is for */
  vault: string;
  primary: HeirField;
  /** null for no contingent heir */
  contingent: HeirField | null;
  /** how long the contingent heir waits after the release without a claim by the primary; 0 with no contingent heir */
  contingentDelayDays: number;
  /** how long the owner may be silent before a waiting period can be opened */
  windowDays: number;
  /** how long the public waiting period lasts */
  waitDays: number;
}

/** The form's defaults: a year of silence, two months of waiting, a year for the contingent heir. */
export const DEFAULTS = Object.freeze({ windowDays: 365, waitDays: 60, contingentDelayDays: 365 });

/** The programs' limits, in days. */
export const LIMITS = Object.freeze({
  windowDays: { min: 90, max: 36_500 },
  waitDays: { min: 30, max: 36_500 },
  contingentDelayDays: { min: 30, max: 36_500 },
});

export type FieldName = "vault" | "primary.address" | "primary.private" | "contingent" | "contingent.address" | "contingent.private" | "contingentDelayDays" | "windowDays" | "waitDays";

export interface FieldProblem {
  field: FieldName;
  problem: string;
}

function address(text: string): PublicKey | undefined {
  try {
    const k = new PublicKey(text);
    return k.toBase58() === text ? k : undefined;
  } catch {
    return undefined;
  }
}

function wholeDays(value: number, limits: { min: number; max: number }): string | undefined {
  if (!Number.isInteger(value)) return "must be a whole number of days";
  if (value < limits.min) return `must be at least ${limits.min} days`;
  if (value > limits.max) return `must be at most ${limits.max} days`;
  return undefined;
}

/** Everything wrong with the fields, in words. An empty list means both programs will accept the plan. */
export function checkFields(f: PlanFields): FieldProblem[] {
  const out: FieldProblem[] = [];
  const vault = address(f.vault);
  if (!vault) out.push({ field: "vault", problem: "is not a Solana address" });
  const primary = address(f.primary.address);
  if (!primary) out.push({ field: "primary.address", problem: "is not a Solana address" });
  else if (primary.equals(PublicKey.default)) out.push({ field: "primary.address", problem: "is the all-zero address" });
  else if (vault && primary.equals(vault)) out.push({ field: "primary.address", problem: "is the vault itself" });

  const window = wholeDays(f.windowDays, LIMITS.windowDays);
  if (window) out.push({ field: "windowDays", problem: window });
  const wait = wholeDays(f.waitDays, LIMITS.waitDays);
  if (wait) out.push({ field: "waitDays", problem: wait });

  if (f.contingent === null) {
    if (f.contingentDelayDays !== 0) out.push({ field: "contingentDelayDays", problem: "must be 0 when there is no contingent heir" });
  } else {
    const contingent = address(f.contingent.address);
    if (!contingent) out.push({ field: "contingent.address", problem: "is not a Solana address" });
    else if (contingent.equals(PublicKey.default)) out.push({ field: "contingent.address", problem: "is the all-zero address" });
    else if (vault && contingent.equals(vault)) out.push({ field: "contingent.address", problem: "is the vault itself" });
    else if (primary && contingent.equals(primary)) out.push({ field: "contingent.address", problem: "is the same as the primary heir" });
    const delay = wholeDays(f.contingentDelayDays, LIMITS.contingentDelayDays);
    if (delay) out.push({ field: "contingentDelayDays", problem: delay });
  }
  return out;
}
