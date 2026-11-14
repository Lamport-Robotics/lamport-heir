/**
 * The heirs' page, under "Family letter".
 *
 *   claim.html#letter=<plan>&from=<wallet>   the owner asked for a reading key: make one
 *   claim.html#letter                        read a letter you were given
 *
 * A letter is opened here, in the browser, and goes nowhere. Before any of it is believed the page
 * checks that the wallet it names as its writer signed it, and the heir's wallet makes a reading
 * key that fits that writer's letters only (tools/src/letter.ts): what somebody else wrote does
 * not open, whoever they say they are.
 *
 * Page only. Nothing here runs when the module loads.
 */
import { PublicKey } from "@solana/web3.js";
import { copy, el, isPubkey } from "../../vendor/lamport-vault/web/src/common.ts";
import { letterKeyMessage, makeReadingKey, readLetter, readLetterFile, type ReceivedLetter } from "../../tools/src/letter.ts";
import type { HeirWallet } from "./heir-wallet.ts";

export interface LetterEnv {
  wallet: HeirWallet | null;
  /** opens the page's wallet chooser; the page draws this view again once a wallet is connected */
  pickWallet: () => void;
}

/** what the owner's link asks for: a reading key for the letters `writer` writes under `plan`. null when the link says nothing of the kind */
export function readInvitation(arg: string): { plan: PublicKey; writer: PublicKey } | null {
  const m = /^=([1-9A-HJ-NP-Za-km-z]{32,44})&from=([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(arg);
  if (!m || !isPubkey(m[1]!) || !isPubkey(m[2]!)) return null;
  return { plan: new PublicKey(m[1]!), writer: new PublicKey(m[2]!) };
}

const NEVER = "A family letter never asks you for money, a key or a seed phrase. If one does, it is not what it seems.";
/** a letter pasted or chosen stays while the page draws the view again for a wallet that was just connected; it is never stored */
let pending = "";

function keyPanel(env: LetterEnv, plan: PublicKey, writer: PublicKey): HTMLElement {
  const sentence = letterKeyMessage(plan, writer);
  const panel = el("div", { class: "panel", id: "lkpanel" }, el("div", { class: "eyebrow" }, "Make your reading key"),
    el("dl", { class: "spec" }, el("dt", {}, "Plan"), el("dd", {}, plan.toBase58()), el("dt", {}, "Letters written by"), el("dd", {}, writer.toBase58())),
    el("p", { class: "quiet" }, "The vault's owner wants to write you a letter that only you can read. For that they need a key of yours. Your wallet makes it by signing a sentence: nothing moves, and nothing is paid."),
    el("div", { class: "notice warn" }, "Do this only if the owner themselves sent you this link. Whoever gets your key can write you letters that this page will show as written by the wallet above."),
    el("p", { class: "quiet" }, "Your wallet will ask three times: twice for the sentence below, to see that it makes the same key every time, and once to tell the owner which key is yours. The signature of this sentence is the key itself, so sign it on this page only:"),
    el("div", { class: "notice mono", style: "font-size:12.5px;overflow-wrap:anywhere" }, sentence));
  if (!env.wallet) {
    const b = el("button", { class: "btn primary" }, "Connect your wallet");
    b.addEventListener("click", env.pickWallet);
    panel.append(el("div", { class: "actions" }, b));
    return panel;
  }
  const wallet = env.wallet;
  const make = el("button", { class: "btn primary", id: "lkmake" }, "Make my reading key");
  const out = el("div", { id: "lkout" }), err = el("div", { class: "err hidden", id: "lkerr" });
  panel.append(el("div", { class: "actions" }, make), err, out);
  make.addEventListener("click", async () => {
    err.classList.add("hidden"); make.setAttribute("disabled", "");
    try {
      const { line } = await makeReadingKey((message) => wallet.signMessage(message), wallet.publicKey, plan, writer);
      const box = el("textarea", { class: "mono", id: "lkline", rows: "5", readonly: "" }); box.value = line;
      const cp = el("button", { class: "link" }, "Copy");
      cp.addEventListener("click", (e) => void copy(line, e.currentTarget as HTMLButtonElement));
      out.replaceChildren(el("label", { class: "field", style: "margin-top:18px" }, el("span", {}, "Send this back to the owner"), box), el("div", { class: "actions" }, cp),
        el("p", { class: "quiet", style: "margin-top:14px" }, "This line is not a secret: it holds the half of your key that others may know. This page has kept nothing. When a letter reaches you, the same wallet, on the same account, makes the key again."));
    } catch (e) { err.textContent = String((e as Error).message ?? e); err.classList.remove("hidden"); }
    finally { make.removeAttribute("disabled"); }
  });
  return panel;
}

function readPanel(env: LetterEnv): HTMLElement {
  const file = el("input", { type: "file", id: "lfilein", accept: ".json,application/json,text/plain" });
  const paste = el("textarea", { class: "mono", id: "lpaste", rows: "4", spellcheck: "false" });
  paste.value = pending;
  const check = el("button", { class: "btn", id: "lcheck" }, "Check the letter");
  const err = el("div", { class: "err hidden", id: "lrerr" }), info = el("div", { id: "linfo" });
  const panel = el("div", { class: "panel", id: "lrpanel" }, el("div", { class: "eyebrow" }, "Read a letter"),
    el("p", { class: "quiet" }, "Choose the file the owner gave you, or paste its text. It is opened here, in your browser, and sent nowhere."),
    el("label", { class: "field" }, el("span", {}, "The letter's file"), file),
    el("label", { class: "field" }, el("span", {}, "Or its text"), paste),
    el("div", { class: "actions" }, check), err, info);
  const fail = (e: unknown) => { err.textContent = String((e as Error).message ?? e); err.classList.remove("hidden"); };

  const show = (received: ReceivedLetter) => {
    const writer = received.writer.toBase58();
    info.replaceChildren(el("dl", { class: "spec" },
      el("dt", {}, "Plan"), el("dd", {}, received.plan.toBase58()),
      el("dt", {}, "Written and signed by"), el("dd", { id: "lwriter" }, writer),
      el("dt", {}, "Sealed on"), el("dd", {}, received.sealedAt),
      el("dt", {}, "Written for"), el("dd", {}, received.readers.map((r) => r.heir.toBase58()).join(" and "))));
    if (!env.wallet) {
      const b = el("button", { class: "btn primary" }, "Connect your wallet to open it");
      b.addEventListener("click", env.pickWallet);
      info.append(el("div", { class: "actions" }, b));
      return;
    }
    const wallet = env.wallet;
    if (!received.readers.some((r) => r.heir.equals(wallet.publicKey))) { info.append(el("p", { class: "err", id: "lnotyours" }, `This letter was not written for the wallet connected here (${wallet.publicKey.toBase58()}). Connect the wallet that made the reading key.`)); return; }
    const open = el("button", { class: "btn primary", id: "lopen" }, "Open it with my wallet");
    const text = el("div", { id: "lread" });
    info.append(el("p", { class: "quiet" }, "Your wallet will ask you to sign the sentence your reading key is made from. It is the same sentence as when you made the key, and the signature stays on this page."), el("div", { class: "actions" }, open), text);
    open.addEventListener("click", async () => {
      err.classList.add("hidden"); open.setAttribute("disabled", "");
      try {
        const letter = await readLetter((message) => wallet.signMessage(message), wallet.publicKey, received);
        // the letter is somebody's words: it is put on the page as text, never as markup
        const words = el("div", { class: "notice", id: "lwords", style: "white-space:pre-wrap;overflow-wrap:anywhere;font-size:14.5px;line-height:1.6" });
        words.textContent = letter;
        text.replaceChildren(el("p", { class: "ok", style: "margin-top:18px" }, `Signed by ${writer}. Your reading key opens letters signed by this wallet and by no other, so this one comes from whoever sent you the link you made the key from.`), words, el("p", { class: "quiet" }, NEVER));
      } catch (e) { fail(e); }
      finally { open.removeAttribute("disabled"); }
    });
  };

  const run = () => {
    err.classList.add("hidden"); info.innerHTML = "";
    pending = paste.value;
    if (!paste.value.trim()) { fail("Choose the letter's file, or paste its text."); return; }
    try { show(readLetterFile(paste.value)); } catch (e) { fail(e); }
  };
  check.addEventListener("click", run);
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 400_000) { fail("That file is far larger than a letter. Choose the file the owner's page made."); return; }
    paste.value = await f.text();
    run();
  });
  if (pending.trim()) run();
  return panel;
}

export function letterView(arg: string, env: LetterEnv): HTMLElement {
  const invitation = readInvitation(arg);
  const left = el("div", {},
    el("div", { class: "eyebrow" }, "The family letter"),
    el("h2", { style: "margin-top:14px" }, "A letter from the owner, for their heirs."),
    el("p", { style: "max-width:52ch" }, "The owner of a vault can leave their heirs a letter: where other accounts are, who to call, where the papers are. It is encrypted so that only the heirs can read it, and signed by the owner's wallet so that nobody else can write one in their name."),
    el("p", { class: "quiet", style: "max-width:52ch" }, NEVER),
    el("p", { class: "quiet", style: "max-width:52ch" }, "Nobody from Lamport will ever contact you about a letter, and this page has no field for a seed phrase."),
    el("p", { class: "quiet", style: "margin-top:30px;max-width:52ch" }, el("a", { class: "link", href: "#", id: "lback" }, "See where a vault stands"), ", and collect what was left to you."));
  const right = el("div", {});
  if (arg !== "" && !invitation) right.append(el("div", { class: "panel" }, el("div", { class: "eyebrow" }, "This link is damaged"), el("p", { class: "quiet" }, "It should name a plan and the owner's wallet, and it does not. Ask the person who sent it to copy it again, whole.")));
  if (invitation) right.append(keyPanel(env, invitation.plan, invitation.writer));
  right.append(readPanel(env));
  return el("div", { class: "page" }, left, right);
}
