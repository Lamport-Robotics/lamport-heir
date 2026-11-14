/**
 * The part of the plan form that chooses who inherits.
 *
 * The vault program releases to one address. To leave a vault to a person, with a second person
 * in case the first never claims, that address is a plan of the claim program, and a plan is
 * fixed by its terms: other heirs are another plan at another address. So the order here is the
 * only one that works: choose the heirs, let each of them show that the address written down for
 * them is theirs, create the plan, and only then hand its address to the form the owner signs.
 *
 * Page only. It reads the chain and asks the wallet to pay for the plan's account; it never sees
 * the vault's words. Nothing here runs when the module loads.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { $, copy, el, isPubkey, short } from "../../vendor/lamport-vault/web/src/common.ts";
import type { HeirCtx } from "../../vendor/lamport-vault/web/src/heir-plan.ts";
import { rpc } from "../../vendor/lamport-vault/web/src/rpc.ts";
import { acceptanceProofInstruction, checkTerms, contingentDelayLimits, decodePlan, initPlanInstruction, isPlan, planAddress, type Terms } from "../../tools/src/claim.ts";
import { readAcceptance } from "./acceptance.ts";
import { buildPrograms, termsToJson } from "./terms.ts";

/** the link an heir opens to accept: it carries the terms, so their page can say what they are accepting */
export function acceptLink(terms: Terms): string {
  const json = JSON.stringify(termsToJson(terms));
  const b64 = btoa(json).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${location.origin}/heir/claim.html#accept=${b64}`;
}

/** what the chain says about an address someone is to inherit at. an heir has to be able to sign */
async function heirProblem(address: PublicKey, vault: PublicKey, who: string): Promise<string | null> {
  if (address.equals(vault)) return `The ${who} heir is this vault itself.`;
  if (!PublicKey.isOnCurve(address.toBytes())) return `The ${who} heir's address belongs to a program, not to a key. Nobody could sign a claim with it.`;
  const info = await rpc.getAccountInfo(address, "confirmed");
  if (info && (info.executable || !info.owner.equals(SystemProgram.programId))) return `The ${who} heir's address is a program's account or a token account, not a wallet.`;
  return null;
}

export function claimComposer(ctx: HeirCtx, set: (claim: string, terms: unknown) => void): HTMLElement | null {
  const programs = buildPrograms();
  const day = programs.daySecs;
  const limits = contingentDelayLimits(programs);
  const s = ctx.vault.succession;
  const armed = !!s && !s.claim.equals(PublicKey.default);

  const mode = el("select", { id: "hmode" }, el("option", { value: "plan" }, "To named heirs, through a plan"), el("option", { value: "address" }, "To one address, directly"));
  const first = el("input", { class: "mono", id: "hfirst", autocomplete: "off", spellcheck: "false" });
  const second = el("input", { class: "mono", id: "hsecond", autocomplete: "off", spellcheck: "false" });
  const delay = el("input", { class: "mono", id: "hdelay", inputmode: "numeric", value: "365" });
  const out = el("div", { id: "hout" });
  const plan = el("div", { id: "hplan" },
    el("label", { class: "field" }, el("span", {}, "First heir · their wallet address"), first),
    el("div", { class: "two" },
      el("label", { class: "field" }, el("span", {}, "Second heir · optional"), second),
      el("label", { class: "field" }, el("span", {}, "May claim if the first has not · days after the release"), delay)),
    el("div", { class: "actions" }, el("button", { class: "btn", id: "hprep", type: "button" }, "Prepare the plan")),
    out);
  const node = el("div", { id: "hcomposer" }, el("label", { class: "field" }, el("span", {}, "The vault releases"), mode), plan);

  /** the form's own address field: read-only while a plan fills it */
  const claimField = () => node.closest("#pfields")?.querySelector<HTMLInputElement>("#pclaim") ?? null;
  const lock = (on: boolean) => { const c = claimField(); if (c) { c.readOnly = on; c.placeholder = on ? "the plan's address, once the plan exists" : ""; } };
  const say = (...kids: (Node | string)[]) => { out.innerHTML = ""; out.append(...kids); };
  const fail = (e: unknown) => say(el("div", { class: "err" }, String((e as Error).message ?? e)));

  /** the terms the fields spell; throws on the first thing wrong with them */
  const read = (): Terms => {
    if (!isPubkey(first.value)) throw new Error("Enter the first heir's wallet address.");
    const primary = new PublicKey(first.value.trim());
    const hasSecond = second.value.trim() !== "";
    if (hasSecond && !isPubkey(second.value)) throw new Error("The second heir's address is not a valid address.");
    let contingentDelaySecs = 0n;
    if (hasSecond) {
      const d = delay.value.trim();
      if (!/^\d{1,6}$/.test(d)) throw new Error("Enter the second heir's delay as a whole number of days.");
      contingentDelaySecs = BigInt(d) * day;
      if (contingentDelaySecs < limits.min || contingentDelaySecs > limits.max) throw new Error(`The second heir's delay must be between ${limits.min / day} and ${limits.max / day} days.`);
    }
    const terms: Terms = { vault: ctx.address, primary: { kind: "address", address: primary }, contingent: hasSecond ? { kind: "address", address: new PublicKey(second.value.trim()) } : { kind: "none" }, contingentDelaySecs };
    checkTerms(terms, programs);
    return terms;
  };

  const ready = (terms: Terms, address: PublicKey, made: boolean) => {
    set(address.toBase58(), termsToJson(terms));
    lock(true);
    say(el("div", { class: "ok" }, `${made ? "The plan was created" : "This plan exists"}: ${address.toBase58()}. Its heirs cannot be changed; other heirs are another plan. Now check the plan below and sign it.`));
  };

  /** the heirs who still have to accept, and the plan's account created once they have */
  const collect = (terms: Terms, address: PublicKey) => {
    const named: { who: string; address: PublicKey }[] = [];
    if (terms.primary.kind === "address") named.push({ who: "first", address: terms.primary.address });
    if (terms.contingent.kind === "address") named.push({ who: "second", address: terms.contingent.address });
    const payer = ctx.wallet?.pubkey;
    const waiting = named.filter((h) => !payer || !h.address.equals(payer));
    const link = acceptLink(terms);
    const boxes = waiting.map((h) => ({ ...h, box: el("textarea", { class: "mono", rows: "2", "data-heir": h.address.toBase58(), placeholder: "" }) }));
    const create = el("button", { class: "btn primary", type: "button", id: "hcreate" }, "Create the plan");
    const err = el("div", { class: "err hidden" });
    say(
      el("div", { class: "notice" },
        el("div", { style: "margin-bottom:10px" }, waiting.length ? "Before the plan is created, each heir shows that the address you wrote down is theirs. Send them this link. Their page says what they are accepting, asks their wallet for a signature that moves nothing, and gives them one line of text to send back to you." : "You are the only heir named, and your wallet is connected: creating the plan is the proof."),
        waiting.length ? el("div", { class: "mono", style: "font-size:12px;overflow-wrap:anywhere;margin-bottom:10px" }, link) : null,
        waiting.length ? el("div", { class: "actions" }, el("button", { class: "link", type: "button", id: "hcopy" }, "Copy the link")) : null),
      ...boxes.map((h) => el("label", { class: "field" }, el("span", {}, `From the ${h.who} heir · ${short(h.address.toBase58(), 6)}`), h.box)),
      el("div", { class: "actions" }, create, el("span", { class: "quiet", style: "font-size:12.5px;color:var(--mute)" }, "your wallet pays for the plan's account, about 0.002 SOL")),
      err);
    $("#hcopy", out)?.addEventListener("click", (e) => void copy(link, e.currentTarget as HTMLButtonElement));
    create.addEventListener("click", async () => {
      err.classList.add("hidden");
      try {
        if (!ctx.wallet) throw new Error("Connect a wallet to pay for the plan's account.");
        const proofs: TransactionInstruction[] = [];
        for (const h of boxes) {
          if (!h.box.value.trim()) throw new Error(`The ${h.who} heir has not accepted yet: paste what they sent back.`);
          const a = readAcceptance(h.box.value, { plan: address, heir: h.address });
          proofs.push(acceptanceProofInstruction(a.heir, a.signature, a.signed));
        }
        create.setAttribute("disabled", ""); create.classList.add("spin");
        const { instruction } = initPlanInstruction({ claimProgram: programs.claim, payer: ctx.wallet.pubkey, terms });
        await ctx.wallet.send([...proofs, instruction]);
        ready(terms, address, true);
      } catch (e) { err.textContent = String((e as Error).message ?? e); err.classList.remove("hidden"); create.removeAttribute("disabled"); create.classList.remove("spin"); }
    });
  };

  $("#hprep", node).addEventListener("click", async () => {
    const btn = $("#hprep", node) as HTMLButtonElement;
    try {
      set("", undefined);
      const terms = read();
      btn.setAttribute("disabled", "");
      const why = (terms.primary.kind === "address" ? await heirProblem(terms.primary.address, ctx.address, "first") : null) ?? (terms.contingent.kind === "address" ? await heirProblem(terms.contingent.address, ctx.address, "second") : null);
      if (why) throw new Error(why);
      const address = planAddress(terms, programs.claim);
      const info = await rpc.getAccountInfo(address, "confirmed");
      if (info && info.owner.equals(programs.claim) && isPlan(info.data)) ready(terms, address, false);
      else if (info) throw new Error("Something other than a plan is at this plan's address. Do not use it.");
      else collect(terms, address);
    } catch (e) { fail(e); }
    finally { btn.removeAttribute("disabled"); }
  });

  // heirs edited after a plan was prepared are another plan: the form must not keep the old one's address
  plan.addEventListener("input", (e) => { if (e.target === first || e.target === second || e.target === delay) { set("", undefined); out.innerHTML = ""; } });
  const sync = () => {
    const direct = (mode as HTMLSelectElement).value === "address";
    plan.classList.toggle("hidden", direct);
    lock(!direct);
    if (direct) out.innerHTML = "";
    set("", undefined);
  };
  mode.addEventListener("change", sync);

  // a vault that already releases to a plan: show that plan's heirs, read from the plan itself
  queueMicrotask(async () => {
    lock((mode as HTMLSelectElement).value === "plan");
    if (!armed) return;
    try {
      const info = await rpc.getAccountInfo(s!.claim, "confirmed");
      if (info && info.owner.equals(programs.claim) && isPlan(info.data)) {
        const terms = decodePlan(info.data).terms;
        if (terms.primary.kind !== "address" || terms.contingent.kind === "hashed") { say(el("p", { class: "quiet" }, "This vault's plan keeps its heirs private. This page cannot show or change them; the command-line tool can.")); return; }
        first.value = terms.primary.address.toBase58();
        if (terms.contingent.kind === "address") { second.value = terms.contingent.address.toBase58(); delay.value = String(terms.contingentDelaySecs / day); }
        if (terms.vault.equals(ctx.address)) ready(terms, s!.claim, false);
      } else { (mode as HTMLSelectElement).value = "address"; plan.classList.add("hidden"); lock(false); }
    } catch { /* the form still works without the prefill */ }
  });
  return node;
}
