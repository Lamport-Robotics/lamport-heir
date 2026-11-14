/**
 * On the owner's Inheritance tab: a letter for the heirs.
 *
 * What no chain can tell them: where other accounts are, who to call, where the papers are. The
 * owner writes it here; it is encrypted in this browser to keys only the heirs can make, and
 * signed by the owner's wallet, so the heirs' page can tell it from anybody else's writing
 * (tools/src/letter.ts). What comes out is a file. No server holds it, and this page keeps no
 * copy of the words.
 *
 * Page only. Nothing here runs when the module loads.
 */
import type { PublicKey } from "@solana/web3.js";
import { copy, el, short } from "../../vendor/lamport-vault/web/src/common.ts";
import type { HeirCtx } from "../../vendor/lamport-vault/web/src/heir-plan.ts";
import type { Terms } from "../../tools/src/claim.ts";
import { letterFileName, letterWarnings, MAX_LETTER_CHARS, readReadingKey, type ReadingKey, writeLetterFile } from "../../tools/src/letter.ts";
import { ownerSigner } from "./owner-wallet.ts";

/** the link an heir opens to make their reading key for the letters `writer` writes under `plan` */
export function readingKeyLink(plan: PublicKey, writer: PublicKey): string {
  return `${location.origin}/heir/claim.html#letter=${plan.toBase58()}&from=${writer.toBase58()}`;
}

/** offers `text` to the browser as a file to save */
function save(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = el("a", { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * `plan` is the plan the vault releases to, as read from the chain: its terms, or null when the
 * vault releases to a plain address (which has nobody to write to but its own holder).
 */
export function letterPanel(ctx: HeirCtx, plan: Promise<Terms | null>): HTMLElement | null {
  const s = ctx.vault.succession;
  if (!s) return null;
  const body = el("div", {});
  const box = el("div", { id: "hletter", style: "margin:22px 0" }, el("div", { class: "eyebrow" }, "A letter for your heirs"),
    el("p", { class: "quiet" }, "What no chain can tell them: where other accounts are, who to call, where the papers are. It is encrypted in this browser so that only your heirs can read it, and signed by your wallet so that they can tell it is yours. Never write a seed phrase or a key in it: say where such a thing is kept, never what it is."),
    body);

  void plan.then((terms) => {
    if (!terms) { box.remove(); return; }
    const heirs: { who: string; address: PublicKey }[] = [];
    if (terms.primary.kind === "address") heirs.push({ who: "first", address: terms.primary.address });
    if (terms.contingent.kind === "address") heirs.push({ who: "second", address: terms.contingent.address });
    if (terms.primary.kind === "hashed" || terms.contingent.kind === "hashed") body.append(el("p", { class: "quiet" }, "An heir kept private cannot be written to from this page: it does not know their address."));
    if (!heirs.length) return;
    if (!ctx.wallet) { body.append(el("p", { class: "quiet" }, "Connect the wallet you pay fees with. It signs the letter, and your heirs make their reading keys for that wallet and no other.")); return; }
    const wallet = ctx.wallet, writer = wallet.pubkey, claim = s.claim;
    const link = readingKeyLink(claim, writer);

    // reading keys are public, and the heirs should not be asked again for every new letter
    const kept = `lamport-heir-reading-keys:${claim.toBase58()}:${writer.toBase58()}`;
    const recall = (): Record<string, string> => { try { const r = JSON.parse(localStorage.getItem(kept) ?? "{}"); return r && typeof r === "object" ? r : {}; } catch { return {}; } };
    const remember = (lines: Record<string, string>) => { try { localStorage.setItem(kept, JSON.stringify(lines)); } catch { /* private mode */ } };
    const had = recall();

    const cp = el("button", { class: "link", type: "button", id: "lcopylink" }, "Copy the link");
    cp.addEventListener("click", (e) => void copy(link, e.currentTarget as HTMLButtonElement));
    const boxes = heirs.map((h) => {
      const field = el("textarea", { class: "mono", rows: "2", "data-reader": h.address.toBase58() });
      const line = had[h.address.toBase58()];
      if (typeof line === "string") field.value = line;
      return { ...h, field };
    });
    const text = el("textarea", { id: "ltext", rows: "10", maxlength: String(MAX_LETTER_CHARS), spellcheck: "true" });
    const seal = el("button", { class: "btn primary", type: "button", id: "lseal" }, "Seal the letter");
    const warn = el("div", { class: "notice warn hidden", id: "lwarn" });
    const err = el("div", { class: "err hidden", id: "lerr" });
    const out = el("div", { id: "lout" });
    body.append(
      el("div", { class: "notice" },
        el("div", { style: "margin-bottom:10px" }, "First, each heir makes a reading key. Send them this link; their page gives them one line of text to send back. The link is for this plan and for the wallet connected here, and a key made from it reads letters signed by this wallet only."),
        el("div", { class: "mono", id: "llink", style: "font-size:12px;overflow-wrap:anywhere;margin-bottom:10px" }, link),
        el("div", { class: "actions" }, cp)),
      ...boxes.map((h) => el("label", { class: "field" }, el("span", {}, `Reading key from the ${h.who} heir · ${short(h.address.toBase58(), 6)}${heirs.length > 1 ? " · leave empty to write to the other heir only" : ""}`), h.field)),
      el("label", { class: "field" }, el("span", {}, "The letter"), text),
      el("p", { class: "quiet", style: "font-size:12.5px" }, "This page keeps no copy of the letter, and nobody can open a sealed one for you: keep your own copy if you want to change it later. An heir who has the sealed file can read it at once, not only after a release. To have it read only later, keep the file with your papers."),
      warn, err, el("div", { class: "actions" }, seal), out);

    // the warnings the owner has read and answered, for exactly this text
    let answered: string | null = null;
    const fail = (e: unknown) => { err.textContent = String((e as Error).message ?? e); err.classList.remove("hidden"); };
    text.addEventListener("input", () => { if (answered !== null && text.value !== answered) { answered = null; warn.classList.add("hidden"); seal.textContent = "Seal the letter"; } });

    seal.addEventListener("click", async () => {
      err.classList.add("hidden"); out.innerHTML = "";
      try {
        const readers: ReadingKey[] = [];
        const lines: Record<string, string> = {};
        for (const h of boxes) {
          const line = h.field.value.trim();
          if (!line) continue;
          try { readers.push(readReadingKey(line, { plan: claim, writer, heir: h.address })); }
          catch (e) { throw new Error(`The ${h.who} heir's reading key: ${String((e as Error).message ?? e)}`); }
          lines[h.address.toBase58()] = line;
        }
        if (!readers.length) throw new Error("No heir has a reading key here yet. Send them the link above and paste what they send back.");
        remember(lines);
        const letter = text.value;
        if (!letter.trim()) throw new Error("The letter is empty.");
        const reasons = letterWarnings(letter);
        if (reasons.length && answered !== letter) {
          warn.replaceChildren(...reasons.map((r) => el("div", { style: "margin-bottom:8px" }, r)), el("div", {}, "If none of this is in the letter, press the button again. If it is, take it out first: a letter lies about for years."));
          warn.classList.remove("hidden");
          answered = letter;
          seal.textContent = "There is no phrase and no key in it. Seal it";
          return;
        }
        seal.setAttribute("disabled", ""); seal.classList.add("spin");
        const sealedAt = new Date();
        const file = await writeLetterFile(ownerSigner(wallet), { letter, plan: claim, writer, readers, sealedAt });
        const name = letterFileName(claim, sealedAt);
        const shown = el("textarea", { class: "mono", id: "lfile", rows: "4", readonly: "" }); shown.value = file;
        const dl = el("button", { class: "btn", type: "button", id: "lsave" }, "Save the file");
        const cpf = el("button", { class: "link", type: "button" }, "Copy as text");
        dl.addEventListener("click", () => save(name, file));
        cpf.addEventListener("click", (e) => void copy(file, e.currentTarget as HTMLButtonElement));
        out.replaceChildren(
          el("div", { class: "ok", id: "lsealed" }, `Sealed for ${readers.length === 1 ? "one heir" : "both heirs"}, and signed by ${short(writer.toBase58(), 6)}. Nobody else can read it, and nobody else could have made it.`),
          el("label", { class: "field", style: "margin-top:14px" }, el("span", {}, name), shown),
          el("div", { class: "actions" }, dl, cpf),
          el("p", { class: "quiet", style: "font-size:12.5px" }, "Give the file to your heirs, or keep it where they will look. They open it on the heirs' page, under Family letter, with the wallet that made their reading key. A newer letter does not undo an older one: tell them which is the last."));
      } catch (e) { fail(e); }
      finally { seal.removeAttribute("disabled"); seal.classList.remove("spin"); }
    });
  }).catch(() => { body.append(el("p", { class: "quiet" }, "The plan could not be read just now; reload to try again.")); });
  return box;
}
