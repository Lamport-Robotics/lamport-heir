// Builds everything Lamport Heir serves under /heir/ on the vault's site, into dist/heir/:
//
//   index.html    the vault page, built for the Heir-enabled program, with this repository's
//                 module in the seam the vault leaves (src/ext.ts): heirs, the check-in key, kits
//   signer.html   the cold signer, the same way, with src/ext-signer.ts: it can derive a plan's
//                 address from the heirs a request names. One file, no network.
//   claim.html    the page for heirs
//
// The page and the signer are the vault's own source (vendor/lamport-vault/web, pinned) and the
// vault's own build configuration; this script only adds the alias for the seam.
//
//   HEIR_CLOCK=short   build for the short-clocks test programs (a day lasts a second)
//   HEIR_RPC=<url>     a test build that talks to another endpoint (a local validator)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const web = at("../vendor/lamport-vault/web/");
const out = at("./dist/heir/");
const tmp = at("./dist/tmp/");
const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: at("./"), stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "unknown"; } })();
const seam = (file) => [{ find: /^\.\/heir-ext\.ts$/, replacement: at(file) }];
const shared = { define: { __APP_BUILD__: JSON.stringify(commit) }, logLevel: "warn" };

rmSync(at("./dist"), { recursive: true, force: true });

// the vault's configuration names its entry pages relative to its own folder
process.chdir(web);
await build({ ...shared, configFile: `${web}vite.heir.config.ts`, root: web, resolve: { alias: seam("./src/ext.ts"), dedupe: ["@solana/web3.js"] }, build: { outDir: out, emptyOutDir: true } });

await build({ ...shared, configFile: `${web}vite.heir.signer.config.ts`, root: web, resolve: { alias: seam("./src/ext-signer.ts"), dedupe: ["@solana/web3.js"] }, build: { outDir: `${tmp}signer`, emptyOutDir: true } });
execFileSync(process.execPath, [`${web}csp-signer.mjs`, `${tmp}signer/signer.html`], { stdio: "inherit" });
cpSync(`${tmp}signer/signer.html`, `${out}signer.html`);

process.chdir(at("./"));
await build({ ...shared, configFile: at("./vite.claim.config.ts"), root: at("./"), build: { outDir: `${tmp}claim`, emptyOutDir: true } });
cpSync(`${tmp}claim/claim.html`, `${out}claim.html`);
cpSync(`${tmp}claim/assets`, `${out}assets`, { recursive: true });
rmSync(tmp, { recursive: true, force: true });

// The signer is the file that sees the 24 words. It must hold no code that talks to a network
// (its CSP would stop such code anyway), and it must know how to check a plan.
const signer = readFileSync(`${out}signer.html`, "utf8");
for (const word of ["sendRawTransaction", "getAccountInfo", "indexedDB.open(\"lamport-heir\"", "claim.html"]) {
  if (signer.includes(word)) throw new Error(`the signer's bundle contains "${word}": page code leaked into it`);
}
for (const word of ["first heir", "SetSuccession"]) {
  if (!signer.includes(word)) throw new Error(`the signer's bundle lacks "${word}": it was not built as the Heir signer`);
}

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
console.log(`\ndist/heir/ at ${commit}${process.env.HEIR_CLOCK === "short" ? "  (short-clocks TEST build)" : ""}${process.env.HEIR_RPC ? `  (TEST endpoint ${process.env.HEIR_RPC})` : ""}`);
for (const f of ["index.html", "signer.html", "claim.html"]) console.log(`  ${f.padEnd(12)} sha256 ${sha(`${out}${f}`)}`);
console.log(`  assets/      ${readdirSync(`${out}assets`).length} files`);
