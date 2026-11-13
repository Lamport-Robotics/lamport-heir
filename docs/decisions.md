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
| 4 | **The vault SDK, the vault page and the cold signer learn `SetSuccession`** and the second program id. The SDK does in the milestone 2 pull request to lamport-vault; the page and the cold signer follow in milestone 4, with the `/heir` page they serve (see "Milestone 2" below). | The spec assumed the existing signing flow could already sign it. |
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

## Milestone 2, the vault's clock

Choices taken while building the `succession` feature. lamport-vault's
[`docs/SUCCESSION.md`](https://github.com/Lamport-Robotics/lamport-vault/blob/main/docs/SUCCESSION.md)
describes the result once the pull request is merged; until then it is in
[lamport-vault#5](https://github.com/Lamport-Robotics/lamport-vault/pull/5).

- **The vault page and the cold signer wait for milestone 4.** Decision 4 put them in this
  milestone. They are the signing flow of the `/heir` page, which is milestone 4, and a page that
  offers an action of a program that is deployed nowhere helps nobody. The SDK part is done here,
  so the page change is a matter of showing the action in words and passing the program id.
- **Succession's errors are written out by hand, 6100 to 6116.** The design note planned a second
  `#[error_code(offset = 6100)]` enum. Anchor's IDL holds one error list per program, and the
  second enum replaced the vault's 38 errors there, so a client of the feature build would have
  lost the names of the vault's own errors. The hand-written type leaves the IDL's list as it is;
  the SDK and the shared vectors carry the new codes.
- **`short-clocks` makes one day last one second.** The note proposed dividing every duration by a
  factor. Redefining the day keeps every rule and every number in the code the same (90, 30, 730),
  so the test build cannot drift from the real one. It has its own program id.
- **The SDK's `encodeAction` and `decodeAction` are unchanged** and still refuse variant 5.
  `encodeHeirAction` and `decodeHeirAction` accept it. A client of the plain vault can never be
  made to sign an action its program does not have.
- **`SetSuccession` cannot use the vault's last free leaf.** `check_action` is untouched, so the
  last leaf still only rotates or closes.
- **A claim address is also refused when it is a program's data or a loader's account**, and when
  it is one of the vault program's own accounts other than an open vault (a tombstone, a signature
  buffer). Another open vault is allowed.
- **Mutation check.** 38 ways of breaking the succession code, each of which a test must catch.
  It found one rule no on-chain test could reach (a program as claim address, which LiteSVM will
  not let a test construct) and that rule now has a unit test.

What the Token-2022 tests found, which the finisher and the claim script (milestone 3) must follow:

- An account with withheld transfer fees cannot be closed, and if it is passed to
  `execute_succession` the release fails. It is left out of the release and swept afterwards;
  closing it needs `HarvestWithheldTokensToMint` first, which anyone may send, and the harvest and
  the sweep fit in one transaction.
- Non-transferable tokens never move. A frozen account, or one of a mint whose accounts start
  frozen, moves only after the issuer thaws it. A paused mint moves once it is resumed.
- An heir whose token account requires memos has to switch that off to receive a sweep. An heir's
  CPI guard does not stop tokens arriving.
- Tokens of a mint with a transfer hook are not moved yet. They stay where they are and are
  reported, like any other token that cannot move, and they hold nothing else back. Supporting
  them needs a hook program to test against; until one has been run, nothing here claims to.
- In every one of these cases the SOL and the other tokens are released as normal.

## Milestone 3, the finisher, the claim tool and the kit

[`release-tools.md`](release-tools.md) describes the result.

- **The claim tool signs with a key file the heir points it at.** The spec gives it "the heir's
  key". The tool reads a Solana CLI key file, signs, and keeps nothing; it has no option that takes
  a key or a seed phrase, never prompts for one, and never prints or logs the file. An heir whose
  key is in a hardware or phone wallet claims through the `/heir` page (milestone 4) instead.
- **Opening a waiting period is its own command, run by a person.** `start` is separate from
  `finish` and `claim`, and the finisher has no path to it. The spec's rule is that no off-chain
  component starts a waiting period on its own.
- **The finisher bounds what it pays.** At most 8 new token accounts per vault per pass, and no
  sweeps of empty accounts. Each new account costs it about 0.002 SOL that ends with the heirs, and
  anyone can make a vault's address own token accounts of worthless mints. What it leaves, the
  heir's claim sweeps. The spec has the finisher call "the sweeps" without a bound.
- **Every transaction is simulated before it is sent**, and one the cluster refuses is reported
  and skipped. That is how "tokens that can't move fail cleanly and are reported" is met without
  the tools having to know every Token-2022 extension.
- **A key the owner did not name is told so before anything is sent or paid for.**
- **A salt is printed as 64 hex digits plus 4 check digits.**
- **The kit is one HTML page with no script and nothing loaded from anywhere**, generated from the
  chain, and refused when it would be wrong for that heir.
- **The gate is met in two tests.** "A local validator with clock jumps" does not exist: a
  validator's clock cannot be moved. The programs run together at their real durations in LiteSVM,
  whose clock can (`tests/svm/tests/release.rs`); the tools run against a real local validator
  with the `short-clocks` test builds (`tools/e2e/`). Decision 5 said so in advance.
- **The claim program has a `short-clocks` test build** with its own program id, which believes
  only the vault's `short-clocks` build.
- **lamport-vault is a submodule at `vendor/lamport-vault`**, pinned to the head of
  lamport-vault#5. The tools use its SDK and the tests build its program.
- **TypeScript is run directly by Node.js 22.18 or later**, with no build step, as the vault's SDK
  scripts are. Dependencies beyond the vault SDK: `@solana/web3.js`, `@solana/spl-token`,
  `@noble/hashes`, `qrcode`; for development `typescript`, `vitest`, `esbuild`.
- **A plan can be created after its vault has released to it.** Building the tools showed a way
  to strand a release: arm a vault to a plan's address without ever creating the plan. The vault
  program accepts an address with nothing at it (an unused wallet looks the same), the release
  lands there, and `init_plan` used to refuse a vault that was no longer open. It now also accepts
  a vault whose tombstone names exactly this plan. The owner signed for that address and only
  these terms produce it, so nobody gains anything the owner did not sign for. No heir has to
  prove control in that state: an independent review pointed out that a primary heir who can no
  longer sign would otherwise keep the contingent heir out, which is the case a contingent heir
  exists for. This changes milestone 1's program, in the direction of fewer ways to lose funds.
  Three guards sit in front of it: the vault SDK's signer refuses a claim address that has neither
  an account nor a key (lamport-vault#5), the tools' `status` and `claim` name the condition, and
  the app must create and check the plan before it builds a `SetSuccession` (milestone 4).
- **Still open: a plan made for another vault.** A vault armed to an existing plan whose terms name
  a different vault releases to a plan it can never activate. No program can see this. The tools
  flag it (`status`, `claim`, the kit refuses); the app must refuse it before the owner signs.
- **An independent review before merging**, by two reviewers who had not seen the code, found no
  way to release early or to the wrong address, and three things that were fixed first: a check-in
  could bring a deadline forward by wiping the contact's extension; two vaults naming each other
  would trap a release between them; and the late creation of a plan demanded proofs it should
  not. It also found that the contact's 90 days (decision 7) end when the owner *signs*, not when
  they check in: the check-in key can only ever delay.
- **Deferred to milestone 4:** the signed acceptance message is accepted inside an off-chain
  message envelope without the envelope being parsed, so other text can precede it. Tightening
  that needs real wallets' envelopes to test against, which the heir-proof flow will have.
- **The mutation check now proves its baseline.** It first requires the untouched program to pass
  every test. Without that, a broken machine would "catch" every mutant.

## Milestone 4, the app and the reminders (in progress)

- **No plan interview and no AI heir guide in v1.** The spec has a language model explain the
  choices, propose values and guide heirs. On 2026-11-13 the project owner asked whether the
  interview was needed, and the answer was no: the form has five choices with sensible defaults,
  and fixed explanatory text beside each field does the explaining. Leaving the model out removes
  an API key, a running cost, a server that would have to hold the key, and the only place a model
  touches the flow. `tools/src/plan/assistant.ts` (a model may only propose durations and privacy
  switches, the owner accepts each field, a reply that asks for a secret is withheld) stays in the
  repository, tested and unused, so that adding an assistant later starts from the guard.
- **The vault's cold signer is not changed.** A Heir-enabled vault belongs to another program, so
  the vault page and its signer have to know that program's id and how to show a `SetSuccession`
  before an owner can use such a vault at all. That is done as a second build of the same source,
  the way the program itself is a second build: the existing page and `signer.html` come out
  byte for byte as they are today, and the Heir build is a separate file with its own hash.
- **The check-in key pays its own fee.** The spec lets Lamport pay the fee of a check-in. A fee
  relay is a funded key on a server and one more thing that has to stay up. A check-in costs
  0.000005 SOL, so the owner sends the check-in key's address a few cents of SOL when they arm,
  and checking in needs nobody else.
- **Push needs no provider.** Web Push is sent with a key pair the service makes for itself.
  Email needs a sending account, which is the project owner's to open.
- **A change of plan is announced to every channel and every trusted contact**, with what changed
  and the soonest a release could now happen. With no on-chain queue (decision 2), this alarm is
  what stands in front of a forced change.

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
