/**
 * The claim kit: one printable page an owner hands to an heir, with everything the heir needs to
 * claim without Lamport and without the owner.
 *
 * It holds addresses, the plan's terms and, for an heir kept private by a salted hash, the salt.
 * It holds no key and no seed phrase, and it has no field one could go in: whoever finds this
 * page cannot take funds with it. It does tell them the vault exists and who inherits.
 *
 * `renderKit` checks the page against the terms before it prints anything, because a kit with a
 * wrong address or a wrong salt is worse than no kit: the heir learns it only when they claim.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { type PublicKey } from "@solana/web3.js";
import QRCode from "qrcode";
import { heirMatches, planAddress, type Terms } from "./claim.ts";
import { type Programs } from "./programs.ts";

export interface KitInput {
  /** Who the page is for, in the owner's words. Printed as given. */
  heirLabel?: string;
  /** The cluster's name, as printed: "devnet", "mainnet-beta". */
  cluster: string;
  /** An RPC endpoint to put in the commands. The heir may use any other. */
  rpcUrl: string;
  programs: Programs;
  vault: PublicKey;
  /** the address the vault releases to */
  claim: PublicKey;
  /** when the claim address is a plan of the claim program: its terms */
  terms?: Terms;
  /** the address whose key this heir holds */
  heirAddress: PublicKey;
  /** for an heir named by a salted hash: the salt. The claim needs it, and nobody else has it. */
  salt?: Uint8Array;
  /** the vault's inactivity window and waiting period, as set when this is printed */
  windowSecs: bigint;
  waitSecs: bigint;
  printedAt: Date;
  /** where the tools come from, and at which commit this page was made */
  source: { repository: string; commit: string };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * A salt as the kit prints it: 64 hex digits, a dash, and 4 check digits (the first two bytes of
 * its SHA-256). The check lets the claim tool catch a mistyped salt before it looks like "you are
 * not an heir".
 */
export function formatSalt(salt: Uint8Array): string {
  if (salt.length !== 32) throw new RangeError(`a salt is 32 bytes, got ${salt.length}`);
  return `${hex(salt)}-${hex(sha256(salt).slice(0, 2))}`;
}

/** Reads a salt as printed by {@link formatSalt}, with or without spaces and the check digits. */
export function parseSalt(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "").toLowerCase();
  const m = /^([0-9a-f]{64})(?:-([0-9a-f]{4}))?$/.exec(clean);
  if (!m) throw new Error("a salt is 64 hex digits, optionally followed by a dash and 4 check digits");
  const salt = Uint8Array.from(m[1]!.match(/../g)!, (b) => parseInt(b, 16));
  if (m[2] !== undefined && m[2] !== hex(sha256(salt).slice(0, 2))) throw new Error("the salt's check digits do not match: one of its digits is mistyped");
  return salt;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A QR code as inline SVG: one path, no external resource, sharp on paper. */
function qr(text: string, sizeMm: number): string {
  const code = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = code.modules.size;
  const quiet = 4;
  let d = "";
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (code.modules.get(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  const total = n + 2 * quiet;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${sizeMm}mm" height="${sizeMm}mm" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function days(secs: bigint, programs: Programs): string {
  const whole = secs / programs.daySecs;
  const unit = programs.daySecs === 86_400n ? "day" : "test-day";
  return secs % programs.daySecs === 0n ? `${whole} ${unit}${whole === 1n ? "" : "s"}` : `${secs} seconds`;
}

function group(text: string, size: number): string {
  return text.match(new RegExp(`.{1,${size}}`, "g"))!.join(" ");
}

/**
 * What this heir is in the plan, checked against the terms. Throws when the page would be wrong:
 * terms for another vault or another plan address, or an heir (or salt) the terms do not name.
 */
export function kitRole(input: Pick<KitInput, "programs" | "vault" | "claim" | "terms" | "heirAddress" | "salt">): "sole" | "primary" | "contingent" {
  if (!input.terms) {
    if (!input.claim.equals(input.heirAddress)) throw new Error(`the vault releases to ${input.claim.toBase58()}, which is not this heir's address and not a plan whose terms were given`);
    if (input.salt) throw new Error("a salt belongs to a plan with hashed heirs; this vault releases straight to an address");
    return "sole";
  }
  if (!input.terms.vault.equals(input.vault)) throw new Error("the plan's terms are for another vault");
  if (!planAddress(input.terms, input.programs.claim).equals(input.claim)) throw new Error("the vault does not release to the plan these terms describe");
  if (heirMatches(input.terms.primary, input.heirAddress, input.salt)) return "primary";
  if (heirMatches(input.terms.contingent, input.heirAddress, input.salt)) return "contingent";
  const hashed = input.terms.primary.kind === "hashed" || input.terms.contingent.kind === "hashed";
  throw new Error(hashed ? "the terms do not name this address with this salt (a hashed heir needs the salt it was committed with)" : "the terms do not name this address");
}

/** The claim kit as one self-contained HTML page: no script, no font, no image fetched from anywhere. */
export function renderKit(input: KitInput): string {
  const role = kitRole(input);
  const hashedHeir = input.terms !== undefined && (role === "primary" ? input.terms.primary : input.terms.contingent).kind === "hashed";
  if (hashedHeir && !input.salt) throw new Error("this heir is named by a salted hash: the kit must print the salt");
  const vault = input.vault.toBase58();
  const claim = input.claim.toBase58();
  const heir = input.heirAddress.toBase58();
  const salt = input.salt ? formatSalt(input.salt) : undefined;
  const test = input.programs.daySecs !== 86_400n;
  const tool = "node src/cli.ts";
  const rpc = `--rpc ${input.rpcUrl}`;
  const claimCommand = `${tool} claim ${vault} --keypair YOUR-KEY-FILE${salt ? ` --salt ${salt}` : ""} ${rpc}`;

  const roleText =
    role === "sole"
      ? "You are the heir. When the vault releases, its funds go straight to your address."
      : role === "primary"
        ? "You are the primary heir. When the vault releases, you can claim at once."
        : `You are the contingent heir. You can claim if the primary heir has not claimed for ${days(input.terms!.contingentDelaySecs, input.programs)} after the release.`;

  const rows: [string, string][] = [
    ["Network", esc(input.cluster)],
    ["Vault", `<code>${esc(vault)}</code>`],
    ...(input.terms ? ([["Plan (holds the funds for the heirs)", `<code>${esc(claim)}</code>`]] as [string, string][]) : []),
    ["Your address", `<code>${esc(heir)}</code>${hashedHeir ? " (not published: the plan stores only a hash of it)" : ""}`],
    ["The owner must be silent for", esc(days(input.windowSecs, input.programs))],
    ["Then the public waiting period lasts", esc(days(input.waitSecs, input.programs))],
    ...(role !== "sole" && input.terms!.contingent.kind !== "none"
      ? ([["The contingent heir may claim after", `${esc(days(input.terms!.contingentDelaySecs, input.programs))} without a claim by the primary heir`]] as [string, string][])
      : []),
    ["Vault program", `<code>${esc(input.programs.vault.toBase58())}</code>`],
    ...(input.terms ? ([["Claim program", `<code>${esc(input.programs.claim.toBase58())}</code>`]] as [string, string][]) : []),
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lamport Heir claim kit</title>
<style>
  @page { margin: 16mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.45 Georgia, "Times New Roman", serif; color: #000; background: #fff; max-width: 178mm; margin: 0 auto; padding: 8mm 4mm; }
  h1 { font-size: 20pt; margin: 0 0 1mm; }
  h2 { font-size: 12.5pt; margin: 7mm 0 2mm; border-bottom: 0.3mm solid #000; padding-bottom: 1mm; }
  p { margin: 0 0 2.5mm; }
  code, pre { font: 9pt/1.4 "SF Mono", Menlo, Consolas, monospace; word-break: break-all; }
  pre { border: 0.3mm solid #000; padding: 2.5mm; margin: 0 0 3mm; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 3mm; }
  th, td { text-align: left; vertical-align: top; padding: 1.2mm 2mm 1.2mm 0; border-bottom: 0.2mm solid #999; }
  th { width: 34%; font-weight: normal; }
  ol { margin: 0 0 3mm; padding-left: 6mm; }
  li { margin-bottom: 1.5mm; }
  .lede { font-size: 11.5pt; }
  .warn { border: 0.5mm solid #000; padding: 3mm; margin: 0 0 3mm; }
  .codes { display: flex; gap: 6mm; flex-wrap: wrap; margin: 0 0 3mm; }
  .codes figure { margin: 0; text-align: center; font-size: 8.5pt; }
  .salt { font: 11pt/1.6 "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.3pt; }
  .small { font-size: 8.5pt; color: #333; }
  h2, .warn, table, pre, .codes { break-inside: avoid; }
</style>
</head>
<body>
<h1>Lamport Heir claim kit</h1>
<p class="lede">${input.heirLabel ? `For ${esc(input.heirLabel)}. ` : ""}Keep this page. It tells you how to collect what a Lamport Vault leaves you, with no help from its owner or from Lamport.</p>
${test ? `<div class="warn"><strong>Test kit.</strong> This vault runs on a test build in which a "day" lasts one second. It holds nothing of value.</div>` : ""}

<h2>What this is</h2>
<p>The owner of the vault below has named you to inherit it. Nothing happens while they are active. If they sign nothing and check in nowhere for the time shown, anyone may start a public waiting period. If the owner does not cancel it, the vault is released when that period ends, and you can claim.</p>
<p><strong>${esc(roleText)}</strong></p>
<p>This page is not a key. Nobody can take the funds with it. It does show that the vault exists and that you inherit it, so keep it where you keep other private papers.</p>

<h2>The facts</h2>
<table>
${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("\n")}
</table>
<div class="codes">
<figure>${qr(vault, 30)}<br>Vault address</figure>
${input.terms ? `<figure>${qr(claim, 30)}<br>Plan address</figure>` : ""}
${salt ? `<figure>${qr(salt, 34)}<br>Your salt</figure>` : ""}
</div>
${
  salt
    ? `<div class="warn"><p><strong>Your salt.</strong> The plan does not publish your address. It stores a hash of your address and this salt, and your claim must show the salt. Without it you cannot claim, and nobody can recover it for you. The last four digits are a check against typing mistakes.</p><p class="salt">${esc(group(salt.slice(0, 64), 8))} - ${esc(salt.slice(65))}</p></div>`
    : ""
}

<h2>What you need</h2>
<ol>
<li>This page.</li>
<li>The key for your address above, as a key file on your own computer. The claim is signed with it. Never give that key, or the words it was made from, to anyone: nobody needs them to help you, and the tool never asks for them.</li>
<li>A computer with Node.js (version 22.18 or later) and git.</li>
<li>A small amount of SOL in your address for fees and for opening your own token accounts: about 0.02 SOL, more if the vault holds many kinds of token. Most of it comes back when the claim finishes.</li>
</ol>

<h2>How to claim</h2>
<ol>
<li>Get the tools. They are open source; if this address has moved, search for "lamport-heir".
<pre>git clone ${esc(input.source.repository)}
cd lamport-heir
git submodule update --init
(cd vendor/lamport-vault/sdk &amp;&amp; npm ci &amp;&amp; npm run build)
cd tools &amp;&amp; npm ci</pre></li>
<li>See where the vault stands. This reads public data and needs no key.
<pre>${esc(`${tool} status ${vault} ${rpc}`)}</pre></li>
<li>If it says the owner's time has run out and no waiting period is open, you may open it. Do this only if you believe the owner is gone. It moves nothing, and the owner can cancel it.
<pre>${esc(`${tool} start ${vault} --keypair YOUR-KEY-FILE ${rpc}`)}</pre></li>
<li>When the waiting period is over, claim. Replace YOUR-KEY-FILE with the path of your key file. The tool finishes the release if nobody has, collects every token, and sends everything to your address. It lists anything that could not be moved and why. Running it again is safe.
<pre>${esc(claimCommand)}</pre></li>
</ol>

<h2>If Lamport is gone</h2>
<p>Nothing above depends on Lamport. The vault and the plan are programs on the Solana network. The tools talk to any Solana RPC endpoint: replace the one after <code>--rpc</code> with any other. The addresses on this page are all the tools need to find the vault.</p>

<p class="small">Printed ${esc(input.printedAt.toISOString().slice(0, 10))} from ${esc(input.source.repository)} at commit ${esc(input.source.commit)}. The terms can change if the owner signs a new plan; this page describes them as they were on that day.</p>
</body>
</html>
`;
}
