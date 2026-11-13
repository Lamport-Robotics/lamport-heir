// Builds the programs the tests load, with `cargo build-sbf` (Agave's tools on the PATH):
//
//   target/deploy/                heir_claim.so, and lamport_vault.so with `succession`
//   target/deploy-short-clocks/   both as `short-clocks` test builds, for the end-to-end run
//
// The vault is built from the pinned submodule in vendor/lamport-vault.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = (dir) => `${root}target/${dir}`;
const builds = [
  ["programs/heir-claim/Cargo.toml", [], "deploy"],
  ["vendor/lamport-vault/programs/lamport-vault/Cargo.toml", ["--features", "succession"], "deploy"],
  ["programs/heir-claim/Cargo.toml", ["--features", "short-clocks"], "deploy-short-clocks"],
  ["vendor/lamport-vault/programs/lamport-vault/Cargo.toml", ["--features", "short-clocks"], "deploy-short-clocks"],
];
for (const [manifest, features, dir] of builds) {
  console.log(`\n== ${manifest} ${features.join(" ")} -> target/${dir}`);
  execFileSync("cargo", ["build-sbf", "--manifest-path", manifest, ...features, "--sbf-out-dir", out(dir), "--", "--locked"], { cwd: root, stdio: "inherit" });
}
