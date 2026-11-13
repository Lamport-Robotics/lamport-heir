import { emptySuccession, encodeTombstone, encodeVault, type SuccessionState, TOMBSTONE_ACCOUNT_VERSION } from "@lamport-robotics/vault";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { checkin, checkinCounts, checkinSignerFrom, generateCheckinKey } from "../src/checkin.ts";
import { PROGRAMS } from "../src/programs.ts";
import { FakeChain } from "./fake-chain.ts";

const DAY = 86_400n;
const T0 = 1_800_000_000n;
const pk = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const vault = pk(0x11);
const H5 = Uint8Array.from([0, 0, 0, 5, 0, 0, 0, 3, ...new Uint8Array(48).fill(0xab)]);
const vaultData = (s: SuccessionState) => encodeVault({ version: 3, bump: 255, vaultId: new Uint8Array(32).fill(1), lmsPubkey: H5, spent: 0, generation: 0, createdSlot: 1n, succession: s, used: new Uint8Array(4), usedKeys: [] });
const armed = (checkinKey: PublicKey, over: Partial<SuccessionState> = {}): SuccessionState => ({ ...emptySuccession(), claim: pk(0x22), windowSecs: 365n * DAY, waitSecs: 60n * DAY, lastSignedTs: T0, checkinKey, ...over });

describe("the check-in key", () => {
  it("cannot be read out, by anything", async () => {
    const key = await generateCheckinKey();
    expect(key.handle.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", key.handle.privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", key.handle.privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("raw", key.handle.privateKey)).rejects.toThrow();
    // the object a caller gets has a public key and a way to sign, and nothing else of the key
    expect(Object.keys(key).sort()).toEqual(["handle", "publicKey", "sign"]);
    expect(JSON.stringify(key)).not.toMatch(/"d"\s*:/);
  });

  it("signs what Solana verifies: an ordinary transaction signature", async () => {
    const key = await generateCheckinKey();
    const tx = new Transaction({ feePayer: key.publicKey, blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 1 }).add(SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: pk(9), lamports: 1 }));
    tx.addSignature(key.publicKey, Buffer.from(await key.sign(tx.serializeMessage())));
    expect(tx.verifySignatures()).toBe(true);
    // another key's signature does not verify as this one's
    const other = await generateCheckinKey();
    const forged = new Transaction({ feePayer: key.publicKey, blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 1 }).add(SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: pk(9), lamports: 1 }));
    forged.addSignature(key.publicKey, Buffer.from(await other.sign(forged.serializeMessage())));
    expect(forged.verifySignatures()).toBe(false);
  });

  it("is refused if somebody made it extractable", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    await expect(checkinSignerFrom(pair)).rejects.toThrow(/non-extractable/);
  });
});

describe("a check-in", () => {
  it("counts only for the vault's own check-in key, with a plan, inside the two-year cap", () => {
    const key = pk(0x33);
    expect(checkinCounts(armed(key), key, T0 + 100n * DAY, PROGRAMS)).toEqual({ ok: true, countsUntil: T0 + 730n * DAY });
    expect(checkinCounts(armed(key), key, T0 + 730n * DAY, PROGRAMS).ok).toBe(true);
    expect(checkinCounts(armed(key), key, T0 + 730n * DAY + 1n, PROGRAMS)).toMatchObject({ ok: false, reason: "past_cap" });
    expect(checkinCounts(armed(key), pk(0x34), T0, PROGRAMS)).toMatchObject({ ok: false, reason: "not_the_check_in_key" });
    expect(checkinCounts(armed(PublicKey.default), PublicKey.default, T0, PROGRAMS)).toMatchObject({ ok: false, reason: "not_the_check_in_key" });
    expect(checkinCounts(emptySuccession(), key, T0, PROGRAMS)).toMatchObject({ ok: false, reason: "no_plan" });
  });

  it("is refused in words, before any fee, when it would not count or cannot be paid for", async () => {
    const key = await generateCheckinKey();
    const chain = new FakeChain();
    chain.now = T0 + 10n * DAY;

    chain.put(vault, PROGRAMS.vault, vaultData(armed(key.publicKey)));
    expect(await checkin(chain, key, vault)).toMatchObject({ sent: false, readiness: { reason: "needs_fee" } });

    chain.put(key.publicKey, SystemProgram.programId, new Uint8Array(0), 1_000_000);
    chain.put(vault, PROGRAMS.vault, vaultData(armed(pk(0x35))));
    expect(await checkin(chain, key, vault)).toMatchObject({ sent: false, readiness: { reason: "not_the_check_in_key" } });

    chain.put(vault, PROGRAMS.vault, vaultData(armed(key.publicKey)));
    chain.now = T0 + 731n * DAY;
    const late = await checkin(chain, key, vault);
    expect(late).toMatchObject({ sent: false, readiness: { reason: "past_cap" } });
    expect(late.sent === false && late.readiness.ok === false && late.readiness.detail).toMatch(/one is due now/);

    chain.put(vault, PROGRAMS.vault, encodeTombstone({ version: TOMBSTONE_ACCOUNT_VERSION, vaultId: new Uint8Array(32), closedSlot: 1n, heir: pk(0x22) }));
    expect(await checkin(chain, key, vault)).toMatchObject({ sent: false, readiness: { reason: "released" } });
    expect(chain.sends).toBe(0);
  });

  it("when it would count, sends one transaction: one instruction, signed and paid by the check-in key alone", async () => {
    const key = await generateCheckinKey();
    const chain = new FakeChain();
    chain.now = T0 + 10n * DAY;
    chain.put(vault, PROGRAMS.vault, vaultData(armed(key.publicKey)));
    chain.put(key.publicKey, SystemProgram.programId, new Uint8Array(0), 1_000_000);
    let raw: Uint8Array | undefined;
    chain.sendRawTransaction = async (bytes: Buffer | Uint8Array | number[]) => {
      raw = Uint8Array.from(bytes);
      return "signature";
    };
    expect(await checkin(chain, key, vault)).toEqual({ sent: true, signature: "signature", countsUntil: T0 + 730n * DAY });
    const tx = Transaction.from(raw!);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer!.equals(key.publicKey)).toBe(true);
    expect(tx.signatures.map((s) => s.publicKey.toBase58())).toEqual([key.publicKey.toBase58()]);
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0]!.programId.equals(PROGRAMS.vault)).toBe(true);
    expect(tx.instructions[0]!.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [vault.toBase58(), false, true],
      [key.publicKey.toBase58(), true, true], // writable only because it pays the fee
    ]);
  });
});
