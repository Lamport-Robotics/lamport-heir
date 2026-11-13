# Decisions

The [design note](design-note.md) ended with eight findings that needed a decision. On 2026-11-13
the project owner left them to the builder ("just make decisions and keep working"), and asked that
nothing conflict with Pincer1's own dead-man's switch. Each was decided as the note recommended.
The note has the reasoning; this file is the record.

Any of these can be reversed. Where reversing gets expensive later, it says so.

| # | decision | where it departs from the spec |
|---|---|---|
| 1 | **The Pincer1 link runs on the robot.** A command-line tool from this repository, run on the robot's computer, talks to the daemon on `127.0.0.1`. The daemon is not changed. | The spec has a paired phone app arm and read the switch. The daemon does not allow that. |
| 2 | **Plan changes are not queued.** Every `SetSuccession` applies at once. The protection is the clock: nothing is released sooner than `window + wait` after any signed action, at least 120 days. The app shows that date after a change. | The spec queues a new heir or a shorter clock for 30 days. The queue changes no outcome (note, section 4.4; `models/queue_vs_immediate.py`). The spec's test "a queued change has no effect for 30 days" is replaced by the 120-day property. |
| 3 | **`execute_succession` has its own copy of the `Close` path**, held to the original by a test that both leave identical accounts. | The spec says it runs the existing path. Sharing the code would change the vault's bytes. |
| 4 | **The vault SDK, the vault page and the cold signer learn `SetSuccession`** and the second program id, in the milestone 2 pull request to lamport-vault. | The spec assumed the existing signing flow could already sign it. |
| 5 | **Clock tests run in LiteSVM. Devnet runs a `short-clocks` build** that scales every duration down and carries its own program id, so it can never be deployed as the real program. | The spec's gates ask for clock jumps on a local validator and short durations on devnet. |
| 6 | **An heir proves control in one of two ways:** by signing the `init_plan` transaction, as the spec says, or by signing a message that names the plan, which `init_plan` checks through Solana's Ed25519 program. Hashed heirs prove control to the owner's app, off chain. | The spec has only the first. It needs every heir online in the same minute, and it publishes the heir. |
| 7 | **The contact's extension moves the deadline to `max(deadline, now) + 90 days` and ends the next time the owner is active.** A `SetSuccession` that names a contact key lets that contact extend once more. | The spec adds 90 days to every later deadline for good. |
| 8 | **Local tests use program ids that have no private key.** Devnet ids come from keypairs the project owner generates and keeps; they are needed at milestone 4. | None. |

Smaller choices made under the same instruction:

- Replacing or removing the check-in key or the contact key applies at once.
- A check-in past the two-year cap fails with its own error code. It cannot be both accepted and an
  error.
- Besides the vault itself, the default address and executable accounts, a claim address is refused
  when it is owned by a Token program, the sysvar program or the native loader. Another vault is
  allowed.
- Window and wait are capped at 100 years.
- The claim program has the Heir-enabled vault's program id compiled in. It does not take it from a
  plan's terms.
- The contingent delay counts from the moment `activate` runs, which anyone may call once the vault
  is closed.
- The repositories this one builds on are carried as git submodules pinned to one commit.
- MIT license, as in the other Lamport repositories.

## Milestone 1, the claim program

Choices the spec did not make, taken while building it. [`claim-program.md`](claim-program.md)
describes the result.

- **The contingent heir's wait restarts when the primary heir claims.** The spec says the contingent
  heir may claim "if the primary hasn't claimed within a year". Read literally, a primary who claimed
  the SOL and then lost their key would leave a forgotten token stuck for ever, and a contingent heir
  with no restart could take what a slow but living primary had not got to yet. With the restart, a
  primary who is still claiming keeps the contingent heir out, and a primary who stops leaves the rest
  to them after the delay.
- **The contingent delay is at least 30 days and at most 100 years.** The spec gives a default of one
  year and no bounds. A delay of zero would let both heirs race for the release.
- **`init_plan` requires the vault to be an open vault of the Heir-enabled vault program.** A
  mistyped vault address fails at once instead of producing a plan that can never activate.
- **Tokens are claimed only into a token account the claiming heir owns.** The spec says heirs
  withdraw "to their own address"; the program holds them to it.
- **Closing a claimed token account is the caller's choice** (`close_account`), because Token-2022
  refuses to close an account with withheld transfer fees. The tokens are never held hostage to the
  close.
- **A hashed heir is `sha256("lamport-heir/heir/v1" || salt || address)`** with a 32-byte salt, and
  claims by passing the salt.
- **The acceptance message is plain text naming the plan's address**, and is accepted bare or inside
  an off-chain message envelope, so software and hardware wallets can both sign it.
- **The claim program is built with `cargo build-sbf` and tested in LiteSVM**, as lamport-vault's
  `execute_direct` tests are. It does not use the Anchor command-line tool; an IDL can be generated
  later if a client wants one.

## From the project owner

- **2026-11-13: Heir's app is a page of the vault site, `vault.lamportrobotics.com/heir`**, not a
  site of its own. Being on the vault page's origin, it shares that page's signing flow and its
  record of which one-time signing keys have been used, and the check-in key it keeps in the
  browser belongs to that origin.

## Still the project owner's

- Devnet keypairs and devnet deployment (milestone 4).
- Anything on mainnet, and any real funds.
- Counsel on estates, money transmission and wording, before anyone outside is told to rely on this.
- Merging. The builder opens draft pull requests and does not merge them.
