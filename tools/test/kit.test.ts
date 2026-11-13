import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { hashedHeir, planAddress, type Terms } from "../src/claim.ts";
import { formatSalt, type KitInput, kitRole, parseSalt, renderKit } from "../src/kit.ts";
import { PROGRAMS, SHORT_CLOCKS_PROGRAMS } from "../src/programs.ts";

const DAY = 86_400n;
const pk = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const vault = pk(0x11);
// throwaway keys, made for this test run and dropped with it
const primaryKey = Keypair.generate();
const contingentKey = Keypair.generate();
const primary = primaryKey.publicKey;
const contingent = contingentKey.publicKey;
const salt = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);

const named: Terms = { vault, primary: { kind: "address", address: primary }, contingent: { kind: "address", address: contingent }, contingentDelaySecs: 365n * DAY };
const hashed: Terms = { vault, primary: hashedHeir(salt, primary), contingent: { kind: "none" }, contingentDelaySecs: 0n };

function input(over: Partial<KitInput> = {}): KitInput {
  return {
    heirLabel: "Ada <my daughter> & co",
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    programs: PROGRAMS,
    vault,
    claim: planAddress(named),
    terms: named,
    heirAddress: primary,
    windowSecs: 180n * DAY,
    waitSecs: 30n * DAY,
    printedAt: new Date("2026-11-13T12:00:00Z"),
    source: { repository: "https://github.com/Lamport-Robotics/lamport-heir", commit: "abc1234" },
    ...over,
  };
}

describe("the salt, as printed", () => {
  it("round-trips with its check digits, with or without spaces", () => {
    const text = formatSalt(salt);
    expect(text).toMatch(/^[0-9a-f]{64}-[0-9a-f]{4}$/);
    expect(parseSalt(text)).toEqual(salt);
    expect(parseSalt(text.slice(0, 64))).toEqual(salt);
    expect(parseSalt(` ${text.slice(0, 8)} ${text.slice(8, 40)}\n${text.slice(40).toUpperCase()} `)).toEqual(salt);
  });

  it("catches a mistyped digit, and anything that is not a salt", () => {
    const text = formatSalt(salt);
    const wrong = (text[0] === "0" ? "1" : "0") + text.slice(1);
    expect(() => parseSalt(wrong)).toThrow(/mistyped/);
    expect(() => parseSalt(text.slice(0, 63))).toThrow(/64 hex digits/);
    expect(() => parseSalt("zz".repeat(32))).toThrow(/64 hex digits/);
    expect(() => parseSalt(`${text}0`)).toThrow(/64 hex digits/);
    expect(() => formatSalt(new Uint8Array(31))).toThrow(RangeError);
  });
});

describe("a kit is checked against the terms before it is printed", () => {
  it("knows the heir's place", () => {
    expect(kitRole(input())).toBe("primary");
    expect(kitRole(input({ heirAddress: contingent }))).toBe("contingent");
    expect(kitRole(input({ terms: hashed, claim: planAddress(hashed), salt }))).toBe("primary");
    expect(kitRole({ programs: PROGRAMS, vault, claim: primary, heirAddress: primary })).toBe("sole");
  });

  it("refuses a page that would be wrong", () => {
    expect(() => renderKit(input({ heirAddress: pk(0x44) }))).toThrow(/do not name this address/);
    expect(() => renderKit(input({ vault: pk(0x12) }))).toThrow(/another vault/);
    expect(() => renderKit(input({ claim: pk(0x13) }))).toThrow(/does not release to the plan/);
    // the short-clocks claim program puts the same terms at another address
    expect(() => renderKit(input({ programs: SHORT_CLOCKS_PROGRAMS }))).toThrow(/does not release to the plan/);
    // a hashed heir: no salt, or the wrong one
    const h = { terms: hashed, claim: planAddress(hashed) };
    expect(() => renderKit(input(h))).toThrow(/with this salt/);
    expect(() => renderKit(input({ ...h, salt: new Uint8Array(32).fill(9) }))).toThrow(/with this salt/);
    // a vault that releases straight to an address
    expect(() => renderKit(input({ terms: undefined as never, claim: contingent }))).toThrow(/not this heir's address/);
    const { terms: _terms, ...direct } = input({ claim: primary });
    expect(() => renderKit({ ...direct, salt })).toThrow(/straight to an address/);
  });
});

describe("the page", () => {
  it("carries what the heir needs", () => {
    const html = renderKit(input());
    expect(html).toContain(vault.toBase58());
    expect(html).toContain(planAddress(named).toBase58());
    expect(html).toContain(primary.toBase58());
    expect(html).toContain("You are the primary heir");
    expect(html).toContain("180 days");
    expect(html).toContain("30 days");
    expect(html).toContain(`node src/cli.ts claim ${vault.toBase58()} --keypair YOUR-KEY-FILE --rpc https://api.devnet.solana.com`);
    expect(html).toContain(`node src/cli.ts status ${vault.toBase58()}`);
    expect(html).toContain(PROGRAMS.vault.toBase58());
    expect(html).toContain(PROGRAMS.claim.toBase58());
    expect(html).toContain("2026-11-13");
    expect(html).toContain("abc1234");
    expect(html).not.toContain("Your salt");
    expect(html).not.toContain("Test kit");
  });

  it("tells a contingent heir how long they wait", () => {
    const html = renderKit(input({ heirAddress: contingent }));
    expect(html).toContain("You are the contingent heir");
    expect(html).toContain("365 days after the release");
  });

  it("prints a hashed heir's salt, in the command too", () => {
    const html = renderKit(input({ terms: hashed, claim: planAddress(hashed), salt }));
    const text = formatSalt(salt);
    expect(html).toContain("Your salt");
    expect(html).toContain(`--salt ${text}`);
    expect(html).toContain("not published");
    expect(html.match(/<svg /g)!.length).toBe(3); // vault, plan, salt
  });

  it("for a vault that releases straight to the heir, there is no plan to show", () => {
    const { terms: _terms, ...direct } = input({ claim: primary });
    const html = renderKit(direct);
    expect(html).toContain("You are the heir.");
    expect(html).not.toContain("Plan address");
    expect(html).not.toContain("Claim program");
    expect(html.match(/<svg /g)!.length).toBe(1);
  });

  it("marks a test build as one", () => {
    const html = renderKit(input({ programs: SHORT_CLOCKS_PROGRAMS, claim: planAddress(named, SHORT_CLOCKS_PROGRAMS.claim), windowSecs: 90n, waitSecs: 30n }));
    expect(html).toContain("Test kit");
    expect(html).toContain("90 test-days");
  });

  it("escapes what the owner typed, and fetches nothing", () => {
    const html = renderKit(input());
    expect(html).toContain("Ada &lt;my daughter&gt; &amp; co");
    expect(html).not.toContain("<my daughter>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<img/i);
    // the only addresses of other machines on the page are the repository and the RPC endpoint, as text
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<)]+/g)].map((m) => m[0]);
    expect(new Set(urls)).toEqual(new Set(["https://github.com/Lamport-Robotics/lamport-heir", "https://api.devnet.solana.com", "http://www.w3.org/2000/svg"]));
  });

  it("holds no key: not the heir's, in any of the forms a key is written in", () => {
    const html = renderKit(input({ terms: hashed, claim: planAddress(hashed), salt }));
    for (const key of [primaryKey, contingentKey]) {
      const secret = key.secretKey;
      const seed = secret.subarray(0, 32);
      const forms = [
        Buffer.from(secret).toString("hex"),
        Buffer.from(seed).toString("hex"),
        Buffer.from(secret).toString("base64"),
        Buffer.from(seed).toString("base64"),
        `[${Array.from(secret).join(",")}]`,
        Array.from(seed).join(","),
      ];
      for (const form of forms) expect(html.includes(form)).toBe(false);
    }
    expect(html).not.toMatch(/seed phrase|mnemonic|private key|secret key/i);
  });
});
