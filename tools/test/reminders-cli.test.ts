import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySuccession, encodeVault, type SuccessionState } from "@lamport-robotics/vault";
import { PublicKey } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";
import { PROGRAMS } from "../src/programs.ts";
import { channelsFrom, main } from "../src/reminders/cli.ts";
import { FakeChain } from "./fake-chain.ts";

const dir = mkdtempSync(join(tmpdir(), "lamport-heir-reminders-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 86_400n, T0 = 1_800_000_000n;
const pk = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const vault = pk(0x11);
const H5 = Uint8Array.from([0, 0, 0, 5, 0, 0, 0, 3, ...new Uint8Array(48).fill(0xab)]);
const armed: SuccessionState = { ...emptySuccession(), claim: pk(0x22), windowSecs: 365n * DAY, waitSecs: 60n * DAY, lastSignedTs: T0 };
const vaultData = encodeVault({ version: 3, bump: 255, vaultId: new Uint8Array(32).fill(1), lmsPubkey: H5, spent: 0, generation: 0, createdSlot: 1n, succession: armed, used: new Uint8Array(4), usedKeys: [] });

async function run(argv: string[], env: Record<string, string | undefined>, chain?: FakeChain): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await main(argv, { out: (l) => lines.push(l), env, ...(chain ? { chain } : {}) });
  return { code, text: lines.join("\n") };
}

function envFrom(file: string): Record<string, string> {
  return Object.fromEntries(readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

describe("the reminder service's command line", () => {
  const keyFile = join(dir, "keys.env");
  let env: Record<string, string | undefined>;

  it("makes its keys into a file only its user can read, and shows no private half", async () => {
    const r = await run(["keys", "--out", keyFile], {});
    expect(r.code).toBe(0);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const made = envFrom(keyFile);
    expect(made.LAMPORT_HEIR_STORE_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(r.text).toContain(made.LAMPORT_HEIR_PUSH_PUBLIC_KEY);
    expect(r.text).not.toContain(made.LAMPORT_HEIR_PUSH_PRIVATE_KEY);
    expect(r.text).not.toContain(made.LAMPORT_HEIR_STORE_KEY);
    // a second run must not replace the key a store was made with
    await expect(run(["keys", "--out", keyFile], {})).rejects.toThrow(/exists already/);
    await expect(run(["keys"], {})).rejects.toThrow(/never shown/);
    env = { ...made, LAMPORT_HEIR_STORE: join(dir, "store.bin") };
  });

  it("adds, lists and removes a vault, and a listing shows no address of anyone", async () => {
    expect((await run(["list"], env)).text).toBe("no vaults");
    const added = await run(["add", vault.toBase58(), "--email", "owner@example.org", "--contact", "friend@example.org", "--contact", "sister@example.org", "--label", "savings"], env);
    expect(added.text).toMatch(/the owner on 1 channel\(s\), 2 trusted contact\(s\)/);
    const listed = (await run(["list"], env)).text;
    expect(listed).toContain(vault.toBase58());
    expect(listed).toContain('"savings"');
    expect(listed).not.toMatch(/@/);
    // the store on disk is not readable either
    expect(readFileSync(env.LAMPORT_HEIR_STORE!).toString("latin1")).not.toMatch(/owner@example\.org|friend@example\.org/);
    await run(["remove", vault.toBase58()], env);
    expect((await run(["list"], env)).text).toBe("no vaults");
  });

  it("refuses what it cannot use", async () => {
    await expect(run(["add", "not-an-address", "--email", "a@example.org"], env)).rejects.toThrow(/needs the vault's address/);
    await expect(run(["add", vault.toBase58()], env)).rejects.toThrow(/somewhere to reach the owner/);
    await expect(run(["add", vault.toBase58(), "--email", "a@example.org\nBcc: b@example.org"], env)).rejects.toThrow(/not an email address/);
    await expect(run(["add", vault.toBase58(), "--email", "a@example.org", "--contact", "nobody"], env)).rejects.toThrow(/not an email address/);
    await expect(run(["list"], { ...env, LAMPORT_HEIR_STORE_KEY: "abc" })).rejects.toThrow(/64 hex digits/);
    await expect(run(["list"], {})).rejects.toThrow(/LAMPORT_HEIR_STORE is not set/);
    await expect(run(["send-everything"], env)).rejects.toThrow(/unknown command/);
  });

  it("with no channel configured, a round queues what is due, sends nothing and says why", async () => {
    await run(["add", vault.toBase58(), "--email", "owner@example.org"], env);
    const chain = new FakeChain();
    chain.put(vault, PROGRAMS.vault, vaultData);
    chain.now = T0 + 365n * DAY - 7n * DAY;
    const r = await run(["run", "--once"], env, chain);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/email is off: no SMTP URL is set/);
    expect(r.text).toMatch(/1 vault\(s\) read, 1 queued, 0 sent, 1 not delivered \(no email channel is configured\)/);
    expect(chain.sends + chain.simulations).toBe(0);
    // the next round does not queue it again
    expect((await run(["run", "--once"], env, chain)).text).toMatch(/0 queued, 0 sent, 1 not delivered/);
  });

  it("turns a channel on only when everything it needs is set, and never repeats a secret", () => {
    const off = channelsFrom({});
    expect(off.channels).toEqual({});
    expect(off.notes.join(" ")).toMatch(/email is off.*notifications are off/);
    const on = channelsFrom({ ...env, LAMPORT_HEIR_SMTP_URL: "smtps://user:hunter2@smtp.example.org:465", LAMPORT_HEIR_MAIL_FROM: "heir@example.org", LAMPORT_HEIR_PUSH_CONTACT: "mailto:heir@example.org" });
    on.close();
    expect(Object.keys(on.channels).sort()).toEqual(["email", "push"]);
    expect(on.notes.join(" ")).not.toMatch(/hunter2/);
    expect(on.notes.join(" ")).not.toContain(env.LAMPORT_HEIR_PUSH_PRIVATE_KEY!);
  });
});
