# The app

Everything Lamport Heir puts in a browser is in [`app/`](../app) and is served under `/heir/` on
the vault's site, `vault.lamportrobotics.com/heir/` (the project owner's decision, 2026-11-13).
`npm run build` in `app/` makes three pages:

| file | who it is for | what it is |
|---|---|---|
| `index.html` | the owner | the vault page, built for the Heir-enabled program, with an Inheritance tab |
| `signer.html` | the owner, offline | the vault's cold signer, built for the Heir-enabled program: one file, no network |
| `claim.html` | an heir | accept being named; see where a vault stands; open the waiting period; collect |

## The page and the signer are the vault's

A Heir-enabled vault is the vault program built with a feature, and the page and signer that
operate it are the vault's page and signer built with a constant: the same source, from the
pinned submodule `vendor/lamport-vault`, with the vault's own build configuration
(lamport-vault's `docs/SUCCESSION.md`, section 9). That source leaves one seam, a module that
knows what a claim address is. The vault's own says "an address". This repository's build puts
its own in that place:

| in the build of | this module | which adds |
|---|---|---|
| the signer | `app/src/ext-signer.ts` | `terms.ts`: who is behind a plan's address |
| the page | `app/src/ext.ts` | the same, and `composer.ts` (heirs, acceptances, creating the plan) and `panels.ts` (the check-in key, the kits) |

The signer gets one file of this repository's, and that file reads no network. `build.mjs`
fails if the signer's bundle contains page code, and the signer's own CSP (`connect-src 'none'`)
would stop such code regardless.

## What the signer checks: who inherits

The vault program releases to one address. When heirs are named, that address is a plan of the
claim program, and a plan's address is derived from a hash of its terms: the vault, the first
heir, the second heir, the delay. Without help, the owner at the offline signer would be shown 32
bytes and asked to trust that they stand for the heirs the online page displayed.

So the signing request carries the terms, and the signer derives the address again:

- it matches: the signer's screen says "a Lamport Heir plan", then the first heir's address and
  the second's, and when each may claim;
- it does not, or the terms are for another vault, or the claim program would refuse them, or a
  field is not understood: the signer refuses the request and shows nothing to sign.

A page that showed the owner one set of heirs and asked the signer for another plan's address is
caught at the signer. Tested without a browser (`app/test/terms.test.ts`) and in one: a request
with the right address and another first heir in its terms was refused.

A request with no terms (a plain address, typed by the owner) is shown as the vault's own build
shows it: "this signer only sees an address".

## Naming heirs

The order is fixed by how plans work, since other heirs are another plan at another address:

1. **The owner writes down the heirs' addresses.** The page refuses an address that is not a
   wallet's: a program's, a token account, the vault itself.
2. **Each heir accepts.** The owner sends them a link, `claim.html#accept=…`, which carries the
   terms. Their page says what they are accepting (which vault, which place, who the other heir
   is), and asks their wallet to sign one sentence that names the plan. Signing moves nothing.
   They send one line of text back, by any means: it is not a secret.
3. **The owner's page checks each acceptance and creates the plan.** The claim program checks the
   same signatures again (`init_plan`). An address with a typo in it never gets this far, because
   nobody holds its key.
4. **The plan's address goes into the form the owner signs**, with the terms, so that the signer
   can make the check above.

The page handles heirs named by address. Heirs kept private (a salted hash in the plan) need
their salt on their kit and nowhere else, and are left to the command-line tools for now.

## The check-in key

A check-in tells the chain the owner is alive without the 24 words. The key that signs it is made
in the browser with WebCrypto, non-extractable, and kept in IndexedDB under the vault's address:
the browser signs with it and gives its bytes to nobody, this page included. The owner names it
in the plan (which takes a vault signature) and sends its address a few cents of SOL; from then
on a check-in is one click and needs no wallet and no server. Clearing the browser loses the key
and nothing else: the owner makes another and names it.

## For heirs

`claim.html` asks for no seed phrase and no key, has no field one could go in, and talks to
nothing but the Solana endpoint. What it does on chain is what `tools/` does, by the same code
(`inspect`, `start`, `claim`), signed by the heir's wallet instead of a key file:

- **where a vault stands**, for anyone, with no wallet: within the owner's time, overdue,
  waiting, releasable, released; and for a connected wallet, its place in the plan;
- **opening the waiting period**, once the owner's deadline has passed, behind a sentence that
  says what it means and that it is public;
- **releasing and collecting**: every step that is still undone, then the withdrawal, each step
  listed with its transaction or with the reason a token could not be moved.

The sentences are in `app/src/heir-words.ts`, apart from the page, and tested as text.

## Tests

| what | where | count |
|---|---|---|
| terms in a request, and the check the signer makes | `app/test/terms.test.ts` | 9 |
| the acceptance: format, envelope rule, refusals | `app/test/acceptance.test.ts` | 4 |
| what the heirs' page says, phase by phase | `app/test/heir-words.test.ts` | 12 |

The tests run with the same alias and constants as the build, so they see the SDK the way the
built pages do.

**In a browser, by hand, 2026-11-13**, on a local validator running the `short-clocks` builds of
both programs (`HEIR_CLOCK=short HEIR_RPC=http://127.0.0.1:8899 npm run build`): a vault created
on the page; an heir named; the heir's acceptance signed on `claim.html` and pasted back; the
plan created; the plan signed and armed from the page, with a check-in key made in that browser;
a check-in; the request shown by the offline signer with the heir's name, and a forged one
refused; then, as the heir, the waiting period opened, the vault released and its 3 SOL
collected, and the same read back by `tools/src/cli.ts status`. There is no automated browser
test yet.

## Not done

- Nothing is deployed, on devnet or on the site.
- Reminders are not wired into the page (the service has no public address yet).
- The family letter has its code (`tools/src/letter.ts`) and no page.
- Heirs kept private, in the page.
- An automated run of the pages in a browser.
