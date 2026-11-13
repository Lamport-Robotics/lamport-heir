import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";
import { loadKeypair, main, parseArgs, UsageError } from "../src/cli.ts";

const dir = mkdtempSync(join(tmpdir(), "lamport-heir-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the command line", () => {
  it("splits commands, positionals and flags", () => {
    const a = parseArgs(["claim", "VAULT", "--keypair", "k.json", "--dry-run", "--rpc=http://127.0.0.1:8899", "--salt", "ab"]);
    expect(a.command).toBe("claim");
    expect(a.positional).toEqual(["VAULT"]);
    expect(Object.fromEntries(a.flags)).toEqual({ keypair: "k.json", "dry-run": true, rpc: "http://127.0.0.1:8899", salt: "ab" });
    expect(parseArgs([]).command).toBe("help");
  });

  it("refuses options it does not have, a seed phrase option among them", () => {
    expect(() => parseArgs(["claim", "--frobnicate"])).toThrow(UsageError);
    expect(() => parseArgs(["claim", "--keypair"])).toThrow(/needs a value/);
    for (const flag of ["--seed", "--seed-phrase", "--mnemonic", "--private-key", "--secret-key", "--words"]) {
      expect(() => parseArgs(["claim", "V", flag, "x"]), flag).toThrow(/unknown option/);
    }
  });

  it("prints help that asks for no secret", async () => {
    const lines: string[] = [];
    expect(await main(["help"], { out: (l) => lines.push(l), env: {} })).toBe(0);
    const help = lines.join("\n");
    for (const command of ["status", "start", "finish", "claim", "kit", "finisher"]) expect(help).toContain(command);
    expect(help).toContain("never asks for a seed phrase");
    await expect(main(["frobnicate"], { out: () => {}, env: {} })).rejects.toThrow(UsageError);
    await expect(main(["status", "not-an-address"], { out: () => {}, env: {} })).rejects.toThrow(/not a Solana address/);
    await expect(main(["status"], { out: () => {}, env: {} })).rejects.toThrow(/is missing/);
  });
});

describe("a key file", () => {
  it("is read in the Solana CLI's format", () => {
    const key = Keypair.generate(); // a throwaway key for this test
    const path = join(dir, "good.json");
    writeFileSync(path, JSON.stringify(Array.from(key.secretKey)));
    expect(loadKeypair(path).publicKey.equals(key.publicKey)).toBe(true);
  });

  it("is never quoted in an error", () => {
    expect(() => loadKeypair(undefined)).toThrow(/--keypair FILE is required/);
    expect(() => loadKeypair(join(dir, "missing.json"))).toThrow(/could not read a key file/);

    const key = Keypair.generate();
    const numbers = Array.from(key.secretKey);
    const cases: [string, string][] = [
      ["short.json", JSON.stringify(numbers.slice(0, 63))],
      ["notjson.json", numbers.join(" ")],
      ["object.json", JSON.stringify({ secretKey: numbers })],
      ["range.json", JSON.stringify([...numbers.slice(0, 63), 256])],
      // 64 bytes whose public half does not belong to the secret half
      ["mismatch.json", JSON.stringify([...numbers.slice(0, 32), ...Array.from(Keypair.generate().publicKey.toBytes())])],
    ];
    for (const [name, content] of cases) {
      const path = join(dir, name);
      writeFileSync(path, content);
      let message = "";
      try {
        loadKeypair(path);
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        message = (e as Error).message;
      }
      expect(message, name).toContain(path);
      // nothing of the file's contents: no run of its numbers, in any spelling the error could carry
      expect(message, name).not.toMatch(/\d+\s*,\s*\d+\s*,\s*\d+/);
      expect(message.includes(String(numbers.slice(0, 4).join(","))), name).toBe(false);
    }
  });
});
