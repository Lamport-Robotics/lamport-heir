# tools

The finisher, the claim tool and the claim kit. TypeScript, run directly by Node.js (22.18 or
later). Everything here talks to a plain Solana RPC endpoint and needs no Lamport server.

```
src/claim.ts      client for the claim program: terms, plan address, the plan account, instructions
src/release.ts    where a vault stands (inspect); the permissionless steps (start, finish)
src/claiming.ts   an heir taking what a vault released (claim)
src/finisher.ts   the loop that finishes every vault that is due
src/kit.ts        the printable claim kit
src/tokens.ts     token accounts under both token programs, withheld fees, transfer hooks
src/chain.ts      the RPC calls used, simulate and send
src/cli.ts        the command-line tool
test/             unit tests, against a stand-in for the cluster that executes nothing
e2e/              a release from end to end on a local validator
scripts/          shared vectors (kat/claim_encoding.json), program builds, the single-file build
```

## Set up

The vault's SDK comes from the pinned submodule and is built first.

```sh
git submodule update --init
(cd vendor/lamport-vault/sdk && npm ci && npm run build)
cd tools && npm ci
```

## The command-line tool

```sh
node src/cli.ts help
node src/cli.ts status <vault or plan>                       # reads public data; needs no key
node src/cli.ts start  <vault> --keypair FILE                # open the waiting period of an overdue vault
node src/cli.ts finish <vault or plan> --keypair FILE        # release a vault that is due, sweep its tokens
node src/cli.ts claim  <vault or plan> --keypair FILE [--salt SALT]
node src/cli.ts kit    <vault> --heir ADDRESS [--salt SALT] [--label NAME] --out kit.html
node src/cli.ts finisher --keypair FILE [--interval 60] [--once]
```

`--rpc URL` picks the endpoint (default: `$LAMPORT_HEIR_RPC`, else devnet). `--dry-run` asks the
cluster what would happen and sends nothing.

A key file is a Solana CLI keypair file. It signs and pays fees; it is never printed, copied or
sent. There is no option that takes a seed phrase or a key on the command line.

What each command may do:

| command | sends | signed by |
|---|---|---|
| `status`, `kit` | nothing | nobody |
| `start` | `start_succession` | any key; it only pays the fee |
| `finish`, `finisher` | `execute_succession`, `activate`, `sweep_closed`, `sweep_closed_sol`, fee harvests | any key; it pays fees and the rent of token accounts created for the heirs |
| `claim` | the above, then `claim_sol` and `claim_token` | the heir's key |

Every instruction in the first three rows is open to anyone on chain and can send funds only to
the address the vault's owner signed for. `finish` and `finisher` never send `start_succession`.

## Tests

```sh
npm run typecheck && npm test        # unit tests
npm run kat                          # rewrite kat/claim_encoding.json; the tests fail if it is stale
npm run build:programs               # both programs, real and short-clocks (needs cargo build-sbf)
npm run e2e                          # needs solana-test-validator on the PATH; about three minutes
npm run bundle                       # dist/lamport-heir.mjs, the tool as one file
```

The end-to-end run starts its own validator on port 18899 with the two `short-clocks` test builds,
in which a day lasts one second, and takes four vaults through a release:
`e2e/release.e2e.ts` describes them at the top.
