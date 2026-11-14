# Devnet

Milestone 4 ends with one whole cycle on devnet, with short durations: arm, go quiet, warn, start,
release, sweep, claim. Everything for it is in the repository and has been run against a local
validator. **Nothing is deployed yet**, for one reason: the deployment needs about 3.4 SOL of
test SOL, devnet's command-line faucet is closed (`requestAirdrop` answers 410), the
proof-of-work faucets are empty, and <https://faucet.solana.com> asks automated clients not to
use it. A person has to request it.

## What to do

1. **Test SOL.** On <https://faucet.solana.com>, request 5 SOL for the deployer address,
   `4ARvLemSynLjt82WaBvcyS93E7PB5ZdSwR2HwQgiRBcg`. That covers the test pair and the cycle. A
   second 5 SOL covers the pair with real durations as well.
2. **Deploy the test pair.**
   ```sh
   cd tools && npm run build:programs && scripts/deploy-devnet.sh
   ```
   The script refuses any cluster but devnet, checks that each key file is the key of the id the
   source declares, checks the balance, deploys both programs, downloads what landed and compares
   it with the file that was built.
3. **Run the cycle.**
   ```sh
   node scripts/cycle.ts --rpc https://api.devnet.solana.com --keypair ~/.config/lamport/heir-devnet/deployer.json --out cycle.json
   ```
   About two and a half minutes. It costs the paying key under 0.01 SOL: what it puts in the
   vault comes back at the end.
4. **Record it**: the two deployments in [`program-ids.md`](program-ids.md), the cycle below.

## The keys

In `~/.config/lamport/heir-devnet/` on the project owner's machine, made on 2026-11-13: one key
file per program (they matter once, at the first deployment) and `deployer.json`, which pays and
is the upgrade authority. They are for devnet, hold test SOL at most, and are in no repository,
CI secret or log.

## The cycle

`tools/scripts/cycle.ts`. It is the same script whichever cluster it is pointed at, and CI runs it
on a local validator with the same two test programs (`tools/e2e/cycle.e2e.ts`).

| step | who | what |
|---|---|---|
| arm | the owner | a new vault with 0.05 SOL and a token; a plan with two heirs, each of whom signs their acceptance; the vault signature that arms it, naming a check-in key |
| go quiet | the owner | one check-in with the check-in key alone, then nothing |
| warn | the reminder service | reads the chain on a schedule and sends: the plan changed; 30, 14, 7 and 1 days left; the window has run out; a waiting period is open; release in 14, 7, 3 and 1 days; released. The trusted contact joins at 7 days |
| start | a stranger | opens the waiting period. Moves nothing |
| release | the finisher | releases the vault to the plan; the plan records it |
| sweep | the finisher | moves the token from the vault's address to the plan |
| claim | the first heir | withdraws the SOL and the token |

The run fails unless the heir ends with every token the vault held and at least its SOL. The
reminder service is the real one with a channel that keeps messages instead of sending them:
email needs a sending account, which nobody has opened yet.

With a day lasting one second, a reminder stage that falls between two ticks of the service is
skipped, which is why a run may show 30, 14 and 7 days but not 1. With real days the service
ticks many times per stage.

### On a local validator, 2026-11-13

Both `short-clocks` programs at their devnet ids, built from commit `a3b299c` with lamport-vault
at `e2efacc`. Clock times are the validator's.

```
02:23:56  arm      a vault holding 0.05 SOL and 1 000 000 units of a token
02:23:57  arm      a plan naming two heirs, each of whom signed their acceptance
02:23:58  arm      the owner's signature: 90 days of silence, a 30-day waiting period
02:23:58  warn     owner, contact: the succession plan changed
02:24:04  quiet    one check-in, with the check-in key alone
02:25:04  warn     owner: 30 days left to check in
02:25:20  warn     owner: 14 days left to check in
02:25:28  warn     owner, contact: 7 days left to check in
02:25:35  warn     owner, contact: the inactivity window has run out
02:25:36  start    a stranger opens the waiting period
02:25:36  warn     owner, contact: a waiting period is open
02:25:52  warn     owner, contact: release in 14 days
02:26:00  warn     owner, contact: release in 7 days
02:26:04  warn     owner, contact: release in 3 days
02:26:07  release  the finisher releases the vault to the plan; the plan records it
02:26:07  sweep    the finisher moves the token to the plan
02:26:07  warn     owner, contact: the vault has been released
02:26:08  claim    the first heir withdraws 0.0537 SOL and 1 000 000 units of the token
```

The run cost the paying key 0.0082 SOL.

### On devnet

Not run yet.
