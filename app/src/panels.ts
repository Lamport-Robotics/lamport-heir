/**
 * Under the plan's status on the Inheritance tab: the check-in key this browser keeps for the
 * vault, and the pages the heirs get.
 *
 * A check-in tells the chain the owner is alive without the 24 words. The key that signs it can
 * do nothing else: it cannot move funds or change the plan, and it stops counting two years after
 * the last signature from the words. It is made here non-extractable and pays the small fee of
 * its own check-ins, so checking in needs no wallet and no server.
 *
 * Page only. Nothing here runs when the module loads.
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { $, CLUSTER, RPC_URL, copy, el, short, sol, txLink } from "../../vendor/lamport-vault/web/src/common.ts";
import { days, type HeirCtx } from "../../vendor/lamport-vault/web/src/heir-plan.ts";
import { rpc } from "../../vendor/lamport-vault/web/src/rpc.ts";
import type { Chain } from "../../tools/src/chain.ts";
import { CHECKIN_FEE_LAMPORTS, checkin, checkinSignerFrom, generateCheckinKey } from "../../tools/src/checkin.ts";
import { decodePlan, isPlan, type Terms } from "../../tools/src/claim.ts";
import { renderKit } from "../../tools/src/kit.ts";
import { forgetCheckinKey, loadCheckinKey, saveCheckinKey } from "./keystore.ts";
import { buildPrograms } from "./terms.ts";

declare const __APP_BUILD__: string | undefined;

/** what one top-up from the wallet pays for: two thousand check-ins */
const TOP_UP_LAMPORTS = 10_000_000;
const chain = () => rpc as unknown as Chain;

function checkinPanel(ctx: HeirCtx): HTMLElement {
  const vault = ctx.address.toBase58();
  const box = el("div", { id: "hcheckin", style: "margin:22px 0" }, el("div", { class: "eyebrow" }, "Check-in key on this device"), el("p", { class: "quiet" }, "Looking in this browser…"));
  const body = el("div", {});
  const paint = async () => {
    body.innerHTML = "";
    const s = ctx.vault.succession;
    let pair: CryptoKeyPair | undefined;
    try { pair = await loadCheckinKey(vault); }
    catch (e) { body.append(el("p", { class: "quiet" }, `This browser gives the page no storage, so it cannot keep a check-in key: ${String((e as Error).message ?? e)}`)); return; }
    if (!pair) {
      const make = el("button", { class: "btn", type: "button", id: "hmakekey" }, "Make a check-in key here");
      body.append(el("p", { class: "quiet" }, "A check-in tells the chain you are alive without your 24 words. The key that signs it stays in this browser and can do nothing else: it cannot move funds or change the plan."), el("div", { class: "actions" }, make));
      make.addEventListener("click", async () => {
        try { const k = await generateCheckinKey(); await saveCheckinKey(vault, k.handle); await paint(); }
        catch (e) { body.append(el("div", { class: "err" }, `This browser could not make the key: ${String((e as Error).message ?? e)}`)); }
      });
      return;
    }
    const signer = await checkinSignerFrom(pair);
    const address = signer.publicKey.toBase58();
    const inPlan = !!s && s.checkinKey.equals(signer.publicKey);
    const cp = el("button", { class: "link quiet", type: "button" }, "Copy");
    cp.addEventListener("click", (e) => void copy(address, e.currentTarget as HTMLButtonElement));
    body.append(el("dl", { class: "spec", style: "margin-top:8px" }, el("dt", {}, "Its address"), el("dd", {}, address, " ", cp)));
    const err = el("div", { class: "err hidden" }), ok = el("div", { class: "ok hidden" });
    const report = (e: unknown) => { err.textContent = String((e as Error).message ?? e); err.classList.remove("hidden"); };
    if (!inPlan) {
      const use = el("button", { class: "btn", type: "button", id: "husekey" }, "Put it in the plan form");
      const drop = el("button", { class: "link quiet", type: "button" }, "Forget this key");
      body.append(el("p", { class: "quiet" }, s && !s.checkinKey.equals(PublicKey.default) ? "The vault's plan names another check-in key. To check in from this browser, name this one: it takes a signature from your words." : "The plan does not name it yet. Put it in the plan below and sign the plan; from then on this browser can check in."),
        el("div", { class: "actions" }, use, drop));
      use.addEventListener("click", () => { const f = document.querySelector<HTMLInputElement>("#pcheckin"); if (f) { f.value = address; f.dispatchEvent(new Event("input", { bubbles: true })); f.scrollIntoView({ behavior: "smooth", block: "center" }); } });
      drop.addEventListener("click", async () => { await forgetCheckinKey(vault); await paint(); });
      return;
    }
    const balance = await rpc.getBalance(signer.publicKey, "confirmed").catch(() => 0);
    const go = el("button", { class: "btn primary", type: "button", id: "hcheckinnow" }, "Check in now");
    const fund = el("button", { class: "btn", type: "button", id: "hfund" }, `Send it ${sol(TOP_UP_LAMPORTS)} SOL from the wallet`);
    body.append(
      el("p", { class: "quiet" }, balance >= CHECKIN_FEE_LAMPORTS ? `It holds ${sol(balance)} SOL, enough for ${Math.floor(balance / CHECKIN_FEE_LAMPORTS).toLocaleString("en-US")} check-ins.` : "It holds no SOL yet. A check-in costs 0.000005 SOL, which this key pays itself, so that checking in needs no wallet."),
      el("div", { class: "actions" }, balance >= CHECKIN_FEE_LAMPORTS ? go : null, fund), err, ok);
    go.addEventListener("click", async () => {
      err.classList.add("hidden"); ok.classList.add("hidden");
      try {
        go.setAttribute("disabled", ""); go.classList.add("spin");
        const r = await checkin(chain(), signer, ctx.address);
        if (!r.sent) throw new Error(r.readiness.ok ? "the check-in was not sent" : r.readiness.detail);
        ok.replaceChildren("Checked in · ", txLink(r.signature)); ok.classList.remove("hidden");
        await ctx.reload();
      } catch (e) { report(e); go.removeAttribute("disabled"); go.classList.remove("spin"); }
    });
    fund.addEventListener("click", async () => {
      err.classList.add("hidden");
      try {
        if (!ctx.wallet) throw new Error("Connect a wallet first.");
        await ctx.wallet.send([SystemProgram.transfer({ fromPubkey: ctx.wallet.pubkey, toPubkey: signer.publicKey, lamports: TOP_UP_LAMPORTS })]);
        await paint();
      } catch (e) { report(e); }
    });
  };
  box.lastElementChild!.replaceWith(body);
  void paint();
  return box;
}

/** opens a kit as a page of its own, to print */
function openKit(html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const a = el("a", { href: url, target: "_blank", rel: "noopener" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function kitsPanel(ctx: HeirCtx): HTMLElement | null {
  const s = ctx.vault.succession;
  if (!s || s.claim.equals(PublicKey.default)) return null;
  const programs = buildPrograms();
  const box = el("div", { id: "hkits", style: "margin:22px 0" }, el("div", { class: "eyebrow" }, "For your heirs"),
    el("p", { class: "quiet" }, "A kit is one page to print for each heir: what this is, the addresses, and the exact steps to claim. It holds no key. Whoever finds it cannot take anything, but learns that the vault exists and who inherits."));
  const list = el("div", { class: "actions" });
  box.append(list);
  const kit = (heir: PublicKey, terms: Terms | undefined) => {
    const b = el("button", { class: "btn", type: "button" }, `Kit for ${short(heir.toBase58(), 5)}`);
    b.addEventListener("click", () => {
      try {
        openKit(renderKit({ cluster: CLUSTER, rpcUrl: RPC_URL.startsWith("http") && !RPC_URL.includes(location.host) ? RPC_URL : "https://api.devnet.solana.com", programs, vault: ctx.address, claim: s.claim, ...(terms ? { terms } : {}), heirAddress: heir, windowSecs: s.windowSecs, waitSecs: s.waitSecs, printedAt: new Date(), source: { repository: "https://github.com/Lamport-Robotics/lamport-heir", commit: typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "dev" } }));
      } catch (e) { box.append(el("div", { class: "err" }, String((e as Error).message ?? e))); }
    });
    list.append(b);
  };
  void rpc.getAccountInfo(s.claim, "confirmed").then((info) => {
    if (info && info.owner.equals(programs.claim) && isPlan(info.data)) {
      const terms = decodePlan(info.data).terms;
      if (terms.primary.kind === "address") kit(terms.primary.address, terms);
      if (terms.contingent.kind === "address") kit(terms.contingent.address, terms);
      if (terms.primary.kind === "hashed" || terms.contingent.kind === "hashed") box.append(el("p", { class: "quiet" }, "An heir kept private needs their salt on the kit, and only the command-line tool that made the plan has it."));
      box.append(el("p", { class: "quiet", style: "font-size:12.5px" }, `The plan gives the first heir everything, and the second the right to claim if the first has not, ${terms.contingent.kind === "none" ? "which this plan does not use" : `${days(terms.contingentDelaySecs)} after the release`}.`));
    } else kit(s.claim, undefined);
  }).catch(() => { box.append(el("p", { class: "quiet" }, "The claim address could not be read just now; reload to try again.")); });
  return box;
}

export function extraPanels(ctx: HeirCtx): HTMLElement | null {
  const box = el("div", {}, checkinPanel(ctx));
  const kits = kitsPanel(ctx);
  if (kits) box.append(kits);
  return box;
}
