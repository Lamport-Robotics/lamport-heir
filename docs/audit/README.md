# For an auditor

**Draft.** Milestone 6 ends with a frozen commit; this is not it yet. Two things stand between
this and a frozen commit: milestone 4's gate is a cycle on devnet, which has run on a local
validator only ([`../devnet.md`](../devnet.md)), and nothing is deployed anywhere.

Nothing here has been audited. Two reviewers who had not seen the code read both programs before
they were merged, and a third read the pages, the offline signer's Heir build and the reminder
channels after they were written (the findings of all three are at the end). Those are reviews,
by reading, not an audit.

## What moves funds

Two on-chain programs. Everything else in this repository reads the chain, sends messages, or
sends transactions any stranger could send.

| program | source | size without tests |
|---|---|---|
| Heir-enabled vault: lamport-vault built with the `succession` cargo feature | [lamport-vault](https://github.com/Lamport-Robotics/lamport-vault), `programs/lamport-vault/src/succession.rs`, and the hooks in `lib.rs`, `action.rs`, `state.rs` (`git diff c4a4ccd..main -- programs/lamport-vault/src`) | about 510 lines |
| `heir-claim` | this repository, `programs/heir-claim/src/` | about 600 lines |

The vault's existing code (LMS verification, the leaf bitmap, key rotation, `Close`, the sweeps) is
in scope only where the feature touches it: the feature adds one action, four instructions and a
200-byte block of state, and changes nothing else. With the feature off the program is, byte for
byte, the vault as deployed; CI rebuilds both and compares on every succession pull request.

The two programs meet at one point. When a vault releases, it writes an 81-byte tombstone naming
the address it released to. The claim program believes a tombstone only from the vault program
whose id is compiled into it, and only when it names that plan.

## What decides what the owner signs

One more piece moves no funds and still belongs in scope: **the offline signer**, the single file
an owner types their 24 words into. Whatever it shows is what the owner believes they are
signing. Heir does not change the vault's signer. It builds a second one from the same source
(lamport-vault `docs/SUCCESSION.md`, section 9; [`../app.md`](../app.md)):

| | source | lines |
|---|---|---|
| the vault's signer, unchanged | lamport-vault `web/src/signer.ts` | about 20 lines added; every one that runs is behind the build constant and compiled out of the vault's own build |
| what a Heir build adds to it | lamport-vault `web/src/heir-plan.ts`, `heir-sdk.ts` | about 140 |
| what this repository adds | `app/src/terms.ts`, through `app/src/ext-signer.ts` | about 150 |

## Build and hashes

```sh
git submodule update --init
node tools/scripts/build-programs.mjs     # needs Agave 2.3.x; platform-tools v1.56 is pinned in each Cargo.toml
```

| build | hash |
|---|---|
| lamport-vault, default features, `solana-verify` 0.5.2 in the image `verify.yml` pins | `b9c055c3ba267849970076a5689e068a19f05dd4045f8f49f16f05cf2e2a563b` (unchanged by this work; in lamport-vault `docs/VERIFY.md`) |
| lamport-vault with `succession`, same image | printed by the `succession build` job of lamport-vault's `succession.yml` for each commit |
| `heir-claim` | printed by this repository's `both programs in litesvm` job |

| the pages and the Heir signer (`app/dist/heir/`) | printed by this repository's `app` job; the signer carries its commit |
| the vault's own page and signer (lamport-vault `web/dist/`) | byte for byte what they were before the Heir build existed; the `web` job in lamport-vault checks that no Heir code is in them |

Program ids have deployment keypairs, kept by the project owner outside every repository
([`../program-ids.md`](../program-ids.md)). Nothing is deployed at them yet.

## What must hold, and what holds it

Each line is a property, then the test that fails if it breaks. "Mutant" means the mutation check
removes or weakens that rule and requires a test to notice (`tests/mutants/` in each repository).

### The vault's clock

| # | property | held by |
|---|---|---|
| V1 | Nothing is released sooner than `window + wait` after the owner's last vault signature (at least 120 days) | `succession_random.rs`: 400 random sequences of signatures, check-ins, extensions, plan changes and clock jumps against a model; `nothing_is_released_sooner_than_window_plus_wait_after_a_plan_change`; fuzz target `succession_clock`; mutants on both comparisons, at the exact second |
| V2 | A release goes to the plan's claim address and nowhere else | `the_release_waits_out_the_waiting_period_then_goes_to_the_claim_address_only`; mutant "the release goes to whatever account is passed" |
| V3 | Only a vault (LMS) signature sets, changes or clears a plan | `SetSuccession` is an `Action`: it goes through `verify_and_act` like a withdrawal; `the_last_free_leaf_cannot_set_a_plan` |
| V4 | The check-in key and the contact key can only delay. Neither moves funds, changes the plan, or brings a deadline forward | `a_check_in_never_brings_the_deadline_forward` (unit and on chain); `check_ins_stop_counting_two_years_after_the_last_signed_action`; `the_contact_extends_once_and_only_the_contact`; mutant "a check-in wipes the contact's extension" |
| V5 | Any vault signature, any check-in inside its cap, and the contact's extension cancel an open waiting period | `a_check_in_or_a_signed_action_cancels_an_open_waiting_period`; `whichever_lands_first_the_owner_wins_the_race_with_a_start`; mutants |
| V6 | `execute_succession` does what a signed `Close` to the claim address does, and nothing else | `succession_close.rs`: byte-identical accounts over 120 random vault states, and the same error for the same bad input |
| V7 | A release needs no free leaf and no room in the key history, and cannot run twice | `the_release_needs_no_leaf_and_no_room_in_the_key_history`; `a_released_vault_is_closed_for_good` |
| V8 | The plan survives `Rotate` | `every_signed_action_is_a_sign_of_life_and_the_plan_survives_rotate` |
| V9 | With the feature off, the program is unchanged | CI job `default build unchanged`, for the vault and the registry |
| V10 | No admin key, no pause, no upgrade hook in the feature | by reading: `succession.rs` has no authority field and no instruction gated on a key other than the three above |

### The claim program

| # | property | held by |
|---|---|---|
| C1 | A plan's terms cannot change: its address is derived from their hash | `terms_their_hash_and_the_plan_address` (shared vectors); `any change to the terms is another plan` |
| C2 | A plan is activated only by the vault program's own tombstone, at the vault in its terms, naming this plan | `activation_needs_the_vaults_own_tombstone_naming_this_plan`; `a_tombstone_is_believed_only_from_the_vault_program_and_only_whole`; `release.rs` with the real vault program; mutants |
| C3 | Before activation nobody claims; after it only the primary heir, and the contingent heir once the primary has not claimed for the delay | `claim.rs` (22 tests); `random.rs` (400 sequences against a model); the ten `claim_role` cases in the shared vectors |
| C4 | A claim by the primary restarts the contingent heir's wait | `a_claim_by_the_primary_restarts_the_contingent_heirs_wait`; mutant |
| C5 | Tokens leave only from an account the plan owns, into an account of the same mint that the signing heir owns | `only_the_plans_own_token_accounts_can_be_emptied`; `tokens_go_only_to_an_account_the_claiming_heir_owns`; mutants |
| C6 | The plan keeps its own rent and is never closed | `claim_sol` tests; mutant "claim_sol takes the rent too" |
| C7 | Before a release, a plan is created only when every heir named by address proved control | `plan.rs`; mutant "heirs need not prove control" |
| C8 | A proof of control is for one plan and cannot be replayed for another | the signed text names the plan's address; `a_signed_message_must_be_by_the_heir_over_this_plan`; `an_ed25519_entry_that_points_at_another_instruction_proves_nothing` |
| C9 | After a vault has released to a plan's address, that plan can still be created, by anyone, and only that plan | `a_plan_can_still_be_created_after_its_vault_released_to_it`; `a_released_vault_lets_only_the_plan_it_named_be_created`; `release.rs`; mutants |

### The signer and the pages

| # | property | held by |
|---|---|---|
| S1 | The vault's own page and signer are unchanged | lamport-vault: `web/dist/` compared file by file before and after; the `web` job fails if the Heir build's text is anywhere in `web/dist/`, or `SetSuccession` or the Heir program id in the vault's signer |
| S2 | A Heir build signs for the Heir-enabled program and no other | lamport-vault `web/test/heir.test.ts`: `a signature made in a Heir build is for the Heir-enabled program`; `a Heir build's SDK names the Heir-enabled program, and nothing else changes` |
| S3 | What is signed is the request that was shown: the same five fields, encoded as the program decodes them | `requests become the bytes and the messages of kat/succession_encoding.json` (the vectors the program's own tests read) |
| S4 | A plan the program would refuse is refused before it costs a one-time key | `a plan the program would refuse is refused before it costs a one-time key`; `removing a plan has one spelling` |
| S5 | When a request names heirs, the signer derives the plan's address from them and refuses anything short of an exact match | `app/test/terms.test.ts`: `refuses a claim address the named heirs do not give`, `refuses a plan made for another vault`, `refuses terms the claim program would refuse, and terms it cannot read`, `are read strictly` |
| S6 | If the signer cannot show the plan, it shows nothing and signs nothing; a request the seam objects to is never described | `showPlan` throws and the caller clears the request (lamport-vault `web/src/signer.ts`, after the `try` block), read; `app/test/signer-seam.test.ts` runs the vault's request code with this repository's module in its seam: `refuses a request that shows the owner's heirs and pays somebody else's plan, and describes nothing`; `app/e2e/pages.e2e.ts` gives the built signer a forged request and then presses Sign |
| S7 | The Heir signer holds no code that talks to a network | `app/build.mjs` fails the build otherwise; the page's CSP is `connect-src 'none'` |
| S8 | The page creates a plan only after every heir named by address has signed for it | `app/test/acceptance.test.ts`; the claim program checks the same signatures again (C7) |
| S9 | The page refuses a claim address that nothing exists at and no key signs for, a program, a token account, and a vault whose plan names this one; it says so when an address is a program's and holds only SOL | `claimProblemOnChain`, `claimNoteOnChain` in lamport-vault `web/src/heir-page.ts`; the browser test covers the first case (the plan's address before the plan exists), the rest are read, **not tested** |
| S10 | The heirs' page asks for no key and no seed phrase | by reading: the fields of `app/src/claim-page.ts` and `app/src/letter-view.ts` take an address, a private heir's salt (not a key: it moves nothing, and is kept only while the page is open), and a letter's file or text |
| S11 | The three pages work together, built as they are shipped, from an empty wallet to an heir holding the vault's SOL | `app/e2e/pages.e2e.ts`, a headless browser on a local validator; it also fails on any uncaught error in a page |

The terms in a request (S5) are not part of what is signed: the signature covers the claim
address, which is all the vault program knows. The terms are how the signer explains that
address, and it accepts them only when they hash to it.

### The family letter

A letter moves no funds and no on-chain state. What can go wrong with it is that the wrong
person reads it, or that an heir is shown somebody else's words as the owner's. The code is
`tools/src/letter.ts` (about 460 lines, half of them comments), with `app/src/letter-panel.ts` and
`app/src/letter-view.ts` in front of it ([`../app.md`](../app.md), "The family letter"). The
tests named here are in `tools/test/letter.test.ts` unless another file is given.

| # | property | held by |
|---|---|---|
| L1 | Only the heirs a letter was sealed for can read it | X25519 to each heir's reading key, HKDF-SHA-256, AES-256-GCM; `is readable by each heir it was written for, and by nobody else`; `does not open once anything in it has been changed`; a reading key of small order is refused (`needs words, someone to read it, and reading keys that are keys`) |
| L2 | A letter shown as written by a wallet was signed by that wallet, whole | the file keeps its content as the exact text the writer's wallet signed for, and `readLetterFile` checks that signature before anything else in the file is used; `is refused once anything the writer signed has been changed`; signatures are checked strictly (`cannot be signed by an address of small order, for which anyone can write down a signature`) |
| L3 | Someone who knows an heir's public reading key cannot get a letter of their own opened | the sentence a reading key is made from names the writer, and so does the key derivation; `cannot be forged by someone who knows an heir's reading key`; each of the two bindings was removed in turn and a test failed |
| L4 | The owner encrypts to the heir's own key, and nothing in the heir's line can be changed on the way | the heir's address signs a sentence that names the reading key and what the wallet put in front of the key's sentence; `is refused by the owner's side unless it is for this plan, this writer and this heir, whole, and signed by the heir`; `carries what the wallet put in front of the sentence under the heir's signature` |
| L5 | A reading key can be made again on the day it is needed | the signer is asked twice and a different answer is refused (`is not made by a wallet that signs differently each time`); a key file can make the key a wrapping wallet made (`made by a wallet that wraps the sentence can be made again by a plain key`); limit 18 |
| L6 | Nothing in these flows signs a transaction | a sentence is signed bare or behind the header of an off-chain message, which starts with a byte no transaction starts with; the key file's signer refuses anything else in front (`is nothing or the header of an off-chain message, and never anything a transaction could start with`) |
| L7 | The signature that is an heir's reading key leaves their device in nothing | `is made with three signatures, and the line that goes to the owner holds no secret`; by reading, `letter-view.ts` stores nothing |
| L8 | A letter's words reach the page as text, and the terminal without control characters | the browser test puts markup in a letter and finds none on the page; `tools/test/cli.test.ts`: `keeps a letter's control characters off the terminal` |
| L9 | The letter's text is not handed to anything before it is sealed, as far as the page can ask | the field asks for no spell check, no saved form data and no writing aid, which the browser test reads back; limit 19 |
| L10 | A letter that reads like a seed phrase or a key is not sealed without the owner being told | `warns about a seed phrase, a run of words that looks like one, and a key`; `sees a phrase written as a numbered list or in capitals, and a key in hex`; the browser test seals such a letter only on the second press; limit 19 |
| L11 | The owner's page repeats nothing a stranger wrote but an address | `repeats nothing of a pasted line to the owner but addresses it could read` |

L2 and L3 together are what "this is the owner's letter" rests on, and they rest in turn on two
things no code enforces (limit 16).

### Off chain

| # | property | held by |
|---|---|---|
| O1 | The finisher never opens a waiting period | no code path from `finish` or `Finisher` to `start_succession`; `finish does nothing to a vault that is not due`; the end-to-end run checks its balance did not move over overdue vaults |
| O2 | Nothing off chain chooses where funds go | every destination is read from the vault's plan or tombstone |
| O3 | No tool asks for, prints, logs or stores a key or a seed phrase | `refuses options it does not have, a seed phrase option among them`; `is never quoted in an error`; the kit's `holds no key` test; the check-in key is non-extractable (`cannot be read out, by anything`) |
| O4 | The reminder service holds no key and sends no transaction | `says nothing while nothing is due, and sends nothing to the chain, ever` |
| O5 | No reminder contains a link or asks for a secret | `never contains a link, and never asks for a secret`, for every kind of notice and both audiences; the owner's label for a vault, which every message prints, is held to a short name (`refuses what it cannot use`) |
| O6 | The Pincer1 link cannot clear or release the robot's switch | `has no way to clear or release the switch` |
| O7 | Email is plain text to exactly one address, no error repeats the mail account's password, and the password is not sent over a connection that is not encrypted | `tools/test/email.test.ts`, against a mail server on the test machine: `does not hand a password to a server that will not encrypt the connection` |
| O8 | The service posts notifications only to browser makers' push services | `refuses an endpoint that is not a browser's push service: the service posts to it`; `never posts for a subscription it refuses` |
| O9 | The service's own keys are written to a file only its user can read and are never shown | `makes its keys into a file only its user can read, and shows no private half` |
| O10 | The check-in key kept in a browser cannot be read out | made non-extractable (`tools/src/checkin.ts`); `app/src/keystore.ts` refuses to store one that is not |

## Known limits

Stated plainly, so that nobody finds them by surprise.

1. **A vault can be armed to a plan that was made for a different vault.** The vault program does
   not know the claim program and must not. The release would go to a plan that only its own
   vault can activate. The tools flag it and the kit refuses to print; `checkBeforeArming` refuses
   it; nothing on chain does.
2. **A ring of three or more vaults naming each other** would trap a release among their
   tombstones. The program refuses a ring of two.
3. **Tokens of a mint with a Token-2022 transfer hook are not moved.** They are reported and stay
   where they are. A fix for the vault's own transfers is open as
   [lamport-vault#8](https://github.com/Lamport-Robotics/lamport-vault/pull/8): it changes the
   vault program itself, so it is the project owner's to merge and deploy. It hands a hook's
   accounts to the token program and never passes anybody's signature on. `heir-claim`'s
   `claim_token` has the same gap and gets the same change once that one is on `main`.
4. **Non-transferable, frozen and paused tokens** stay until their issuer lets them move, or for
   ever. They hold nothing else back.
5. **The acceptance message is accepted inside an off-chain message envelope that is not parsed**,
   so other signed text may precede it. It still names the plan.
6. **The owner's inability is not death.** An owner who cannot sign or check in for longer than
   their window and wait loses the vault to the heirs they named. The clock is the only judge.
7. **Whoever holds an heir's key at the time receives the funds.**
8. **A check-in key that is stolen can delay a release by up to two years** past the owner's last
   vault signature, and a contact's key once by 90 days. That is their whole power.
9. **The browser test uses a test wallet.** A headless browser drives the pages from an empty
   wallet to an heir holding the vault's SOL ([`../app.md`](../app.md)), with the key the pages
   offer on localhost. No Wallet Standard wallet and no hardware wallet has been driven, by a
   machine or by hand.
10. **The owner's page names heirs by address only.** A plan with an heir kept private (a salted
    hash) is made with the command-line tools. Such an heir collects on the heirs' page with the
    salt from their kit; that field is tested as words and through the claim code on a validator,
    not by the browser test.
11. **Nobody can sign up for reminders from the page.** Whoever runs the service adds vaults by
    hand; email has no sending account yet ([`../reminders.md`](../reminders.md)).
12. **Whoever controls the page an owner uses can lie on that page.** The offline signer is the
    defence, and it covers what is signed: the claim address and who is behind it, the durations,
    the two keys. It cannot cover what the page says afterwards about the state of the chain.
13. **The signer cannot say who a private heir is.** For an heir kept as a salted hash it shows
    the whole fingerprint and says it cannot tell whose address is behind it. The owner's only
    reference is the kit they printed, which prints that fingerprint.
14. **An heir's claim has no limit on new token accounts.** Anyone can make a released vault's
    address hold worthless tokens; each one the heir sweeps and claims is a wallet prompt and
    about 0.002 SOL of rent, which comes back when the account is closed. The heir can decline
    any of them. (The finisher, which pays for strangers, does have a limit.)
15. **A copy of a browser profile carries the check-in key with it**, and any script on the
    page's origin can ask it to sign. What it signs can only delay a release (limit 8).
16. **"This is the owner's letter" rests on two things no code enforces.** The owner's wallet
    must sign the authorship sentence nowhere but in Lamport Heir: a site that got that one
    signature, for a letter of its own making, would hold a letter that opens. And an heir must
    make a reading key only for the owner: nothing on chain names the owner's wallet (a vault is
    owned by its words; a wallet pays its fees), so the heirs' page cannot check the wallet in
    the link, and an heir talked into making a key for a stranger has given that stranger a way
    to write to them. Both sentences say what signing them grants and where they are signed.
17. **A letter is a file, and nothing delivers it.** An heir who has the file can read it at
    once, not only after a release. No service stores it or hands it over at the release, and
    the owner cannot open a sealed letter again. A newer letter does not undo an older one.
18. **A reading key lives in how a wallet signs.** A wallet that later signs the same sentence
    differently no longer makes the key, and the letter has to be sealed again, which needs the
    owner. What the wallet put in front of the sentence is recorded, which lets a key file make
    the same key; that helps nobody whose key never leaves a hardware wallet.
19. **The page cannot protect a letter from other software, and its check for secrets is a
    guess.** An extension that reads pages, or a keyboard that sends what is typed, sees the
    letter before it is sealed. The warning about a seed phrase or a key goes by how text looks
    and can miss one written another way.
20. **One sealed file could be made to read differently to two heirs**, by its writer and by
    nobody else: AES-GCM does not commit to its key. The writer could as well send two letters.

## Where the spec was not followed

`docs/decisions.md`, in full. The ones that touch funds: no 30-day queue for plan changes
(decision 2); `execute_succession` as its own copy of the `Close` path (decision 3); proof of
control by signed message as well as by signature (decision 6); the contact's extension (decision
7); a plan may be created after its vault released to it (milestone 3).

## Review before merge

Two reviewers read the vault's feature and the claim program without having seen them. Neither
found a way to release early, to release elsewhere, to claim without being a named heir, to forge
or replay a proof, or to block a release or a cancellation from outside. Three defects were fixed
before the merge:

- a check-in cleared the contact's extension and so could bring a deadline forward (V4);
- two vaults naming each other were accepted (limit 2);
- creating a plan after a release demanded proofs that a missing heir could not give (C9).

## Review of the pages, the signer's Heir build and the channels

A third reviewer, who had not seen them, read the Heir build of the signer and the page in
lamport-vault, everything in `app/`, the wallet signing in `tools/src/chain.ts` and the reminder
channels. By reading, with small scripts against the request code; nothing was built or run in a
browser by the reviewer.

**Not found:** a way to make the Heir signer show one plan and sign another, show a claim
address, heirs, durations or keys other than those in the signed bytes, sign a plan while showing
another action, or sign for another program or vault. The screen and the encoder read the same
five fields; base58 parsing is exact; seventeen hostile requests (duplicate and `__proto__` keys,
full-width digits, leading zeros, stray whitespace) were either refused or gave the same screen
and the same bytes. The terms encoding, hash and address derivation match the claim program's
Rust rule for rule. No untrusted data reaches `innerHTML`, a link or CSS in the pages, and the
kit escapes everything it prints. Every change to the vault's own page and signer is behind the
build constant, a type-only cast, or folds to the old value.

**Found and fixed:**

- the signer made a private (hashed) heir look checked (limit 13, S5);
- the push endpoint was checked with one URL parser and posted to with another (O8);
- `smtp://` went on without TLS, password included, when a server did not offer it (O7);
- a vault's label, printed in every message, could carry a link (O5);
- the plan form's refusal of an address with nothing behind it was defeated by one lamport sent
  there: it is still accepted, since a multisig's vault looks the same, and the form now says
  what it is (S9);
- the request code could have described a request the seam objects to, with the claim's row
  missing: it now refuses to describe it (S6);
- smaller: a delay rounded down on the acceptance page, an endpoint's full address in the
  cycle's report, a comment that overstated what "non-extractable" protects.

**Open, outside this repository:** one finding is in the vault's own signer, which the Heir
signer is built from. A fix is written and is with the project owner; it is not described here
until it is published.

**Not covered by that review:** `tools/src/cli.ts`, `finisher.ts`, `letter.ts` (reviewed since: the next section), `plan/`, the
reminder schedule and service beyond the send loop, the programs beyond the terms and the proof
of control, real wallets, and byte identity of the vault's own build (checked separately, by
building).

## Review of the family letter

A fourth reviewer, who had not seen it, read the letter code, both pages and the command-line
commands before any of it was pushed, with test files of their own against `tools/src/letter.ts`.
The brief was to forge a letter, read one, turn the owner's encryption to another key, make a
wallet or a key file sign something harmful, leak the secret signature, and get markup onto a
page.

**Not found:** any of those, for an attacker who knows an heir's line, the plan and the owner's
wallet and can hand an heir any file. Renaming, re-signing, moving signatures between letters,
duplicate keys in the signed content, every X25519 point of small order as a reading key, and a
wrapped key moved to another recipient were all refused.

**Found, and fixed before the first push** (commit "letter: what an independent review found"):

- The letter's field asked for spell check, which in some browsers sends the text to the
  browser's maker. No attacker needed. It now asks for none (L9).
- What a wallet put in front of the key's sentence was outside the heir's signature. Changed on
  the way, it left a letter sealed to the right key and unreadable with a key file, silently. It
  is now in the signed sentence (L4).
- The two public sentences did not say what signing them grants (limit 16).
- Signatures were checked by the lenient rule: an address of small order signed anything (L2).
- The owner's error box repeated a pasted line's own text (L11).
- A stranger's letter was refused in words that blamed the heir's wallet; the refusal now says
  that such a letter is not the owner's.
- A kit accepted and printed a salt for an heir named by address.
- The seed-phrase check missed a numbered or capitalised list and a key in hex (L10).
- A typed salt outlived Disconnect.

**Not covered by that review:** the pages in a real browser with a real wallet (limit 9), and
how wallets other than the test key sign messages: whether each wraps a sentence, and whether it
does so the same way from one version to the next (limit 18).

## Running everything

```sh
cargo test --workspace                                   # 23
(cd tests/svm && cargo test)                             # 49, both programs in LiteSVM
python3 tests/mutants/run.py                             # 23 mutants, after a green baseline
(cd tools && npm test)                                   # 161
(cd tools && npm run build:programs && npm run e2e)      # a local validator: four releases, the whole cycle, the Pincer1 link
(cd app && npm test && npm run build)                    # 34; then app/dist/heir/, with the signer's checks
(cd app && npm run e2e)                                  # the pages in a headless browser, on the same validator
```

and in lamport-vault: `cargo test --workspace --features lamport-lms/sign,lamport-vault/succession`,
`scripts/anchor-succession.sh`, `(cd tests/svm && cargo test --features succession)`,
`python3 tests/mutants/succession.py`, `(cd fuzz && cargo +nightly fuzz run --features succession succession_clock)`,
and for the page and the signer `(cd web && npm test && npm run build && npm run build:heir)`.
