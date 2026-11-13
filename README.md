# lamport-heir

Inheritance for [Lamport Vault](https://github.com/Lamport-Robotics/lamport-vault) and
[Pincer1](https://github.com/Lamport-Robotics/pincer1).

If a vault's owner signs nothing and checks in nowhere for a long time, anyone may open a public
waiting period. Any signature or check-in from the owner cancels it. If none comes, the vault
releases to a claim account, and only the heirs the owner named can withdraw from it. The same plan
arms and watches Pincer1's own dead-man's switch for the robot's wallet.

**Status: milestone 2.** The claim program and the vault's inactivity clock exist and are tested,
each in a draft pull request; the tools and the app do not exist yet. Nothing is deployed. Local
validators and devnet only. Nothing in this repository is audited.

- Spec: [Lamport Heir spec](https://claude.ai/artifact/G1AFWhoqMZqufobPxZRNuC)
- How the spec maps onto the vault and the Pincer1 daemon, and where it does not fit:
  [`docs/design-note.md`](docs/design-note.md)
- What was decided where the spec left a choice: [`docs/decisions.md`](docs/decisions.md)
- The claim program: [`docs/claim-program.md`](docs/claim-program.md)
- The vault side lives in lamport-vault as the `succession` cargo feature:
  [lamport-vault#4](https://github.com/Lamport-Robotics/lamport-vault/pull/4) (the feature and its
  CI) and [lamport-vault#5](https://github.com/Lamport-Robotics/lamport-vault/pull/5) (the clock);
  its reference is `docs/SUCCESSION.md` there

```
programs/heir-claim   the claim program: holds what a vault releases, for the heirs named
tests/svm             the built program in LiteSVM, with a clock the tests can move
docs/                 design note, decisions, the claim program, program ids, models
```

## Build and test

Needs Rust and the Solana tools (agave 2.3.x; `cargo build-sbf` fetches platform-tools v1.56 on first
use).

```sh
cargo test --workspace                                              # unit tests
cargo build-sbf --manifest-path programs/heir-claim/Cargo.toml     # target/deploy/heir_claim.so
cd tests/svm && cargo test                                          # the built program in LiteSVM
```

## Milestones

| | ships | state |
|---|---|---|
| M0 | design note; the vault's tests running with the `succession` feature on and off | in review |
| M1 | claim program: `init_plan`, `activate`, `claim_sol`, `claim_token`, optional hashed heirs | in review |
| M2 | Heir-enabled vault: succession state, `SetSuccession`, check-ins, the waiting period, release | in review |
| M3 | permissionless finisher, claim command-line tool, printable claim kit | not started |
| M4 | app and reminder service | not started |
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
