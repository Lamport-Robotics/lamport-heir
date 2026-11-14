import { createPrivateKey, sign as edSign } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  authorshipMessage, envelopeOf, keySigner, letterFileName, letterKeyFromSignature, letterKeyMessage, letterWarnings, makeReadingKey, MAX_LETTER_CHARS, openLetter,
  readingKeyMessage, readLetter, readLetterFile, readReadingKey, sealLetter, type SignMessage, writeLetterFile,
} from "../src/letter.ts";

const plan = new PublicKey(new Uint8Array(32).fill(0x21));
const otherPlan = new PublicKey(new Uint8Array(32).fill(0x22));
const LETTER = "The house deeds are with Marta Okafor at the notary on Elm Street. The brokerage account is at Northfield, in my name. Call Sam first.";
const SEALED_ON = new Date("2026-11-14T09:30:00Z");

/** What a wallet's "sign message" does with an Ed25519 key, by another implementation than the one under test. */
function walletSign(key: Keypair, message: Uint8Array): Uint8Array {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(key.secretKey.subarray(0, 32))]);
  return new Uint8Array(edSign(null, Buffer.from(message), createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })));
}
const utf8 = (s: string) => new TextEncoder().encode(s);
// throwaway keys for this run
const owner = Keypair.generate();
const heirA = Keypair.generate();
const heirB = Keypair.generate();
const stranger = Keypair.generate();
const signerOf = (k: Keypair) => keySigner(k.secretKey.subarray(0, 32));
const readingKey = (k: Keypair, p = plan, w = owner.publicKey) => letterKeyFromSignature(walletSign(k, utf8(letterKeyMessage(p, w))), p, w);

/** a wallet that wraps what it signs in an off-chain message header, as a hardware wallet does */
const OFFCHAIN_HEADER = Uint8Array.from([0xff, ...utf8("solana offchain"), 0, ...new Uint8Array(32).fill(7), 0, 1]);
function wrappingWallet(k: Keypair, header = OFFCHAIN_HEADER): SignMessage {
  return async (message) => {
    const signed = Uint8Array.from([...header, ...message]);
    return { signed, signature: walletSign(k, signed) };
  };
}

async function keysFor(...heirs: Keypair[]) {
  return Promise.all(heirs.map(async (h) => readReadingKey((await makeReadingKey(signerOf(h), h.publicKey, plan, owner.publicKey)).line, { plan, writer: owner.publicKey, heir: h.publicKey })));
}
const fileFor = async (...heirs: Keypair[]) => writeLetterFile(signerOf(owner), { letter: LETTER, plan, writer: owner.publicKey, readers: await keysFor(...heirs), sealedAt: SEALED_ON });
/** a letter file with something in its signed content changed, and the rest left as it was */
function withContent(file: string, change: (content: any) => void): string {
  const f = JSON.parse(file);
  const c = JSON.parse(f.content);
  change(c);
  return JSON.stringify({ ...f, content: JSON.stringify(c) });
}

describe("an heir's reading key", () => {
  it("comes back the same from the same wallet, and is another key for another plan, writer or wallet", () => {
    const a1 = readingKey(heirA);
    const a2 = readingKey(heirA);
    expect(a1.secretKey).toEqual(a2.secretKey);
    expect(a1.publicKey).toEqual(a2.publicKey);
    expect(readingKey(heirA, otherPlan).publicKey).not.toEqual(a1.publicKey);
    expect(readingKey(heirA, plan, stranger.publicKey).publicKey).not.toEqual(a1.publicKey);
    expect(readingKey(heirB).publicKey).not.toEqual(a1.publicKey);
    expect(() => letterKeyFromSignature(new Uint8Array(63), plan, owner.publicKey)).toThrow(RangeError);
    // the same signature read as another writer's is another key: the writer is in the key, not only in the sentence
    const signature = walletSign(heirA, utf8(letterKeyMessage(plan, owner.publicKey)));
    expect(letterKeyFromSignature(signature, plan, stranger.publicKey).publicKey).not.toEqual(a1.publicKey);
  });

  it("is made from a sentence that says what it is and names the plan and the writer", () => {
    const m = letterKeyMessage(plan, owner.publicKey);
    expect(m).toContain(plan.toBase58());
    expect(m).toContain(`written by ${owner.publicKey.toBase58()}`);
    expect(m).toContain("my private key for reading the family letter");
    expect(m).toContain("never give it to anyone");
    expect(letterKeyMessage(otherPlan, owner.publicKey)).not.toBe(m);
    expect(letterKeyMessage(plan, stranger.publicKey)).not.toBe(m);
  });

  it("is made with three signatures, and the line that goes to the owner holds no secret", async () => {
    const asked: string[] = [];
    const sign: SignMessage = async (message, envelope) => { asked.push(new TextDecoder().decode(message)); return signerOf(heirA)(message, envelope); };
    const { line, key } = await makeReadingKey(sign, heirA.publicKey, plan, owner.publicKey);
    const secret = letterKeyMessage(plan, owner.publicKey);
    expect(asked).toEqual([secret, secret, readingKeyMessage(plan, owner.publicKey, key.publicKey)]);
    expect(key.publicKey).toEqual(readingKey(heirA).publicKey);

    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ v: 1, plan: plan.toBase58(), writer: owner.publicKey.toBase58(), heir: heirA.publicKey.toBase58(), envelope: "" });
    expect(line).not.toContain("\n");
    const secretSignature = Buffer.from(walletSign(heirA, utf8(secret)));
    for (const hidden of [secretSignature.toString("base64"), secretSignature.toString("hex"), Buffer.from(key.secretKey).toString("base64"), Buffer.from(key.secretKey).toString("hex")]) expect(line).not.toContain(hidden);
    expect(parsed.signature).not.toBe(secretSignature.toString("base64"));

    const read = readReadingKey(line, { plan, writer: owner.publicKey, heir: heirA.publicKey });
    expect(read.key).toEqual(key.publicKey);
    expect(read.heir.equals(heirA.publicKey)).toBe(true);
  });

  it("is not made by a wallet that signs differently each time, signs something else, or is not the heir's", async () => {
    // two headers, in turn: both signatures are good, and they are not the same
    let turn = 0;
    const fickle: SignMessage = (message) => wrappingWallet(heirA, Uint8Array.from([...OFFCHAIN_HEADER, turn++]))(message);
    await expect(makeReadingKey(fickle, heirA.publicKey, plan, owner.publicKey)).rejects.toThrow(/differently each time/);

    const elsewhere: SignMessage = async () => { const signed = utf8("Sign in to example.org"); return { signed, signature: walletSign(heirA, signed) }; };
    await expect(makeReadingKey(elsewhere, heirA.publicKey, plan, owner.publicKey)).rejects.toThrow(/something other than the sentence/);

    await expect(makeReadingKey(signerOf(stranger), heirA.publicKey, plan, owner.publicKey)).rejects.toThrow(/does not belong to its own address/);
  });

  it("is refused by the owner's side unless it is for this plan, this writer and this heir, whole, and signed by the heir", async () => {
    const { line } = await makeReadingKey(signerOf(heirA), heirA.publicKey, plan, owner.publicKey);
    const expected = { plan, writer: owner.publicKey, heir: heirA.publicKey };
    expect(() => readReadingKey(line, { ...expected, plan: otherPlan })).toThrow(/for another plan/);
    expect(() => readReadingKey(line, { ...expected, writer: stranger.publicKey })).toThrow(/not by the wallet connected here/);
    expect(() => readReadingKey(line, { ...expected, heir: heirB.publicKey })).toThrow(/not to the heir named here/);
    for (const junk of ["", "hello", "{}", "[1]", "null", JSON.stringify({ ...JSON.parse(line), v: 2 }), JSON.stringify({ ...JSON.parse(line), key: 7 })]) expect(() => readReadingKey(junk, expected), junk).toThrow(/not a reading key/);
    expect(() => readReadingKey(JSON.stringify({ ...JSON.parse(line), key: "@@@@" }), expected)).toThrow(/does not decode/);
    expect(() => readReadingKey(JSON.stringify({ ...JSON.parse(line), key: "AAAA" }), expected)).toThrow(/damaged/);

    // someone on the way swaps in a reading key of their own: the heir never signed for it
    const theirs = Buffer.from(readingKey(stranger).publicKey).toString("base64");
    expect(() => readReadingKey(JSON.stringify({ ...JSON.parse(line), key: theirs }), expected)).toThrow(/not the sentence that names this reading key/);
    // and signing for it themselves does not make it the heir's
    const claim = utf8(readingKeyMessage(plan, owner.publicKey, readingKey(stranger).publicKey));
    const forged = { ...JSON.parse(line), key: theirs, signed: Buffer.from(claim).toString("base64"), signature: Buffer.from(walletSign(stranger, claim)).toString("base64") };
    expect(() => readReadingKey(JSON.stringify(forged), expected)).toThrow(/does not belong to that heir's address/);
    // a signature of the wrong length is not a signature
    expect(() => readReadingKey(JSON.stringify({ ...JSON.parse(line), signature: "AAAA" }), expected)).toThrow(/does not belong to that heir's address/);
  });

  it("made by a wallet that wraps the sentence can be made again by a plain key, from what the line records", async () => {
    const { line, key } = await makeReadingKey(wrappingWallet(heirA), heirA.publicKey, plan, owner.publicKey);
    const read = readReadingKey(line, { plan, writer: owner.publicKey, heir: heirA.publicKey });
    expect(read.envelope).toEqual(OFFCHAIN_HEADER);
    expect(key.publicKey).not.toEqual(readingKey(heirA).publicKey); // the wrapped sentence gives another signature, so another key

    const file = await writeLetterFile(signerOf(owner), { letter: LETTER, plan, writer: owner.publicKey, readers: [read], sealedAt: SEALED_ON });
    const received = readLetterFile(file);
    expect(await readLetter(wrappingWallet(heirA), heirA.publicKey, received)).toBe(LETTER);
    expect(await readLetter(signerOf(heirA), heirA.publicKey, received)).toBe(LETTER); // the key file, years later, with no such wallet
  });
});

describe("what goes in front of a signed sentence", () => {
  it("is nothing or the header of an off-chain message, and never anything a transaction could start with", async () => {
    const sentence = "a sentence";
    expect(envelopeOf(utf8(sentence), sentence)).toEqual(new Uint8Array(0));
    expect(envelopeOf(Uint8Array.from([...OFFCHAIN_HEADER, ...utf8(sentence)]), sentence)).toEqual(OFFCHAIN_HEADER);
    expect(envelopeOf(utf8("another sentence entirely"), sentence)).toBeNull();
    expect(envelopeOf(utf8("a sentenc"), sentence)).toBeNull();
    expect(envelopeOf(Uint8Array.from([1, 0, 1, 3, ...utf8(sentence)]), sentence)).toBeNull(); // what a transaction starts with
    expect(envelopeOf(Uint8Array.from([...OFFCHAIN_HEADER.subarray(0, 16), ...utf8(sentence)]), sentence)).toBeNull(); // the bare marker, with no header after it
    expect(envelopeOf(Uint8Array.from([...OFFCHAIN_HEADER, ...new Uint8Array(100), ...utf8(sentence)]), sentence)).toBeNull(); // longer than any header

    // the key file's signer puts nothing else in front either, whatever a letter file tells it to
    await expect(signerOf(heirA)(utf8(sentence), Uint8Array.from([1, 0, 1, 3]))).rejects.toThrow(/refusing to sign/);
    const wrapped = await signerOf(heirA)(utf8(sentence), OFFCHAIN_HEADER);
    expect(wrapped.signature).toEqual(walletSign(heirA, wrapped.signed));
    expect(() => keySigner(new Uint8Array(31))).toThrow(RangeError);
  });
});

describe("the letter", () => {
  it("is readable by each heir it was written for, and by nobody else", async () => {
    const a = readingKey(heirA);
    const b = readingKey(heirB);
    const sealed = await sealLetter(LETTER, [a.publicKey, b.publicKey]);
    expect(await openLetter(sealed, a)).toBe(LETTER);
    expect(await openLetter(sealed, b)).toBe(LETTER);
    await expect(openLetter(sealed, readingKey(stranger))).rejects.toThrow(/not written for this key/);
    // the same heir's key for another plan does not open it either
    await expect(openLetter(sealed, readingKey(heirA, otherPlan))).rejects.toThrow(/not written for this key/);
  });

  it("holds nothing readable once sealed, and two sealings of one letter share nothing", async () => {
    const a = readingKey(heirA);
    const one = await sealLetter(LETTER, [a.publicKey]);
    const two = await sealLetter(LETTER, [a.publicKey]);
    const stored = JSON.stringify(one);
    for (const word of ["Marta", "Okafor", "notary", "Northfield", "Sam"]) {
      expect(stored).not.toContain(word);
      expect(Buffer.from(one.body, "base64").includes(Buffer.from(word))).toBe(false);
    }
    expect(one.body).not.toBe(two.body);
    expect(one.recipients[0]!.eph).not.toBe(two.recipients[0]!.eph);
    expect(one.recipients[0]!.key).not.toBe(two.recipients[0]!.key);
  });

  it("does not open once anything in it has been changed", async () => {
    const a = readingKey(heirA);
    const sealed = await sealLetter(LETTER, [a.publicKey]);
    const flip = (s: string) => {
      const bytes = Buffer.from(s, "base64");
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      return bytes.toString("base64");
    };
    await expect(openLetter({ ...sealed, body: flip(sealed.body) }, a)).rejects.toThrow(/could not be opened/);
    await expect(openLetter({ ...sealed, recipients: [{ ...sealed.recipients[0]!, key: flip(sealed.recipients[0]!.key) }] }, a)).rejects.toThrow(/could not be opened/);
    await expect(openLetter({ ...sealed, recipients: [{ ...sealed.recipients[0]!, eph: flip(sealed.recipients[0]!.eph) }] }, a)).rejects.toThrow(/could not be opened/);
    // a wrapped key lifted from one heir's entry into another's does not open
    const b = readingKey(heirB);
    const both = await sealLetter(LETTER, [a.publicKey, b.publicKey]);
    const swapped = { ...both, recipients: [{ ...both.recipients[1]!, to: both.recipients[0]!.to }] };
    await expect(openLetter(swapped, a)).rejects.toThrow(/could not be opened/);
    await expect(openLetter({ ...sealed, v: 2 as never }, a)).rejects.toThrow(/format/);
  });

  it("needs words, someone to read it, and reading keys that are keys", async () => {
    const a = readingKey(heirA);
    await expect(sealLetter(LETTER, [])).rejects.toThrow(/at least one heir/);
    await expect(sealLetter(LETTER, [new Uint8Array(31)])).rejects.toThrow(RangeError);
    await expect(sealLetter("  \n ", [a.publicKey])).rejects.toThrow(/empty/);
    await expect(sealLetter("x".repeat(MAX_LETTER_CHARS + 1), [a.publicKey])).rejects.toThrow(/longer than/);
    expect(await openLetter(await sealLetter("x".repeat(MAX_LETTER_CHARS), [a.publicKey]), a)).toHaveLength(MAX_LETTER_CHARS);
    // a "key" of small order would wrap the letter's key under something anyone can work out
    await expect(sealLetter(LETTER, [new Uint8Array(32)])).rejects.toThrow();
    const one = new Uint8Array(32); one[0] = 1;
    await expect(sealLetter(LETTER, [one])).rejects.toThrow();
  });
});

describe("the file an owner hands over", () => {
  it("is read by each heir with their own wallet, says who wrote it and when, and shows nothing of the letter", async () => {
    const file = await fileFor(heirA, heirB);
    for (const word of ["Marta", "Okafor", "notary", "Northfield", "Sam"]) expect(file).not.toContain(word);
    const received = readLetterFile(file);
    expect(received.plan.equals(plan)).toBe(true);
    expect(received.writer.equals(owner.publicKey)).toBe(true);
    expect(received.sealedAt).toBe("2026-11-14");
    expect(received.readers.map((r) => r.heir.toBase58())).toEqual([heirA.publicKey.toBase58(), heirB.publicKey.toBase58()]);
    expect(await readLetter(signerOf(heirA), heirA.publicKey, received)).toBe(LETTER);
    expect(await readLetter(signerOf(heirB), heirB.publicKey, received)).toBe(LETTER);
    expect(readLetterFile(`\n  ${file}\n`).sealedAt).toBe("2026-11-14"); // pasted with space around it
    expect(letterFileName(plan, SEALED_ON)).toBe(`lamport-heir-letter-${plan.toBase58().slice(0, 8)}-2026-11-14.json`);
  });

  it("does not open for anyone it was not written for, or for the heir's wallet on another account", async () => {
    const received = readLetterFile(await fileFor(heirA));
    await expect(readLetter(signerOf(stranger), stranger.publicKey, received)).rejects.toThrow(/was not written for/);
    // the right address, and a signer that is not its key: another key comes out, and nothing opens
    await expect(readLetter(signerOf(stranger), heirA.publicKey, received)).rejects.toThrow(/did not give the key the letter was written to/);
    const elsewhere: SignMessage = async () => { const signed = utf8("Sign in to example.org"); return { signed, signature: walletSign(heirA, signed) }; };
    await expect(readLetter(elsewhere, heirA.publicKey, received)).rejects.toThrow(/something other than the sentence/);
  });

  it("cannot be forged by someone who knows an heir's reading key", async () => {
    const [a] = await keysFor(heirA);
    // the stranger seals a letter of their own to the heir's real reading key and signs it as themselves:
    // it is a well-made letter from the stranger, and the heir's wallet makes another key for that writer
    const asThemselves = await writeLetterFile(signerOf(stranger), { letter: "Send 2 SOL to unlock the estate.", plan, writer: stranger.publicKey, readers: [a!], sealedAt: SEALED_ON });
    const received = readLetterFile(asThemselves);
    expect(received.writer.equals(stranger.publicKey)).toBe(true);
    await expect(readLetter(signerOf(heirA), heirA.publicKey, received)).rejects.toThrow(/did not give the key the letter was written to/);

    // the same letter, naming the owner as its writer: the owner did not sign it
    await expect(writeLetterFile(signerOf(stranger), { letter: "Send 2 SOL to unlock the estate.", plan, writer: owner.publicKey, readers: [a!], sealedAt: SEALED_ON })).rejects.toThrow(/did not sign the letter as asked/);
    const renamed = withContent(asThemselves, (c) => { c.writer = owner.publicKey.toBase58(); });
    expect(() => readLetterFile(renamed)).toThrow(/not signed by the wallet it names as its writer/);
    // and re-signing the renamed content with the stranger's key is still not the owner's signature
    const content = JSON.parse(renamed).content as string;
    const sentence = utf8(authorshipMessage(plan, "2026-11-14", content));
    const resigned = JSON.stringify({ lamportHeirLetter: 1, content, signed: Buffer.from(sentence).toString("base64"), signature: Buffer.from(walletSign(stranger, sentence)).toString("base64") });
    expect(() => readLetterFile(resigned)).toThrow(/not signed by the wallet it names as its writer/);
  });

  it("is refused once anything the writer signed has been changed", async () => {
    const file = await fileFor(heirA, heirB);
    const changes: ((c: any) => void)[] = [
      (c) => { c.sealedAt = "2031-01-01"; },
      (c) => { c.plan = otherPlan.toBase58(); },
      (c) => { c.readers[0].heir = stranger.publicKey.toBase58(); },
      (c) => { c.readers.reverse(); },
      (c) => { c.letter.body = c.letter.body.replace(/^./, (x: string) => (x === "A" ? "B" : "A")); },
      (c) => { c.letter.recipients[0].key = c.letter.recipients[1].key; },
      (c) => { c.note = "added"; },
    ];
    for (const change of changes) expect(() => readLetterFile(withContent(file, change)), String(change)).toThrow(/not signed by the wallet it names as its writer/);
    // the same content written out another way is other bytes, and the signature is over the bytes
    const f = JSON.parse(file);
    expect(() => readLetterFile(JSON.stringify({ ...f, content: JSON.stringify(JSON.parse(f.content), null, 1) }))).toThrow(/not signed by the wallet it names as its writer/);
    // a signature for one letter does not carry over to another
    const other = JSON.parse(await fileFor(heirA, heirB));
    expect(() => readLetterFile(JSON.stringify({ ...f, signed: other.signed, signature: other.signature }))).toThrow(/not signed by the wallet it names as its writer/);
  });

  it("is refused when it is not a letter file or is not whole", async () => {
    const file = await fileFor(heirA);
    const f = JSON.parse(file);
    for (const junk of ["", "the deeds are at the notary", "[]", "null", "{}", JSON.stringify({ ...f, lamportHeirLetter: 2 }), JSON.stringify({ ...f, content: 5 }), JSON.stringify({ lamportHeirLetter: 1, content: f.content }), `${file}${" ".repeat(400_000)}`]) {
      expect(() => readLetterFile(junk), junk.slice(0, 40)).toThrow(/not a Lamport Heir letter/);
    }
    for (const broken of [{ ...f, content: "{" }, { ...f, content: "7" }, { ...f, signature: "AAAA" }, { ...f, signed: "@" }, { ...f, content: JSON.stringify({ ...JSON.parse(f.content), writer: "nobody" }) }, { ...f, content: JSON.stringify({ ...JSON.parse(f.content), sealedAt: "yesterday" }) }]) {
      expect(() => readLetterFile(JSON.stringify(broken))).toThrow(/damaged/);
    }
    // well signed by its writer, and still not a letter this code will hand on: each part is checked after the signature too
    const signedAs = (change: (c: any) => void) => {
      const content = JSON.parse(withContent(file, change)).content as string;
      const c = JSON.parse(content);
      const sentence = utf8(authorshipMessage(new PublicKey(c.plan), c.sealedAt, content));
      return JSON.stringify({ lamportHeirLetter: 1, content, signed: Buffer.from(sentence).toString("base64"), signature: Buffer.from(walletSign(owner, sentence)).toString("base64") });
    };
    expect(readLetterFile(signedAs(() => {})).sealedAt).toBe("2026-11-14");
    const malformed: ((c: any) => void)[] = [
      (c) => { c.readers = []; },
      (c) => { c.readers = [c.readers[0], c.readers[0], c.readers[0]]; },
      (c) => { c.readers[0].to = "AAAA"; },
      (c) => { c.readers[0].envelope = Buffer.from([1, 0, 1, 3]).toString("base64"); },
      (c) => { c.readers[0].to = Buffer.from(new Uint8Array(32).fill(9)).toString("base64"); }, // a reader the letter holds no key for
      (c) => { c.letter.v = 2; },
      (c) => { c.letter.recipients = []; },
      (c) => { c.letter.recipients[0].eph = "AAAA"; },
      (c) => { c.letter.recipients[0].key = "AAAA"; },
      (c) => { c.letter.body = "@@"; },
      (c) => { delete c.letter; },
    ];
    for (const change of malformed) expect(() => readLetterFile(signedAs(change)), String(change)).toThrow(/damaged/);
  });
});

describe("what must never go into a letter", () => {
  it("lets an ordinary letter through", () => {
    expect(letterWarnings(LETTER)).toEqual([]);
    expect(letterWarnings("My will is in the blue folder. The safe deposit box is at First Street, number 114.")).toEqual([]);
  });

  it("warns about a seed phrase, a run of words that looks like one, and a key", () => {
    expect(letterWarnings("My seed phrase is in the safe.")[0]).toMatch(/never what it is/);
    expect(letterWarnings("the words are abandon ability able about above absent absorb abstract absurd abuse access accident")[0]).toMatch(/looks like a recovery phrase/);
    expect(letterWarnings(`key: ${"5".repeat(88)}`)[0]).toMatch(/looks like a private key/);
    expect(letterWarnings(`[${Array.from(Keypair.generate().secretKey).join(", ")}]`)[0]).toMatch(/looks like a private key/);
  });
});
