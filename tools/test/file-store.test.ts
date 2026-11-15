import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySuccession, encodeVault, type SuccessionState } from "@lamport-robotics/vault";
import { PublicKey } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";
import { FileStore, storeKey } from "../src/reminders/file-store.ts";
import { type Message } from "../src/reminders/messages.ts";
import { type Channel, ReminderService } from "../src/reminders/service.ts";
import { PROGRAMS } from "../src/programs.ts";
import { FakeChain } from "./fake-chain.ts";

const dir = mkdtempSync(join(tmpdir(), "lamport-heir-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 86_400n;
const T0 = 1_800_000_000n;
const pk = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const vault = pk(0x11);
const key = Buffer.alloc(32, 7);
const H5 = Uint8Array.from([0, 0, 0, 5, 0, 0, 0, 3, ...new Uint8Array(48).fill(0xab)]);
const vaultData = (s: SuccessionState) => encodeVault({ version: 3, bump: 255, vaultId: new Uint8Array(32).fill(1), lmsPubkey: H5, spent: 0, generation: 0, createdSlot: 1n, succession: s, used: new Uint8Array(4), usedKeys: [] });
const armed: SuccessionState = { ...emptySuccession(), claim: pk(0x22), windowSecs: 365n * DAY, waitSecs: 60n * DAY, lastSignedTs: T0, checkinKey: pk(0x33) };
const sub = { vault: vault.toBase58(), label: "savings", owner: [{ channel: "email" as const, to: "owner@example.org" }], contacts: [{ channel: "email" as const, to: "friend@example.org" }] };

class Inbox implements Channel {
  readonly got: { to: string; message: Message }[] = [];
  fail = false;
  async send(to: string, message: Message): Promise<void> {
    if (this.fail) throw new Error("down");
    this.got.push({ to, message });
  }
}

describe("the reminder store on disk", () => {
  it("holds nothing readable: no address of anyone, no vault, no label", async () => {
    const path = join(dir, "a.store");
    const store = FileStore.open(path, key);
    store.subscribe(sub);
    const chain = new FakeChain();
    chain.put(vault, PROGRAMS.vault, vaultData(armed));
    chain.now = T0 + 358n * DAY;
    const email = new Inbox();
    email.fail = true; // leave a delivery queued, so the file holds a rendered-to-be message's facts too
    await new ReminderService(chain, store, { email }).tick();
    const bytes = readFileSync(path);
    for (const secret of ["owner@example.org", "friend@example.org", "savings", vault.toBase58(), pk(0x22).toBase58(), "deadline_ahead", "subscriptions"]) {
      expect(bytes.includes(Buffer.from(secret)), secret).toBe(false);
    }
    expect(bytes.subarray(0, 4).toString()).toBe("LHS1");
  });

  it("comes back as it was, bigints, keys and all, and carries on where it stopped", async () => {
    const path = join(dir, "b.store");
    const chain = new FakeChain();
    chain.put(vault, PROGRAMS.vault, vaultData(armed));
    chain.now = T0 + 358n * DAY; // seven days left: the owner and the contact are due a notice
    const email = new Inbox();
    email.fail = true;
    const first = FileStore.open(path, key);
    first.subscribe(sub);
    expect(await new ReminderService(chain, first, { email }).tick()).toMatchObject({ queued: 2, sent: 0 });

    // the process restarts
    const second = FileStore.open(path, key);
    expect(await second.subscriptions()).toEqual([sub]);
    const snap = await second.snapshot(vault.toBase58());
    expect(snap?.kind === "open" && snap.succession.claim.equals(pk(0x22))).toBe(true);
    expect(snap?.kind === "open" && snap.succession.windowSecs).toBe(365n * DAY);
    expect(snap?.kind === "open" && snap.succession.reserved).toEqual(new Uint8Array(54));
    expect((await second.outbox()).map((d) => d.recipient.to).sort()).toEqual(["friend@example.org", "owner@example.org"]);
    expect((await second.outbox())[0]!.queuedAt).toBe(chain.now);

    email.fail = false;
    expect(await new ReminderService(chain, second, { email }).tick()).toMatchObject({ queued: 0, sent: 2 });
    // and after one more restart nothing is sent twice
    const third = FileStore.open(path, key);
    expect(await new ReminderService(chain, third, { email }).tick()).toMatchObject({ queued: 0, sent: 0 });
    expect(email.got).toHaveLength(2);
  });

  it("refuses a wrong key and a changed file instead of starting empty", () => {
    const path = join(dir, "c.store");
    FileStore.open(path, key).subscribe(sub);
    expect(() => FileStore.open(path, Buffer.alloc(32, 8))).toThrow(/key is wrong or the file has been changed/);
    const bytes = readFileSync(path);
    bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 1;
    writeFileSync(path, bytes);
    expect(() => FileStore.open(path, key)).toThrow(/key is wrong or the file has been changed/);
    writeFileSync(path, "not a store at all, just some text that is long enough");
    expect(() => FileStore.open(path, key)).toThrow(/is not a reminder store/);
    expect(() => FileStore.open(join(dir, "d.store"), Buffer.alloc(31))).toThrow(/32 bytes/);
  });

  it("replaces a vault's subscription, forgets one on request, and refuses what is not an address", async () => {
    const path = join(dir, "e.store");
    const store = FileStore.open(path, key);
    store.subscribe(sub);
    store.subscribe({ ...sub, label: "renamed", contacts: [] });
    expect(await store.subscriptions()).toEqual([{ ...sub, label: "renamed", contacts: [] }]);
    expect(() => store.subscribe({ ...sub, vault: "not an address" })).toThrow();
    store.unsubscribe(vault.toBase58());
    expect(await FileStore.open(path, key).subscriptions()).toEqual([]);
  });

  it("takes its key as 64 hex digits and nothing else", () => {
    expect(storeKey("ab".repeat(32)).length).toBe(32);
    for (const bad of [undefined, "", "ab".repeat(31), "zz".repeat(32), "ab".repeat(33)]) expect(() => storeKey(bad)).toThrow(/64 hex digits/);
  });
});
