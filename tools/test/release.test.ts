import { ACCOUNT, emptySuccession, encodeTombstone, encodeVault, type SuccessionState, TOMBSTONE_ACCOUNT_VERSION } from "@lamport-robotics/vault";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { encodePlanForTests } from "../scripts/claim-kat.ts";
import { base58 } from "../src/chain.ts";
import { claim } from "../src/claiming.ts";
import { hashedHeir, planAddress, type Terms } from "../src/claim.ts";
import { closedVaults, Finisher, releasableVaults } from "../src/finisher.ts";
import { PROGRAMS, SHORT_CLOCKS_PROGRAMS } from "../src/programs.ts";
import { finish, inspect, start } from "../src/release.ts";
import { FakeChain } from "./fake-chain.ts";

const DAY = 86_400n;
const T0 = 1_800_000_000n;
const WINDOW = 90n * DAY;
const WAIT = 30n * DAY;
let counter = 0;
/** A fresh artificial address. No key for it exists. */
const addr = () => {
  const bytes = new Uint8Array(32).fill(0x40);
  bytes[31] = ++counter;
  bytes[30] = counter >> 8;
  return new PublicKey(bytes);
};
// throwaway keys: they only ever sign transactions the fake chain refuses to run
const payer = Keypair.generate();
const heirKey = Keypair.generate();

const H5_PUBKEY = Uint8Array.from([0, 0, 0, 5, 0, 0, 0, 3, ...new Uint8Array(48).fill(0xab)]);

function vaultData(succession: SuccessionState): Uint8Array {
  return encodeVault({ version: 3, bump: 255, vaultId: new Uint8Array(32).fill(1), lmsPubkey: H5_PUBKEY, spent: 0, generation: 0, createdSlot: 1n, succession, used: new Uint8Array(4), usedKeys: [] });
}

function armed(claimAddress: PublicKey, over: Partial<SuccessionState> = {}): SuccessionState {
  return { ...emptySuccession(), claim: claimAddress, windowSecs: WINDOW, waitSecs: WAIT, lastSignedTs: T0, ...over };
}

function tombstone(heir: PublicKey): Uint8Array {
  return encodeTombstone({ version: TOMBSTONE_ACCOUNT_VERSION, vaultId: new Uint8Array(32).fill(1), closedSlot: 4242n, heir });
}

describe("inspect", () => {
  it("reads an open vault through each phase of its clock", async () => {
    const chain = new FakeChain();
    const vault = addr();
    const heir = addr();
    chain.put(vault, PROGRAMS.vault, vaultData(emptySuccession()));
    let s = await inspect(chain, vault);
    expect(s).toMatchObject({ state: "open", programs: PROGRAMS, now: T0, vaultLamports: 5_000_000 });
    expect(s.status?.phase).toBe("unarmed");
    expect(s.claim).toBeUndefined();

    chain.put(vault, PROGRAMS.vault, vaultData(armed(heir)));
    s = await inspect(chain, vault);
    expect(s.claim?.equals(heir)).toBe(true);
    expect(s.plan).toBeUndefined();
    expect(s.status).toMatchObject({ phase: "quiet", deadline: T0 + WINDOW, earliestRelease: T0 + WINDOW + 1n + WAIT });

    chain.now = T0 + WINDOW; // on the deadline: still the owner's
    expect((await inspect(chain, vault)).status?.phase).toBe("quiet");
    chain.now = T0 + WINDOW + 1n;
    expect((await inspect(chain, vault)).status?.phase).toBe("overdue");

    const started = T0 + WINDOW + 5n;
    chain.put(vault, PROGRAMS.vault, vaultData(armed(heir, { waitOpen: true, waitStartedTs: started })));
    chain.now = started + WAIT - 1n;
    expect((await inspect(chain, vault)).status).toMatchObject({ phase: "waiting", releaseAt: started + WAIT });
    chain.now = started + WAIT;
    expect((await inspect(chain, vault)).status?.phase).toBe("releasable");
  });

  it("reads a released vault, and the plan it released to, from either address", async () => {
    const chain = new FakeChain();
    const vault = addr();
    const terms: Terms = { vault, primary: { kind: "address", address: heirKey.publicKey }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
    const plan = planAddress(terms);
    chain.put(vault, PROGRAMS.vault, tombstone(plan), 1_454_640);
    chain.put(plan, PROGRAMS.claim, encodePlanForTests({ bump: 255, terms, createdTs: T0, activated: false, activatedTs: 0n, closedSlot: 0n, contingentClockTs: 0n }), 9_000_000);

    for (const from of [vault, plan]) {
      const s = await inspect(chain, from);
      expect(s.state).toBe("released");
      expect(s.vault.equals(vault)).toBe(true);
      expect(s.closedSlot).toBe(4242n);
      expect(s.claim?.equals(plan)).toBe(true);
      expect(s.plan?.address.equals(plan)).toBe(true);
      expect(s.plan?.lamports).toBe(9_000_000);
      expect(s.plan?.account.activated).toBe(false);
      expect(s.planNamesAnotherVault).toBeUndefined();
    }
  });

  it("flags a plan that was made for another vault", async () => {
    const chain = new FakeChain();
    const vault = addr();
    const otherVault = addr();
    const terms: Terms = { vault: otherVault, primary: { kind: "address", address: heirKey.publicKey }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
    const plan = planAddress(terms);
    chain.put(vault, PROGRAMS.vault, vaultData(armed(plan)));
    chain.put(plan, PROGRAMS.claim, encodePlanForTests({ bump: 255, terms, createdTs: T0, activated: false, activatedTs: 0n, closedSlot: 0n, contingentClockTs: 0n }));
    const s = await inspect(chain, vault);
    expect(s.plan?.address.equals(plan)).toBe(true);
    expect(s.planNamesAnotherVault).toBe(true);
    // and the heir's claim stops there, before anything is sent
    const res = await claim(chain, heirKey, vault);
    expect(res.verdict).toEqual({ kind: "plan_for_another_vault", plan });
    expect(chain.simulations + chain.sends).toBe(0);
  });

  it("flags a claim address that has neither an account nor a key: a plan that was never created", async () => {
    const chain = new FakeChain();
    const vault = addr();
    const terms: Terms = { vault, primary: { kind: "address", address: heirKey.publicKey }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
    const plan = planAddress(terms); // a program-derived address: off the curve
    chain.put(vault, PROGRAMS.vault, vaultData(armed(plan)));
    let s = await inspect(chain, vault);
    expect(s.plan).toBeUndefined();
    expect(s.claimHasNoKeyAndNoAccount).toBe(true);
    // the heir's claim says what is wrong, and sends nothing
    expect((await claim(chain, heirKey, vault)).verdict).toEqual({ kind: "plan_not_created", address: plan });
    // the same once the release has landed there: lamports, but still no plan
    chain.put(vault, PROGRAMS.vault, tombstone(plan));
    chain.put(plan, SystemProgram.programId, new Uint8Array(0), 3_000_000_000);
    s = await inspect(chain, vault);
    expect(s.state).toBe("released");
    expect(s.claimHasNoKeyAndNoAccount).toBe(true);
    expect(chain.simulations + chain.sends).toBe(0);
    // a wallet that has never been used is not flagged: a key exists for it
    const wallet = Keypair.generate().publicKey;
    chain.put(vault, PROGRAMS.vault, vaultData(armed(wallet)));
    expect((await inspect(chain, vault)).claimHasNoKeyAndNoAccount).toBeUndefined();
    // and once the plan exists, it is a plan
    chain.put(vault, PROGRAMS.vault, vaultData(armed(plan)));
    chain.put(plan, PROGRAMS.claim, encodePlanForTests({ bump: 255, terms, createdTs: T0, activated: false, activatedTs: 0n, closedSlot: 0n, contingentClockTs: 0n }));
    s = await inspect(chain, vault);
    expect(s.plan?.address.equals(plan)).toBe(true);
    expect(s.claimHasNoKeyAndNoAccount).toBeUndefined();
  });

  it("does not take a plan of the other program pair for a plan", async () => {
    const chain = new FakeChain();
    const vault = addr();
    const terms: Terms = { vault, primary: { kind: "address", address: heirKey.publicKey }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
    // a plan account under the short-clocks claim program, named by a vault of the real program
    const plan = planAddress(terms, SHORT_CLOCKS_PROGRAMS.claim);
    chain.put(vault, PROGRAMS.vault, vaultData(armed(plan)));
    chain.put(plan, SHORT_CLOCKS_PROGRAMS.claim, encodePlanForTests({ bump: 255, terms, createdTs: T0, activated: false, activatedTs: 0n, closedSlot: 0n, contingentClockTs: 0n }));
    expect((await inspect(chain, vault)).plan).toBeUndefined();
  });

  it("knows the test build by the program that owns the vault, and uses its clock", async () => {
    const chain = new FakeChain();
    const vault = addr();
    chain.put(vault, SHORT_CLOCKS_PROGRAMS.vault, vaultData(armed(addr(), { windowSecs: 90n, waitSecs: 30n, lastCheckinTs: T0 + 800n })));
    const s = await inspect(chain, vault);
    expect(s.programs).toBe(SHORT_CLOCKS_PROGRAMS);
    // a check-in counts for 730 test-days (seconds) past the last signature, not for two years
    expect(s.status?.deadline).toBe(T0 + 730n + 90n);
  });

  it("says what is wrong with an address it cannot use", async () => {
    const chain = new FakeChain();
    const nowhere = addr();
    await expect(inspect(chain, nowhere)).rejects.toThrow(/no account at/);
    const foreign = addr();
    chain.put(foreign, addr(), new Uint8Array(100));
    await expect(inspect(chain, foreign)).rejects.toThrow(/not an account of a Heir-enabled vault program/);
    const buffer = addr();
    chain.put(buffer, PROGRAMS.vault, Uint8Array.from([...ACCOUNT.sigBuffer, ...new Uint8Array(60)]));
    await expect(inspect(chain, buffer)).rejects.toThrow(/neither a vault nor a tombstone/);
    const lostVault = addr();
    const terms: Terms = { vault: lostVault, primary: { kind: "address", address: heirKey.publicKey }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
    const plan = planAddress(terms);
    chain.put(plan, PROGRAMS.claim, encodePlanForTests({ bump: 255, terms, createdTs: T0, activated: false, activatedTs: 0n, closedSlot: 0n, contingentClockTs: 0n }));
    await expect(inspect(chain, plan)).rejects.toThrow(/there is no account there/);
  });
});

describe("the finisher's search", () => {
  function world() {
    const chain = new FakeChain();
    const heir = addr();
    const started = T0 + WINDOW + 10n;
    chain.now = started + WAIT;
    const v = { quiet: addr(), overdue: addr(), waiting: addr(), dueNow: addr(), dueLongAgo: addr(), closed: addr(), otherProgram: addr() };
    chain.put(v.quiet, PROGRAMS.vault, vaultData(armed(heir, { lastSignedTs: chain.now - 5n })));
    chain.put(v.overdue, PROGRAMS.vault, vaultData(armed(heir)));
    chain.put(v.waiting, PROGRAMS.vault, vaultData(armed(heir, { waitOpen: true, waitStartedTs: started + 1n })));
    chain.put(v.dueNow, PROGRAMS.vault, vaultData(armed(heir, { waitOpen: true, waitStartedTs: started })));
    chain.put(v.dueLongAgo, PROGRAMS.vault, vaultData(armed(heir, { waitOpen: true, waitStartedTs: started - 400n * DAY })));
    chain.put(v.closed, PROGRAMS.vault, tombstone(heir));
    chain.put(v.otherProgram, SHORT_CLOCKS_PROGRAMS.vault, vaultData(armed(heir, { waitOpen: true, waitStartedTs: started - 400n * DAY })));
    return { chain, heir, v };
  }

  it("finds exactly the vaults whose waiting period has run out, by the cluster's clock", async () => {
    const { chain, v } = world();
    const due = (await releasableVaults(chain, PROGRAMS)).map((k) => k.toBase58()).sort();
    expect(due).toEqual([v.dueNow.toBase58(), v.dueLongAgo.toBase58()].sort());
    // one request: vaults only, waiting period open, and only their succession blocks
    expect(chain.listed).toHaveLength(1);
    const asked = chain.listed[0]!;
    expect(asked.programId.equals(PROGRAMS.vault)).toBe(true);
    expect(asked.dataSlice).toEqual({ offset: 114, length: 200 });
    expect(asked.filters).toEqual([{ memcmp: { offset: 0, bytes: base58(ACCOUNT.vault) } }, { memcmp: { offset: 251, bytes: "2" } }]);
    // a second earlier, the one that ends this second is not due yet
    chain.now -= 1n;
    expect((await releasableVaults(chain, PROGRAMS)).map((k) => k.toBase58())).toEqual([v.dueLongAgo.toBase58()]);
    // the other pair's vaults belong to a finisher for that pair
    expect((await releasableVaults(chain, SHORT_CLOCKS_PROGRAMS)).map((k) => k.toBase58())).toEqual([v.otherProgram.toBase58()]);
  });

  it("the offset it filters on is where wait_open is", () => {
    // Set only wait_open in an otherwise empty block and see which byte of the account changed.
    const off = vaultData(emptySuccession());
    const on = vaultData({ ...emptySuccession(), waitOpen: true });
    const changed = [...on.keys()].filter((i) => on[i] !== off[i]);
    expect(changed).toEqual([251]);
    expect(on[251]).toBe(1);
  });

  it("lists closed vaults with the address each released to", async () => {
    const { chain, heir, v } = world();
    const closed = await closedVaults(chain, PROGRAMS);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.vault.equals(v.closed)).toBe(true);
    expect(closed[0]!.heir.equals(heir)).toBe(true);
  });
});

describe("what is never sent", () => {
  it("finish does nothing to a vault that is not due, whatever its phase", async () => {
    const heir = addr();
    const started = T0 + WINDOW + 10n;
    const cases: [string, SuccessionState, bigint][] = [
      ["no plan", emptySuccession(), T0 + 1000n * DAY],
      ["quiet", armed(heir), T0 + 1n],
      ["overdue: finish never opens a waiting period", armed(heir), T0 + WINDOW + 400n * DAY],
      ["waiting", armed(heir, { waitOpen: true, waitStartedTs: started }), started + WAIT - 1n],
    ];
    for (const [name, succession, now] of cases) {
      const chain = new FakeChain();
      const vault = addr();
      chain.put(vault, PROGRAMS.vault, vaultData(succession));
      chain.now = now;
      const { steps, situation } = await finish(chain, payer, vault);
      expect(steps, name).toEqual([]);
      expect(situation.state, name).toBe("open");
      expect(chain.simulations + chain.sends, name).toBe(0);
    }
  });

  it("a finisher pass with nothing due sends nothing", async () => {
    const chain = new FakeChain();
    const heir = addr();
    for (const s of [emptySuccession(), armed(heir), armed(heir, { lastSignedTs: T0 - 500n * DAY }), armed(heir, { waitOpen: true, waitStartedTs: T0 })]) chain.put(addr(), PROGRAMS.vault, vaultData(s));
    const reports = await new Finisher(chain, payer, PROGRAMS).pass();
    expect(reports).toEqual([]);
    expect(chain.simulations + chain.sends).toBe(0);
  });

  it("start is refused, in words, unless the owner's window has run out", async () => {
    const chain = new FakeChain();
    const heir = addr();
    const vault = addr();
    chain.put(vault, PROGRAMS.vault, vaultData(emptySuccession()));
    expect((await start(chain, payer, vault)).step.skipped).toMatch(/no succession plan/);
    chain.put(vault, PROGRAMS.vault, vaultData(armed(heir)));
    expect((await start(chain, payer, vault)).step.skipped).toMatch(/active within the window/);
    chain.put(vault, PROGRAMS.vault, vaultData(armed(heir, { waitOpen: true, waitStartedTs: T0 })));
    chain.now = T0 + 1n;
    expect((await start(chain, payer, vault)).step.skipped).toMatch(/already open/);
    chain.put(vault, PROGRAMS.vault, tombstone(heir));
    expect((await start(chain, payer, vault)).step.skipped).toMatch(/already been released/);
    expect(chain.simulations + chain.sends).toBe(0);
    // overdue: now it asks the cluster (which, here, runs nothing)
    chain.put(vault, PROGRAMS.vault, vaultData(armed(heir)));
    chain.now = T0 + WINDOW + 1n;
    const res = await start(chain, payer, vault);
    expect(res.step.failed).toBeDefined();
    expect(chain.simulations).toBe(1);
    expect(chain.sends).toBe(0);
  });

  it("a key the owner did not name is told so before anything is sent or paid", async () => {
    const stranger = Keypair.generate();
    const salt = new Uint8Array(32).fill(3);
    const chain = new FakeChain();

    // a vault that releases to somebody's plain address
    const direct = addr();
    const theirs = addr();
    chain.put(direct, PROGRAMS.vault, tombstone(theirs));
    expect((await claim(chain, stranger, direct)).verdict).toEqual({ kind: "released_to_address", address: theirs, yours: false });

    // a plan with named heirs
    const v1 = addr();
    const named: Terms = { vault: v1, primary: { kind: "address", address: heirKey.publicKey }, contingent: { kind: "none" }, contingentDelaySecs: 0n };
    chain.put(v1, PROGRAMS.vault, tombstone(planAddress(named)));
    chain.put(planAddress(named), PROGRAMS.claim, encodePlanForTests({ bump: 255, terms: named, createdTs: T0, activated: true, activatedTs: T0, closedSlot: 1n, contingentClockTs: T0 }));
    expect((await claim(chain, stranger, v1)).verdict).toEqual({ kind: "not_an_heir", hashedHeirs: false, saltGiven: false });

    // a plan with a hashed heir: without the salt even the heir is not recognised, and is told to pass it
    const v2 = addr();
    const hashed: Terms = { vault: v2, primary: hashedHeir(salt, heirKey.publicKey), contingent: { kind: "none" }, contingentDelaySecs: 0n };
    chain.put(v2, PROGRAMS.vault, tombstone(planAddress(hashed)));
    chain.put(planAddress(hashed), PROGRAMS.claim, encodePlanForTests({ bump: 255, terms: hashed, createdTs: T0, activated: true, activatedTs: T0, closedSlot: 1n, contingentClockTs: T0 }));
    expect((await claim(chain, heirKey, v2)).verdict).toEqual({ kind: "not_an_heir", hashedHeirs: true, saltGiven: false });
    expect((await claim(chain, heirKey, v2, { salt: new Uint8Array(32).fill(4) })).verdict).toEqual({ kind: "not_an_heir", hashedHeirs: true, saltGiven: true });
    expect((await claim(chain, stranger, v2, { salt })).verdict).toEqual({ kind: "not_an_heir", hashedHeirs: true, saltGiven: true });

    expect(chain.simulations + chain.sends).toBe(0);
  });
});
