# The reminder service

A program that reads the chain on a schedule and tells people what the chain says about a vault:
the owner, before their time runs out, and the people the owner chose, when it is nearly out and
at every turn after. It is in [`tools/src/reminders/`](../tools/src/reminders).

**It can move nothing.** It holds no key that the vault or the claim program listens to. The
worst a broken or stolen reminder service does is stay silent or send a reminder too many. The
chain is the record; a reminder is a courtesy. That is also why the release has a long window, a
public waiting period and a finisher anyone can run: none of it depends on this service being up.

## What it sends

It decides from the vault account alone, by the cluster's clock (`schedule.ts`). Each notice is
sent once per recipient, whatever happens to the service in between.

| when | to the owner | to the trusted contacts |
|---|---|---|
| the plan is set, changed or removed | what changed, and the soonest a release could now happen | the same |
| 30, 14, 7 and 1 days before the owner's deadline | yes | from 7 days |
| the deadline has passed | yes | yes |
| someone opened the waiting period | yes | yes |
| 14, 7, 3 and 1 days before the vault can be released | yes | yes |
| the vault can be released; the vault was released | yes | yes |
| check-ins are about to stop counting (two years after the last signature) | 30 and 7 days before | no |

A change of plan goes to everyone because nothing on chain delays one: whoever holds the 24 words
can change the heirs at once, and this alarm is what stands in front of that.

**No message contains a link**, and email is sent as plain text, so nothing in it can be made to
look like a button. Each message says so, and says that Lamport never asks for words or keys. The
owner acts from their own bookmark.

## Channels

| channel | needs | state |
|---|---|---|
| email (`email.ts`) | any SMTP sending account, over TLS (`smtps://`, or `smtp://` that must upgrade before anything is sent) | built and tested against a mail server on the test machine. **No account exists yet**: that is the project owner's to open |
| browser notifications (`push.ts`) | nothing but the service's own key pair, which it makes | built and tested up to the push service. The page that subscribes a browser is not built |

A subscription for browser notifications names the address the service is to post to, and it
comes from a web form. The service posts only to the push services of browser makers (Google,
Mozilla, Apple, Microsoft), over HTTPS, and to nothing else: without that list it could be made
to post to an address only it can reach. The host has to be written plainly (no escapes, no
credentials, no port), and what is posted to is the address as the check understood it.

A vault's label, the owner's own name for it, is printed in every message. It is held to a short
name, so it cannot carry an address to open or a paragraph of somebody's own.

## What it keeps

One file (`file-store.ts`), encrypted with AES-256-GCM under a key from the environment: the
vaults, where to reach the owner and the contacts, each vault's last seen state, and which notices
were sent. No balances, no keys, no seed, no heir beyond what is public on chain. A wrong key or a
changed file is an error, never an empty store.

## Running it

```sh
cd tools
node src/reminders/cli.ts keys --out heir-reminders.env     # once: the store key and the notification key pair
# add to that file: LAMPORT_HEIR_STORE, LAMPORT_HEIR_RPC, and for email LAMPORT_HEIR_SMTP_URL, LAMPORT_HEIR_MAIL_FROM
set -a; . ./heir-reminders.env; set +a
node src/reminders/cli.ts add <vault> --email owner@example.org --contact friend@example.org --label savings
node src/reminders/cli.ts run                                 # every ten minutes; --once for one round
```

The top of `tools/src/reminders/cli.ts` lists every variable. A channel that is not configured is
left out and says so at start; reminders for it wait in the outbox for 14 days and then are given
up on. `keys` writes to a file only its user can read and shows nothing but the public half of
the notification key. `list` shows vaults and counts, never an address.

The service is not part of the single-file tool heirs download.

## Tests

| what | where |
|---|---|
| which notices are due, stage by stage, and that each is sent once | `tools/test/reminders.test.ts`, `reminder-service.test.ts` |
| the store: encrypted, atomic, a wrong key is an error | `file-store.test.ts` |
| email: one address, plain text, no link, no password in any error | `email.test.ts`, against a real SMTP server on the test machine |
| notifications: which endpoints are accepted, what is posted | `push.test.ts` |
| the command line | `reminders-cli.test.ts` |
| the service against real programs | the cycle, `tools/e2e/cycle.e2e.ts` and [`devnet.md`](devnet.md) |

## Not done

- **Signing up from the page.** Subscriptions are added by whoever runs the service, with `add`.
  A public sign-up needs an address the page can reach, and has to confirm an email address
  before writing to it, or anyone could point the service at a stranger's inbox.
- **An email account**, and a machine to run the service on. Both are the project owner's.
- **Telling a browser's notification from the page**: the page has no service worker yet.
