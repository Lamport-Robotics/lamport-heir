/**
 * Where the browser keeps a vault's check-in key: IndexedDB, one entry per vault address.
 *
 * What is stored is a WebCrypto key pair whose private half was created non-extractable
 * (tools/src/checkin.ts): the browser will sign with it and will not give its bytes to anyone,
 * this page included. Losing the entry loses nothing but the convenience: the owner makes a new
 * key and names it in the plan with a vault signature.
 */
const DB = "lamport-heir";
const STORE = "checkin-keys";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("this browser gives the page no storage"));
  });
}

function run<T>(mode: IDBTransactionMode, f: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = f(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error("the browser's storage refused")); };
  }));
}

export function loadCheckinKey(vault: string): Promise<CryptoKeyPair | undefined> {
  return run<CryptoKeyPair | undefined>("readonly", (s) => s.get(vault));
}

export async function saveCheckinKey(vault: string, pair: CryptoKeyPair): Promise<void> {
  if (pair.privateKey.extractable) throw new Error("a check-in key must be non-extractable");
  await run("readwrite", (s) => s.put(pair, vault));
}

export async function forgetCheckinKey(vault: string): Promise<void> {
  await run("readwrite", (s) => s.delete(vault));
}
