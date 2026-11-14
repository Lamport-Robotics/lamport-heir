import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { acceptanceMessage, acceptanceProofInstruction } from "../../tools/src/claim.ts";
import { acceptanceBytes, isAcceptanceOf, readAcceptance, writeAcceptance } from "../src/acceptance.ts";

const plan = Keypair.generate().publicKey;
const heir = Keypair.generate();
const sign = (bytes: Uint8Array, kp = heir) => ed25519.sign(bytes, kp.secretKey.subarray(0, 32));
const DOMAIN = Uint8Array.from([0xff, ...new TextEncoder().encode("solana offchain")]);
const envelope = (header: number) => Uint8Array.from([...DOMAIN, ...new Uint8Array(header), ...acceptanceBytes(plan)]);

describe("an heir's acceptance", () => {
  it("is the sentence the claim program expects, naming the plan", () => {
    expect(new TextDecoder().decode(acceptanceBytes(plan))).toBe(acceptanceMessage(plan));
    expect(acceptanceMessage(plan)).toContain(plan.toBase58());
  });

  it("travels as one line and reads back to what the claim program is given", () => {
    const signed = acceptanceBytes(plan), signature = sign(signed);
    const text = writeAcceptance(plan, heir.publicKey, signed, signature);
    expect(text).not.toContain("\n");
    const a = readAcceptance(`  ${text}\n`, { plan, heir: heir.publicKey });
    expect(Buffer.from(a.signature).equals(Buffer.from(signature))).toBe(true);
    const ix = acceptanceProofInstruction(a.heir, a.signature, a.signed);
    expect(ix.programId.toBase58()).toBe("Ed25519SigVerify111111111111111111111111111");
  });

  it("is accepted inside an off-chain envelope, as a hardware wallet signs it, and nowhere else", () => {
    expect(isAcceptanceOf(acceptanceBytes(plan), plan)).toBe(true);
    for (const header of [4, 36, 112]) {
      const signed = envelope(header);
      expect(isAcceptanceOf(signed, plan)).toBe(true);
      expect(() => readAcceptance(writeAcceptance(plan, heir.publicKey, signed, sign(signed)), { plan, heir: heir.publicKey })).not.toThrow();
    }
    expect(isAcceptanceOf(envelope(113), plan)).toBe(false); // more in front than the program allows
    expect(isAcceptanceOf(Uint8Array.from([...new TextEncoder().encode("Sign in to Example. "), ...acceptanceBytes(plan)]), plan)).toBe(false); // no envelope, just text in front
    expect(isAcceptanceOf(Uint8Array.from([...acceptanceBytes(plan), 0x2e]), plan)).toBe(false); // something after it
    expect(isAcceptanceOf(acceptanceBytes(Keypair.generate().publicKey), plan)).toBe(false);
    expect(isAcceptanceOf(new Uint8Array(0), plan)).toBe(false);
  });

  it("is refused in words when it is for another plan, from another key, altered or not one at all", () => {
    const signed = acceptanceBytes(plan);
    const good = writeAcceptance(plan, heir.publicKey, signed, sign(signed));
    const read = (text: string, expect_: { plan?: PublicKey; heir?: PublicKey } = {}) => () => readAcceptance(text, { plan: expect_.plan ?? plan, heir: expect_.heir ?? heir.publicKey });
    expect(read(good)).not.toThrow();
    expect(read("thanks, signed!")).toThrow(/not an acceptance/);
    expect(read("{}")).toThrow(/not an acceptance/);
    expect(read("null")).toThrow(/not an acceptance/);
    expect(read(good, { plan: Keypair.generate().publicKey })).toThrow(/for another plan/);
    expect(read(good, { heir: Keypair.generate().publicKey })).toThrow(/not by the address named here/);
    // signed by someone else but labelled with the heir's address
    const other = Keypair.generate();
    expect(read(writeAcceptance(plan, heir.publicKey, signed, sign(signed, other)))).toThrow(/does not belong to that address/);
    // a real signature by the heir, over other words
    const words = new TextEncoder().encode("I agree to nothing in particular.");
    expect(read(writeAcceptance(plan, heir.publicKey, words, sign(words)))).toThrow(/not the acceptance sentence/);
    const a = JSON.parse(good);
    expect(read(JSON.stringify({ ...a, signature: a.signature.slice(4) }))).toThrow(/damaged|does not belong/);
    expect(read(JSON.stringify({ ...a, signed: "%%%" }))).toThrow(/damaged/);
    expect(read(JSON.stringify({ ...a, v: 2 }))).toThrow(/not an acceptance/);
  });
});
