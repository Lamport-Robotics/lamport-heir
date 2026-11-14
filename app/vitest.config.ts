import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { heirAlias, heirDefine } from "../vendor/lamport-vault/web/vite.heir.config.ts";

// The tests see what the built signer sees: the vault's own shim in the SDK's place
// (vendor/lamport-vault/web/src/heir-sdk.ts), the build's constants, and this repository's module
// in the seam the vault's request code leaves (./heir-ext.ts), as build.mjs puts it for the signer.
export default defineConfig({
  define: { ...heirDefine, __APP_BUILD__: '"test"' },
  resolve: {
    alias: [
      ...Object.entries(heirAlias).map(([find, replacement]) => ({ find, replacement })),
      { find: /^\.\/heir-ext\.ts$/, replacement: fileURLToPath(new URL("./src/ext-signer.ts", import.meta.url)) },
    ],
    dedupe: ["@solana/web3.js"],
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
