# lamport-heir

Inheritance for [Lamport Vault](https://github.com/Lamport-Robotics/lamport-vault) and
[Pincer1](https://github.com/Lamport-Robotics/pincer1).

If a vault's owner signs nothing and checks in nowhere for a long time, anyone may open a public
waiting period. Any signature or check-in from the owner cancels it. If none comes, the vault
releases to a claim account, and only the heirs the owner named can withdraw from it. The same plan
arms and watches Pincer1's own dead-man's switch for the robot's wallet.

**Status: milestone 4 in progress.** The claim program, the vault's inactivity clock, the finisher,
the claim tool and the claim kit are merged and tested. The app and reminders are being built; the
Pincer1 link does not exist yet. Nothing is deployed. Local validators and devnet only. Nothing in
this repository is audited.

- Spec: [Lamport Heir spec](https://claude.ai/artifact/G1AFWhoqMZqufobPxZRNuC)
- How the spec maps onto the vault and the Pincer1 daemon, and where it does not fit:
  [`docs/design-note.md`](docs/design-note.md)
- What was decided where the spec left a choice: [`docs/decisions.md`](docs/decisions.md)
- The claim program: [`docs/claim-program.md`](docs/claim-program.md)
- Finishing a release and claiming it, the finisher, the claim tool and the claim kit:
  [`docs/release-tools.md`](docs/release-tools.md)
- The pages: the owner's Inheritance tab, the offline signer that checks who inherits, and the
  heirs' page: [`docs/app.md`](docs/app.md)
- The vault side lives in lamport-vault as the `succession` cargo feature, merged in
  [lamport-vault#5](https://github.com/Lamport-Robotics/lamport-vault/pull/5); its reference is
  [`docs/SUCCESSION.md`](https://github.com/Lamport-Robotics/lamport-vault/blob/main/docs/SUCCESSION.md)
  there

```
programs/heir-claim   the claim program: holds what a vault releases, for the heirs named
tools/                the finisher, the claim tool and the claim kit (TypeScript)
app/                  what is served under /heir/: the page, the cold signer, the heirs' page
tests/svm             the built programs in LiteSVM, with a clock the tests can move
kat/                  byte layouts shared by the program and the tools
vendor/lamport-vault  lamport-vault, pinned to one commit (a git submodule)
docs/                 design note, decisions, the claim program, the tools, program ids, models
```

## Build and test

Needs Rust, the Solana tools (agave 2.3.x; `cargo build-sbf` fetches platform-tools v1.56 on first
use) and, for the tools, Node.js 22.18 or later.

```sh
git submodule update --init                                         # lamport-vault, pinned
cargo test --workspace                                              # unit tests
node tools/scripts/build-programs.mjs                               # both programs, into target/deploy*
(cd tests/svm && cargo test)                                        # the built programs in LiteSVM
```

The tools have their own set-up and tests, an end-to-end run on a local validator among them:
[`tools/README.md`](tools/README.md).

The pages are built from the vault's own page and signer (the pinned submodule) plus `app/`:

```sh
(cd vendor/lamport-vault/sdk && npm ci --ignore-scripts && npm run build)
(cd vendor/lamport-vault/web && npm ci --ignore-scripts)
(cd tools && npm ci --ignore-scripts) && cd app && npm ci --ignore-scripts
npm test && npm run build                                           # app/dist/heir/
```

## Milestones

| | ships | state |
|---|---|---|
| M0 | design note; the vault's tests running with the `succession` feature on and off | merged |
| M1 | claim program: `init_plan`, `activate`, `claim_sol`, `claim_token`, optional hashed heirs | merged |
| M2 | Heir-enabled vault: succession state, `SetSuccession`, check-ins, the waiting period, release | merged |
| M3 | permissionless finisher, claim command-line tool, printable claim kit | merged |
| M4 | app and reminder service | in progress |
| M5 | Pincer1 link | not started |
| M6 | audit preparation | not started |

## Rules this is built under

- No admin key, no pause switch, and no off-chain component that can move funds, open a waiting
  period on its own, or shorten a clock. The finisher only finishes what the chain already allows.
- Nothing here asks for, stores, logs or prints a seed phrase or a private key.
- The vault change is a cargo feature of the vault crate, deployed under its own program id. With
  the feature off, the vault builds to exactly the program it is today.
- No change to Pincer1's firmware, controller or daemon.
- The AI parts advise. The model never sets a plan field the owner has not accepted, and never sees
  keys, seeds or balances.

## License

MIT
