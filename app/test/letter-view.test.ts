import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readingKeyLink } from "../src/letter-panel.ts";
import { readInvitation } from "../src/letter-view.ts";

// throwaway addresses for this test
const plan = Keypair.generate().publicKey;
const writer = Keypair.generate().publicKey;
const had = (globalThis as any).location;
beforeAll(() => { (globalThis as any).location = { origin: "https://vault.lamportrobotics.com", hostname: "vault.lamportrobotics.com" }; });
afterAll(() => { (globalThis as any).location = had; });

describe("the link with which an owner asks an heir for a reading key", () => {
  it("names the plan and the owner's wallet, and the heirs' page reads both back", () => {
    const link = readingKeyLink(plan, writer);
    expect(link).toBe(`https://vault.lamportrobotics.com/heir/claim.html#letter=${plan.toBase58()}&from=${writer.toBase58()}`);
    const hash = new URL(link).hash.slice(1);
    expect(hash.startsWith("letter=")).toBe(true);
    const read = readInvitation(hash.slice(6));
    expect(read?.plan.equals(plan)).toBe(true);
    expect(read?.writer.equals(writer)).toBe(true);
  });

  it("is not read as an invitation when anything is missing, added or not an address", () => {
    const p = plan.toBase58(), w = writer.toBase58();
    for (const arg of ["", `=${p}`, `=${p}&from=`, `=${p}&from=${w}&x=1`, `=${p}&from=${w} `, `=&from=${w}`, `=${p}&to=${w}`, `=${p.slice(0, 20)}&from=${w}`, `=${p}&from=${"1".repeat(31)}`, `=${"l".repeat(44)}&from=${w}`, `=${"z".repeat(44)}&from=${w}`, `${p}&from=${w}`]) {
      expect(readInvitation(arg), arg).toBeNull();
    }
  });
});
