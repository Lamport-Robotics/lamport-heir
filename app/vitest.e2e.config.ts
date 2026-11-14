import { defineConfig } from "vitest/config";

// The pages in a real browser, against the built programs on a local validator. The validator is
// the one the tools' end-to-end run uses (tools/e2e/validator.ts): both `short-clocks` test
// programs at their ids. `npm run build:programs` in tools/ has to have run.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    globalSetup: ["../tools/e2e/validator.ts"],
    testTimeout: 1_200_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
