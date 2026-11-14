/**
 * The salts of the heirs an owner keeps private, as this browser holds them.
 *
 * A plan can name an heir by a fingerprint, `sha256(domain || salt || address)`, in place of their
 * address. Collecting then needs the salt, and a salt that exists nowhere is an heir who can never
 * collect. The copies that count are the one the owner writes down and the one the heir is handed
 * in their own link. The copy kept here is what lets this page find the plan again and print the
 * heir's kit, and it is a convenience, not a safeguard: a private window keeps it until it is
 * closed, and a browser may clear what a site stored.
 *
 * A salt is not a key: with it and nothing else, nobody can take anything. It does tell whoever
 * holds it which address is behind a fingerprint.
 *
 * Page only. Nothing here runs when the module loads.
 */
import { PublicKey } from "@solana/web3.js";

export interface KeptSalt {
  salt: Uint8Array;
  /** the owner has shown, by typing its check digits, that they wrote it down */
  written: boolean;
  /** the plan for which this heir's acceptance was checked here, as an address */
  acceptedFor?: string;
}

interface Entry {
  /** 64 lowercase hex digits */
  salt: string;
  written: boolean;
  acceptedFor?: string;
}

const key = (vault: PublicKey) => `lamport-heir-salts:${vault.toBase58()}`;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16));

const UNREADABLE = "This browser's record of salts for this vault cannot be read: something changed it. Nothing was written over it. Use the salt you wrote down, and the browser's own tools to look at what this page stored.";

function entry(x: unknown): Entry | null {
  const e = x as Partial<Entry> | null;
  if (!e || typeof e !== "object" || typeof e.salt !== "string" || !/^[0-9a-f]{64}$/.test(e.salt) || typeof e.written !== "boolean") return null;
  if (e.acceptedFor !== undefined && typeof e.acceptedFor !== "string") return null;
  return { salt: e.salt, written: e.written, ...(e.acceptedFor !== undefined ? { acceptedFor: e.acceptedFor } : {}) };
}

/** what is stored for `vault`, as it is: null when it is there and is not a record */
function record(vault: PublicKey): Record<string, unknown> | null {
  let text: string | null;
  try { text = localStorage.getItem(key(vault)); } catch { return {}; }
  if (text === null) return {};
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch { return null; }
}

/** the salt this browser keeps for `heir` of `vault`, if it keeps one it can read */
export function keptSalt(vault: PublicKey, heir: PublicKey): KeptSalt | null {
  const e = entry(record(vault)?.[heir.toBase58()]);
  return e ? { salt: unhex(e.salt), written: e.written, ...(e.acceptedFor !== undefined ? { acceptedFor: e.acceptedFor } : {}) } : null;
}

/** every salt this browser keeps for `vault` */
export function keptSalts(vault: PublicKey): { heir: PublicKey; salt: Uint8Array }[] {
  const out: { heir: PublicKey; salt: Uint8Array }[] = [];
  for (const [address, v] of Object.entries(record(vault) ?? {})) {
    const e = entry(v);
    if (!e) continue;
    try { out.push({ heir: new PublicKey(address), salt: unhex(e.salt) }); } catch { /* not an address: not ours */ }
  }
  return out;
}

/**
 * Writes one heir's entry, leaving every other entry as it was, read or not. Refuses to write over
 * anything it cannot read: an entry that does not parse may be the only copy of a salt in a plan.
 */
function put(vault: PublicKey, heir: PublicKey, change: (had: Entry | null) => Entry): Entry {
  const all = record(vault);
  if (all === null) throw new Error(UNREADABLE);
  const raw = all[heir.toBase58()];
  const had = entry(raw);
  if (raw !== undefined && !had) throw new Error(UNREADABLE);
  const next = change(had);
  localStorage.setItem(key(vault), JSON.stringify({ ...all, [heir.toBase58()]: next }));
  return next;
}

/**
 * The salt for `heir` of `vault`: the one this browser already keeps, or a new one, kept before it
 * is returned. `made` says which. Throws when the browser does not hand back what was just
 * stored. That it will still be there next month is not something a page can know.
 */
export function saltFor(vault: PublicKey, heir: PublicKey): { salt: Uint8Array; made: boolean } {
  const had = keptSalt(vault, heir);
  if (had) return { salt: had.salt, made: false };
  const salt = crypto.getRandomValues(new Uint8Array(32));
  let failed = false;
  try { put(vault, heir, () => ({ salt: hex(salt), written: false })); }
  catch (e) { if ((e as Error).message === UNREADABLE) throw e; failed = true; }
  const kept = keptSalt(vault, heir);
  if (failed || !kept || hex(kept.salt) !== hex(salt)) throw new Error("This browser will not store anything for this page, so the page could not find this plan again or print the heir's kit. Allow it to store data, or use another browser, to keep an heir private.");
  // ask the browser not to clear this page's data under storage pressure. it may say no, and says nothing about a private window
  try { void navigator.storage?.persist?.().catch(() => undefined); } catch { /* not offered */ }
  return { salt, made: true };
}

const GONE = (who: string) => `This browser no longer holds the salt of the ${who}: its data for this page was cleared. Nothing was done. Press "Prepare the plan" again.`;

/** records that the owner wrote the salt down. Throws when the salt is no longer here: there is nothing to have written down */
export function markWritten(vault: PublicKey, heir: PublicKey, who = "heir"): void {
  put(vault, heir, (had) => { if (!had) throw new Error(GONE(who)); return { ...had, written: true }; });
}

/** records that this heir's acceptance of `plan` was checked here */
export function markAccepted(vault: PublicKey, heir: PublicKey, plan: PublicKey, who = "heir"): void {
  put(vault, heir, (had) => { if (!had) throw new Error(GONE(who)); return { ...had, acceptedFor: plan.toBase58() }; });
}
