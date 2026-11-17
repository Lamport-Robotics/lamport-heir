# Devnet

The spec ends milestone 4 with one whole cycle on devnet, with short durations: arm, go quiet,
warn, start, release, sweep, claim. Everything for it is in the repository, and it runs against a
local validator on every push. **It has not run on devnet.** What is on devnet, since 2026-11-17,
is the pair with real durations, which the pages talk to; no vault there has been released. On
2026-11-14 the project owner decided not to wait for a devnet test run
([`decisions.md`](decisions.md), "From the project owner"), and milestone 4 was merged on the
local runs.

A deployment needs test SOL. Devnet's command-line faucet is closed (`requestAirdrop` answers
410), the proof-of-work faucets are empty, and <https://faucet.solana.com> asks automated clients
not to use it, so a person has to request it. The pages cannot be served before the pair with
real durations is on devnet: they would be pages for programs that do not exist.

## The pair with real durations

Deployed on 2026-11-17, after the project owner requested 5 test SOL on
<https://faucet.solana.com> for the deployer address, `4ARvLemSynLjt82WaBvcyS93E7PB5ZdSwR2HwQgiRBcg`.
The two programs took 3.35 SOL of rent. Ids, slots and hashes are in
[`program-ids.md`](program-ids.md).

What is deployed is not a laptop's build. A Mac makes a different file from the same source (the
claim program: 272,664 bytes there, 273,240 from CI), and nobody could check such a file
against the source. The files are the artifacts of the `verify` workflows, which build in a
pinned Docker image: `heir_claim-<commit>` from this repository, and
`lamport_vault-heir-<commit>` from lamport-vault at the commit `vendor/lamport-vault` is pinned
to. To do it again:

```sh
gh run download --repo Lamport-Robotics/lamport-heir  --name heir_claim-<commit>         --dir builds
gh run download --repo Lamport-Robotics/lamport-vault --name lamport_vault-heir-<commit> --dir builds
cd tools && LAMPORT_HEIR_DEVNET_BUILDS="$PWD/../builds" scripts/deploy-devnet.sh --real
```

The script says `same` for a program that is already there as that file, and sends nothing for
it. On the day, the first attempt sent its writes through the public endpoint and landed about
30 of 380 in ten minutes before the tool gave up; sent straight to the validators, which is what
the script does now, the vault took eight seconds and the claim program eighteen. A call to each
program, simulated, is answered by the program itself at its id.

## The test pair and the cycle

Not deployed. The test run, should anyone want it, is this list and about 3.4 SOL, of which the
deployer holds 1.64:

1. **Test SOL**, as above.
2. **Deploy the test pair.**
   ```sh
   cd tools && npm run build:programs && scripts/deploy-devnet.sh
   ```
   The script refuses any cluster but devnet, checks that each key file is the key of the id the
   source declares, checks the balance, deploys both programs, reads what landed and compares it
   with the file that was built. Running it again is safe: a program that is already on chain as
   that file is left alone, and a deploy the network interrupted carries on where it stopped.
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

Not run: the test pair is not deployed. The project owner decided on 2026-11-14 not to wait for it.

## Putting the pages on the site

The pages are static files, served under `/heir/` on the vault's site (lamport-vault,
`web/README.md`: a directory behind Caddy). `tools/scripts/deploy-site.sh` builds them, copies
`app/dist/heir/` into the site's `heir/` folder and nothing else, and then fetches every file
back over HTTPS and compares it with the build:

```sh
cd tools
HEIR_SITE_HOST=<the ssh host the site is on> scripts/deploy-site.sh          # checks, and shows what would change
HEIR_SITE_HOST=<the ssh host the site is on> scripts/deploy-site.sh --go     # copies
```

It refuses a test build, a tree with changes in no commit, and **pages for programs that are not
on the cluster**: the real pair has to be deployed first (`scripts/deploy-devnet.sh --real`). What
was there before is kept in the site's `backups/` folder.

The cold signer carries its script inline, by design: it is one file that works with no network.
The site's policy for pages allows scripts from the site only, so `/heir/signer.html` needs the
policy the vault's own signer has. In the site's Caddyfile, in the block for the vault's host:

```
  # was: @app not path /signer.html
  @app not path /signer.html /heir/signer.html

  # beside the vault signer's own lines: the same policy, and a name of its own for the download
  @heirsigner path /heir/signer.html
  header @heirsigner Content-Security-Policy `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; connect-src 'none'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`
  header @heirsigner Content-Disposition "attachment; filename=lamport-heir-signer.html"
  header @heirsigner Cache-Control "no-store"
```

Then `caddy validate` and `caddy reload`. The script's last check fails until this is in place.
The signer's own page also carries a stricter policy inside the file, with the hash of its one
script, so the header above only has to let that script run.

**Published on 2026-11-17**, from commit `d59af17`, at <https://vault.lamportrobotics.com/heir/>:

| file | sha256 |
|---|---|
| `index.html` | `30024aeed8a7dadf7ff47f508d254d0c3a34c8d4008e36decfbcfa338e81c1d1` |
| `signer.html` | `a2b2f297969e05e249909be075793917a1c34c4f7d2cb8255bb0aada32817791` |
| `claim.html` | `000e2abb5092edd29ea62541a2ba3573a2771a4a6d7bd2063b9ea18673048b2c` |

The script fetched all eighteen files back and found each the same as the build, and the
signer served with its own policy; the Caddyfile lines above went in the same day. In a browser,
both pages load with no error in the console, and the heirs' page looked an address up through
the site's `/rpc`. Nobody has yet made a vault or a plan there with a real wallet. The vault's
own pages do not link to `/heir/` yet.
