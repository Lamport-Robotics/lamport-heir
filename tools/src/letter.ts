/**
 * The family letter: what the owner wants their heirs to know that no chain can tell them (where
 * other accounts are, who to call, where the documents are). It is written, encrypted and signed
 * on the owner's device. What leaves the device is ciphertext, so whoever stores or carries it,
 * Lamport included, cannot read it. It must never hold a seed phrase or a key, and the app says so
 * where it is written.
 *
 * Who can read it: each heir, with a key only they can make. A wallet will sign a message but
 * will not decrypt one, so an heir's reading key is derived from their signature over a fixed
 * sentence that names the plan and the wallet of the person who writes the letter. Ed25519
 * signatures are deterministic, so the heir gets the same key again years later from the same
 * wallet, a hardware wallet included, and gives the owner only the public half.
 *
 * That signature is therefore a secret. The sentence says what it is for and where to sign it;
 * signing it anywhere else hands that place the letter (and nothing but the letter: no funds move
 * on it).
 *
 * Who can have written it: only the wallet the heir made their key for. Anyone who has seen an
 * heir's public reading key can encrypt to it, so a letter is also signed by its writer, and a
 * reading key opens letters of one writer only: the writer's address is in the sentence the key is
 * made from. A letter that names another writer asks the heir's wallet for another sentence, which
 * gives a key nobody ever encrypted to. Without this the heirs' page would show a stranger's text
 * under the words "the family letter".
 *
 * Construction: X25519, HKDF-SHA-256, AES-256-GCM, Ed25519. One random content key encrypts the
 * letter; it is wrapped once per heir under a key agreed between a fresh ephemeral key and the
 * heir's. The writer's wallet signs a sentence that holds the SHA-256 of everything else in the file.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

const utf8 = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function b64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("not base64");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** the longest letter that is sealed: a letter says where things are, it is not an archive */
export const MAX_LETTER_CHARS = 20_000;
/** a plan has two heirs at most */
const MAX_READERS = 2;

// ── what a wallet signs ──

/** what a wallet puts in front of a message it signs under Solana's off-chain message format */
const OFFCHAIN_DOMAIN = Uint8Array.from([0xff, ...utf8.encode("solana offchain")]);
/** the most an envelope may put in front of a sentence: the claim program's own limit for an acceptance */
const MAX_ENVELOPE_LEN = 128;

/** nothing, or the start of an off-chain message: bytes no transaction starts with, so signing them and a sentence never signs a transaction */
function isEnvelope(e: Uint8Array): boolean {
  return e.length === 0 || (e.length > OFFCHAIN_DOMAIN.length && e.length <= MAX_ENVELOPE_LEN && same(e.subarray(0, OFFCHAIN_DOMAIN.length), OFFCHAIN_DOMAIN));
}

/**
 * What a wallet put in front of `sentence` when it signed it: nothing, or the header of an
 * off-chain message. Null when what it signed is not the sentence.
 */
export function envelopeOf(signed: Uint8Array, sentence: string): Uint8Array | null {
  const expected = utf8.encode(sentence);
  const extra = signed.length - expected.length;
  if (extra < 0 || !same(signed.subarray(extra), expected)) return null;
  const envelope = signed.slice(0, extra);
  return isEnvelope(envelope) ? envelope : null;
}

/**
 * Something that signs a message with one Ed25519 key, the way a wallet's "sign message" does.
 * `envelope` is what was in front of this sentence the last time it was signed; a signer that can
 * choose puts the same bytes in front again, and a wallet does whatever it does.
 */
export type SignMessage = (message: Uint8Array, envelope?: Uint8Array) => Promise<{ signed: Uint8Array; signature: Uint8Array }>;

/** A {@link SignMessage} for a key held as bytes: the command-line tool's, and the tests'. */
export function keySigner(seed: Uint8Array): SignMessage {
  if (seed.length !== 32) throw new RangeError("an Ed25519 seed is 32 bytes");
  return async (message, envelope = new Uint8Array(0)) => {
    if (!isEnvelope(envelope)) throw new Error("refusing to sign: what is to go in front of the sentence is not the start of an off-chain message");
    const signed = new Uint8Array(envelope.length + message.length);
    signed.set(envelope);
    signed.set(message, envelope.length);
    return { signed, signature: ed25519.sign(signed, seed) };
  };
}

function signedBy(signature: Uint8Array, signed: Uint8Array, address: PublicKey): boolean {
  if (signature.length !== 64) return false;
  try { return ed25519.verify(signature, signed, address.toBytes()); } catch { return false; }
}

// ── an heir's reading key ──

/** The sentence an heir signs to make their reading key for the letters `writer` writes under `plan`. */
export function letterKeyMessage(plan: PublicKey, writer: PublicKey): string {
  return `Lamport Heir: this signature is my private key for reading the family letter of plan ${plan.toBase58()}, written by ${writer.toBase58()}. I sign it only inside Lamport Heir, and never give it to anyone.`;
}

export interface LetterKey {
  /** given to the owner */
  publicKey: Uint8Array;
  /** stays with the heir; made again from their signature whenever it is needed */
  secretKey: Uint8Array;
}

/** An heir's reading key, from their wallet's signature over {@link letterKeyMessage}. */
export function letterKeyFromSignature(signature: Uint8Array, plan: PublicKey, writer: PublicKey): LetterKey {
  if (signature.length !== 64) throw new RangeError(`an Ed25519 signature is 64 bytes, got ${signature.length}`);
  const info = new Uint8Array(64);
  info.set(plan.toBytes());
  info.set(writer.toBytes(), 32);
  const secretKey = hkdf(sha256, signature, utf8.encode("lamport-heir/letter/key/v2"), info, 32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** The sentence with which an heir tells the owner which reading key is theirs. Not a secret. */
export function readingKeyMessage(plan: PublicKey, writer: PublicKey, key: Uint8Array): string {
  return `Lamport Heir: the family letter of plan ${plan.toBase58()}, written by ${writer.toBase58()}, may be encrypted to my reading key ${hex(key)}. This sentence is not a secret.`;
}

/** An heir's reading key as the owner's side holds it. */
export interface ReadingKey {
  heir: PublicKey;
  /** the public half: 32 bytes */
  key: Uint8Array;
  /** what the heir's wallet put in front of the sentence the key is made from; kept so that another signer can make the same key */
  envelope: Uint8Array;
}

interface ReadingKeyLine {
  v: 1;
  plan: string;
  writer: string;
  heir: string;
  key: string;
  envelope: string;
  /** base64: what the wallet signed, which is {@link readingKeyMessage}, bare or inside an off-chain envelope */
  signed: string;
  signature: string;
}

const NOT_A_READING_KEY = "That is not a reading key: it should be the one line of text the heir's page gave them.";

/**
 * Reads the line an heir sent back and checks all of it: that it is for this plan, this writer
 * and this heir, and that the heir's own key signed for the reading key in it. Throws in words.
 */
export function readReadingKey(text: string, expect: { plan: PublicKey; writer: PublicKey; heir: PublicKey }): ReadingKey {
  let l: Partial<ReadingKeyLine>;
  try { l = JSON.parse(text.trim()); } catch { throw new Error(NOT_A_READING_KEY); }
  if (!l || typeof l !== "object" || l.v !== 1 || [l.plan, l.writer, l.heir, l.key, l.envelope, l.signed, l.signature].some((x) => typeof x !== "string")) throw new Error(NOT_A_READING_KEY);
  if (l.plan !== expect.plan.toBase58()) throw new Error(`That reading key is for another plan (${l.plan}). Ask the heir for one made from the link on this page.`);
  if (l.writer !== expect.writer.toBase58()) throw new Error(`That reading key was made for letters written by ${l.writer}, not by the wallet connected here (${expect.writer.toBase58()}). Connect that wallet, or ask the heir for a key made from the link on this page.`);
  if (l.heir !== expect.heir.toBase58()) throw new Error(`That reading key belongs to ${l.heir}, not to the heir named here (${expect.heir.toBase58()}).`);
  let key: Uint8Array, envelope: Uint8Array, signed: Uint8Array, signature: Uint8Array;
  try { key = unb64(l.key!); envelope = unb64(l.envelope!); signed = unb64(l.signed!); signature = unb64(l.signature!); } catch { throw new Error("That reading key is damaged: it does not decode."); }
  if (key.length !== 32 || !isEnvelope(envelope)) throw new Error("That reading key is damaged.");
  if (!envelopeOf(signed, readingKeyMessage(expect.plan, expect.writer, key))) throw new Error("What was signed is not the sentence that names this reading key.");
  if (!signedBy(signature, signed, expect.heir)) throw new Error("The signature does not belong to that heir's address, so the reading key may be somebody else's. Ask the heir to make it again.");
  return { heir: expect.heir, key, envelope };
}

/**
 * Makes an heir's reading key and the line that tells the owner about it. The signer is asked
 * three times: twice for the secret sentence, to see that it gives the same key every time, and
 * once to say, in the heir's name, which reading key is theirs.
 */
export async function makeReadingKey(sign: SignMessage, heir: PublicKey, plan: PublicKey, writer: PublicKey): Promise<{ line: string; key: LetterKey }> {
  const sentence = letterKeyMessage(plan, writer);
  const first = await sign(utf8.encode(sentence));
  const envelope = envelopeOf(first.signed, sentence);
  if (!envelope) throw new Error("The wallet signed something other than the sentence it was asked to sign. No key was made. Try another wallet.");
  if (!signedBy(first.signature, first.signed, heir)) throw new Error("The wallet's signature does not belong to its own address. No key was made.");
  // a key that cannot be made again is a letter nobody can read, found out on the day it is needed
  const again = await sign(utf8.encode(sentence), envelope);
  if (!same(first.signature, again.signature) || !same(first.signed, again.signed)) throw new Error("This wallet signs the same sentence differently each time, so it could not make the same key again on the day the letter is to be read. No key was made. Use another wallet that holds this address.");
  const key = letterKeyFromSignature(first.signature, plan, writer);
  const claim = readingKeyMessage(plan, writer, key.publicKey);
  const third = await sign(utf8.encode(claim));
  const line: ReadingKeyLine = { v: 1, plan: plan.toBase58(), writer: writer.toBase58(), heir: heir.toBase58(), key: b64(key.publicKey), envelope: b64(envelope), signed: b64(third.signed), signature: b64(third.signature) };
  const text = JSON.stringify(line);
  readReadingKey(text, { plan, writer, heir }); // what is handed out is what the owner's page will accept
  return { line: text, key };
}

// ── sealing and opening ──

/** A letter's ciphertext, and one wrapped copy of its key per heir. Holds nothing readable. */
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
  if (!letter.trim()) throw new Error("the letter is empty");
  if (letter.length > MAX_LETTER_CHARS) throw new Error(`the letter is longer than ${MAX_LETTER_CHARS.toLocaleString("en-US")} characters`);
  if (recipients.length === 0) throw new Error("a letter needs at least one heir to read it");
  for (const r of recipients) if (r.length !== 32) throw new RangeError("a reading key is 32 bytes");
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const aad = utf8.encode("lamport-heir/letter/v1");
  const body = await seal(contentKey, utf8.encode(letter), aad);
  const out: SealedLetter = { v: 1, body: b64(body), recipients: [] };
  for (const to of recipients) {
    const ephSecret = x25519.utils.randomPrivateKey();
    const eph = x25519.getPublicKey(ephSecret);
    // a reading key of small order would give a wrapping key anyone can work out: the agreement refuses it
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
    return new TextDecoder("utf-8", { fatal: true }).decode(await open(contentKey, unb64(sealed.body), utf8.encode("lamport-heir/letter/v1")));
  } catch {
    throw new Error("the letter could not be opened: it has been changed, or this is not the key it was written for");
  }
}

// ── the file an owner hands over ──

/**
 * What the writer's signature covers. The file keeps it as the exact text that was signed, so
 * checking the signature depends on no rule for how JSON is written out.
 */
interface LetterContent {
  plan: string;
  writer: string;
  /** the day it was sealed, YYYY-MM-DD */
  sealedAt: string;
  readers: { heir: string; to: string; envelope: string }[];
  letter: SealedLetter;
}

interface LetterFile {
  lamportHeirLetter: 1;
  /** {@link LetterContent} as JSON text */
  content: string;
  /** base64: what the writer's wallet signed, which is {@link authorshipMessage}, bare or inside an off-chain envelope */
  signed: string;
  signature: string;
}

/** The sentence the writer's wallet signs: it names the plan, the day, and the SHA-256 of the file's content. */
export function authorshipMessage(plan: PublicKey, sealedAt: string, content: string): string {
  return `Lamport Heir: I wrote the family letter of plan ${plan.toBase58()}, sealed on ${sealedAt}. Its fingerprint is ${hex(sha256(utf8.encode(content)))}.`;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** A letter file that has been checked: its writer signed exactly this. */
export interface ReceivedLetter {
  plan: PublicKey;
  writer: PublicKey;
  sealedAt: string;
  readers: ReadingKey[];
  letter: SealedLetter;
}

const NOT_A_LETTER = "This is not a Lamport Heir letter: it should be the file, or the text, the owner's page made.";
const DAMAGED_LETTER = "This letter is damaged: a part of it is missing or is not what it should be.";

function isText(x: unknown): x is string {
  return typeof x === "string";
}

function pubkey(x: unknown): PublicKey {
  if (!isText(x)) throw new Error(DAMAGED_LETTER);
  try { return new PublicKey(x); } catch { throw new Error(DAMAGED_LETTER); }
}

function bytes(x: unknown, length?: number): Uint8Array {
  if (!isText(x)) throw new Error(DAMAGED_LETTER);
  let b: Uint8Array;
  try { b = unb64(x); } catch { throw new Error(DAMAGED_LETTER); }
  if (length !== undefined && b.length !== length) throw new Error(DAMAGED_LETTER);
  return b;
}

/**
 * Reads a letter file and checks all of it before anything in it is believed: its shape, and that
 * the wallet it names as its writer signed exactly this content. Throws in words. What it returns
 * is still sealed.
 */
export function readLetterFile(text: string): ReceivedLetter {
  if (text.length > 400_000) throw new Error(NOT_A_LETTER);
  let f: Partial<LetterFile>;
  try { f = JSON.parse(text.trim()); } catch { throw new Error(NOT_A_LETTER); }
  if (!f || typeof f !== "object" || f.lamportHeirLetter !== 1 || !isText(f.content) || !isText(f.signed) || !isText(f.signature)) throw new Error(NOT_A_LETTER);
  let c: Partial<LetterContent>;
  try { c = JSON.parse(f.content); } catch { throw new Error(DAMAGED_LETTER); }
  if (!c || typeof c !== "object") throw new Error(DAMAGED_LETTER);
  const plan = pubkey(c.plan), writer = pubkey(c.writer);
  if (!isText(c.sealedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(c.sealedAt)) throw new Error(DAMAGED_LETTER);

  // the signature first: nothing below is shown to anyone unless the named writer signed it
  const signed = bytes(f.signed), signature = bytes(f.signature, 64);
  if (!envelopeOf(signed, authorshipMessage(plan, c.sealedAt, f.content)) || !signedBy(signature, signed, writer)) throw new Error(`This letter is not signed by the wallet it names as its writer (${writer.toBase58()}). Somebody else made it or changed it. Do not act on anything it says.`);

  const l = c.letter as Partial<SealedLetter> | undefined;
  if (!Array.isArray(c.readers) || c.readers.length < 1 || c.readers.length > MAX_READERS || !l || typeof l !== "object" || l.v !== 1 || !isText(l.body) || !Array.isArray(l.recipients) || l.recipients.length !== c.readers.length) throw new Error(DAMAGED_LETTER);
  bytes(l.body);
  for (const r of l.recipients) {
    if (!r || typeof r !== "object") throw new Error(DAMAGED_LETTER);
    bytes(r.to, 32); bytes(r.eph, 32); bytes(r.key, 12 + 32 + 16);
  }
  const readers = c.readers.map((r): ReadingKey => {
    if (!r || typeof r !== "object") throw new Error(DAMAGED_LETTER);
    const reader = { heir: pubkey(r.heir), key: bytes(r.to, 32), envelope: bytes(r.envelope) };
    if (!isEnvelope(reader.envelope) || !l.recipients!.some((x) => x.to === r.to)) throw new Error(DAMAGED_LETTER);
    return reader;
  });
  return { plan, writer, sealedAt: c.sealedAt, readers, letter: { v: 1, body: l.body, recipients: l.recipients.map((r) => ({ to: r.to, eph: r.eph, key: r.key })) } };
}

/**
 * Seals `letter` for the heirs whose reading keys are given and has the writer's signer sign it.
 * Returns the text of the file to hand over, which only those heirs can read and which anyone can
 * see was made by `writer`.
 */
export async function writeLetterFile(sign: SignMessage, input: { letter: string; plan: PublicKey; writer: PublicKey; readers: ReadingKey[]; sealedAt: Date }): Promise<string> {
  if (input.readers.length < 1 || input.readers.length > MAX_READERS) throw new Error("a letter is written for the one or two heirs of a plan");
  const sealed = await sealLetter(input.letter, input.readers.map((r) => r.key));
  const inside: LetterContent = {
    plan: input.plan.toBase58(),
    writer: input.writer.toBase58(),
    sealedAt: day(input.sealedAt),
    readers: input.readers.map((r) => ({ heir: r.heir.toBase58(), to: b64(r.key), envelope: b64(r.envelope) })),
    letter: sealed,
  };
  const content = JSON.stringify(inside);
  const { signed, signature } = await sign(utf8.encode(authorshipMessage(input.plan, inside.sealedAt, content)));
  const file: LetterFile = { lamportHeirLetter: 1, content, signed: b64(signed), signature: b64(signature) };
  const text = JSON.stringify(file);
  try { readLetterFile(text); } // what is handed over is what an heir's page will accept
  catch { throw new Error("The wallet did not sign the letter as asked, so the heirs' page would not accept it. Nothing was made. Try another wallet."); }
  return text;
}

/** the name the owner's page gives the file */
export function letterFileName(plan: PublicKey, sealedAt: Date): string {
  return `lamport-heir-letter-${plan.toBase58().slice(0, 8)}-${day(sealedAt)}.json`;
}

/**
 * Opens a checked letter for `heir`, whose signer makes the reading key again. Throws in words
 * when the letter was not written for this heir, or when the signer gives another key than the
 * one the letter was written to.
 */
export async function readLetter(sign: SignMessage, heir: PublicKey, received: ReceivedLetter): Promise<string> {
  const reader = received.readers.find((r) => r.heir.equals(heir));
  if (!reader) throw new Error(`This letter was not written for ${heir.toBase58()}. It was written for ${received.readers.map((r) => r.heir.toBase58()).join(" and ")}.`);
  const sentence = letterKeyMessage(received.plan, received.writer);
  const { signed, signature } = await sign(utf8.encode(sentence), reader.envelope);
  if (!envelopeOf(signed, sentence)) throw new Error("The wallet signed something other than the sentence it was asked to sign. The letter was not opened.");
  const key = letterKeyFromSignature(signature, received.plan, received.writer);
  if (!same(key.publicKey, reader.key)) throw new Error("This wallet did not give the key the letter was written to. Open it with the same wallet, on the same account, that made the reading key.");
  return openLetter(received.letter, key);
}

// ── what must not go into a letter ──

const SECRET_WORDS = /\b(seed\s*phrase|recovery\s*phrase|secret\s*phrase|mnemonic|private\s*key|secret\s*key)\b/i;

/**
 * Looks for what must never go into a letter: something that reads like a seed phrase or a key.
 * The letter is for the heirs' eyes, but it lies about for years, and a key in it is a key in a
 * place the owner cannot watch. Returns the reasons, for the app to show before the owner seals
 * the letter; empty when nothing was found.
 */
export function letterWarnings(letter: string): string[] {
  const out: string[] = [];
  if (SECRET_WORDS.test(letter)) out.push("The letter mentions a seed phrase or a private key. Say where such a thing is kept, never what it is.");
  // twelve or more short lowercase words in a row: what a recovery phrase looks like
  if (/(?:\b[a-z]{3,8}\b[\s,]+){11,}\b[a-z]{3,8}\b/.test(letter)) out.push("The letter contains a run of words that looks like a recovery phrase. Do not put one in a letter.");
  if (/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/.test(letter) || /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/.test(letter)) out.push("The letter contains what looks like a private key. Do not put one in a letter.");
  return out;
}
