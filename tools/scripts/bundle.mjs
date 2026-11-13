// Builds dist/lamport-heir.mjs: the whole command-line tool in one file, for someone who has
// Node.js and nothing else. `node lamport-heir.mjs help`.
//
// The build is plain esbuild: every dependency is inlined, nothing is fetched when the file runs.
// CI prints the file's sha256 for the commit it was built from.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = fileURLToPath(new URL("../dist/lamport-heir.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  // optional native speed-ups of a websocket library the tool never opens a socket with
  external: ["bufferutil", "utf-8-validate"],
  // some dependencies are CommonJS and call require(); an ES module has to be given one
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "warning",
});
const bytes = readFileSync(out);
console.log(`${out}\n  ${bytes.length} bytes\n  sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
