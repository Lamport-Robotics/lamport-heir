/**
 * The heir's wallet, as the heirs' page uses it: it signs one sentence (the acceptance) and the
 * transactions of a claim. Wallet Standard, the same wallets the vault page lists.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getWallets } from "@wallet-standard/app";
import type { Wallet as StdWallet, WalletAccount } from "@wallet-standard/base";
import { CLUSTER } from "../../vendor/lamport-vault/web/src/common.ts";
import type { WalletSigner } from "../../tools/src/chain.ts";

const CHAIN = `solana:${CLUSTER}` as const;

export interface HeirWallet extends WalletSigner {
  name: string;
  /** signs `message`; `signed` is what the wallet actually signed, which may wrap the message in an envelope */
  signMessage(message: Uint8Array): Promise<{ signed: Uint8Array; signature: Uint8Array }>;
}

export function listWallets(): StdWallet[] {
  return getWallets().get().filter((w) => (w.chains as readonly string[]).includes(CHAIN) && "solana:signTransaction" in w.features);
}

export function onWalletsChange(cb: () => void) {
  const { on } = getWallets();
  on("register", cb); on("unregister", cb);
}

export async function connect(w: StdWallet): Promise<HeirWallet> {
  const feat = w.features as Record<string, any>;
  const res = await feat["standard:connect"].connect();
  const account: WalletAccount | undefined = (res.accounts as WalletAccount[]).find((a) => (a.chains as readonly string[]).includes(CHAIN)) ?? res.accounts[0];
  if (!account) throw new Error("the wallet returned no account");
  return {
    name: w.name,
    publicKey: new PublicKey(account.publicKey),
    async signMessage(message) {
      const f = feat["solana:signMessage"];
      if (!f) throw new Error(`${w.name} cannot sign a message. Use another wallet for this step.`);
      const [out] = await f.signMessage({ account, message });
      return { signed: Uint8Array.from(out.signedMessage), signature: Uint8Array.from(out.signature) };
    },
    async signTransaction(transaction) {
      const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      const [out] = await feat["solana:signTransaction"].signTransaction({ transaction: bytes, account, chain: CHAIN });
      return Transaction.from(out.signedTransaction);
    },
  };
}

/** a key kept in this tab, offered only on localhost: for trying the page against a local validator */
export function localTestWallet(): HeirWallet {
  const k = "lamport-heir-local-heir";
  const saved = sessionStorage.getItem(k);
  const kp = saved ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved))) : Keypair.generate();
  if (!saved) sessionStorage.setItem(k, JSON.stringify(Array.from(kp.secretKey)));
  return {
    name: "local test key",
    publicKey: kp.publicKey,
    async signMessage(message) { return { signed: message, signature: ed25519.sign(message, kp.secretKey.subarray(0, 32)) }; },
    async signTransaction(transaction) { transaction.partialSign(kp); return transaction; },
  };
}
