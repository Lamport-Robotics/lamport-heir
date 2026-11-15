import { emptySuccession, type SuccessionState } from "@lamport-robotics/vault";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { renderNotice } from "../src/reminders/messages.ts";
import { type Notice, type NoticeKind, noticesDue, planChanges, type Snapshot } from "../src/reminders/schedule.ts";

const DAY = 86_400n;
const T0 = 1_800_000_000n;
const WINDOW = 365n * DAY;
const WAIT = 60n * DAY;
const pk = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const VAULT = pk(0x11).toBase58();
const heir = pk(0x22);

function armed(over: Partial<SuccessionState> = {}): SuccessionState {
  return { ...emptySuccession(), claim: heir, windowSecs: WINDOW, waitSecs: WAIT, lastSignedTs: T0, checkinKey: pk(0x33), ...over };
}
const open = (s: SuccessionState): Snapshot => ({ kind: "open", succession: s });
const due = (s: SuccessionState, now: bigint, previous?: SuccessionState) => noticesDue({ vault: VAULT, now, snapshot: open(s), ...(previous ? { previous: open(previous) } : {}) });
const kinds = (n: Notice[]) => n.map((x) => (x.days !== undefined ? `${x.kind}:${x.days}` : x.kind));

describe("the countdown to the deadline", () => {
  const deadline = T0 + WINDOW;

  it("is silent while the deadline is far, and for a vault with no plan", () => {
    expect(due(armed(), T0)).toEqual([]);
    expect(due(armed(), deadline - 30n * DAY - 1n)).toEqual([]);
    expect(due(emptySuccession(), T0 + 5000n * DAY)).toEqual([]);
  });

  it("reminds the owner at 30, 14, 7 and 1 days, and trusted contacts from 7", () => {
    const at = (days: bigint) => due(armed(), deadline - days * DAY);
    expect(at(30n)).toMatchObject([{ kind: "deadline_ahead", days: 30, audience: ["owner"], at: deadline }]);
    expect(at(20n)).toMatchObject([{ days: 30, audience: ["owner"] }]);
    expect(at(14n)).toMatchObject([{ days: 14, audience: ["owner"] }]);
    expect(at(7n)).toMatchObject([{ days: 7, audience: ["owner", "contacts"] }]);
    expect(at(1n)).toMatchObject([{ days: 1, audience: ["owner", "contacts"] }]);
    expect(due(armed(), deadline - 1n)).toMatchObject([{ days: 1 }]);
  });

  it("gives each stage one key, so it is sent once, and a new key when the deadline moves", () => {
    const a = due(armed(), deadline - 10n * DAY)[0]!;
    const b = due(armed(), deadline - 9n * DAY)[0]!;
    expect(a.key).toBe(b.key); // still the 14-day stage of the same deadline
    const next = due(armed(), deadline - 7n * DAY)[0]!;
    expect(next.key).not.toBe(a.key);
    // the owner checked in: another deadline, and the countdown starts over for it
    const checkedIn = armed({ lastCheckinTs: deadline - 8n * DAY });
    expect(due(checkedIn, deadline - 7n * DAY)).toEqual([]);
    const later = due(checkedIn, deadline - 8n * DAY + WINDOW - 30n * DAY)[0]!;
    expect(later).toMatchObject({ kind: "deadline_ahead", days: 30 });
    expect(later.key).not.toBe(a.key);
  });

  it("after an outage sends the most urgent stage only, not every one it missed", () => {
    expect(kinds(due(armed(), deadline - 2n * DAY))).toEqual(["deadline_ahead:7"]);
    expect(kinds(due(armed(), deadline - 3600n))).toEqual(["deadline_ahead:1"]);
  });

  it("works on the test build's clock, where a day is a second", () => {
    const s = armed({ windowSecs: 90n, waitSecs: 30n });
    const n = noticesDue({ vault: VAULT, now: T0 + 90n - 7n, snapshot: open(s), daySecs: 1n });
    expect(n).toMatchObject([{ kind: "deadline_ahead", days: 7, at: T0 + 90n }]);
  });
});

describe("after the deadline", () => {
  const deadline = T0 + WINDOW;

  it("says once that the window has run out, to everyone", () => {
    const a = due(armed(), deadline + 1n);
    expect(a).toMatchObject([{ kind: "overdue", audience: ["owner", "contacts"], at: deadline }]);
    expect(due(armed(), deadline + 200n * DAY)[0]!.key).toBe(a[0]!.key);
    // on the deadline itself the window has not run out yet, and the 1-day reminder has long been sent
    expect(due(armed(), deadline)).toEqual([]);
  });

  it("announces an open waiting period, then counts down to the release", () => {
    const started = deadline + 5n * DAY;
    const s = armed({ waitOpen: true, waitStartedTs: started });
    const releaseAt = started + WAIT;
    expect(kinds(due(s, started))).toEqual(["wait_opened"]);
    expect(due(s, started)[0]).toMatchObject({ audience: ["owner", "contacts"], at: releaseAt });
    expect(kinds(due(s, releaseAt - 14n * DAY))).toEqual(["wait_opened", "release_ahead:14"]);
    expect(kinds(due(s, releaseAt - 3n * DAY))).toEqual(["wait_opened", "release_ahead:3"]);
    expect(kinds(due(s, releaseAt - 1n))).toEqual(["wait_opened", "release_ahead:1"]);
    expect(kinds(due(s, releaseAt))).toEqual(["wait_opened", "releasable"]);
    // the wait_opened key is the same throughout: one announcement per waiting period
    expect(new Set([started, releaseAt - DAY, releaseAt + DAY].map((t) => due(s, t)[0]!.key)).size).toBe(1);
    // a second waiting period, after the first was cancelled, is announced again
    const second = armed({ lastSignedTs: started + DAY, waitOpen: true, waitStartedTs: started + DAY + WINDOW + 9n });
    expect(due(second, second.waitStartedTs)[0]!.key).not.toBe(due(s, started)[0]!.key);
  });

  it("announces the release once", () => {
    const n = noticesDue({ vault: VAULT, now: T0, snapshot: { kind: "released", heir: heir.toBase58(), closedSlot: 77n } });
    expect(n).toEqual([{ key: `${VAULT}:released:77`, kind: "released", audience: ["owner", "contacts"], vault: VAULT, heir: heir.toBase58() }]);
  });
});

describe("a change of plan", () => {
  it("is announced to everyone, with what changed and the soonest release", () => {
    const before = armed();
    const after = armed({ claim: pk(0x44), windowSecs: 90n * DAY, waitSecs: 30n * DAY, lastSignedTs: T0 + 100n * DAY });
    const n = due(after, T0 + 100n * DAY, before);
    expect(kinds(n)).toEqual(["plan_changed"]);
    expect(n[0]!.audience).toEqual(["owner", "contacts"]);
    expect(n[0]!.changes).toEqual([
      `the address the vault releases to changed from ${heir.toBase58()} to ${pk(0x44).toBase58()}`,
      "the inactivity window changed from 365 days to 90 days",
      "the waiting period changed from 60 days to 30 days",
    ]);
    // never sooner than window + wait after the signature that changed it
    expect(n[0]!.earliestRelease).toBe(T0 + 100n * DAY + 90n * DAY + 1n + 30n * DAY);
  });

  it("covers a first plan, the keys, and a clear; and is silent when only the clock moved", () => {
    expect(planChanges(emptySuccession(), armed(), DAY)).toEqual([`a succession plan was set: the vault now releases to ${heir.toBase58()}`, "the inactivity window is 365 days", "the waiting period is 60 days", "a check-in key was set"]);
    expect(planChanges(armed(), armed({ checkinKey: pk(0x55), contactKey: pk(0x66) }), DAY)).toEqual(["the check-in key was replaced", "a trusted contact's key was set"]);
    expect(planChanges(armed(), armed({ checkinKey: PublicKey.default }), DAY)).toEqual(["the check-in key was removed"]);
    expect(planChanges(armed(), emptySuccession(), DAY)).toEqual(["the succession plan was cleared: the vault no longer releases to anyone"]);
    expect(planChanges(armed(), armed({ lastSignedTs: T0 + 5n, lastCheckinTs: T0 + 9n, waitOpen: true, waitStartedTs: 5n, contactUsed: true, extendedUntilTs: 7n }), DAY)).toEqual([]);
    expect(due(armed({ lastSignedTs: T0 + 5n }), T0 + 6n, armed())).toEqual([]);
    // restating the same plan is a signed action, not a change
    expect(due(armed({ lastSignedTs: T0 + 50n }), T0 + 51n, armed())).toEqual([]);
  });

  it("gets a new key for each change, and the same key while nothing changes again", () => {
    const before = armed();
    const after = armed({ windowSecs: 180n * DAY, lastSignedTs: T0 + DAY });
    const k1 = due(after, T0 + DAY, before)[0]!.key;
    expect(due(after, T0 + 2n * DAY, before)[0]!.key).toBe(k1);
    const again = armed({ windowSecs: 365n * DAY, lastSignedTs: T0 + 3n * DAY });
    expect(due(again, T0 + 3n * DAY, after)[0]!.key).not.toBe(k1);
  });
});

describe("an owner who only checks in", () => {
  it("is told a vault signature is due before check-ins stop counting", () => {
    const cap = T0 + 730n * DAY;
    const s = (checkin: bigint) => armed({ lastCheckinTs: checkin });
    // checked in recently, cap 40 days off: nothing yet
    expect(kinds(due(s(cap - 60n * DAY), cap - 40n * DAY))).toEqual([]);
    const thirty = due(s(cap - 60n * DAY), cap - 30n * DAY);
    expect(thirty).toMatchObject([{ kind: "signature_due", days: 30, audience: ["owner"], at: cap }]);
    expect(kinds(due(s(cap - 20n * DAY), cap - 7n * DAY))).toEqual(["signature_due:7"]);
    // an owner who signs is never told: their last sign of life is a signature
    expect(due(armed({ lastSignedTs: cap - 60n * DAY }), cap - 30n * DAY)).toEqual([]);
  });
});

describe("what a reminder says", () => {
  const samples: Notice[] = [
    { key: "k", kind: "deadline_ahead", audience: ["owner", "contacts"], vault: VAULT, days: 7, at: T0 },
    { key: "k", kind: "deadline_ahead", audience: ["owner"], vault: VAULT, days: 1, at: T0 },
    { key: "k", kind: "overdue", audience: ["owner", "contacts"], vault: VAULT, at: T0 },
    { key: "k", kind: "wait_opened", audience: ["owner", "contacts"], vault: VAULT, at: T0 },
    { key: "k", kind: "release_ahead", audience: ["owner", "contacts"], vault: VAULT, days: 3, at: T0 },
    { key: "k", kind: "releasable", audience: ["owner", "contacts"], vault: VAULT, at: T0 },
    { key: "k", kind: "released", audience: ["owner", "contacts"], vault: VAULT, heir: heir.toBase58() },
    { key: "k", kind: "plan_changed", audience: ["owner", "contacts"], vault: VAULT, changes: ["the waiting period changed from 60 days to 30 days"], earliestRelease: T0 + 120n * DAY },
    { key: "k", kind: "signature_due", audience: ["owner"], vault: VAULT, days: 30, at: T0 },
  ];

  it("has a template for every kind of notice", () => {
    const all: NoticeKind[] = ["deadline_ahead", "overdue", "wait_opened", "release_ahead", "releasable", "released", "plan_changed", "signature_due"];
    expect(new Set(samples.map((s) => s.kind))).toEqual(new Set(all));
  });

  it("never contains a link, and never asks for a secret", () => {
    for (const n of samples) {
      for (const audience of n.audience) {
        const m = renderNotice(n, audience, "savings");
        const text = `${m.subject}\n${m.body}`;
        expect(text, n.kind).not.toMatch(/https?:|www\.|\.com\b|\.io\b|\.xyz\b|\bclick\b|\btap here\b/i);
        expect(text, n.kind).toContain("contains no link");
        expect(text, n.kind).toContain("never asks for your words or your keys");
        expect(text, n.kind).not.toMatch(/enter your|send (us|me) your|reply with|verification code|one-time code/i);
        expect(text, n.kind).toContain(VAULT);
      }
    }
  });

  it("tells the owner what cancels, and a contact what they can and cannot do", () => {
    const wait = samples.find((s) => s.kind === "wait_opened")!;
    const owner = renderNotice(wait, "owner");
    expect(owner.body).toContain("Any signature with your vault, or one check-in, cancels it.");
    expect(owner.body).toContain("Open it yourself, from your own bookmark.");
    const contact = renderNotice(wait, "contacts");
    expect(contact.body).toContain("You cannot move or release anything");
    expect(contact.body).toContain("If you can reach the owner, tell them.");
    expect(contact.body).not.toContain("your vault");
  });

  it("states dates in UTC and names the vault the owner's way", () => {
    const m = renderNotice({ key: "k", kind: "deadline_ahead", audience: ["owner"], vault: VAULT, days: 14, at: 1_800_000_000n }, "owner", "savings");
    expect(m.subject).toBe("Lamport Heir: 14 days left to check in");
    expect(m.body).toContain(`vault "savings" (${VAULT}) runs out in 14 days, on 2027-01-15 08:00 UTC.`);
    expect(renderNotice(samples[1]!, "owner").subject).toBe("Lamport Heir: 1 day left to check in");
  });

  it("puts a plan change in the plan's own terms, with the date nothing can be released before", () => {
    const change = samples.find((s) => s.kind === "plan_changed")!;
    const m = renderNotice(change, "owner");
    expect(m.body).toContain("  - the waiting period changed from 60 days to 30 days");
    expect(m.body).toContain("Nothing can be released under it before");
    expect(m.body).toContain("If you did not make this change");
    expect(renderNotice(change, "contacts").body).toContain("If the owner did not mean to make this change, they need to know.");
  });
});
