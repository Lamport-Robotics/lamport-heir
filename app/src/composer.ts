/**
 * The part of the plan form that chooses who inherits.
 *
 * The vault program releases to one address. To leave a vault to a person, with a second person
 * in case the first never claims, that address is a plan of the claim program, and a plan is
 * fixed by its terms: other heirs are another plan at another address. So the order here is the
 * only one that works: choose the heirs, let each of them show that the address written down for
 * them is theirs, create the plan, and only then hand its address to the form the owner signs.
 *
 * An heir can be kept private: the plan then holds a fingerprint of their address and a salt, and
 * they collect with the salt. A salt that is lost is an heir who can never collect, so before such
 * a plan goes anywhere near a signature the salt is on the owner's paper and in the heir's own
 * hands (their link carries it), and this browser keeps a copy to find the plan again (salts.ts).
 *
 * Page only. It reads the chain and asks the wallet to pay for the plan's account; it never sees
 * the vault's words. Nothing here runs when the module loads.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { copy, el, isPubkey, short } from "../../vendor/lamport-vault/web/src/common.ts";
import type { HeirCtx } from "../../vendor/lamport-vault/web/src/heir-plan.ts";
import { rpc } from "../../vendor/lamport-vault/web/src/rpc.ts";
import { acceptanceProofInstruction, checkTerms, contingentDelayLimits, decodePlan, hashedHeir, heirCommitment, heirMatches, type HeirRef, initPlanInstruction, isPlan, planAddress, type Terms } from "../../tools/src/claim.ts";
import { formatSalt } from "../../tools/src/salt.ts";
import { writeAcceptLink } from "./accept-link.ts";
import { readAcceptance } from "./acceptance.ts";
import { keptSalt, keptSalts, markAccepted, markWritten, saltFor } from "./salts.ts";
import { buildPrograms, termsToJson } from "./terms.ts";

/** an heir as the owner typed them */
interface Named {
  who: "first" | "second";
  address: PublicKey;
  /** kept private: in the plan as a fingerprint */
  private: boolean;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const inEights = (s: string) => s.match(/.{1,8}/g)!.join(" ");

/** the addresses this page has asked the network about since it was loaded: an owner who then keeps one private is told */
const asked = new Set<string>();

/** the link an heir opens to accept: it carries the terms, so their page can say what they are accepting, and for an heir kept private, their salt */
export function acceptLink(terms: Terms, salt?: Uint8Array): string {
  return writeAcceptLink(location.origin, terms, salt);
}

/**
 * What is wrong with an address someone is to inherit at: an heir has to be able to sign. With
 * `lookup` the chain is asked what is at the address. It is not asked for an heir kept private:
 * the question itself would tell the endpoint which address this browser looked up just before
 * making a plan for this vault; their signed acceptance shows that a key holds the address.
 */
async function heirProblem(address: PublicKey, vault: PublicKey, who: string, lookup: boolean): Promise<string | null> {
  if (address.equals(PublicKey.default)) return `The ${who} heir's address is the all-zero address, which nobody holds.`;
  if (address.equals(vault)) return `The ${who} heir is this vault itself.`;
  if (!PublicKey.isOnCurve(address.toBytes())) return `The ${who} heir's address belongs to a program, not to a key. Nobody could sign a claim with it.`;
  if (!lookup) return null;
  asked.add(address.toBase58());
  const info = await rpc.getAccountInfo(address, "confirmed");
  if (info && (info.executable || !info.owner.equals(SystemProgram.programId))) return `The ${who} heir's address is a program's account or a token account, not a wallet.`;
  return null;
}

/** a page to print: one private heir's salt and fingerprint, for the owner's papers */
function printSlip(vault: PublicKey, h: Named, salt: Uint8Array) {
  const printed = formatSalt(salt);
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lamport Heir: a private heir's salt</title><style>body{font:11pt/1.5 Georgia,serif;max-width:170mm;margin:12mm auto;color:#000}code{font:11pt/1.7 Menlo,Consolas,monospace;word-break:break-all}h1{font-size:16pt}</style></head><body>
<h1>Lamport Heir: the salt of an heir kept private</h1>
<p>Keep this with your papers. It is not a key: nobody can take anything with it. It does show which address is an heir of this vault.</p>
<p>Vault<br><code>${esc(vault.toBase58())}</code></p>
<p>The ${esc(h.who)} heir's address<br><code>${esc(h.address.toBase58())}</code></p>
<p>Their salt (the last four characters are a check against typing mistakes)<br><code>${esc(inEights(printed.slice(0, 64)))} - ${esc(printed.slice(65))}</code></p>
<p>The fingerprint the plan holds in place of their address, which the signer shows when you sign<br><code>${esc(inEights(hex(heirCommitment(salt, h.address))))}</code></p>
<p>Written ${esc(new Date().toISOString().slice(0, 10))}. The heir cannot collect without the salt. Their kit prints it too.</p>
</body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  el("a", { href: url, target: "_blank", rel: "noopener" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function claimComposer(ctx: HeirCtx, set: (claim: string, terms: unknown) => void): HTMLElement | null {
  const programs = buildPrograms();
  const day = programs.daySecs;
  const limits = contingentDelayLimits(programs);
  const s = ctx.vault.succession;
  const armed = !!s && !s.claim.equals(PublicKey.default);
  /** the addresses the vault's current plan names openly: on the chain for good, whatever a later plan hides */
  const armedOpenly = new Set<string>();

  const mode = el("select", { id: "hmode" }, el("option", { value: "plan" }, "To named heirs, through a plan"), el("option", { value: "address" }, "To one address, directly"));
  const first = el("input", { class: "mono", id: "hfirst", autocomplete: "off", spellcheck: "false" });
  const second = el("input", { class: "mono", id: "hsecond", autocomplete: "off", spellcheck: "false" });
  const delay = el("input", { class: "mono", id: "hdelay", inputmode: "numeric", value: "365" });
  const firstPrivate = el("input", { type: "checkbox", id: "hfirstpriv" });
  const secondPrivate = el("input", { type: "checkbox", id: "hsecondpriv" });
  const tick = (box: HTMLInputElement, who: string) => el("label", { style: "display:flex;gap:8px;align-items:center;font-size:13px;margin:-8px 0 16px;color:var(--ink-2)" }, box, `Keep the ${who} heir private: the plan shows a fingerprint in place of their address`);
  const out = el("div", { id: "hout" });
  const prep = el("button", { class: "btn", id: "hprep", type: "button" }, "Prepare the plan");
  const plan = el("div", { id: "hplan" },
    el("label", { class: "field" }, el("span", {}, "First heir · their wallet address"), first),
    tick(firstPrivate, "first"),
    el("div", { class: "two" },
      el("label", { class: "field" }, el("span", {}, "Second heir · optional"), second),
      el("label", { class: "field" }, el("span", {}, "May claim if the first has not · days after the release"), delay)),
    tick(secondPrivate, "second"),
    el("div", { class: "actions" }, prep),
    out);
  const node = el("div", { id: "hcomposer" }, el("label", { class: "field" }, el("span", {}, "The vault releases"), mode), plan);

  /** the form's own address field: read-only while a plan fills it */
  const claimField = () => node.closest("#pfields")?.querySelector<HTMLInputElement>("#pclaim") ?? null;
  const lock = (on: boolean) => { const c = claimField(); if (c) { c.readOnly = on; c.placeholder = on ? "the plan's address, once the plan exists" : ""; } };
  const say = (...kids: (Node | string | null)[]) => { out.innerHTML = ""; for (const k of kids) if (k !== null) out.append(k); };
  const fail = (e: unknown) => say(el("div", { class: "err" }, String((e as Error).message ?? e)));

  // Every edit of the heirs starts over. What an earlier "Prepare" is still waiting for (the chain, the
  // wallet) belongs to heirs that are no longer on the screen, and must not put anything there or go on.
  let generation = 0;

  /**
   * The heirs and the terms the fields spell; throws on the first thing wrong with them. With
   * `make`, an heir kept private gets a salt if this browser has none for them yet; without, the
   * lack of one is an error, so that nothing but the owner's own press makes a salt.
   */
  const read = (make: boolean): { terms: Terms; heirs: Named[]; made: Set<string> } => {
    if (!isPubkey(first.value)) throw new Error("Enter the first heir's wallet address.");
    const heirs: Named[] = [{ who: "first", address: new PublicKey(first.value.trim()), private: firstPrivate.checked }];
    const hasSecond = second.value.trim() !== "";
    if (hasSecond && !isPubkey(second.value)) throw new Error("The second heir's address is not a valid address.");
    if (!hasSecond && secondPrivate.checked) throw new Error("There is no second heir to keep private: enter their address, or clear the box.");
    let contingentDelaySecs = 0n;
    if (hasSecond) {
      heirs.push({ who: "second", address: new PublicKey(second.value.trim()), private: secondPrivate.checked });
      // one address in both places is one heir, however each place is written into the plan
      if (heirs[1]!.address.equals(heirs[0]!.address)) throw new Error("The second heir is the first heir. A second heir is someone else, for when the first never claims.");
      const d = delay.value.trim();
      if (!/^\d{1,6}$/.test(d)) throw new Error("Enter the second heir's delay as a whole number of days.");
      contingentDelaySecs = BigInt(d) * day;
      if (contingentDelaySecs < limits.min || contingentDelaySecs > limits.max) throw new Error(`The second heir's delay must be between ${limits.min / day} and ${limits.max / day} days.`);
    }
    const made = new Set<string>();
    const ref = (h: Named): HeirRef => {
      if (!h.private) return { kind: "address", address: h.address };
      if (make) { const r = saltFor(ctx.address, h.address); if (r.made) made.add(h.who); return hashedHeir(r.salt, h.address); }
      const kept = keptSalt(ctx.address, h.address);
      if (!kept) throw new Error(`This tab remembers the ${h.who} heir as kept private, and this browser no longer holds their salt. A plan made with that salt can only be found again with it, and the copies that count are on your paper and with the heir. "Prepare the plan" makes a new salt, which is a new plan: the old salt would not fit it.`);
      return hashedHeir(kept.salt, h.address);
    };
    const terms: Terms = { vault: ctx.address, primary: ref(heirs[0]!), contingent: heirs[1] ? ref(heirs[1]) : { kind: "none" }, contingentDelaySecs };
    checkTerms(terms, programs);
    return { terms, heirs, made };
  };

  // the page builds this form anew when the owner switches between the offline signer and this device.
  // the heirs they typed are kept for the tab's lifetime, so the switch does not empty the fields
  const remembered = `lamport-heir-heirs:${ctx.address.toBase58()}`;
  const remember = () => { try { sessionStorage.setItem(remembered, JSON.stringify({ first: first.value, second: second.value, delay: delay.value, firstPrivate: firstPrivate.checked, secondPrivate: secondPrivate.checked })); } catch { /* private mode */ } };
  const recall = () => {
    try {
      const r = JSON.parse(sessionStorage.getItem(remembered) ?? "null");
      if (r && typeof r.first === "string" && typeof r.second === "string" && typeof r.delay === "string") {
        first.value = r.first; second.value = r.second; delay.value = r.delay;
        firstPrivate.checked = r.firstPrivate === true; secondPrivate.checked = r.secondPrivate === true;
        return true;
      }
    } catch { /* nothing kept */ }
    return false;
  };

  /**
   * The salts this browser holds are still the ones in `terms`, and each was written down. Checked
   * again at every step that commits to the plan: between the slip and the signature a browser can
   * have lost what it stored.
   */
  const checkSalts = (terms: Terms, heirs: Named[]) => {
    for (const h of heirs) {
      if (!h.private) continue;
      const kept = keptSalt(ctx.address, h.address);
      if (!kept) throw new Error(`This browser no longer holds the salt of the ${h.who} heir: its data for this page was cleared. Nothing was done. Press "Prepare the plan" again.`);
      if (!kept.written || !heirMatches(h.who === "first" ? terms.primary : terms.contingent, h.address, kept.salt)) throw new Error(`The salt this browser holds for the ${h.who} heir is not the one this plan was prepared with. Nothing was done. Press "Prepare the plan" again.`);
    }
  };

  /** what an owner should know about keeping this address private, given what is already known of it */
  const caveats = (h: Named): string[] => [
    ...(armedOpenly.has(h.address.toBase58()) ? ["This vault's current plan names this address openly, and that plan stays on the chain. A new plan can stop naming them; it cannot take back what is already public."] : []),
    ...(asked.has(h.address.toBase58()) ? ["This page asked the network about this address a moment ago, while the box was clear, so the endpoint may have noted it. From here on it asks nothing more about it."] : []),
  ];

  /** each private heir's salt and fingerprint, for the owner to see again whenever a plan with them is on the screen */
  const privateNotes = (heirs: Named[]): HTMLElement[] => heirs.filter((h) => h.private).map((h) => {
    const salt = keptSalt(ctx.address, h.address)!.salt;
    const printed = formatSalt(salt);
    const print = el("button", { class: "link", type: "button" }, "Print it");
    print.addEventListener("click", () => printSlip(ctx.address, h, salt));
    return el("div", { class: "notice", "data-private": h.who },
      el("div", { style: "margin-bottom:10px" }, `The ${h.who} heir is kept private. This is their salt and the fingerprint the plan holds in place of their address: the same you wrote down. When you sign, the signer shows the fingerprint and cannot tell whose it is; compare it with your paper.`),
      el("dl", { class: "spec", style: "margin-top:0" },
        el("dt", {}, "Salt"), el("dd", { "data-salt-text": h.who }, `${inEights(printed.slice(0, 64))} - ${printed.slice(65)}`),
        el("dt", {}, "Fingerprint"), el("dd", { "data-fingerprint": h.who }, inEights(hex(heirCommitment(salt, h.address))))),
      ...caveats(h).map((c) => el("div", { class: "quiet", style: "font-size:12.5px;margin-top:10px" }, c)),
      el("div", { class: "actions" }, print));
  });

  const ready = (terms: Terms, address: PublicKey, made: boolean, heirs: Named[]) => {
    checkSalts(terms, heirs);
    set(address.toBase58(), termsToJson(terms));
    lock(true);
    say(el("div", { class: "ok" }, `${made ? "The plan was created" : "This plan exists"}: ${address.toBase58()}. Its heirs cannot be changed; other heirs are another plan. Now check the plan below and sign it.`), ...privateNotes(heirs));
  };

  /**
   * Before a plan with a private heir goes any further: the owner writes each salt down, with its
   * fingerprint, and shows it by typing the salt's four check digits. `then` runs once every salt
   * has been written down.
   */
  const slips = (unwritten: Named[], made: Set<string>, g: number, then: () => void) => {
    const rows = unwritten.map((h) => {
      const salt = keptSalt(ctx.address, h.address)!.salt;
      const printed = formatSalt(salt);
      const field = el("input", { class: "mono", "data-slip": h.who, autocomplete: "off", spellcheck: "false", maxlength: "4", style: "max-width:120px" });
      const print = el("button", { class: "link", type: "button" }, "Print it");
      print.addEventListener("click", () => printSlip(ctx.address, h, salt));
      return { h, field, check: printed.slice(65), node: el("div", { class: "notice warn", "data-salt": h.who },
        el("div", { style: "margin-bottom:10px" }, `The ${h.who} heir is kept private. In place of their address the plan holds a fingerprint, made from the address and a salt, and they cannot collect without that salt. ${made.has(h.who) ? "This salt was made just now: no earlier paper or link has it. " : ""}Their own link will carry it to them, and their kit will print it. This browser keeps a copy to find the plan again, which is a convenience and not a safeguard: a private window loses it when it closes, and a browser may clear what a page stored. So write the salt down now, with the fingerprint, or print it. When you sign, the signer shows the fingerprint and cannot tell whose it is, and you compare.`),
        el("dl", { class: "spec", style: "margin-top:0" },
          el("dt", {}, "Salt"), el("dd", { "data-salt-text": h.who }, `${inEights(printed.slice(0, 64))} - ${printed.slice(65)}`),
          el("dt", {}, "Fingerprint"), el("dd", { "data-fingerprint": h.who }, inEights(hex(heirCommitment(salt, h.address))))),
        ...caveats(h).map((c) => el("div", { class: "quiet", style: "font-size:12.5px;margin-top:10px" }, c)),
        el("div", { class: "actions" }, print),
        el("label", { class: "field", style: "margin:12px 0 0" }, el("span", {}, "Written down? Type the four characters after the dash"), field)) };
    });
    const go = el("button", { class: "btn", type: "button", id: "hslipgo" }, unwritten.length > 1 ? "I have written them down" : "I have written it down");
    const err = el("div", { class: "err hidden" });
    say(...rows.map((r) => r.node), el("div", { class: "actions" }, go), err);
    go.addEventListener("click", () => {
      err.classList.add("hidden");
      if (g !== generation) return;
      const wrong = rows.find((r) => r.field.value.trim().toLowerCase() !== r.check);
      if (wrong) { err.textContent = `Those are not the four characters after the dash of the ${wrong.h.who} heir's salt.`; err.classList.remove("hidden"); return; }
      // the salt may have left the browser while the slip was on the screen: then there is nothing to have written down
      try { for (const r of rows) markWritten(ctx.address, r.h.address, `${r.h.who} heir`); }
      catch (e) { fail(e); return; }
      then();
    });
  };

  /**
   * The heirs who still have to accept, and then the plan: created here, or, when `exists`, one
   * that is already on the chain. For a plan this page creates, every heir accepts but a named one
   * who pays for it, whose signature on the transaction is the proof. A plan that somebody already
   * created has its named heirs' proofs on the chain, and nothing about a private heir: the claim
   * program asks nothing of a fingerprint, so anyone holding the terms can have created it. A
   * private heir's acceptance is therefore asked for here whoever made the plan, and they are
   * always sent their link, which is how their salt reaches them.
   */
  const collect = (terms: Terms, address: PublicKey, heirs: Named[], exists: boolean, g: number) => {
    const payer = ctx.wallet?.pubkey;
    const waiting = heirs.filter((h) => (h.private ? keptSalt(ctx.address, h.address)?.acceptedFor !== address.toBase58() : !exists && (!payer || !h.address.equals(payer))));
    const boxes = waiting.map((h) => {
      // an heir kept private gets a link of their own: it carries their salt, which nobody else is sent
      const link = acceptLink(terms, h.private ? keptSalt(ctx.address, h.address)!.salt : undefined);
      const cp = el("button", { class: "link", type: "button" }, "Copy the link");
      cp.addEventListener("click", (e) => void copy(link, e.currentTarget as HTMLButtonElement));
      return { ...h, link, cp, box: el("textarea", { class: "mono", rows: "2", "data-heir": h.address.toBase58(), placeholder: "" }) };
    });
    const create = el("button", { class: "btn primary", type: "button", id: "hcreate" }, exists ? "Use this plan" : "Create the plan");
    const err = el("div", { class: "err hidden" });
    say(
      el("div", { class: "notice" }, exists
        ? "This plan is on the chain already. Whoever created it showed nothing about an heir kept private, so that heir still accepts here: send them their link, and paste what they send back."
        : waiting.length ? "Before the plan is created, each heir shows that the address you wrote down is theirs. Send each their link. Their page says what they are accepting, asks their wallet for a signature that moves nothing, and gives them one line of text to send back to you." : "You are the only heir named, and your wallet is connected: creating the plan is the proof."),
      ...boxes.flatMap((h) => [
        el("div", { class: "notice" },
          el("div", { style: "margin-bottom:10px" }, h.private ? `For the ${h.who} heir, and for nobody else: this link carries their salt. Whoever sees it learns that this address is an heir of this vault; they can take nothing with it.` : `For the ${h.who} heir.`),
          el("div", { class: "mono", "data-link": h.who, style: "font-size:12px;overflow-wrap:anywhere;margin-bottom:10px" }, h.link),
          el("div", { class: "actions" }, h.cp)),
        el("label", { class: "field" }, el("span", {}, `From the ${h.who} heir · ${short(h.address.toBase58(), 6)}`), h.box),
      ]),
      ...privateNotes(heirs),
      el("div", { class: "actions" }, create, exists ? null : el("span", { class: "quiet", style: "font-size:12.5px;color:var(--mute)" }, "your wallet pays for the plan's account, about 0.002 SOL")),
      err);
    create.addEventListener("click", async () => {
      err.classList.add("hidden");
      try {
        if (g !== generation) throw new Error("The heirs were changed after this was prepared. Press \"Prepare the plan\" again.");
        if (!exists && !ctx.wallet) throw new Error("Connect a wallet to pay for the plan's account.");
        checkSalts(terms, heirs);
        const proofs: TransactionInstruction[] = [];
        for (const h of boxes) {
          if (!h.box.value.trim()) throw new Error(`The ${h.who} heir has not accepted yet: paste what they sent back.`);
          const a = readAcceptance(h.box.value, { plan: address, heir: h.address });
          // a named heir's proof goes on chain, where the claim program checks it again. a private heir's stays
          // here: on chain it would publish the address the plan is keeping private
          if (!h.private) proofs.push(acceptanceProofInstruction(a.heir, a.signature, a.signed));
        }
        create.setAttribute("disabled", ""); create.classList.add("spin");
        if (!exists) {
          const { instruction } = initPlanInstruction({ claimProgram: programs.claim, payer: ctx.wallet!.pubkey, terms });
          await ctx.wallet!.send([...proofs, instruction]);
        }
        try { for (const h of boxes) if (h.private) markAccepted(ctx.address, h.address, address, `${h.who} heir`); }
        catch { throw new Error(exists ? "This browser lost a private heir's salt just now. The plan is not handed to the form. Press \"Prepare the plan\" again." : "The plan's account was created, but this browser lost a private heir's salt while your wallet was open, so the plan is not handed to the form. Press \"Prepare the plan\" again: with the salt gone that makes a new salt and a new plan, and the account just created is left unused."); }
        // the heirs on the screen may have changed while the wallet was asked: this plan is then not theirs
        if (g !== generation) return;
        ready(terms, address, !exists, heirs);
      } catch (e) { if (g !== generation) return; err.textContent = String((e as Error).message ?? e); err.classList.remove("hidden"); create.removeAttribute("disabled"); create.classList.remove("spin"); }
    });
  };

  /**
   * `auto`: the form was rebuilt and is putting back what the tab remembers. Nothing the owner did
   * not press for happens then: no salt is made, and the network is asked nothing about an heir.
   */
  const prepare = async (auto: boolean) => {
    const g = ++generation;
    const stale = () => g !== generation;
    try {
      set("", undefined);
      const { terms, heirs, made } = read(!auto);
      prep.setAttribute("disabled", "");
      for (const h of heirs) {
        const why = await heirProblem(h.address, ctx.address, h.who, !h.private && !auto);
        if (stale()) return;
        if (why) throw new Error(why);
      }
      const address = planAddress(terms, programs.claim);
      const go = async () => {
        if (stale()) return;
        try {
          const info = await rpc.getAccountInfo(address, "confirmed");
          if (stale()) return;
          checkSalts(terms, heirs); // the browser may have lost one while the chain was asked
          if (info && info.owner.equals(programs.claim) && isPlan(info.data)) {
            // the plan the vault already releases to was signed for by the owner, heirs and all. any other plan found
            // on the chain says nothing about an heir it keeps private, who still accepts here
            const unaccepted = heirs.some((h) => h.private && keptSalt(ctx.address, h.address)?.acceptedFor !== address.toBase58());
            if (unaccepted && !(armed && s!.claim.equals(address))) collect(terms, address, heirs, true, g);
            else ready(terms, address, false, heirs);
          } else if (info) throw new Error("Something other than a plan is at this plan's address. Do not use it.");
          else collect(terms, address, heirs, false, g);
        } catch (e) { if (!stale()) fail(e); }
      };
      // nothing with a private heir in it is created, found or handed to the form before their salt is on paper
      const unwritten = heirs.filter((h) => h.private && !keptSalt(ctx.address, h.address)!.written);
      if (unwritten.length) slips(unwritten, made, g, () => void go());
      else await go();
    } catch (e) { if (!stale()) fail(e); }
    finally { if (!stale()) prep.removeAttribute("disabled"); }
  };
  prep.addEventListener("click", () => void prepare(false));

  // heirs edited after a plan was prepared are another plan: the form must not keep the old one's address,
  // and whatever an earlier "Prepare" is still waiting for is dropped
  plan.addEventListener("input", (e) => {
    if (e.target === first || e.target === second || e.target === delay || e.target === firstPrivate || e.target === secondPrivate) { generation++; prep.removeAttribute("disabled"); set("", undefined); out.innerHTML = ""; remember(); }
  });
  const sync = () => {
    generation++;
    prep.removeAttribute("disabled");
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
    let armedTerms: Terms | null = null, readable = true;
    if (armed) {
      try {
        const info = await rpc.getAccountInfo(s!.claim, "confirmed");
        if (info && info.owner.equals(programs.claim) && isPlan(info.data)) {
          armedTerms = decodePlan(info.data).terms;
          for (const h of [armedTerms.primary, armedTerms.contingent]) if (h.kind === "address") armedOpenly.add(h.address.toBase58());
        }
      } catch { readable = false; }
    }
    // heirs typed earlier in this tab come back; preparing finds the plan if it was already created
    if (recall() && first.value.trim()) { void prepare(true); return; }
    if (!armed || !readable) return;
    if (!armedTerms) { (mode as HTMLSelectElement).value = "address"; plan.classList.add("hidden"); lock(false); return; }
    // an heir the plan names is shown from the plan; one it keeps private, only if this browser holds their salt
    const kept = keptSalts(ctx.address);
    const show = (h: HeirRef, field: HTMLInputElement, box: HTMLInputElement): boolean => {
      if (h.kind === "none") { field.value = ""; box.checked = false; return true; }
      if (h.kind === "address") { field.value = h.address.toBase58(); box.checked = false; return true; }
      const mine = kept.find((k) => heirMatches(h, k.heir, k.salt));
      if (!mine) return false;
      field.value = mine.heir.toBase58(); box.checked = true;
      return true;
    };
    if (!show(armedTerms.primary, first, firstPrivate) || !show(armedTerms.contingent, second, secondPrivate)) {
      first.value = ""; second.value = ""; firstPrivate.checked = false; secondPrivate.checked = false;
      say(el("p", { class: "quiet" }, "This vault's plan keeps an heir private, and this browser does not hold their salt, so it cannot show who they are. The browser the plan was made in can. Naming heirs here makes a new plan."));
      return;
    }
    if (armedTerms.contingent.kind !== "none") delay.value = String(armedTerms.contingentDelaySecs / day);
    if (armedTerms.vault.equals(ctx.address)) {
      try {
        const { terms, heirs } = read(false);
        if (planAddress(terms, programs.claim).equals(s!.claim)) ready(terms, s!.claim, false, heirs);
      } catch { /* the fields are shown; "Prepare the plan" says what is wrong with them */ }
    }
  });
  return node;
}
