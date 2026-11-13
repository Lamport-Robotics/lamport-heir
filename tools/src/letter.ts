/**
 * The family letter: what the owner wants their heirs to know that no chain can tell them (where
 * other accounts are, who to call, where the documents are). It is written and encrypted on the
 * owner's device. What leaves the device is ciphertext, so whoever stores it, Lamport included,
 * cannot read it. It must never hold a seed phrase or a key, and the app says so where it is
 * written.
 *
 * Who can read it: each heir, with a key only they can make. A wallet will sign a message but
 * will not decrypt one, so an heir's reading key is derived from their signature over a fixed
 * sentence that names the plan. Ed25519 signatures are deterministic, so the heir gets the same
 * key again years later from the same wallet, a hardware wallet included, and gives the owner only
 * the public half when they accept their place in the plan.
 *
 * That signature is therefore a secret. The sentence says what it is for and where to sign it;
 * signing it anywhere else hands that place the letter (and nothing but the letter: no funds move
 * on it).
 *
 * Construction: X25519, HKDF-SHA-256, AES-256-GCM. One random content key encrypts the letter; it
 * is wrapped once per heir under a key agreed between a fresh ephemeral key and the heir's.
 */
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { type PublicKey } from "@solana/web3.js";

const utf8 = new TextEncoder();

/** The sentence an heir signs to make their reading key for `plan`. */
export function letterKeyMessage(plan: PublicKey): string {
  return `Lamport Heir: this signature is my private key for reading the family letter of plan ${plan.toBase58()}. I sign it only inside the Heir app, and never give it to anyone.`;
}

export interface LetterKey {
  /** given to the owner */
  publicKey: Uint8Array;
  /** stays with the heir; made again from their signature whenever it is needed */
  secretKey: Uint8Array;
}

/** An heir's reading key, from their wallet's signature over {@link letterKeyMessage} for `plan`. */
export function letterKeyFromSignature(signature: Uint8Array, plan: PublicKey): LetterKey {
  if (signature.length !== 64) throw new RangeError(`an Ed25519 signature is 64 bytes, got ${signature.length}`);
  const secretKey = hkdf(sha256, signature, utf8.encode("lamport-heir/letter/key/v1"), plan.toBytes(), 32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** A letter as it is stored: ciphertext, and one wrapped copy of its key per heir. Safe to hand to anyone. */
export interface SealedLetter {
  v: 1;
  /** base64: nonce (12) || ciphertext || tag (16) */
  body: string;
  recipients: {
    /** base64 of the heir's public reading key */
    to: string;
    /** base64 of the ephemeral public key used for this heir */
    eph: string;
    /** base64: nonce (12) || wrapped content key || tag (16) */
    key: string;
  }[];
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, usage);
}

async function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad as BufferSource }, await aesKey(key, ["encrypt"]), plaintext as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce);
  out.set(ct, 12);
  return out;
}

async function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 12 + 16) throw new Error("the letter is damaged");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(0, 12) as BufferSource, additionalData: aad as BufferSource }, await aesKey(key, ["decrypt"]), sealed.subarray(12) as BufferSource));
}

function wrapKey(shared: Uint8Array, eph: Uint8Array, to: Uint8Array): Uint8Array {
  const salt = new Uint8Array(64);
  salt.set(eph);
  salt.set(to, 32);
  return hkdf(sha256, shared, salt, utf8.encode("lamport-heir/letter/wrap/v1"), 32);
}

/**
 * Encrypts `letter` for the heirs whose public reading keys are given. Runs on the owner's device;
 * the result holds nothing readable.
 */
export async function sealLetter(letter: string, recipients: Uint8Array[]): Promise<SealedLetter> {
  if (recipients.length === 0) throw new Error("a letter needs at least one heir to read it");
  for (const r of recipients) if (r.length !== 32) throw new RangeError("a reading key is 32 bytes");
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const aad = utf8.encode("lamport-heir/letter/v1");
  const body = await seal(contentKey, utf8.encode(letter), aad);
  const out: SealedLetter = { v: 1, body: b64(body), recipients: [] };
  for (const to of recipients) {
    const ephSecret = x25519.utils.randomPrivateKey();
    const eph = x25519.getPublicKey(ephSecret);
    const key = await seal(wrapKey(x25519.getSharedSecret(ephSecret, to), eph, to), contentKey, to);
    out.recipients.push({ to: b64(to), eph: b64(eph), key: b64(key) });
  }
  return out;
}

/** Decrypts a letter with an heir's reading key. Throws when the letter was not written for this key or has been changed. */
export async function openLetter(sealed: SealedLetter, key: LetterKey): Promise<string> {
  if (sealed.v !== 1) throw new Error(`this letter is in a format this code does not know (${String(sealed.v)})`);
  const mine = sealed.recipients.find((r) => r.to === b64(key.publicKey));
  if (!mine) throw new Error("this letter was not written for this key");
  try {
    const eph = unb64(mine.eph);
    const contentKey = await open(wrapKey(x25519.getSharedSecret(key.secretKey, eph), eph, key.publicKey), unb64(mine.key), key.publicKey);
    return new TextDecoder().decode(await open(contentKey, unb64(sealed.body), utf8.encode("lamport-heir/letter/v1")));
  } catch {
    throw new Error("the letter could not be opened: it has been changed, or this is not the key it was written for");
  }
}

const SECRET_WORDS = /\b(seed\s*phrase|recovery\s*phrase|secret\s*phrase|mnemonic|private\s*key|secret\s*key)\b/i;

/**
 * Looks for what must never go into a letter: something that reads like a seed phrase or a key.
 * The letter is for the heirs' eyes, but it sits on someone else's server for years, and a key in
 * it is a key in a place the owner cannot watch. Returns the reasons, for the app to show before
 * the owner seals the letter; empty when nothing was found.
 */
export function letterWarnings(letter: string): string[] {
  const out: string[] = [];
  if (SECRET_WORDS.test(letter)) out.push("The letter mentions a seed phrase or a private key. Say where such a thing is kept, never what it is.");
  // twelve or more short lowercase words in a row: what a recovery phrase looks like
  if (/(?:\b[a-z]{3,8}\b[\s,]+){11,}\b[a-z]{3,8}\b/.test(letter)) out.push("The letter contains a run of words that looks like a recovery phrase. Do not put one in a letter.");
  if (/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/.test(letter) || /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/.test(letter)) out.push("The letter contains what looks like a private key. Do not put one in a letter.");
  return out;
}
