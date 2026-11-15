/**
 * The gate of milestone 4, on the local validator: `scripts/cycle.ts`, the same script that is run
 * against devnet, start to finish. Arm, go quiet, warn, start, release, sweep, claim.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { runCycle } from "../scripts/cycle.ts";
import { RPC_URL } from "./validator.ts";

describe("one whole cycle with the short-clocks programs", () => {
  it("arms a vault, lets it go quiet, warns, starts, releases, sweeps, and the first heir claims everything", async () => {
    const connection = new Connection(RPC_URL, "confirmed");
    const payer = Keypair.generate();
    const signature = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) });
    const before = await connection.getBalance(payer.publicKey);

    const lines: string[] = [];
    const report = await runCycle({ rpcUrl: RPC_URL, payer, log: (l) => { lines.push(l); console.log(l); } });

    // every step of the gate happened, in order, and every one that sends something has a transaction
    expect(report.steps.map((s) => s.step)).toEqual(["arm", "arm", "arm", "quiet", "warn", "start", "release", "sweep", "claim"]);
    for (const s of report.steps) if (s.step !== "warn") expect(s.signatures.length, s.what).toBeGreaterThan(0);

    // warned: the owner ahead of the deadline, the contact from seven days, both when it passed and at each turn after
    const to = (who: string) => report.reminders.filter((r) => r.to.startsWith(who)).map((r) => r.subject);
    expect(to("owner").some((s) => /30 days left to check in/.test(s))).toBe(true);
    expect(to("owner").filter((s) => /days? left to check in/.test(s)).length).toBeGreaterThanOrEqual(2);
    expect(to("contact").some((s) => /30 days left|14 days left/.test(s))).toBe(false);
    for (const who of ["owner", "contact"]) {
      expect(to(who).some((s) => /succession plan changed/.test(s)), who).toBe(true);
      expect(to(who).some((s) => /window has run out/.test(s)), who).toBe(true);
      expect(to(who).some((s) => /waiting period is open/.test(s)), who).toBe(true);
      expect(to(who).some((s) => /has been released/.test(s)), who).toBe(true);
    }
    // no reminder is sent twice
    const sent = report.reminders.map((r) => `${r.to}|${r.subject}`);
    expect(new Set(sent).size).toBe(sent.length);

    // everything the vault held is with the first heir
    expect(BigInt(report.delivered.tokensClaimed)).toBe(BigInt(report.delivered.tokensInVault));
    expect(BigInt(report.delivered.lamportsClaimed)).toBeGreaterThanOrEqual(BigInt(report.delivered.lamportsInVault));

    // and it cost the paying key fees and rent only: what went into the vault came back
    const spent = before - (await connection.getBalance(payer.publicKey));
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(0.05 * LAMPORTS_PER_SOL);
  });
});
