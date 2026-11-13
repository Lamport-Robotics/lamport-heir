# Finishing a release and claiming it

Three pieces of milestone 3, all in [`tools/`](../tools): the **finisher**, the **claim tool** and
the **claim kit**. They share one rule: nothing here can do anything a stranger with a Solana RPC
endpoint could not do, except sign as an heir with the heir's own key.

[`tools/README.md`](../tools/README.md) has the commands. This file says what they do and why.

## What happens after the owner goes quiet

| step | instruction | who may send it | what it does |
|---|---|---|---|
| 1 | `start_succession` (vault) | anyone, once the owner's window has run out | opens the public waiting period. Moves nothing. The owner cancels it with any signature or check-in |
| 2 | `execute_succession` (vault) | anyone, once the waiting period has run out | sends the vault's SOL to the claim address, closes the vault's empty token accounts, leaves a tombstone naming that address |
| 3 | `activate` (claim program) | anyone | only when the claim address is a plan: the plan reads the tombstone and opens for its heirs |
| 4 | `sweep_closed` (vault), once per token account | anyone | moves one token balance to the claim address's own token account and closes the vault's |
| 5 | `sweep_closed_sol` (vault) | anyone | SOL that reached the vault's address after it closed goes to the claim address |
| 6 | `claim_sol`, `claim_token` (claim program) | the heir | only for a plan: the heir withdraws to their own address |

Step 1 is a person's decision: somebody believes the owner is gone. Nothing in this repository
takes it on its own. Steps 2 to 5 are bookkeeping that the chain already allows; `finish` does
them. Step 6 needs the heir.

When the vault names a plain address instead of a plan, steps 3 and 6 do not exist: the release
and the sweeps deliver straight to that address.

`status` also names two conditions nobody should arm a vault into, both of which the app has to
refuse before an owner signs:

- **the claim address is a plan made for another vault.** That plan can only be activated by the
  vault in its own terms, so what this vault released to it could not be claimed;
- **nothing is set up at the claim address and no key exists for it**: a plan that was never
  created. The release would land at an address nobody controls. The claim program lets the plan
  be created afterwards, with exactly the terms the owner chose, so this one can be repaired by
  whoever knows the terms.

## The finisher

`node src/cli.ts finisher --keypair FILE` runs a loop. Each pass:

1. asks the RPC endpoint for vaults of the program whose waiting period is open (one
   `getProgramAccounts` call, filtered on the account type and on the `wait_open` byte at offset
   251, fetching only each vault's 200-byte succession block) and keeps those whose waiting period
   has run out **by the cluster's clock**;
2. for each, does steps 2 to 5;
3. looks at closed vaults for token accounts that still hold something, and sweeps them.

What it cannot do, by construction and by test:

- **It never opens a waiting period.** There is no code path from the finisher to
  `start_succession`. A pass over overdue vaults sends nothing (unit test, and the end-to-end run
  checks its balance did not change).
- **It cannot choose where funds go.** Every instruction it sends takes its destination from the
  vault's own plan or tombstone.
- **Its key is worth its balance.** It signs nothing but fee payments and the creation of token
  accounts owned by claim addresses.

Stopping it stops nothing: an heir's `claim` does the same steps.

**It bounds what it pays.** Sweeping a token to a claim address that has no account for that mint
creates one, about 0.002 SOL of rent that ends with the heirs and never returns to the finisher.
Anyone can make a vault's address own token accounts of worthless mints, so a finisher that pays
for strangers needs a limit: by default it creates at most 8 token accounts per vault per pass
(`--max-new-token-accounts`), and it does not sweep empty accounts at all. Whatever it leaves, the
heir's own claim sweeps, at the heir's cost, and that cost comes back to the heir when the claim
closes the plan's token accounts.

It keeps no state on disk. While it runs it remembers which closed vaults had nothing left, so it
does not ask about them every pass.

## The claim tool

`node src/cli.ts claim <vault or plan> --keypair FILE [--salt SALT]`

1. **Before anything is sent or paid:** reads the vault and the plan, and tells a key that the
   owner did not name that it is not an heir. A plan with private heirs recognises nobody without
   their salt, and says so.
2. Does every step of the release that is still undone (2 to 5 above), paying for it.
3. For a plan: `claim_sol`, then one `claim_token` per token account the plan holds, each into the
   heir's own associated token account, created if missing. The plan's token accounts are closed
   and their rent goes to the heir.

It is safe to run again at any time. Later arrivals (a sweep someone else ran, SOL sent to the old
address) are picked up by the next run.

**Every transaction is simulated first.** One the cluster refuses is not sent; it is listed with
the reason, and the rest go on. A token that cannot move never holds back the SOL or the other
tokens. The exit code is 0 when everything moved, 1 when something was left, 2 when the key may
not claim (yet).

What the tool says for tokens it cannot move comes from the token program's own error:

| it says | meaning |
|---|---|
| this token is non-transferable | nobody can ever move it; it stays at the vault's address |
| the token account is frozen | the issuer froze it; it moves after a thaw |
| the token's issuer has paused all transfers | it moves once the issuer resumes |
| the receiving account requires a memo | the heir switches that setting off and runs the claim again |

Two cases it handles without being asked: an account with **withheld transfer fees** cannot be
closed, so the tool harvests the fees to the mint (which anyone may do) in the same transaction;
and a mint with a **transfer hook** gets the hook's extra accounts passed along.

### The heir's key

The claim tool signs with a Solana CLI key file that the heir points it at. It reads the file,
signs, and keeps nothing: the key is not printed, logged, copied or sent, and an unreadable file
is reported by its path, never its contents (tested). There is no option that accepts a key or a
seed phrase on the command line, and the tool never prompts for one.

This is the plainest thing that works for someone alone with a terminal. It does not cover an heir
whose key lives in a hardware wallet or a phone wallet. For them the claim is the same two
instructions signed in a wallet, which the `/heir` page will offer (milestone 4).

### Private heirs and the salt

A plan can store a salted hash of an heir's address instead of the address. The heir then needs
the salt to claim, and nobody can recover a lost one. The kit prints it as 64 hex digits, a dash
and 4 check digits. The check digits catch a mistyped salt before it turns into "you are not an
heir".

## The claim kit

`node src/cli.ts kit <vault> --heir ADDRESS [--salt SALT] [--label NAME] --out kit.html` writes
one HTML page to print. It reads the vault and the plan from the chain and **refuses to print a
page that would be wrong**: an address the plan does not name, a salt that does not match, terms
for another vault.

The page has the vault and plan addresses (also as QR codes), the heir's place in the plan, the
durations, the salt if there is one, and the exact commands, the claim command included. The
end-to-end test claims with the command lifted from a printed kit.

It holds no key and has no field one could go in. It loads nothing from anywhere: no script, no
font, no image. Whoever finds it cannot take funds; they do learn that the vault exists and who
inherits, which the page says.

## One file

`npm run bundle` builds `dist/lamport-heir.mjs`: the whole command-line tool in one file with
every dependency inlined, for someone who has Node.js and nothing else. CI builds it and prints
its sha256. It is not published anywhere yet.

## Tests

| what | where | count |
|---|---|---|
| the claim client's bytes, against the program's own types | `kat/claim_encoding.json`, read by `programs/heir-claim/tests/encoding.rs` | 9 Rust tests |
| the two real programs together, real durations, a clock that jumps | `tests/svm/tests/release.rs` | 7 |
| the tools' logic, with a stand-in chain that executes nothing | `tools/test/` | 47 |
| a release from end to end on a local validator | `tools/e2e/release.e2e.ts` | 8 steps, 4 vaults |

The end-to-end run uses the `short-clocks` test builds of both programs (a day lasts a second, own
program ids), so 90 days of silence, 30 of waiting and a 30-day contingent delay pass in about
three minutes. Four vaults are armed and go quiet together. Each holds SOL, an SPL token, a
Token-2022 token with a transfer fee and fees withheld in the vault's account, a non-transferable
Token-2022 token, and an empty token account.

| vault | what happens | what is checked |
|---|---|---|
| A, a plan with two named heirs | the finisher releases it; the primary heir claims with the command from their kit | everything movable is in the heir's hands; the plan is empty and its token accounts closed; SOL sent to the old address later still arrives |
| B, a plain address | no finisher: the heir's `claim` alone releases, sweeps and delivers | "no Lamport server involved" |
| C, a plan with private heirs | the primary never claims; the contingent heir claims after the delay with the salt from their kit | too early is refused with the date; without the salt nobody is recognised; a mistyped salt is caught |
| D, the owner is alive | one check-in cancels the waiting period | never released; the finisher leaves it alone |

In all three releases the non-transferable token stays behind, is reported by name, and holds
nothing else back.

## What is not done

- **A working transfer hook has not been run.** The code passes a hook's accounts along, and a
  missing hook program fails cleanly (the vault's tests). A sweep through a live hook needs a hook
  program to test against.
- **Hardware and phone wallets** claim through the page in milestone 4, not through this tool.
- **The finisher asks again every pass about a token that cannot move.** That costs RPC calls, not
  fees.
- **The single-file build is not published.** Where heirs download it from, and how they check it,
  is a release question for milestone 6.
