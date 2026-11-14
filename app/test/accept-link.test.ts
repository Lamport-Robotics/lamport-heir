import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { hashedHeir, heirMatches, type Terms } from "../../tools/src/claim.ts";
import { readAcceptLink, writeAcceptLink } from "../src/accept-link.ts";

// throwaway addresses for this test
const vault = Keypair.generate().publicKey, first = Keypair.generate().publicKey, second = Keypair.generate().publicKey;
const salt = Uint8Array.from({ length: 32 }, (_, i) => 255 - i * 3);
const ORIGIN = "https://vault.lamportrobotics.com";
const after = (link: string) => new URL(link).hash.slice("#accept=".length);

describe("the link an heir accepts through", () => {
  it("carries the terms, and nothing else for an heir named by address", () => {
    const terms: Terms = { vault, primary: { kind: "address", address: first }, contingent: { kind: "address", address: second }, contingentDelaySecs: 365n * 86_400n };
    const link = writeAcceptLink(ORIGIN, terms);
    expect(link.startsWith(`${ORIGIN}/heir/claim.html#accept=`)).toBe(true);
    expect(link).not.toContain("salt");
    const read = readAcceptLink(after(link));
    expect(read.salt).toBeUndefined();
    expect(read.terms.vault.equals(vault)).toBe(true);
    expect(read.terms.contingentDelaySecs).toBe(365n * 86_400n);
    expect(heirMatches(read.terms.primary, first)).toBe(true);
  });

  it("carries an heir's salt when the plan keeps them private, and their address nowhere", () => {
    const terms: Terms = { vault, primary: { kind: "address", address: first }, contingent: hashedHeir(salt, second), contingentDelaySecs: 365n * 86_400n };
    const link = writeAcceptLink(ORIGIN, terms, salt);
    expect(link).toMatch(/&salt=[0-9a-f]{64}$/);
    // the link is the terms and the salt: the private heir's address is in neither, in any spelling
    const inside = Buffer.from(after(link).split("&")[0]!.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString();
    for (const text of [link, inside]) {
      expect(text).not.toContain(second.toBase58());
      expect(text).not.toContain(Buffer.from(second.toBytes()).toString("hex"));
    }
    const read = readAcceptLink(after(link));
    expect(read.salt).toEqual(salt);
    // with the salt their wallet is recognised, and nobody else's is
    expect(heirMatches(read.terms.contingent, second, read.salt)).toBe(true);
    expect(heirMatches(read.terms.contingent, first, read.salt)).toBe(false);
    expect(heirMatches(read.terms.contingent, second)).toBe(false);
    // the link the other heir is sent has no salt in it
    expect(readAcceptLink(after(writeAcceptLink(ORIGIN, terms))).salt).toBeUndefined();
    expect(() => writeAcceptLink(ORIGIN, terms, new Uint8Array(31))).toThrow(RangeError);
  });

  it("is refused when it is not whole", () => {
    const terms: Terms = { vault, primary: { kind: "address", address: first }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
    const good = after(writeAcceptLink(ORIGIN, terms, salt));
    expect(readAcceptLink(good).terms.vault.equals(vault)).toBe(true);
    for (const arg of ["", "!!", good.slice(0, 30), `${good}0`, good.replace("&salt=", "&salt=zz"), good.replace("&salt=", "&pepper="), `${good}&salt=${"0".repeat(64)}`, good.toUpperCase(), good.split("&")[0]! + "&salt=", `${good.split("&")[0]!}&salt=${"A".repeat(64)}`]) {
      expect(() => readAcceptLink(arg), arg.slice(-40)).toThrow();
    }
  });
});
