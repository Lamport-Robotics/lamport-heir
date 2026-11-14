import { defineConfig } from "vitest/config";
import { heirAlias, heirDefine } from "../vendor/lamport-vault/web/vite.heir.config.ts";

// The tests see the SDK the way the Heir build does: the vault's own shim in the SDK's place
// (vendor/lamport-vault/web/src/heir-sdk.ts) and the build's constants set.
export default defineConfig({
  define: { ...heirDefine, __APP_BUILD__: '"test"' },
  resolve: { alias: heirAlias, dedupe: ["@solana/web3.js"] },
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
