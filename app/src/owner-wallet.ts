/**
 * A signed message from the wallet the owner connected to the vault page.
 *
 * The vault page's own wallet object sends transactions and nothing else, because the vault needs
 * nothing else. A family letter is signed, not sent, so this asks the same wallet for a message
 * signature through the Wallet Standard, without changing the vault's code.
 *
 * Page only. Nothing here runs when the module loads.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getWallets } from "@wallet-standard/app";
import type { WalletAccount } from "@wallet-standard/base";
import type { Wallet } from "../../vendor/lamport-vault/web/src/wallet.ts";
import type { SignMessage } from "../../tools/src/letter.ts";

/** where the vault page keeps its test wallet on localhost (vendor/lamport-vault/web/src/wallet.ts) */
const LOCAL_PAYER = "lamport-vault-local-payer";

export function ownerSigner(wallet: Wallet): SignMessage {
  return async (message) => {
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (local && wallet.name === "local test key") {
      const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(sessionStorage.getItem(LOCAL_PAYER) ?? "[]")));
      if (!key.publicKey.equals(wallet.pubkey)) throw new Error("The local test key changed under this page. Reload it.");
      return { signed: message, signature: ed25519.sign(message, key.secretKey.subarray(0, 32)) };
    }
    const standard = getWallets().get().find((w) => w.name === wallet.name);
    const features = standard?.features as Record<string, any> | undefined;
    if (!features?.["solana:signMessage"]) throw new Error(`${wallet.name} cannot sign a message, which is how a letter is signed. Connect another wallet for this step.`);
    // the wallet is connected already: this asks it for the same account again, and it does not prompt
    const res = await features["standard:connect"].connect({ silent: true });
    const account = ((res.accounts ?? []) as WalletAccount[]).find((a) => new PublicKey(a.publicKey).equals(wallet.pubkey));
    if (!account) throw new Error("The wallet no longer offers the account that is connected here. Reconnect it and try again.");
    const [out] = await features["solana:signMessage"].signMessage({ account, message });
    return { signed: Uint8Array.from(out.signedMessage), signature: Uint8Array.from(out.signature) };
  };
}
