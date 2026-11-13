import { defineConfig } from "vitest/config";

// The end-to-end run: the built programs on a local validator, the tools against its RPC.
// `e2e/validator.ts` starts and stops the validator around the whole run.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    globalSetup: ["e2e/validator.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // keep what the tools print: the run's log is then a transcript of a release and three claims
    silent: false,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
