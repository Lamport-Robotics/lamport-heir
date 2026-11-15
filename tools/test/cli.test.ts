import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";
import { loadKeypair, main, parseArgs, UsageError } from "../src/cli.ts";
import { keySigner, readReadingKey, writeLetterFile } from "../src/letter.ts";

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
    for (const command of ["status", "start", "finish", "claim", "kit", "finisher", "letter-key", "letter-open"]) expect(help).toContain(command);
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

describe("the family letter, from the command line", () => {
  // throwaway keys for this test
  const owner = Keypair.generate();
  const heir = Keypair.generate();
  const other = Keypair.generate();
  const plan = new PublicKey(new Uint8Array(32).fill(0x31));
  const keyFile = (name: string, k: Keypair) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(Array.from(k.secretKey))); return path; };
  const run = async (argv: string[]) => { const lines: string[] = []; const code = await main(argv, { out: (l) => lines.push(l), env: {} }); return { code, text: lines.join("\n") }; };

  it("makes a reading key the owner's side accepts, and reads the letter written to it", async () => {
    const heirKey = keyFile("heir.json", heir);
    const made = await run(["letter-key", plan.toBase58(), "--writer", owner.publicKey.toBase58(), "--keypair", heirKey]);
    expect(made.code).toBe(0);
    expect(made.text).not.toContain("\n"); // one line, to send as it is
    const reader = readReadingKey(made.text, { plan, writer: owner.publicKey, heir: heir.publicKey });
    // the line is public: nothing of the key file is in it
    expect(made.text).not.toMatch(/\d+\s*,\s*\d+\s*,\s*\d+/);
    expect(made.text).not.toContain(Buffer.from(heir.secretKey.subarray(0, 32)).toString("base64"));

    const letter = "The deeds are with the notary on Elm Street.\nCall Sam first.";
    const file = join(dir, "letter.json");
    writeFileSync(file, await writeLetterFile(keySigner(owner.secretKey.subarray(0, 32)), { letter, plan, writer: owner.publicKey, readers: [reader], sealedAt: new Date("2026-11-14T00:00:00Z") }));
    const opened = await run(["letter-open", file, "--keypair", heirKey]);
    expect(opened.code).toBe(0);
    expect(opened.text).toContain(letter);
    expect(opened.text).toContain(`Written and signed by ${owner.publicKey.toBase58()}`);
    expect(opened.text).toContain("on 2026-11-14");
    expect(opened.text).toMatch(/never asks you for money, a key or a seed phrase/);

    await expect(run(["letter-open", file, "--keypair", keyFile("other.json", other)])).rejects.toThrow(/was not written for/);
    await expect(run(["letter-open", file])).rejects.toThrow(/--keypair FILE is required/);
    await expect(run(["letter-open", "--keypair", heirKey])).rejects.toThrow(/letter's file is missing/);
    await expect(run(["letter-open", join(dir, "no-such-letter.json"), "--keypair", heirKey])).rejects.toThrow(/could not read a letter/);
    await expect(run(["letter-key", plan.toBase58(), "--keypair", heirKey])).rejects.toThrow(/--writer ADDRESS/);
    await expect(run(["letter-key", "--writer", owner.publicKey.toBase58(), "--keypair", heirKey])).rejects.toThrow(/plan address is missing/);
  });

  it("opens nothing that the named writer did not sign, and keeps a letter's control characters off the terminal", async () => {
    const heirKey = keyFile("heir2.json", heir);
    const reader = readReadingKey((await run(["letter-key", plan.toBase58(), "--writer", owner.publicKey.toBase58(), "--keypair", heirKey])).text, { plan, writer: owner.publicKey, heir: heir.publicKey });
    const text = await writeLetterFile(keySigner(owner.secretKey.subarray(0, 32)), { letter: "first line\u001b[2J\u001b[1;1Hsecond\rline\u0007", plan, writer: owner.publicKey, readers: [reader], sealedAt: new Date("2026-11-14T00:00:00Z") });
    const good = join(dir, "escapes.json");
    writeFileSync(good, text);
    const opened = await run(["letter-open", good, "--keypair", heirKey]);
    expect(opened.text).toContain("first line[2J[1;1Hsecondline");
    expect(opened.text).not.toMatch(/[\u001b\r\u0007]/);

    const f = JSON.parse(text);
    const c = JSON.parse(f.content);
    c.sealedAt = "2030-01-01";
    const forged = join(dir, "forged.json");
    writeFileSync(forged, JSON.stringify({ ...f, content: JSON.stringify(c) }));
    await expect(run(["letter-open", forged, "--keypair", heirKey])).rejects.toThrow(/not signed by the wallet it names as its writer/);
    writeFileSync(forged, "Dear heir, send 2 SOL");
    await expect(run(["letter-open", forged, "--keypair", heirKey])).rejects.toThrow(/not a Lamport Heir letter/);
  });
});
