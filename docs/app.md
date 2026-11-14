# The app

Everything Lamport Heir puts in a browser is in [`app/`](../app) and is served under `/heir/` on
the vault's site, `vault.lamportrobotics.com/heir/` (the project owner's decision, 2026-11-13).
`npm run build` in `app/` makes three pages:

| file | who it is for | what it is |
|---|---|---|
| `index.html` | the owner | the vault page, built for the Heir-enabled program, with an Inheritance tab |
| `signer.html` | the owner, offline | the vault's cold signer, built for the Heir-enabled program: one file, no network |
| `claim.html` | an heir | accept being named; see where a vault stands; open the waiting period; collect; read the family letter |

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
| the page | `app/src/ext.ts` | the same, and `composer.ts` (heirs, acceptances, creating the plan) and `panels.ts` (the check-in key, the kits, the letter) |

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

**A private heir is not vouched for.** A plan can hold a salted hash of an heir's address instead
of the address. The derivation above still proves the address is a plan for this vault with those
terms, but whoever wrote the request could have made the hash from their own address and salt. So
for such an heir the signer says it cannot tell who they are, prints the whole fingerprint, and
tells the owner to compare it with the one on the kit they printed. (An independent review found
that the first version made a private heir look checked.)

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

The owner's page names heirs by address. Heirs kept private (a salted hash in the plan) need
their salt on their kit and nowhere else; making such a plan is left to the command-line tools
for now. Their kit prints the fingerprint the signer shows, and they can collect on the heirs'
page (below).

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
  listed with its transaction or with the reason a token could not be moved;
- **for the owner's trusted contact**, whose wallet is neither heir's: the one thing their key can
  do, pushing the deadline back by 90 days, once;
- **for an heir kept private**: a plan that names an heir by a salted hash shows a wallet it does
  not name openly a field for the salt on their kit. With the right salt the page tells them
  their place and collects for them; with a wrong one, or the wrong wallet, it says that the two
  do not fit and sends nothing. A salt is typed, kept while the page is open, and never stored.

The sentences are in `app/src/heir-words.ts`, apart from the page, and tested as text.

## The family letter

What no chain can tell the heirs: where other accounts are, who to call, where the papers are.
The owner writes it on the Inheritance tab; it leaves the browser as a file that only the heirs
can read and that only the owner's wallet can have made. No server holds it. The code is
`tools/src/letter.ts`, used by the pages and by the command-line tool alike.

1. **Each heir makes a reading key.** The owner sends a link, `claim.html#letter=<plan>&from=<the
   owner's wallet>`. A wallet signs messages and decrypts nothing, so the heir's key is derived
   from their wallet's signature over a sentence that names the plan and the owner's wallet. A
   wallet that signs the same bytes gives the same signature years later, so nothing has to be
   kept. The page asks for that signature twice and refuses a wallet that answers differently the
   second time: such a wallet could not make the key again on the day the letter is read. A third
   signature tells the owner, in the heir's name, which public key is theirs and what the wallet
   put in front of the sentence when it signed. The heir sends back one line of text, which is
   not a secret.
2. **The owner writes and seals.** The page checks each line (this plan, this wallet, that heir's
   own signature over everything else in it), warns if the text reads like a seed phrase or a key
   and seals only when the owner presses again, encrypts the letter in the browser, and has the
   owner's wallet sign a sentence that holds the SHA-256 of everything in the file. The page
   keeps the heirs' lines, which are public, and no copy of the letter. The field the letter is
   typed in asks the browser for no spell check and no saved form data: some browsers send what
   they spell-check to their maker, which would be the letter leaving the device unsealed.
3. **An heir reads.** `claim.html#letter`, or `letter-open` in the command-line tool: choose the
   file. Before anything in it is believed, the page checks that the wallet it names as its writer
   signed exactly this. Then the heir's wallet makes the key again and the letter is shown, as
   text and never as markup.

**A letter cannot be forged, even by someone who knows an heir's reading key.** A public key is
something anyone can encrypt to, so without more the heirs' page would show a stranger's text
under the words "the family letter". Two things stand in the way. The file is signed, so a letter
that names the owner's wallet as its writer needs the owner's wallet. And the reading key is made
from a sentence that names the writer, so a letter that names any other writer asks the heir's
wallet for another sentence, which gives a key nobody ever encrypted to: it does not open, and
the refusal says that a letter from a writer the heir never made a key for is not the owner's.
Signatures are checked strictly: an address of small order, for which anyone can write down a
signature, signs nothing.

This holds on two conditions that code cannot enforce, and the sentences themselves say both:

- **The owner's wallet signs the authorship sentence nowhere but here.** A site that got the
  owner's wallet to sign that one sentence, for a letter of the site's making, would hold a
  letter that opens. The sentence says what the signature means and that it is signed only inside
  Lamport Heir.
- **An heir makes a reading key only for the owner.** An heir talked into making one from a
  stranger's link has given that stranger a way to write to them, and an heir talked into signing
  the sentence that names a reading key, with a stranger's key in it, has given that stranger the
  owner's letters. The page says to make a key only when the owner themselves sent the link, and
  every letter is shown with its writer's address and the line that a family letter never asks
  for money, a key or a seed phrase.

What the owner should know, and is told on the page:

- **An heir who has the file can read it at once**, not only after a release. An owner who wants
  it read later keeps the file with their papers.
- **Nobody can open a sealed letter for the owner**, the owner included. To change a letter they
  write it again from their own copy.
- **A newer letter does not undo an older one.** Each carries the day it was sealed.
- **The reading key is tied to the wallet that signs the letters.** An owner who changes wallets
  asks the heirs for new keys.
- **A wallet that changes how it signs** loses the heir that key: the letter then has to be sealed
  again, which needs the owner. The file records what the heir's wallet put in front of the
  sentence, if anything, under the heir's own signature, so that the command-line tool can make
  the same key from a key file. That helps an heir who can get at the key itself, and not one
  whose key never leaves a hardware wallet.
- **The page cannot stop other software from reading the field**: an extension that reads pages,
  or a keyboard that sends what is typed, sees the letter before it is sealed.
- **The check for a seed phrase or a key is a guess** from how text looks. It catches a run of
  short words, a numbered or capitalised list of them, and a key in the usual spellings, and it
  can miss one written some other way.

Heirs kept private cannot be written to from the page: it does not know their address.

Nothing on chain names the owner's wallet (a vault is owned by its 24 words, and a wallet only
pays its fees), so the heirs' page cannot check the link's wallet against the chain. What it
guarantees is narrower and is what it says when a letter opens: this letter was signed by the
wallet the heir made their key for.

## Tests

| what | where | count |
|---|---|---|
| terms in a request, and the check the signer makes | `app/test/terms.test.ts` | 9 |
| the acceptance: format, envelope rule, refusals | `app/test/acceptance.test.ts` | 4 |
| what the heirs' page says, phase by phase, to the trusted contact, and to an heir kept private | `app/test/heir-words.test.ts` | 15 |
| the vault's own request code with this repository's module in its seam, as the signer is built | `app/test/signer-seam.test.ts` | 4 |
| the link that asks an heir for a reading key | `app/test/letter-view.test.ts` | 2 |
| the letter itself: keys, the file, forgeries, refusals | `tools/test/letter.test.ts`, `tools/test/cli.test.ts` | 25 + 2 |

The tests run with the same alias and constants as the build, so they see the SDK the way the
built pages do.

**In a browser** (`app/e2e/pages.e2e.ts`, `npm run e2e`, part of CI's end-to-end job; it uses the
Chrome installed on the machine, or with `HEIR_E2E_BROWSER=chromium` the one Playwright installs). The pages
are built as they are shipped, as a test build for the `short-clocks` programs and a local
validator, and a headless Chromium clicks through them:

| who | what | what is checked |
|---|---|---|
| owner | creates a vault; names an heir | the plan cannot be created before the heir accepts; a damaged acceptance is refused |
| heir | opens the owner's link, signs the sentence | their page says which vault and which place |
| owner | creates the plan, makes a check-in key, signs on this device | the plan is the claim program's; the summary names the heir; the chain accepts the signature |
| owner, heir | the heir makes a reading key; the owner writes a letter and saves the sealed file; the heir opens it | a reading key somebody changed on the way is refused; the letter's field asks for no spell check; a letter that mentions a seed phrase is sealed only after a warning; the file holds none of the letter's words; a changed copy is refused before any wallet is asked; the letter is shown as text, never as markup; it is not offered to another wallet |
| signer | is given a forged request, then the real one | the forged one is refused and cannot be signed; the real one shows the heir by name and never the words "close the vault"; its signature is accepted by the chain; the words are gone from the page afterwards |
| owner | checks in with the browser's key | the chain records it |
| contact | pushes the deadline back | offered to the contact's wallet only, once; the owner's page then shows the extension as used |
| heir | waits, opens the waiting period, releases, collects | nothing can be pressed while the owner is within their time; the vault's 2 SOL arrives in the heir's wallet |

It also fails on any uncaught error in any of the three pages. What only a browser can show is
tested here and nowhere else: that the bundler's aliases give the pages the Heir program's id,
signed message and encoder. The first run by hand found exactly such a fault (the signed message
bound the vault's own program id; the chain refused it).

## Not done

- Nothing is deployed, on devnet or on the site.
- Reminders are not wired into the page (the service has no public address yet).
- The family letter is a file the owner hands over. Nothing stores it for them or delivers it at
  the release, and the owner cannot open a sealed one again.
- Naming an heir privately from the owner's page. An heir kept private can collect on the heirs'
  page with their salt, but making such a plan, and the kit that carries the salt, is the
  command-line tool's. The salt field is tested as words and through the claim code on a
  validator (`tools/e2e/release.e2e.ts`, vault C), not by the browser test.
- Real wallets in the browser test: it uses the test key the pages offer on localhost. Wallet
  Standard wallets and hardware wallets were not driven by a machine or by hand.
