import { createPrivateKey, sign as edSign } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { letterKeyFromSignature, letterKeyMessage, letterWarnings, openLetter, sealLetter } from "../src/letter.ts";

const plan = new PublicKey(new Uint8Array(32).fill(0x21));
const otherPlan = new PublicKey(new Uint8Array(32).fill(0x22));
const LETTER = "The house deeds are with Marta Okafor at the notary on Elm Street. The brokerage account is at Northfield, in my name. Call Sam first.";

/** What a wallet's "sign message" does with an Ed25519 key. */
function walletSign(key: Keypair, text: string): Uint8Array {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(key.secretKey.subarray(0, 32))]);
  return new Uint8Array(edSign(null, Buffer.from(text), createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })));
}
// throwaway keys for this run
const heirA = Keypair.generate();
const heirB = Keypair.generate();
const stranger = Keypair.generate();
const readingKey = (k: Keypair, p = plan) => letterKeyFromSignature(walletSign(k, letterKeyMessage(p)), p);

describe("an heir's reading key", () => {
  it("comes back the same from the same wallet, and is another key for another plan or another wallet", () => {
    const a1 = readingKey(heirA);
    const a2 = readingKey(heirA);
    expect(a1.secretKey).toEqual(a2.secretKey);
    expect(a1.publicKey).toEqual(a2.publicKey);
    expect(readingKey(heirA, otherPlan).publicKey).not.toEqual(a1.publicKey);
    expect(readingKey(heirB).publicKey).not.toEqual(a1.publicKey);
    expect(() => letterKeyFromSignature(new Uint8Array(63), plan)).toThrow(RangeError);
  });

  it("is made from a sentence that says what it is and names the plan", () => {
    const m = letterKeyMessage(plan);
    expect(m).toContain(plan.toBase58());
    expect(m).toContain("my private key for reading the family letter");
    expect(m).toContain("never give it to anyone");
    expect(letterKeyMessage(otherPlan)).not.toBe(m);
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

  it("needs someone to read it, and keys of the right size", async () => {
    await expect(sealLetter(LETTER, [])).rejects.toThrow(/at least one heir/);
    await expect(sealLetter(LETTER, [new Uint8Array(31)])).rejects.toThrow(RangeError);
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
