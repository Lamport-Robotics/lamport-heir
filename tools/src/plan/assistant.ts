/**
 * The line between the assistant and the plan.
 *
 * The plan interview uses a language model to explain choices and to propose values. The model
 * holds no authority, and this file is where that is enforced rather than hoped for:
 *
 * - **It can only propose.** A proposal sits beside the plan until the owner accepts that one
 *   field. Nothing the model writes is read into the plan any other way.
 * - **It cannot propose who inherits.** Addresses (the vault, the heirs) are never taken from a
 *   model, whatever it says and whatever it was told. They come from the owner's own typing or
 *   from an heir's signed proof.
 * - **Its proposals are checked like any other input**: a known field, the right type, inside the
 *   programs' limits. Anything else is dropped and reported.
 * - **It is told nothing it does not need.** What is sent to the model carries no address, no key,
 *   no seed and no balance, only the choices that are open.
 * - **If its text asks for a secret, the owner never sees it.**
 *
 * The summary the owner signs against is built from the fields by template (`summary.ts`), never
 * from the model's words.
 */
import { DEFAULTS, LIMITS, type PlanFields } from "./fields.ts";

/** The only fields a model may propose a value for, with the limits a value must meet. */
const PROPOSABLE = {
  windowDays: LIMITS.windowDays,
  waitDays: LIMITS.waitDays,
  contingentDelayDays: LIMITS.contingentDelayDays,
} as const;
export type ProposableField = keyof typeof PROPOSABLE;
const PRIVACY_FIELDS = ["primary.private", "contingent.private"] as const;
export type PrivacyField = (typeof PRIVACY_FIELDS)[number];

export type Proposal = { field: ProposableField; value: number; why: string } | { field: PrivacyField; value: boolean; why: string };

export interface Refusal {
  /** the field the model named, as it wrote it */
  field: string;
  reason: string;
}

export interface ParsedReply {
  /** what the model says to the owner; replaced by a fixed notice if it asked for a secret */
  say: string;
  proposals: Proposal[];
  /** proposals that were dropped, and why */
  refused: Refusal[];
}

const SECRET_REQUEST = /\b(seed\s*phrase|recovery\s*phrase|secret\s*phrase|mnemonic|24\s*words|twenty[\s-]*four\s*words|12\s*words|private\s*key|secret\s*key|key\s*file|keypair|pass\s*phrase|password)\b/i;
const ASKING = /\b(enter|type|paste|send|share|give|tell|provide|upload|read\s+out|what\s+(is|are)|confirm|verify)\b/i;

/** The notice shown in place of a reply that asked for a secret. */
export const SECRET_NOTICE =
  "The assistant's last message was withheld because it appeared to ask for a secret. Nothing in this app, and nobody at Lamport, ever needs your words, your keys or a password. Do not give them to anyone.";

/** True when `text` reads as a request for a seed phrase, a key or a password. */
export function asksForSecret(text: string): boolean {
  return text
    .split(/(?<=[.!?\n])/)
    .some((sentence) => SECRET_REQUEST.test(sentence) && ASKING.test(sentence) && !/\b(never|do not|don't|nobody|no one)\b/i.test(sentence));
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Reads a model's reply. The reply is expected to be JSON of the form
 * `{ "say": string, "proposals": [{ "field", "value", "why" }] }`; anything else is treated as
 * text with no proposals. Nothing in the result has been applied to any plan.
 */
export function parseAssistantReply(raw: string): ParsedReply {
  let say = raw;
  let listed: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      say = typeof parsed.say === "string" ? parsed.say : "";
      listed = Array.isArray(parsed.proposals) ? parsed.proposals : [];
    }
  } catch {
    // not JSON: plain text, no proposals
  }
  const proposals: Proposal[] = [];
  const refused: Refusal[] = [];
  for (const item of listed.slice(0, 16)) {
    if (!isRecord(item) || typeof item.field !== "string") {
      refused.push({ field: "?", reason: "not a proposal" });
      continue;
    }
    const field = item.field;
    const why = typeof item.why === "string" ? item.why.slice(0, 500) : "";
    // own properties only: "__proto__" and "constructor" are `in` every object
    if (Object.hasOwn(PROPOSABLE, field)) {
      const limits = PROPOSABLE[field as ProposableField];
      const value = item.value;
      if (typeof value !== "number" || !Number.isInteger(value)) refused.push({ field, reason: "the value is not a whole number of days" });
      else if (value < limits.min || value > limits.max) refused.push({ field, reason: `the value is outside ${limits.min} to ${limits.max} days` });
      else proposals.push({ field: field as ProposableField, value, why });
    } else if ((PRIVACY_FIELDS as readonly string[]).includes(field)) {
      if (typeof item.value !== "boolean") refused.push({ field, reason: "the value is not true or false" });
      else proposals.push({ field: field as PrivacyField, value: item.value, why });
    } else if (/address|vault|heir|primary|contingent|claim|key|plan/i.test(field)) {
      refused.push({ field, reason: "the assistant cannot propose who inherits, or any address or key" });
    } else {
      refused.push({ field, reason: "not a field of the plan" });
    }
  }
  if (proposals.some((p) => asksForSecret(p.why))) return { say: SECRET_NOTICE, proposals: [], refused: [...refused, { field: "*", reason: "a proposal's explanation asked for a secret" }] };
  return { say: asksForSecret(say) ? SECRET_NOTICE : say, proposals: asksForSecret(say) ? [] : proposals, refused };
}

/** A plan being filled in: the fields, and what the assistant has proposed but the owner has not accepted. */
export interface Draft {
  fields: PlanFields;
  pending: Proposal[];
}

export function newDraft(vault: string): Draft {
  return {
    fields: { vault, primary: { address: "", private: false }, contingent: null, contingentDelayDays: 0, windowDays: DEFAULTS.windowDays, waitDays: DEFAULTS.waitDays },
    pending: [],
  };
}

/** Puts proposals beside the plan. The fields are not touched. A newer proposal for a field replaces an older one. */
export function propose(draft: Draft, proposals: Proposal[]): Draft {
  const fields = new Set(proposals.map((p) => p.field));
  return { fields: draft.fields, pending: [...draft.pending.filter((p) => !fields.has(p.field)), ...proposals] };
}

/**
 * The owner accepts the pending proposal for one field: the only way a model's value reaches the
 * plan. Throws when there is none, or when it no longer applies.
 */
export function accept(draft: Draft, field: Proposal["field"]): Draft {
  const p = draft.pending.find((x) => x.field === field);
  if (!p) throw new Error(`there is no proposal for ${field} to accept`);
  const f: PlanFields = { ...draft.fields, primary: { ...draft.fields.primary }, contingent: draft.fields.contingent ? { ...draft.fields.contingent } : null };
  if (p.field === "primary.private") f.primary.private = p.value;
  else if (p.field === "contingent.private") {
    if (!f.contingent) throw new Error("there is no contingent heir to keep private");
    f.contingent.private = p.value;
  } else if (p.field === "contingentDelayDays") {
    if (!f.contingent) throw new Error("there is no contingent heir to set a delay for");
    f.contingentDelayDays = p.value;
  } else if (p.field === "windowDays") f.windowDays = p.value;
  else if (p.field === "waitDays") f.waitDays = p.value;
  return { fields: f, pending: draft.pending.filter((x) => x !== p) };
}

/** The owner turns a proposal down. */
export function decline(draft: Draft, field: Proposal["field"]): Draft {
  return { fields: draft.fields, pending: draft.pending.filter((x) => x.field !== field) };
}

/**
 * What the model is told about the plan so far: the open choices and nothing that identifies
 * anyone. No address, no key, no balance. Whether an heir has been named is a yes or a no.
 */
export function assistantContext(draft: Draft): Record<string, unknown> {
  const f = draft.fields;
  return {
    windowDays: f.windowDays,
    waitDays: f.waitDays,
    primaryHeirNamed: f.primary.address !== "",
    primaryHeirPrivate: f.primary.private,
    contingentHeirNamed: f.contingent !== null && f.contingent.address !== "",
    contingentHeirPrivate: f.contingent?.private ?? false,
    contingentDelayDays: f.contingentDelayDays,
    limits: LIMITS,
    defaults: DEFAULTS,
    awaitingOwner: draft.pending.map((p) => p.field),
  };
}
