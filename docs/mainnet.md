# Mainnet

**Nothing is deployed on mainnet.** This page is how a deployment is made and what it changes.
The record of what is deployed is the table in [`program-ids.md`](program-ids.md).

## What has and has not been checked

- No independent audit of the vault, of its Heir build, or of the claim program.
  [`audit/README.md`](audit/README.md) is written for whoever does one.
- A whole cycle (arm, go quiet, warn, start, release, sweep, claim) has run against a local
  validator with the `short-clocks` builds, in CI on every push. It has not run on a public
  cluster, devnet included ([`devnet.md`](devnet.md)).
- The programs with real durations are on devnet since 2026-11-17, as devnet builds
  ([`program-ids.md`](program-ids.md)); no vault there has been released. The mainnet builds
  have never been on a public cluster. The four CI
  builds that `deploy-mainnet.sh` deploys were put on a local validator with a copy of that script
  that differed only in the cluster it accepts: each landed with the hash CI printed, each answers
  at its mainnet id, and `--burn` left each without an upgrade authority. That rehearses the
  script, not the programs: no vault was made there. On 2026-11-18 the two ways of sending
  (below) were rehearsed the same way, at throwaway ids, and the four builds were deployed on a
  local validator started with mainnet's own set of active features
  (`solana-test-validator --clone-feature-set`, Agave 4.4.1; mainnet answered as 4.4.0 that day).
  The script ran with the 2.3.13 command-line tools and with 4.4.1.

## The programs

Mainnet has program ids of its own. The message a vault key signs binds the program id and nothing
else about the cluster, so under the devnet ids a devnet signature would be a mainnet one.

| program | built with | id |
|---|---|---|
| Heir-enabled vault | lamport-vault, `mainnet,succession` | `3XsnTrQJ5XmFyEyVauMmMseHph4wXkn6QWUZCRPjuEEX` |
| claim program | heir-claim, `mainnet` | `L8EWcWfZbPu3iWNSkShaFJYwLgQ5vAdjLQNzP2DY8Yf` |
| vault | lamport-vault, `mainnet` | `7EiE5pRP5byrY7mzvUBfXS2UD8GwGtPhbGne6D1BTR5H` |
| registry | pq-registry, `mainnet` | `9MYg9uqYBrTPXA6MNRZ6cbpwHSissY3496Y84iofTaNF` |

The `mainnet` feature changes the ids and nothing else, and does not compile together with a test
build. The mainnet claim program believes the mainnet Heir-enabled vault's tombstones and no
other program's. The tools know the pair as `MAINNET_PROGRAMS`; it is never a default
(`finisher --mainnet`).

## Deploying

`tools/scripts/deploy-mainnet.sh` is the project owner's to run.

```
scripts/deploy-mainnet.sh            # checks everything, says what it would do, sends nothing
scripts/deploy-mainnet.sh --deploy   # deploys what is not on chain, then compares it with the CI build
scripts/deploy-mainnet.sh --burn     # removes each program's upgrade authority. Cannot be undone.
```

- It deploys the artifacts of the `verify` workflows, for lamport-heir's `main` and for the
  lamport-vault commit it pins. Never a local build.
- `--deploy` spends SOL from the deployer wallet as rent: about 2 SOL
  for the Heir-enabled vault, 1.4 for the claim program, 1.8 for the vault and 1.3 for the
  registry at the time of writing. The script prints the exact figures before sending anything.
  Until `--burn`, a program's rent can be had back by closing the program
  (`solana program close`), which ends that id for good. After `--burn` it never comes back.
- Rent is 5,080 lamports for each byte on mainnet since epoch 1033; it was 6,960, then 6,333.
  Three more cuts are in the validators and not switched on, to 2,575, 1,322 and 696
  (SIMD-0437-3 to -5), and nobody has given a date. At 2,575 the four programs would take about
  3.25 SOL and the Heir pair 1.70; at 696, about 0.88 and 0.46.
- The builds are SBPF v0, which is what the pinned toolchain makes, and mainnet deploys such
  programs today. A feature that is in the validators and not switched on ends that: SIMD-0500,
  "Disable deployment of SBPF v0, v1 and v2 programs" (`B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`).
  On a local validator with every feature on, a deploy of these builds failed at its last
  transaction (`invalid account data for instruction`), with the whole program already written
  to a buffer; with that one feature off it went through. The script asks the cluster first and
  sends nothing where the feature is active. From that day on, whatever is not yet on mainnet
  has to be rebuilt as SBPF v3 with a newer toolchain: other files with other hashes, to be
  tested again. By its title the feature is about deploying, an upgrade included, and not about
  programs that are already there.
- A deploy is a few hundred writes, and `LAMPORT_MAINNET_SEND` says how they are sent.
  `validators`, the default, sends them straight to the validators, as the command-line tool
  does by default: on devnet a program took seconds that way, where the public endpoint had let
  about 30 of 380 writes through in ten minutes before the tool gave up (2026-11-17). `rpc`
  sends them through the endpoint in `LAMPORT_MAINNET_RPC` (`--use-rpc`), which suits a
  provider that forwards with stake, on a plan that allows a few hundred sends a minute; the
  script refuses it for the public endpoint. Neither has been tried on mainnet. A deploy that
  stops half way loses nothing: `--deploy` again carries on from its buffer, with either
  setting.
- An endpoint's address may carry its key. Whatever the script and the tools it runs print
  shows the endpoint's scheme and host and nothing else of it.
- Between `--deploy` and `--burn` the deployer wallet can still replace the programs. After
  `--burn` nobody can: a bug is then fixed only by new programs under new ids, and by people
  moving to them (`Close` and recreate, for a vault).
- Afterwards: push `mainnet-<version>` in both repositories, so that CI compares the cluster with
  the builds, and write the slots and hashes under "Deployed" in `program-ids.md` and in
  lamport-vault's `docs/VERIFY.md`.

The keys (the deployer's and one per program) are in `~/.config/lamport/mainnet` on the owner's
machine, outside every repository.

## The pages

`npm run build:mainnet` in `app/` builds what is served under `/heir/` for the mainnet pair, and
`HEIR_SITE_CLUSTER=mainnet HEIR_SITE_HOST=<ssh host> tools/scripts/deploy-site.sh` publishes it
the way [`devnet.md`](devnet.md) describes for devnet. Two things on the site come first, and
both are in place: the first since 2026-11-17, the second since 2026-11-18.

The cold signer's lines in the Caddyfile, from `devnet.md`.

A route for the mainnet pages' json-rpc, beside the one the vault page has for devnet. The key is
the provider's, and stays on the server:

```
  @rpcmainnet {
    path /rpc-mainnet
    header Origin https://vault.lamportrobotics.com
  }
  handle @rpcmainnet {
    rewrite * /?api-key=<the provider's key>
    reverse_proxy https://mainnet.helius-rpc.com {
      header_up Host mainnet.helius-rpc.com
      header_up -Origin
      header_up -Referer
      header_up -Cookie
    }
  }
  @rpcmainnetother path /rpc-mainnet
  respond @rpcmainnetother 403
```

`deploy-site.sh` copies nothing for mainnet until the programs are on mainnet and
`/rpc-mainnet` answers as mainnet. It does answer: asked for the genesis hash with the site as
`Origin`, it gives mainnet's, and without that header it gives 403. The pages served under
`/heir/` are still the devnet build.

## Reminders and the finisher

Both read the chain and hold no key that can move a vault's funds. On mainnet they are run with a
mainnet endpoint (`LAMPORT_HEIR_RPC`, `--rpc`) and, for the finisher, `--mainnet`; its fee payer
then pays real fees.
