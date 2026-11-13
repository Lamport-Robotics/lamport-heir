/**
 * The reminder service: looks at each subscribed vault, works out which notices are due
 * (`schedule.ts`), and sends them.
 *
 * It reads the chain and sends messages. It holds no key any program listens to, so it cannot
 * move funds, open a waiting period, or change a clock; the worst a break-in here can do is send
 * or withhold reminders. It learns nothing about balances and stores none.
 *
 * Notices go through an outbox. What is due is written down first, together with the vault's new
 * snapshot, and delivered afterwards, recipient by recipient. A channel that fails is tried again
 * on the next tick without anyone else getting the message twice, and a notice that exists only
 * because something changed (a plan change) is not lost when its first delivery fails.
 */
import { decodeSuccessionBlock, decodeTombstone, isLiveVault, isTombstone, SUCCESSION_BLOCK_OFFSET, SUCCESSION_BLOCK_SIZE } from "@lamport-robotics/vault";
import { PublicKey } from "@solana/web3.js";
import { type Chain, clusterTime, COMMITMENT } from "../chain.ts";
import { programsForVaultProgram } from "../programs.ts";
import { type Message, renderNotice } from "./messages.ts";
import { type Audience, type Notice, noticesDue, type Snapshot } from "./schedule.ts";

export type ChannelKind = "email" | "push";

/** Where one person gets their reminders. Stored encrypted. */
export interface Recipient {
  channel: ChannelKind;
  /** an email address, or a push subscription */
  to: string;
}

/** One vault somebody asked to be reminded about. */
export interface Subscription {
  vault: string;
  /** the owner's own name for the vault, used in messages */
  label?: string;
  owner: Recipient[];
  /** trusted contacts: people the heirs do not control */
  contacts: Recipient[];
}

/** A notice waiting to reach one recipient. */
export interface Delivery {
  /** notice key + audience + recipient: sent at most once */
  id: string;
  notice: Notice;
  audience: Audience;
  recipient: Recipient;
  label?: string;
  /** unix seconds (cluster clock) when it was queued */
  queuedAt: bigint;
}

export interface Store {
  subscriptions(): Promise<Subscription[]>;
  snapshot(vault: string): Promise<Snapshot | undefined>;
  /** Records a vault's new snapshot and queues deliveries in one step. Deliveries whose id was ever queued are ignored. */
  record(vault: string, snapshot: Snapshot, deliveries: Delivery[]): Promise<void>;
  /** Deliveries queued and not yet marked done. */
  outbox(): Promise<Delivery[]>;
  done(id: string, outcome: "sent" | "expired"): Promise<void>;
}

export interface Channel {
  send(to: string, message: Message): Promise<void>;
}

export interface TickReport {
  vaultsRead: number;
  queued: number;
  sent: number;
  failed: { id: string; error: string }[];
  expired: number;
  /** vaults that could not be read this time, and why */
  unread: { vault: string; error: string }[];
}

/** A delivery nobody could be reached for is dropped after this long: 14 days. */
const GIVE_UP_AFTER_DAYS = 14n;

/** What is at a vault's address, as the schedule wants it. Throws for anything that is not a Heir vault. */
export async function readSnapshot(chain: Chain, vault: PublicKey): Promise<{ snapshot: Snapshot; daySecs: bigint }> {
  const info = await chain.getAccountInfo(vault, COMMITMENT);
  if (!info) throw new Error("there is no account at this address");
  const programs = programsForVaultProgram(info.owner);
  if (!programs) throw new Error("this is not an account of a Heir-enabled vault program");
  const data = new Uint8Array(info.data);
  if (isTombstone(data)) {
    const t = decodeTombstone(data);
    return { snapshot: { kind: "released", heir: t.heir.toBase58(), closedSlot: t.closedSlot }, daySecs: programs.daySecs };
  }
  if (!isLiveVault(data) || data.length < SUCCESSION_BLOCK_OFFSET + SUCCESSION_BLOCK_SIZE) throw new Error("this account is neither a vault with a succession block nor a tombstone");
  return { snapshot: { kind: "open", succession: decodeSuccessionBlock(data.subarray(SUCCESSION_BLOCK_OFFSET, SUCCESSION_BLOCK_OFFSET + SUCCESSION_BLOCK_SIZE)) }, daySecs: programs.daySecs };
}

export class ReminderService {
  private readonly chain: Chain;
  private readonly store: Store;
  private readonly channels: Partial<Record<ChannelKind, Channel>>;

  constructor(chain: Chain, store: Store, channels: Partial<Record<ChannelKind, Channel>>) {
    this.chain = chain;
    this.store = store;
    this.channels = channels;
  }

  /** One round: read every subscribed vault, queue what is newly due, then work through the outbox. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { vaultsRead: 0, queued: 0, sent: 0, failed: [], expired: 0, unread: [] };
    const now = await clusterTime(this.chain);

    for (const sub of await this.store.subscriptions()) {
      try {
        const { snapshot, daySecs } = await readSnapshot(this.chain, new PublicKey(sub.vault));
        report.vaultsRead += 1;
        const previous = await this.store.snapshot(sub.vault);
        const deliveries: Delivery[] = [];
        for (const notice of noticesDue({ vault: sub.vault, now, snapshot, previous, daySecs })) {
          for (const audience of notice.audience) {
            for (const recipient of audience === "owner" ? sub.owner : sub.contacts) {
              deliveries.push({ id: `${notice.key}|${audience}|${recipient.channel}:${recipient.to}`, notice, audience, recipient, ...(sub.label ? { label: sub.label } : {}), queuedAt: now });
            }
          }
        }
        const before = (await this.store.outbox()).length;
        await this.store.record(sub.vault, snapshot, deliveries);
        report.queued += Math.max(0, (await this.store.outbox()).length - before);
      } catch (e) {
        // one vault that cannot be read must not stop the others from being reminded
        report.unread.push({ vault: sub.vault, error: (e as Error).message });
      }
    }

    for (const d of await this.store.outbox()) {
      if (now - d.queuedAt > GIVE_UP_AFTER_DAYS * 86_400n) {
        await this.store.done(d.id, "expired");
        report.expired += 1;
        continue;
      }
      const channel = this.channels[d.recipient.channel];
      if (!channel) {
        report.failed.push({ id: d.id, error: `no ${d.recipient.channel} channel is configured` });
        continue;
      }
      try {
        await channel.send(d.recipient.to, renderNotice(d.notice, d.audience, d.label));
        await this.store.done(d.id, "sent");
        report.sent += 1;
      } catch (e) {
        report.failed.push({ id: d.id, error: (e as Error).message });
      }
    }
    return report;
  }
}

/** A store that lives in memory: for tests, and the reference for what a real store must do. */
export class MemoryStore implements Store {
  readonly subs: Subscription[] = [];
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly queued = new Map<string, Delivery>();
  /** every delivery id ever queued, with how it ended ("" while still waiting) */
  readonly history = new Map<string, "" | "sent" | "expired">();

  async subscriptions(): Promise<Subscription[]> {
    return this.subs;
  }
  async snapshot(vault: string): Promise<Snapshot | undefined> {
    return this.snapshots.get(vault);
  }
  async record(vault: string, snapshot: Snapshot, deliveries: Delivery[]): Promise<void> {
    this.snapshots.set(vault, snapshot);
    for (const d of deliveries) {
      if (this.history.has(d.id)) continue;
      this.history.set(d.id, "");
      this.queued.set(d.id, d);
    }
  }
  async outbox(): Promise<Delivery[]> {
    return [...this.queued.values()];
  }
  async done(id: string, outcome: "sent" | "expired"): Promise<void> {
    this.queued.delete(id);
    this.history.set(id, outcome);
  }
}
