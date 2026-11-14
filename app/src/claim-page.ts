/**
 * The page for heirs, served beside the vault page under /heir/.
 *
 *   claim.html#accept=<terms>   someone named you: see what you are accepting, sign one sentence
 *   claim.html#<vault or plan>  where the vault stands, and what you may do about it
 *
 * Everything it does on chain is something anyone may do, except claiming, which the heir's own
 * wallet signs. It asks for no seed phrase and no key, has no field one could go in, and talks to
 * nothing but the Solana endpoint.
 */
import "../../vendor/lamport-vault/web/src/polyfill.ts";
import "../../vendor/lamport-vault/web/src/style.css";
import "../../vendor/lamport-vault/web/src/pages.css";
import "../../vendor/lamport-vault/web/src/interface.css";
import { PublicKey } from "@solana/web3.js";
import { $, CLUSTER, copy, el, isPubkey, short, txLink } from "../../vendor/lamport-vault/web/src/common.ts";
import { rpc } from "../../vendor/lamport-vault/web/src/rpc.ts";
import { contactExtendInstruction, successionLimits } from "@lamport-robotics/vault";
import { send, type Chain } from "../../tools/src/chain.ts";
import { acceptanceMessage, checkTerms, planAddress, type Terms } from "../../tools/src/claim.ts";
import { claim } from "../../tools/src/claiming.ts";
import { inspect, start, type Situation, type Step } from "../../tools/src/release.ts";
import { acceptanceBytes, isAcceptanceOf, writeAcceptance } from "./acceptance.ts";
import { connect, listWallets, localTestWallet, onWalletsChange, type HeirWallet } from "./heir-wallet.ts";
import { contactWords, durationInDays, placeInTerms, situationWords, stepWords, verdictWords } from "./heir-words.ts";
import { buildPrograms, termsFromJson } from "./terms.ts";

const chain = rpc as unknown as Chain;
const programs = buildPrograms();
let wallet: HeirWallet | null = null;

const app = $("#app");
app.className = "shell";
const main = el("div", { id: "main" });
app.append(
  el("div", { class: "top app" },
    el("a", { class: "brand", href: "/heir/claim.html" }, el("img", { src: "/mark.svg", alt: "" }), el("b", {}, "Lamport Heir"), el("i", {}), el("small", {}, `for heirs · ${CLUSTER}`)),
    el("nav", { class: "nav" }, el("a", { href: "/heir/" }, "For owners"), el("a", { href: "/how-it-works" }, "How the vault works")),
    el("div", { class: "wallet", id: "walletbox" })),
  main,
  el("footer", {}, el("a", { href: "https://github.com/Lamport-Robotics/lamport-heir" }, "Source"), el("a", { href: "https://lamportrobotics.com" }, "Lamport Robotics"),
    el("span", { class: "ids" }, `vault ${short(programs.vault.toBase58(), 6)} · claim ${short(programs.claim.toBase58(), 6)}${programs.daySecs === 86_400n ? "" : " · TEST BUILD, a day lasts a second"}`)));

// ── wallet ──
function paintWallet() {
  const box = $("#walletbox"); box.innerHTML = "";
  if (wallet) {
    const off = el("button", { class: "link quiet" }, "Disconnect");
    off.addEventListener("click", () => { wallet = null; paintWallet(); route(); });
    box.append(el("span", {}, el("span", { class: "dot" }), short(wallet.publicKey.toBase58())), off);
    return;
  }
  const btn = el("button", { class: "link" }, "Connect wallet");
  btn.addEventListener("click", pickWallet);
  box.append(btn);
}

function pickWallet() {
  const ws = listWallets();
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const overlay = el("div", { class: "overlay" });
  const list = el("div", { class: "wlist" });
  const err = el("div", { class: "err" });
  const close = () => overlay.remove();
  const choose = async (f: () => Promise<HeirWallet> | HeirWallet) => { try { wallet = await f(); close(); paintWallet(); route(); } catch (e) { err.textContent = String((e as Error).message ?? e); } };
  for (const w of ws) { const row = el("button", { class: "wrow" }, el("img", { src: w.icon, alt: "" }), el("span", {}, w.name)); row.addEventListener("click", () => void choose(() => connect(w))); list.append(row); }
  if (local) { const row = el("button", { class: "wrow", id: "wlocal" }, el("span", { class: "wdot" }), el("span", {}, "Local test key")); row.addEventListener("click", () => void choose(localTestWallet)); list.append(row); }
  if (!ws.length && !local) list.append(el("p", { class: "quiet", style: "margin:4px 0 0" }, "No Solana wallet is installed in this browser. On a phone, open this page inside your wallet's browser."));
  const shut = el("button", { class: "link quiet" }, "Close");
  shut.addEventListener("click", close);
  overlay.append(el("div", { class: "modal" }, el("div", { class: "mhead" }, el("span", { class: "eyebrow", style: "margin:0" }, "Connect your wallet"), shut),
    el("p", { class: "quiet", style: "font-size:13px" }, "The wallet whose address the owner named. This page never asks for a seed phrase; if anything does, it is not this page."), list, err));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
}
onWalletsChange(paintWallet);

// ── routing ──
addEventListener("hashchange", route);
function route() {
  const h = location.hash.slice(1);
  main.innerHTML = "";
  if (h.startsWith("accept=")) main.append(acceptView(h.slice(7)));
  else main.append(statusView(isPubkey(h) ? h : ""));
}

// ── accepting ──
function readLink(b64url: string): Terms {
  const b64 = b64url.replaceAll("-", "+").replaceAll("_", "/");
  const terms = termsFromJson(JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))));
  checkTerms(terms, programs);
  return terms;
}

function acceptView(link: string): HTMLElement {
  let terms: Terms;
  try { terms = readLink(link); }
  catch { return el("div", { class: "page" }, el("div", {}, el("h2", {}, "This link is damaged"), el("p", { class: "quiet" }, "It should carry the plan you were named in, and it does not read as one. Ask the person who sent it to copy it again, whole."))); }
  const plan = planAddress(terms, programs.claim);
  const sentence = acceptanceMessage(plan);
  const place = wallet ? placeInTerms(terms, wallet.publicKey, programs.daySecs) : null;
  const heir = (h: Terms["primary"]) => (h.kind === "address" ? h.address.toBase58() : h.kind === "hashed" ? "kept private" : "none");
  const left = el("div", {},
    el("div", { class: "eyebrow" }, "You were named an heir"),
    el("h2", { style: "margin-top:14px" }, "Someone has left you their vault, if they die."),
    el("p", { style: "max-width:52ch" }, "A Lamport Vault can be set to release to its heirs after its owner has been silent for a long time. The owner of the vault below wants to name you. Before they can, you show that the address they wrote down is really yours, so that a typing mistake cannot leave their vault to nobody."),
    el("dl", { class: "spec" },
      el("dt", {}, "Vault"), el("dd", {}, terms.vault.toBase58()),
      el("dt", {}, "First heir"), el("dd", {}, heir(terms.primary)),
      el("dt", {}, "Second heir"), el("dd", {}, terms.contingent.kind === "none" ? "none" : `${heir(terms.contingent)} · if the first has not claimed ${durationInDays(terms.contingentDelaySecs, programs.daySecs)} after the release`),
      el("dt", {}, "Plan"), el("dd", {}, plan.toBase58())));
  const panel = el("div", { class: "panel" }, el("div", { class: "eyebrow" }, "Accept"),
    el("p", { class: "quiet" }, "You sign one sentence with your wallet. It moves nothing, costs nothing, and gives nobody access to your wallet. It is this sentence, and nothing else:"),
    el("div", { class: "notice mono", style: "font-size:12.5px;overflow-wrap:anywhere" }, sentence));
  if (!wallet) { const b = el("button", { class: "btn primary" }, "Connect your wallet"); b.addEventListener("click", pickWallet); panel.append(el("div", { class: "actions" }, b)); }
  else {
    panel.append(el("p", { class: place!.named ? "ok" : "err" }, place!.text));
    if (place!.named) {
      const sign = el("button", { class: "btn primary", id: "asign" }, "Sign the sentence");
      const out = el("div", { id: "aout" }), err = el("div", { class: "err hidden" });
      panel.append(el("div", { class: "actions" }, sign), err, out);
      sign.addEventListener("click", async () => {
        err.classList.add("hidden");
        try {
          const { signed, signature } = await wallet!.signMessage(acceptanceBytes(plan));
          // what the wallet says it signed has to be the sentence, or the claim program will not take it either
          if (!isAcceptanceOf(signed, plan)) throw new Error("Your wallet signed something other than the sentence above. Nothing was sent anywhere. Try another wallet.");
          const text = writeAcceptance(plan, wallet!.publicKey, signed, signature);
          const box = el("textarea", { class: "mono", id: "atext", rows: "5", readonly: "" }); box.value = text;
          const cp = el("button", { class: "link" }, "Copy");
          cp.addEventListener("click", (e) => void copy(text, e.currentTarget as HTMLButtonElement));
          out.replaceChildren(el("label", { class: "field", style: "margin-top:18px" }, el("span", {}, "Send this back to the owner"), box), el("div", { class: "actions" }, cp),
            el("p", { class: "quiet", style: "margin-top:14px" }, "Send it any way you like; it is not a secret and it cannot be used to take anything. The owner will give you a page to keep, your kit. Nobody from Lamport will ever contact you about this or ask you for a seed phrase."));
        } catch (e) { err.textContent = String((e as Error).message ?? e); err.classList.remove("hidden"); }
      });
    }
  }
  return el("div", { class: "page" }, left, panel);
}

// ── where a vault stands ──
function statusView(address: string): HTMLElement {
  const input = el("input", { class: "mono", id: "saddr", autocomplete: "off", spellcheck: "false", value: address });
  const go = el("button", { class: "btn primary", id: "sgo" }, "Look it up");
  const left = el("div", {},
    el("div", { class: "eyebrow" }, "For heirs"),
    el("h2", { style: "margin-top:14px" }, "See where a vault stands, and collect what was left to you."),
    el("p", { style: "max-width:52ch" }, "Enter the vault's address, or the plan's. Both are on your kit. Looking needs no wallet and changes nothing."),
    el("label", { class: "field", style: "max-width:560px" }, el("span", {}, "Vault or plan address"), input),
    el("div", { class: "actions" }, go));
  const panel = el("div", { class: "panel", id: "spanel" }, el("p", { class: "quiet" }, address ? "Reading the chain…" : "Nothing looked up yet."));
  const open = () => { const v = input.value.trim(); if (isPubkey(v)) { if (location.hash.slice(1) === v) route(); else location.hash = v; } else input.focus(); };
  go.addEventListener("click", open);
  input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") open(); });
  if (address) void paintSituation(panel, new PublicKey(address));
  return el("div", { class: "page" }, left, panel);
}

async function paintSituation(panel: HTMLElement, address: PublicKey) {
  let s: Situation;
  try { s = await inspect(chain, address); }
  catch (e) { panel.replaceChildren(el("div", { class: "eyebrow" }, "Not found"), el("p", { class: "quiet" }, `That address is not a Lamport Vault with inheritance, nor a plan of one, or the network did not answer: ${String((e as Error).message ?? e)}`)); return; }
  const w = situationWords(s, wallet?.publicKey);
  const steps = el("ul", { class: "steps hidden", id: "ssteps" });
  const err = el("div", { class: "err hidden" }), done = el("div", { class: "ok hidden", id: "sdone" });
  const acts = el("div", { class: "actions" });
  panel.replaceChildren(el("div", { class: "eyebrow" }, "Vault"), el("div", { class: "addr", style: "font-size:13px;overflow-wrap:anywhere" }, s.vault.toBase58()),
    el("h3", { style: "margin:18px 0 10px" }, w.headline), ...w.lines.map((l) => el("p", { class: "quiet" }, l)), ...(w.warning ? [el("div", { class: "notice warn" }, w.warning)] : []), acts, steps, err, done);
  const report = (e: unknown) => { err.textContent = String((e as Error).message ?? e); err.classList.remove("hidden"); };
  const show = (list: Step[]) => {
    steps.classList.remove("hidden");
    for (const st of list) { const t = stepWords(st); const li = el("li", { class: t.outcome === "done" ? "done" : "" }, el("span", {}, t.name)); li.append(t.outcome === "done" ? txLink(t.detail, 5) : el("span", { class: "quiet", style: "margin-left:auto;font-size:12px" }, t.detail)); steps.append(li); }
  };
  // the owner's trusted contact is not an heir, and has one button of their own
  const contact = contactWords(s, wallet?.publicKey, successionLimits({ daySecs: s.programs.daySecs }).contactExtensionSecs / s.programs.daySecs);
  if (contact) {
    const box = el("div", { class: "notice", id: "scontact", style: "margin-top:16px" }, el("div", {}, contact.text));
    if (contact.canExtend) {
      const extend = el("button", { class: "btn sm", id: "sextend", style: "margin-top:12px" }, "Push the deadline back");
      box.append(extend);
      extend.addEventListener("click", async () => {
        err.classList.add("hidden"); extend.setAttribute("disabled", "");
        try { await send(chain, [wallet!], [contactExtendInstruction({ programId: s.programs.vault, vault: s.vault, contactKey: wallet!.publicKey })]); await paintSituation(panel, address); }
        catch (e) { report(e); extend.removeAttribute("disabled"); }
      });
    }
    acts.before(box);
  }
  if (w.next === "nothing") return;
  if (!wallet) { const b = el("button", { class: "btn" }, "Connect a wallet to go on"); b.addEventListener("click", pickWallet); acts.append(b); return; }
  if (w.next === "start") {
    const b = el("button", { class: "btn", id: "sstart" }, "Open the waiting period");
    acts.append(b);
    b.addEventListener("click", () => {
      const yes = el("button", { class: "btn primary sm", id: "sstartyes" }, "I believe so. Open it"), no = el("button", { class: "link quiet" }, "Cancel");
      const box = el("div", { class: "notice warn", style: "margin-top:16px" }, el("div", { style: "margin-bottom:12px" }, "Do this only if you believe the owner has died or can no longer act. It is public: the owner and the people they chose are told, and it stays on the chain. It moves nothing, and the owner cancels it with any sign of life."), el("div", { class: "actions" }, yes, no));
      acts.after(box);
      no.addEventListener("click", () => box.remove());
      yes.addEventListener("click", async () => {
        err.classList.add("hidden"); yes.setAttribute("disabled", "");
        try { const r = await start(chain, wallet!, s.vault); box.remove(); show([r.step]); if (r.step.failed) throw new Error(`The chain refused: ${r.step.failed}`); await paintSituation(panel, address); }
        catch (e) { report(e); yes.removeAttribute("disabled"); }
      });
    });
    return;
  }
  const b = el("button", { class: "btn primary", id: "scollect" }, w.next === "release" ? "Release the vault and collect" : "Collect");
  acts.append(b, el("span", { class: "quiet", style: "font-size:12.5px;color:var(--mute)" }, "your wallet pays the network fees, a few cents"));
  b.addEventListener("click", async () => {
    err.classList.add("hidden"); done.classList.add("hidden"); steps.innerHTML = "";
    b.setAttribute("disabled", ""); b.classList.add("spin");
    try {
      const r = await claim(chain, wallet!, address);
      show(r.steps);
      done.textContent = verdictWords(r.verdict, r.situation.now, programs.daySecs); done.classList.remove("hidden");
    } catch (e) { report(e); }
    finally { b.removeAttribute("disabled"); b.classList.remove("spin"); }
  });
}

paintWallet();
route();
