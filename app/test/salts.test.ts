/**
 * Where the owner's browser keeps the salts of heirs kept private (app/src/salts.ts): what it does
 * with storage that fails, and with storage that is not as it left it. Every key here is generated
 * for the test.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { keptSalt, keptSalts, markAccepted, markWritten, saltFor } from "../src/salts.ts";

class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; } setItem(k: string, v: string) { this.m.set(k, String(v)); } removeItem(k: string) { this.m.delete(k); } }
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (vault: PublicKey) => `lamport-heir-salts:${vault.toBase58()}`;
let store: Mem;
beforeEach(() => { store = new Mem(); vi.stubGlobal("localStorage", store); });

describe("the salts a browser keeps", () => {
  it("are one per vault and heir, kept before they are returned, and marked only by what was done with that very salt", () => {
    const v1 = Keypair.generate().publicKey, v2 = Keypair.generate().publicKey, h = Keypair.generate().publicKey, plan = Keypair.generate().publicKey;
    const s1 = saltFor(v1, h);
    expect(s1.made).toBe(true);
    expect(s1.salt).toHaveLength(32);
    expect(saltFor(v1, h)).toMatchObject({ made: false });
    expect(hex(saltFor(v1, h).salt)).toBe(hex(s1.salt));
    expect(keptSalt(v1, h)).toMatchObject({ written: false });
    expect(keptSalt(v1, h)!.acceptedFor).toBeUndefined();
    expect(keptSalt(v2, h)).toBeNull();
    markWritten(v1, h);
    expect(keptSalt(v1, h)!.written).toBe(true);
    markAccepted(v1, h, plan);
    expect(keptSalt(v1, h)).toMatchObject({ written: true, acceptedFor: plan.toBase58() });
    expect(hex(keptSalt(v1, h)!.salt)).toBe(hex(s1.salt));
    // the same heir in another vault is another salt, unwritten and unaccepted
    expect(hex(saltFor(v2, h).salt)).not.toBe(hex(s1.salt));
    expect(keptSalt(v2, h)).toMatchObject({ written: false });
    expect(keptSalts(v1).map((k) => k.heir.toBase58())).toEqual([h.toBase58()]);
  });

  it("are not made in a store that throws or that drops what it is given", () => {
    const v = Keypair.generate().publicKey, h = Keypair.generate().publicKey;
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } });
    expect(() => saltFor(v, h)).toThrow(/will not store anything for this page/);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    expect(() => saltFor(v, h)).toThrow(/will not store anything for this page/);
    vi.stubGlobal("localStorage", undefined);
    expect(() => saltFor(v, h)).toThrow(/will not store anything for this page/);
  });

  it("cannot be marked once they are gone: there is nothing to have written down, or to have accepted", () => {
    const v = Keypair.generate().publicKey, h = Keypair.generate().publicKey;
    saltFor(v, h);
    store.removeItem(key(v));
    expect(() => markWritten(v, h, "first heir")).toThrow(/no longer holds the salt of the first heir/);
    expect(() => markAccepted(v, h, Keypair.generate().publicKey, "first heir")).toThrow(/no longer holds the salt of the first heir/);
    expect(keptSalt(v, h)).toBeNull();
    expect(store.getItem(key(v))).toBeNull(); // and marking wrote nothing in their place
    expect(() => markWritten(Keypair.generate().publicKey, h)).toThrow(/no longer holds/); // nor for a vault that never had one
  });

  it("are never written over when an entry cannot be read: it may be the only copy of a salt in a plan", () => {
    const v = Keypair.generate().publicKey, h = Keypair.generate().publicKey;
    const armed = saltFor(v, h).salt; markWritten(v, h);
    const good = JSON.parse(store.getItem(key(v))!)[h.toBase58()] as { salt: string; written: boolean };
    const damaged: unknown[] = [{ ...good, salt: good.salt.toUpperCase() }, { salt: good.salt }, { ...good, written: "true" }, { ...good, salt: `${good.salt} ` }, { ...good, acceptedFor: 7 }, "a string", null];
    for (const entry of damaged) {
      const stored = JSON.stringify({ [h.toBase58()]: entry });
      store.setItem(key(v), stored);
      expect(keptSalt(v, h), stored).toBeNull();
      expect(() => saltFor(v, h), stored).toThrow(/cannot be read: something changed it\. Nothing was written over it/);
      expect(() => markWritten(v, h), stored).toThrow(/cannot be read/);
      expect(store.getItem(key(v))).toBe(stored); // untouched, the old salt's digits still in it where they were
    }
    void armed;
  });

  it("are never written over when the vault's whole record cannot be read, whichever heir is asked for", () => {
    const v = Keypair.generate().publicKey, a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
    saltFor(v, a); markWritten(v, a);
    const good = store.getItem(key(v))!;
    for (const bad of [good.slice(0, -1), `[${good}]`, "null", `"x"`, "7"]) {
      store.setItem(key(v), bad);
      expect(keptSalts(v)).toEqual([]);
      expect(() => saltFor(v, b), bad).toThrow(/cannot be read/);
      expect(store.getItem(key(v))).toBe(bad);
    }
  });

  it("leave every other entry as it was when one is written, read or not", () => {
    const v = Keypair.generate().publicKey, a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
    const sa = saltFor(v, a).salt;
    // an entry of a later version of this page, which this one does not understand, beside a good one
    const all = JSON.parse(store.getItem(key(v))!);
    store.setItem(key(v), JSON.stringify({ ...all, somethingElse: { v: 2, note: "kept" } }));
    saltFor(v, b); markWritten(v, b);
    const after = JSON.parse(store.getItem(key(v))!);
    expect(after.somethingElse).toEqual({ v: 2, note: "kept" });
    expect(after[a.toBase58()].salt).toBe(hex(sa));
    expect(keptSalts(v).map((k) => k.heir.toBase58()).sort()).toEqual([a.toBase58(), b.toBase58()].sort());
  });
});
