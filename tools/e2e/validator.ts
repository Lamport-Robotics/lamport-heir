/**
 * Starts a local validator with the two `short-clocks` test builds loaded at their ids, and stops
 * it when the run is over. In those builds a "day" lasts one second, so a whole cycle (90 days of
 * silence, 30 of waiting, a 30-day contingent delay) passes while the test watches.
 *
 * The programs must be built first: `npm run build:programs` (see tools/README.md).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection } from "@solana/web3.js";
import { SHORT_CLOCKS_PROGRAMS } from "../src/programs.ts";

export const RPC_PORT = 18_899;
export const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

const deploy = fileURLToPath(new URL("../../target/deploy-short-clocks/", import.meta.url));

export default async function setup(): Promise<() => Promise<void>> {
  const vaultSo = join(deploy, "lamport_vault.so");
  const claimSo = join(deploy, "heir_claim.so");
  for (const so of [vaultSo, claimSo]) {
    if (!existsSync(so)) throw new Error(`${so} is missing: build the test programs first with \`npm run build:programs\``);
  }
  const ledger = mkdtempSync(join(tmpdir(), "lamport-heir-e2e-"));
  const args = [
    "--reset",
    "--quiet",
    "--ledger",
    ledger,
    "--bind-address",
    "127.0.0.1",
    "--rpc-port",
    String(RPC_PORT),
    "--faucet-port",
    "19900",
    "--gossip-port",
    "18001",
    "--dynamic-port-range",
    "18002-18040",
    "--bpf-program",
    SHORT_CLOCKS_PROGRAMS.vault.toBase58(),
    vaultSo,
    "--bpf-program",
    SHORT_CLOCKS_PROGRAMS.claim.toBase58(),
    claimSo,
  ];
  let output = "";
  const validator: ChildProcess = spawn("solana-test-validator", args, { stdio: ["ignore", "pipe", "pipe"] });
  validator.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  validator.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  let exited: number | null | undefined;
  validator.on("exit", (code) => (exited = code));
  validator.on("error", (e) => {
    output += `\n${e.message}`;
    exited = -1;
  });

  const stop = async () => {
    if (exited === undefined) {
      validator.kill("SIGTERM");
      await new Promise((resolve) => validator.once("exit", resolve));
    }
    rmSync(ledger, { recursive: true, force: true });
  };

  const connection = new Connection(RPC_URL, "confirmed");
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited !== undefined) {
      await stop();
      throw new Error(`solana-test-validator did not start (is it installed and on the PATH?):\n${output.slice(-2000)}`);
    }
    try {
      // ready when it produces blocks and has both programs
      if ((await connection.getSlot()) > 1 && (await connection.getAccountInfo(SHORT_CLOCKS_PROGRAMS.vault))?.executable && (await connection.getAccountInfo(SHORT_CLOCKS_PROGRAMS.claim))?.executable) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`solana-test-validator was not ready after 90 seconds:\n${output.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return stop;
}
