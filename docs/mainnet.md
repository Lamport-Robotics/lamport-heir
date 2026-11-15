# Mainnet

**Nothing is deployed on mainnet.** This page is how a deployment is made and what it changes.
The record of what is deployed is the table in [`program-ids.md`](program-ids.md).

## What has and has not been checked

- No independent audit of the vault, of its Heir build, or of the claim program.
  [`audit/README.md`](audit/README.md) is written for whoever does one.
- A whole cycle (arm, go quiet, warn, start, release, sweep, claim) has run against a local
  validator with the `short-clocks` builds, in CI on every push. It has not run on a public
  cluster, devnet included ([`devnet.md`](devnet.md)).
- The programs with real durations have never been deployed anywhere.

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
- `--deploy` spends SOL from the deployer wallet as rent, which does not come back: about 2 SOL
  for the Heir-enabled vault, 1.4 for the claim program, 1.8 for the vault and 1.3 for the
  registry at the time of writing. The script prints the exact figures before sending anything.
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
the way [`devnet.md`](devnet.md) describes for devnet. Two things on the site come first.

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
`/rpc-mainnet` answers as mainnet.

## Reminders and the finisher

Both read the chain and hold no key that can move a vault's funds. On mainnet they are run with a
mainnet endpoint (`LAMPORT_HEIR_RPC`, `--rpc`) and, for the finisher, `--mainnet`; its fee payer
then pays real fees.
