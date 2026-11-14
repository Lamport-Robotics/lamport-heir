# The Pincer1 link

Pincer1 has its own dead-man's switch for the robot's wallet: a transaction the controller signed
once and keeps, which the robot broadcasts if nobody touches it for a set number of days. Heir does
not replace that switch, wrap it or add a second one. The link makes the two arrangements agree
and tells the owner when they stop agreeing.

**Nothing in Pincer1 is changed.** The link uses routes the daemon already has, and
`NOTIFY_WEBHOOK_URL`, which the daemon already reads.

## Where it runs

On the robot's own computer. The daemon serves its switch routes to callers on the robot itself
and to nobody else, pairing token or not, so a phone app cannot arm the switch and this link does
not try to make it. It is two commands of the same tool the heirs use:

```sh
node src/cli.ts pincer-arm    <vault> [--heir ADDRESS] [--mints MINT,MINT] [--nonce-account ADDRESS]
node src/cli.ts pincer-status <vault>
```

Neither needs a key. They talk to `http://127.0.0.1:7401` and refuse any other address.

| the link calls | for |
|---|---|
| `GET /status` | one thing: the address of the robot's wallet |
| `GET /inheritance` | what the robot reports about its switch |
| `POST /inheritance/arm` | asking the robot to arm it; the owner confirms with a three-second hold on the robot |
| `POST /offline/nonce/create` | having the robot make the switch's nonce account, when none is given |

There is no call that clears the switch and none that releases it, and the client has no method
for either (a test holds it to that list).

## What it arms

`pincer-arm` reads the vault's plan from the chain and asks the robot for:

- **inactivity = the vault's window + the vault's waiting period.** The robot's release has no
  public waiting period and cannot be undone, so it must not fire before the vault could. Its
  timer counts powered days only, so in practice it fires later, never earlier.
- **heir = the primary heir's own address.** The robot pays an ordinary wallet address; a plan's
  address cannot be its heir. When the plan keeps the primary heir private, the owner passes the
  address with `--heir`. The contingent heir does not cover the robot's wallet, and the command
  says so.
- **warnings at 30, 14, 7 and 1 days**, the robot's own, spoken by the robot.
- **SOL and at most four classic SPL tokens**, which is what the robot's stored transaction has
  room for.

Before the robot is asked, the link checks that the nonce account answers to the robot's wallet.
The robot signs any durable-nonce transaction it is shown; one built on a nonce account that
answers to another key could never run, and nobody would know until it mattered. The end-to-end
test found that the first version of the link allowed exactly this.

What was armed is written to `~/.lamport-heir/pincer-<vault>.json` on the robot's computer: the
heir, the days, the nonce account and its value, and the amounts the stored transaction moves. No
secret is in it.

## What it watches

`pincer-status` compares that record with what the robot reports and with the chain, and with the
vault's plan as it is now. It reads only, and says each difference in a sentence:

- the robot reports no switch, another heir, or another number of days;
- the nonce account was used for something else or is gone, so the stored transaction can never run;
- the wallet holds less than the stored transaction sends, so the whole release would fail;
- the wallet holds more, or tokens the stored transaction does not send, which would stay behind;
- the vault's plan has moved on: another primary heir, or a window and wait that no longer add up
  to what the robot was armed for.

The fix for every one of them is the owner's: arm again, on the robot. The link never clears,
re-arms or releases on its own, and it draws no conclusion from a refusal by the robot: it prints
the robot's answer as given.

## The robot's warnings

The daemon posts two events to `NOTIFY_WEBHOOK_URL`: a warning with the days left, and word of a
release. Pointed at the reminder service (`POST /robot/<secret>`), they become reminders on the
owner's own channels, and to trusted contacts from seven days. The secret is in the address; the
service keeps only its hash. A forged call can cause a reminder and nothing else, and the same
event is passed on once. `NOTIFY_WEBHOOK_URL` holds one address: pointing it at Heir replaces
whatever was there.

**A touch is not a check-in, and a check-in is not a touch.** The robot's timer and the vault's
clock stay independent. Each reminder about the robot says so.

## Tests

| what | where |
|---|---|
| the client, the arming rules, the record, every kind of drift, the webhook, the two commands | `tools/test/pincer.test.ts` |
| the link against **Pincer1's own daemon in simulator mode** | `tools/e2e/pincer.e2e.ts` |

The end-to-end run loads the daemon's real `ApiServer`, `Inheritance` and `SimController` from the
pinned copy in `vendor/pincer1`, unmodified, with a local validator as the chain. A running daemon
never advances the simulated controller's clock, so the test does, with the simulator's own `tick`,
and calls the daemon's hourly check itself. It covers arming with the owner's hold, the drift
check, the refusal of a nonce account the robot does not control, the 30-day and 7-day warnings
reaching the reminder service, a touch resetting the timer, and the release: the daemon broadcasts
the transaction the controller kept and the heir is paid on chain, SOL and token.

## Not done

- The robot's switch covers classic SPL tokens only, four at most. That is the robot's limit.
- Nothing asks the owner to re-arm when the wallet's contents change. `pincer-status` has to be
  run, by hand or on a schedule; reporting its result to the reminder service is not built.
- The daemon's default RPC is mainnet. Everything here has run against the simulator and a local
  validator only.
