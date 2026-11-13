# lamport-heir

Inheritance for [Lamport Vault](https://github.com/Lamport-Robotics/lamport-vault) and
[Pincer1](https://github.com/Lamport-Robotics/pincer1).

If a vault's owner signs nothing and checks in nowhere for a long time, anyone may open a public
waiting period. Any signature or check-in from the owner cancels it. If none comes, the vault
releases to a claim account, and only the heirs the owner named can withdraw from it. The same plan
arms and watches Pincer1's own dead-man's switch for the robot's wallet.

**Status: milestone 0. There is no Heir code here yet.** Local validators and devnet only. Nothing
in this repository is audited.

- Spec: [Lamport Heir spec](https://claude.ai/artifact/G1AFWhoqMZqufobPxZRNuC)
- How the spec maps onto the vault and the Pincer1 daemon, and where it does not fit:
  [`docs/design-note.md`](docs/design-note.md)
- The vault side lives in lamport-vault as the `succession` cargo feature:
  [lamport-vault#4](https://github.com/Lamport-Robotics/lamport-vault/pull/4)

## Milestones

| | ships | state |
|---|---|---|
| M0 | design note; the vault's tests running with the `succession` feature on and off | in review |
| M1 | claim program: `init_plan`, `activate`, `claim_sol`, `claim_token`, optional hashed heirs | not started |
| M2 | Heir-enabled vault: succession state, `SetSuccession`, check-ins, the waiting period, release | not started |
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
