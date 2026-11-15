import { emptySuccession, encodeTombstone, encodeVault, type SuccessionState, TOMBSTONE_ACCOUNT_VERSION } from "@lamport-robotics/vault";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { type Message } from "../src/reminders/messages.ts";
import { type Channel, MemoryStore, ReminderService } from "../src/reminders/service.ts";
import { PROGRAMS } from "../src/programs.ts";
import { FakeChain } from "./fake-chain.ts";

const DAY = 86_400n;
const T0 = 1_800_000_000n;
const WINDOW = 365n * DAY;
const pk = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const vault = pk(0x11);
const heir = pk(0x22);
const H5 = Uint8Array.from([0, 0, 0, 5, 0, 0, 0, 3, ...new Uint8Array(48).fill(0xab)]);

function vaultData(s: SuccessionState): Uint8Array {
  return encodeVault({ version: 3, bump: 255, vaultId: new Uint8Array(32).fill(1), lmsPubkey: H5, spent: 0, generation: 0, createdSlot: 1n, succession: s, used: new Uint8Array(4), usedKeys: [] });
}
const armed = (over: Partial<SuccessionState> = {}): SuccessionState => ({ ...emptySuccession(), claim: heir, windowSecs: WINDOW, waitSecs: 60n * DAY, lastSignedTs: T0, ...over });

class Inbox implements Channel {
  readonly got: { to: string; message: Message }[] = [];
  failFor = new Set<string>();
  async send(to: string, message: Message): Promise<void> {
    if (this.failFor.has(to)) throw new Error(`could not reach ${to}`);
    this.got.push({ to, message });
  }
}

function world() {
  const chain = new FakeChain();
  chain.now = T0;
  chain.put(vault, PROGRAMS.vault, vaultData(armed()));
  const store = new MemoryStore();
  store.subs.push({ vault: vault.toBase58(), label: "savings", owner: [{ channel: "email", to: "owner@example.org" }, { channel: "push", to: "owner-phone" }], contacts: [{ channel: "email", to: "friend@example.org" }] });
  const email = new Inbox();
  const push = new Inbox();
  return { chain, store, email, push, service: new ReminderService(chain, store, { email, push }) };
}

describe("the reminder service", () => {
  it("says nothing while nothing is due, and sends nothing to the chain, ever", async () => {
    const w = world();
    expect(await w.service.tick()).toMatchObject({ vaultsRead: 1, queued: 0, sent: 0, failed: [] });
    expect(w.email.got).toEqual([]);
    w.chain.now = T0 + WINDOW + 400n * DAY; // long overdue: it still only talks
    await w.service.tick();
    expect(w.chain.sends + w.chain.simulations).toBe(0);
  });

  it("sends each stage once, to the owner on every channel, and to contacts from seven days", async () => {
    const w = world();
    const deadline = T0 + WINDOW;
    w.chain.now = deadline - 30n * DAY;
    expect(await w.service.tick()).toMatchObject({ queued: 2, sent: 2 });
    expect(w.email.got.map((g) => g.to)).toEqual(["owner@example.org"]);
    expect(w.push.got.map((g) => g.to)).toEqual(["owner-phone"]);
    expect(w.email.got[0]!.message.subject).toBe("Lamport Heir: 30 days left to check in");
    expect(w.email.got[0]!.message.body).toContain('vault "savings"');

    // the same stage, an hour later and a day later: nothing more
    for (const later of [3600n, DAY]) {
      w.chain.now = deadline - 30n * DAY + later;
      expect(await w.service.tick()).toMatchObject({ queued: 0, sent: 0 });
    }
    w.chain.now = deadline - 7n * DAY;
    expect(await w.service.tick()).toMatchObject({ queued: 3, sent: 3 });
    expect(w.email.got.map((g) => g.to)).toEqual(["owner@example.org", "owner@example.org", "friend@example.org"]);
    expect(w.email.got[2]!.message.body).toContain("You cannot move or release anything");
  });

  it("tries a failed channel again without sending anyone the message twice", async () => {
    const w = world();
    w.chain.now = T0 + WINDOW - 7n * DAY;
    w.email.failFor.add("friend@example.org");
    const first = await w.service.tick();
    expect(first.sent).toBe(2);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]!.error).toBe("could not reach friend@example.org");

    w.email.failFor.clear();
    w.chain.now += 600n;
    expect(await w.service.tick()).toMatchObject({ queued: 0, sent: 1, failed: [] });
    expect(w.email.got.map((g) => g.to)).toEqual(["owner@example.org", "friend@example.org"]);
    expect(w.push.got).toHaveLength(1);
  });

  it("does not lose a plan change when its first delivery fails", async () => {
    const w = world();
    await w.service.tick(); // the service has seen the plan as it was
    w.chain.put(vault, PROGRAMS.vault, vaultData(armed({ claim: pk(0x44), windowSecs: 90n * DAY, lastSignedTs: T0 + DAY })));
    w.chain.now = T0 + DAY;
    for (const to of ["owner@example.org", "friend@example.org", "owner-phone"]) {
      w.email.failFor.add(to);
      w.push.failFor.add(to);
    }
    expect(await w.service.tick()).toMatchObject({ queued: 3, sent: 0 });
    // By the next tick the stored snapshot already holds the new plan, so the change is no longer
    // "new". It is still delivered, because it was written to the outbox when it was seen.
    w.email.failFor.clear();
    w.push.failFor.clear();
    w.chain.now += 60n;
    expect(await w.service.tick()).toMatchObject({ queued: 0, sent: 3 });
    const toFriend = w.email.got.find((g) => g.to === "friend@example.org")!;
    expect(toFriend.message.subject).toBe("Lamport Heir: the succession plan changed");
    expect(toFriend.message.body).toContain("the inactivity window changed from 365 days to 90 days");
  });

  it("gives up on a delivery nobody could be reached for after two weeks", async () => {
    const w = world();
    w.chain.now = T0 + WINDOW - 30n * DAY;
    w.email.failFor.add("owner@example.org");
    await w.service.tick();
    w.chain.now += 16n * DAY; // 14 days before the deadline: that stage is what matters now, and it is queued fresh
    w.email.failFor.clear();
    const r = await w.service.tick();
    expect(r.expired).toBe(1);
    expect(w.email.got.map((g) => g.message.subject)).toEqual(["Lamport Heir: 14 days left to check in"]);
  });

  it("announces a waiting period and a release, and keeps going when one vault cannot be read", async () => {
    const w = world();
    const missing = pk(0x77);
    w.store.subs.unshift({ vault: missing.toBase58(), owner: [{ channel: "email", to: "other@example.org" }], contacts: [] });
    const started = T0 + WINDOW + 5n;
    w.chain.put(vault, PROGRAMS.vault, vaultData(armed({ waitOpen: true, waitStartedTs: started })));
    w.chain.now = started + 10n;
    const r = await w.service.tick();
    expect(r.unread).toEqual([{ vault: missing.toBase58(), error: "there is no account at this address" }]);
    expect(r.sent).toBe(3);
    expect(w.email.got[0]!.message.subject).toBe("Lamport Heir: a waiting period is open");

    w.chain.put(vault, PROGRAMS.vault, encodeTombstone({ version: TOMBSTONE_ACCOUNT_VERSION, vaultId: new Uint8Array(32), closedSlot: 9n, heir }));
    w.chain.now = started + 61n * DAY;
    expect((await w.service.tick()).sent).toBe(3);
    expect(w.email.got.at(-1)!.message.subject).toBe("Lamport Heir: the vault has been released");
    expect((await w.service.tick()).sent).toBe(0);
  });

  it("reports a channel that is not configured instead of dropping the message", async () => {
    const w = world();
    const service = new ReminderService(w.chain, w.store, { email: w.email });
    w.chain.now = T0 + WINDOW - 30n * DAY;
    const r = await service.tick();
    expect(r.sent).toBe(1);
    expect(r.failed).toEqual([expect.objectContaining({ error: "no push channel is configured" })]);
  });
});
