import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAMPORT_VAULT_HEIR_MAINNET_PROGRAM_ID, LAMPORT_VAULT_HEIR_PROGRAM_ID } from "@lamport-robotics/vault";
import { Keypair } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import {
  HEIR_CLAIM_MAINNET_PROGRAM_ID,
  HEIR_CLAIM_PROGRAM_ID,
  MAINNET_PROGRAMS,
  PROGRAMS,
  SHORT_CLOCKS_PROGRAMS,
  programsForClaimProgram,
  programsForVaultProgram,
} from "../src/programs.ts";

const rust = readFileSync(new URL("../../programs/heir-claim/src/lib.rs", import.meta.url), "utf8");
/** the address in the line after this `#[cfg(...)]`, the n-th time the attribute appears */
function under(cfg: string, nth: number): string {
  const parts = rust.split(`#[cfg(${cfg})]\n`);
  const line = parts[nth + 1]?.split("\n")[0] ?? "";
  return line.match(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/)?.[1] ?? "";
}

const dir = mkdtempSync(join(tmpdir(), "lamport-heir-programs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the pairs of programs", () => {
  const MAINNET = 'all(feature = "mainnet", not(feature = "short-clocks"))';
  const DEVNET = 'not(any(feature = "short-clocks", feature = "mainnet"))';

  it("the mainnet pair is the one the claim program compiles in with `mainnet`", () => {
    expect(MAINNET_PROGRAMS.claim.toBase58()).toBe(under(MAINNET, 0)); // declare_id!
    expect(MAINNET_PROGRAMS.vault.toBase58()).toBe(under(MAINNET, 1)); // VAULT_PROGRAM_ID
    expect(MAINNET_PROGRAMS.vault.equals(LAMPORT_VAULT_HEIR_MAINNET_PROGRAM_ID)).toBe(true);
    expect(MAINNET_PROGRAMS.claim.equals(HEIR_CLAIM_MAINNET_PROGRAM_ID)).toBe(true);
    expect(MAINNET_PROGRAMS.daySecs).toBe(86_400n);
  });

  it("the devnet pair is where it was", () => {
    expect(PROGRAMS.claim.toBase58()).toBe(under(DEVNET, 0));
    expect(PROGRAMS.vault.toBase58()).toBe(under(DEVNET, 1));
    expect(PROGRAMS.vault.equals(LAMPORT_VAULT_HEIR_PROGRAM_ID)).toBe(true);
    expect(PROGRAMS.claim.equals(HEIR_CLAIM_PROGRAM_ID)).toBe(true);
  });

  it("no program belongs to two pairs", () => {
    const ids = [PROGRAMS, MAINNET_PROGRAMS, SHORT_CLOCKS_PROGRAMS].flatMap((p) => [p.vault.toBase58(), p.claim.toBase58()]);
    expect(new Set(ids).size).toBe(6);
  });

  it("a program is looked up to its own pair, and a claim program is never used with another pair's vault", () => {
    for (const pair of [PROGRAMS, MAINNET_PROGRAMS, SHORT_CLOCKS_PROGRAMS]) {
      expect(programsForVaultProgram(pair.vault)).toBe(pair);
      expect(programsForClaimProgram(pair.claim)).toBe(pair);
      expect(programsForVaultProgram(pair.claim)).toBeUndefined();
      expect(programsForClaimProgram(pair.vault)).toBeUndefined();
    }
  });

  it("the source refuses a mainnet build that is also the short-clocks test build", () => {
    expect(rust).toContain('#[cfg(all(feature = "mainnet", feature = "short-clocks"))]\ncompile_error!');
  });
});

describe("the finisher names its pair", () => {
  const keyfile = join(dir, "payer.json");
  writeFileSync(keyfile, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  const run = (...args: string[]) => main(["finisher", "--keypair", keyfile, "--once", ...args], { out: () => {}, env: {} });

  it("mainnet is never a default: a mainnet endpoint without --mainnet is refused", async () => {
    await expect(run("--rpc", "https://api.mainnet-beta.solana.com")).rejects.toThrow(/say --mainnet/);
  });

  it("--mainnet is refused with a devnet endpoint, and with --short-clocks", async () => {
    await expect(run("--mainnet", "--rpc", "https://api.devnet.solana.com")).rejects.toThrow(/not there/);
    await expect(run("--mainnet", "--short-clocks", "--rpc", "https://example.invalid")).rejects.toThrow(/two different pairs/);
  });
});
