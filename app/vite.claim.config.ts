import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { heirAlias, heirDefine } from "../vendor/lamport-vault/web/vite.heir.config.ts";

// The heirs' page. It shares the vault page's styles and the tools' reading of the chain, and is
// served beside the Heir build of the vault page, under /heir/.
const commit = (() => { try { return execSync("git rev-parse --short=10 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "unknown"; } })();
const rpc = process.env.HEIR_RPC ?? "";
const testEndpoint = { name: "heir-test-endpoint", transformIndexHtml: (html: string) => (rpc ? html.replace("https://api.devnet.solana.com wss://api.devnet.solana.com", `${rpc} ${rpc.replace(/^http/, "ws").replace(/:(\d+)$/, (_m, p) => `:${Number(p) + 1}`)}`) : html) };

export default defineConfig({
  plugins: [testEndpoint],
  base: "/heir/",
  publicDir: fileURLToPath(new URL("../vendor/lamport-vault/web/public", import.meta.url)),
  build: { outDir: "dist/claim-tmp", target: "es2022", sourcemap: false, rollupOptions: { input: { claim: "claim.html" } } },
  define: { ...heirDefine, __APP_BUILD__: JSON.stringify(commit) },
  resolve: { alias: heirAlias, dedupe: ["@solana/web3.js"] },
});
