/**
 * Which reminders are due for a vault, decided from what the chain says and nothing else.
 *
 * This is a plain schedule: no model, no judgement, no memory beyond "this notice was already
 * sent". The chain already says when the deadline is. Given the same vault state and the same
 * clock, it always returns the same notices, each with a key that is sent at most once.
 *
 * Nothing here can act on a vault. The service that runs this reads accounts and sends messages;
 * it holds no key any program listens to, and it never opens a waiting period.
 */
import { type SuccessionState, successionStatus } from "@lamport-robotics/vault";
import { PublicKey } from "@solana/web3.js";

/** What the service saw at a vault's address. */
export type Snapshot = { kind: "open"; succession: SuccessionState } | { kind: "released"; heir: string; closedSlot: bigint };

export type Audience = "owner" | "contacts";

export type NoticeKind =
  /** the owner's window runs out in `days` */
  | "deadline_ahead"
  /** the window has run out; anyone may now open the waiting period */
  | "overdue"
  /** somebody opened the waiting period */
  | "wait_opened"
  /** the waiting period ends in `days` */
  | "release_ahead"
  /** the waiting period is over; anyone may release the vault now */
  | "releasable"
  /** the vault has been released */
  | "released"
  /** the plan was set, changed or cleared */
  | "plan_changed"
  /** check-ins stop counting in `days`: a full vault signature is due */
  | "signature_due"
  /** the owner's Pincer1 says its own switch fires in `days` unless someone touches the robot */
  | "robot_warning"
  /** the owner's Pincer1 says it has passed the robot's wallet to its heir */
  | "robot_released";

export interface Notice {
  /** Identifies this notice for good. The service sends each key once. */
  key: string;
  kind: NoticeKind;
  audience: Audience[];
  vault: string;
  /** days ahead, for the kinds that count down */
  days?: number;
  /** unix seconds: the deadline, the release time or the cap this notice is about */
  at?: bigint;
  /** for `plan_changed`: what is different, in words; and the soonest a release could now happen */
  changes?: string[];
  earliestRelease?: bigint;
  /** for `released`: where it went */
  heir?: string;
  /** for `robot_released`: the transaction the robot reported */
  signature?: string;
}

/** Days ahead of the deadline at which the owner is reminded; trusted contacts join at 7. */
export const DEADLINE_STAGES = [30, 14, 7, 1] as const;
export const CONTACTS_FROM_DAYS = 7;
/** Days ahead of the release at which everyone is reminded while a waiting period is open. */
export const RELEASE_STAGES = [14, 7, 3, 1] as const;
/** Days ahead of the check-in cap at which an owner who relies on check-ins is told to sign. */
export const SIGNATURE_STAGES = [30, 7] as const;

/** The most urgent stage that has been reached: the smallest `d` with `now >= at - d days`, while `now < at`. */
function stageReached(stages: readonly number[], at: bigint, now: bigint, daySecs: bigint): number | undefined {
  if (now >= at) return undefined;
  let reached: number | undefined;
  for (const d of stages) {
    if (now >= at - BigInt(d) * daySecs && (reached === undefined || d < reached)) reached = d;
  }
  return reached;
}

const isDefault = (k: PublicKey) => k.equals(PublicKey.default);

function durationWords(secs: bigint, daySecs: bigint): string {
  const days = secs / daySecs;
  return `${days} day${days === 1n ? "" : "s"}`;
}

/** What differs between two plans, in words. Empty when nothing a release depends on changed. */
export function planChanges(before: SuccessionState, after: SuccessionState, daySecs: bigint): string[] {
  const out: string[] = [];
  const wasArmed = !isDefault(before.claim);
  const armed = !isDefault(after.claim);
  if (!wasArmed && armed) out.push(`a succession plan was set: the vault now releases to ${after.claim.toBase58()}`);
  else if (wasArmed && !armed) return ["the succession plan was cleared: the vault no longer releases to anyone"];
  else if (!before.claim.equals(after.claim)) out.push(`the address the vault releases to changed from ${before.claim.toBase58()} to ${after.claim.toBase58()}`);
  if (!armed) return out;
  if (before.windowSecs !== after.windowSecs) out.push(wasArmed ? `the inactivity window changed from ${durationWords(before.windowSecs, daySecs)} to ${durationWords(after.windowSecs, daySecs)}` : `the inactivity window is ${durationWords(after.windowSecs, daySecs)}`);
  if (before.waitSecs !== after.waitSecs) out.push(wasArmed ? `the waiting period changed from ${durationWords(before.waitSecs, daySecs)} to ${durationWords(after.waitSecs, daySecs)}` : `the waiting period is ${durationWords(after.waitSecs, daySecs)}`);
  if (!before.checkinKey.equals(after.checkinKey)) out.push(isDefault(after.checkinKey) ? "the check-in key was removed" : wasArmed && !isDefault(before.checkinKey) ? "the check-in key was replaced" : "a check-in key was set");
  if (!before.contactKey.equals(after.contactKey)) out.push(isDefault(after.contactKey) ? "the trusted contact's key was removed" : wasArmed && !isDefault(before.contactKey) ? "the trusted contact's key was replaced" : "a trusted contact's key was set");
  return out;
}

/**
 * The notices that are due for `vault` at `now` (the cluster's clock), given what is at its address
 * and, when known, what was there at the last look. The caller sends those whose key it has not
 * sent before.
 *
 * Only the most urgent stage of a countdown is returned: a service that was down for three weeks
 * sends the 7-day reminder, not 30, 14 and 7 at once.
 */
export function noticesDue(input: { vault: string; now: bigint; snapshot: Snapshot; previous?: Snapshot | undefined; daySecs?: bigint }): Notice[] {
  const { vault, now, snapshot, previous } = input;
  const daySecs = input.daySecs ?? 86_400n;
  const everyone: Audience[] = ["owner", "contacts"];
  const out: Notice[] = [];

  if (snapshot.kind === "released") {
    out.push({ key: `${vault}:released:${snapshot.closedSlot}`, kind: "released", audience: everyone, vault, heir: snapshot.heir });
    return out;
  }
  const s = snapshot.succession;
  const status = successionStatus(s, now, { daySecs });

  // A change of plan is announced to everyone, contacts included, whoever made it: it is the alarm
  // for a change the owner was pushed into. Nothing it sets can release before `earliestRelease`.
  if (previous?.kind === "open") {
    const changes = planChanges(previous.succession, s, daySecs);
    if (changes.length > 0) {
      const id = [s.claim.toBase58(), s.windowSecs, s.waitSecs, s.checkinKey.toBase58(), s.contactKey.toBase58(), s.lastSignedTs].join("/");
      out.push({ key: `${vault}:plan:${id}`, kind: "plan_changed", audience: everyone, vault, changes, ...(status.earliestRelease !== undefined ? { earliestRelease: status.earliestRelease } : {}) });
    }
  }
  if (status.phase === "unarmed") return out;

  const deadline = status.deadline!;
  if (status.phase === "quiet") {
    const days = stageReached(DEADLINE_STAGES, deadline, now, daySecs);
    if (days !== undefined) {
      out.push({ key: `${vault}:deadline:${deadline}:${days}`, kind: "deadline_ahead", audience: days <= CONTACTS_FROM_DAYS ? everyone : ["owner"], vault, days, at: deadline });
    }
    // An owner who has been checking in instead of signing: check-ins stop counting at the cap.
    const cap = status.checkinCountsUntil!;
    if (s.lastCheckinTs > s.lastSignedTs && !isDefault(s.checkinKey)) {
      const capDays = stageReached(SIGNATURE_STAGES, cap, now, daySecs);
      if (capDays !== undefined) out.push({ key: `${vault}:signature:${cap}:${capDays}`, kind: "signature_due", audience: ["owner"], vault, days: capDays, at: cap });
    }
  } else if (status.phase === "overdue") {
    out.push({ key: `${vault}:overdue:${deadline}`, kind: "overdue", audience: everyone, vault, at: deadline });
  } else {
    const releaseAt = status.releaseAt!;
    out.push({ key: `${vault}:wait:${s.waitStartedTs}`, kind: "wait_opened", audience: everyone, vault, at: releaseAt });
    if (status.phase === "waiting") {
      const days = stageReached(RELEASE_STAGES, releaseAt, now, daySecs);
      if (days !== undefined) out.push({ key: `${vault}:release:${s.waitStartedTs}:${days}`, kind: "release_ahead", audience: everyone, vault, days, at: releaseAt });
    } else {
      out.push({ key: `${vault}:releasable:${s.waitStartedTs}`, kind: "releasable", audience: everyone, vault, at: releaseAt });
    }
  }
  return out;
}
