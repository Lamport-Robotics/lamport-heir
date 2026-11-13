/**
 * The reminder service's store, as one encrypted file.
 *
 * Everything the service remembers is in it: who asked to be reminded about which vault and how to
 * reach them and their trusted contacts, what each vault looked like at the last look, and which
 * notices are waiting or were sent. The whole file is encrypted with AES-256-GCM under a key that
 * is given to the process and never written next to the file, so the disk, a backup or a stolen
 * copy holds no contact details and no list of vaults. It holds no balances and no keys in any
 * case: the service never has any.
 *
 * Small on purpose. One process, one file, rewritten whole and atomically on every change. A
 * service with many thousands of subscriptions would want a database behind the same `Store`
 * interface.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { type Snapshot } from "./schedule.ts";
import { type Delivery, type Store, type Subscription } from "./service.ts";

const MAGIC = Buffer.from("LHS1");

interface State {
  subscriptions: Subscription[];
  snapshots: Record<string, Snapshot>;
  queued: Record<string, Delivery>;
  history: Record<string, "" | "sent" | "expired">;
}

// JSON has no bigint, no bytes and no public keys: each is written as a one-key object.
function replacer(this: unknown, key: string, value: unknown): unknown {
  const raw = (this as Record<string, unknown>)[key];
  if (typeof raw === "bigint") return { $n: raw.toString() };
  // by shape, not `instanceof`: a key decoded by the vault SDK comes from that package's own copy of web3.js
  if (typeof raw === "object" && raw !== null && typeof (raw as PublicKey).toBase58 === "function" && typeof (raw as PublicKey).toBytes === "function") {
    return { $k: (raw as PublicKey).toBase58() };
  }
  if (raw instanceof Uint8Array) return { $b: Buffer.from(raw).toString("hex") };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    const keys = Object.keys(v);
    if (keys.length === 1) {
      if (typeof v.$n === "string") return BigInt(v.$n);
      if (typeof v.$k === "string") return new PublicKey(v.$k);
      if (typeof v.$b === "string") return Uint8Array.from(Buffer.from(v.$b, "hex"));
    }
  }
  return value;
}

/** Parses a store key: 64 hex digits, 32 bytes. */
export function storeKey(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) throw new Error("the store key must be 64 hex digits (32 random bytes)");
  return Buffer.from(hex.trim(), "hex");
}

export class FileStore implements Store {
  private readonly path: string;
  private readonly key: Buffer;
  private state: State;

  private constructor(path: string, key: Buffer, state: State) {
    this.path = path;
    this.key = key;
    this.state = state;
  }

  /** Opens the store at `path`, or starts an empty one. A wrong key or a damaged file is an error, never an empty store. */
  static open(path: string, key: Buffer): FileStore {
    if (key.length !== 32) throw new Error("the store key must be 32 bytes");
    if (!existsSync(path)) return new FileStore(path, key, { subscriptions: [], snapshots: {}, queued: {}, history: {} });
    const file = readFileSync(path);
    if (file.length < MAGIC.length + 12 + 16 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${path} is not a reminder store`);
    const nonce = file.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = file.subarray(file.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(file.subarray(MAGIC.length + 12, file.length - 16)), decipher.final()]);
    } catch {
      throw new Error(`${path} could not be opened: the key is wrong or the file has been changed`);
    }
    return new FileStore(path, key, JSON.parse(plain.toString("utf8"), reviver) as State);
  }

  private save(): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(MAGIC);
    const body = Buffer.concat([cipher.update(JSON.stringify(this.state, replacer), "utf8"), cipher.final()]);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()]), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Adds a subscription, or replaces the one for the same vault. */
  subscribe(sub: Subscription): void {
    new PublicKey(sub.vault); // throws on anything that is not an address
    this.state.subscriptions = [...this.state.subscriptions.filter((s) => s.vault !== sub.vault), sub];
    this.save();
  }

  /** Removes a vault's subscription and what was remembered about it. Notices already sent stay recorded as sent. */
  unsubscribe(vault: string): void {
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.vault !== vault);
    delete this.state.snapshots[vault];
    for (const [id, d] of Object.entries(this.state.queued)) if (d.notice.vault === vault) delete this.state.queued[id];
    this.save();
  }

  async subscriptions(): Promise<Subscription[]> {
    return this.state.subscriptions;
  }
  async snapshot(vault: string): Promise<Snapshot | undefined> {
    return this.state.snapshots[vault];
  }
  async record(vault: string, snapshot: Snapshot, deliveries: Delivery[]): Promise<void> {
    this.state.snapshots[vault] = snapshot;
    for (const d of deliveries) {
      if (d.id in this.state.history) continue;
      this.state.history[d.id] = "";
      this.state.queued[d.id] = d;
    }
    this.save();
  }
  async outbox(): Promise<Delivery[]> {
    return Object.values(this.state.queued);
  }
  async done(id: string, outcome: "sent" | "expired"): Promise<void> {
    delete this.state.queued[id];
    this.state.history[id] = outcome;
    this.save();
  }
}
