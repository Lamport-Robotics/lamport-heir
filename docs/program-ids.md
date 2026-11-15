# Program ids

Four ids for devnet, in two pairs, and a third pair for mainnet further down. Each of the four has
a deployment keypair, made for devnet on 2026-11-13 and kept by
the project owner outside every repository. An id says where a build goes, not that it is there:
the table under "Deployed" is the record of what is.

| program | id |
|---|---|
| `heir-claim` | `cvxRorjDzekSCcAyiinzgALnBT1dTuUdVvEraPeDkUW` |
| Heir-enabled vault (lamport-vault built with `succession`) | `3mJU9ozZByXsHavMGfzdwDLFs9YuFaMA3jabaLwczxAV` |
| `heir-claim`, `short-clocks` test build | `HxMZSdKeFP2zJzhYUVNHefqEEz3B87EdTRjKwwPG6UhE` |
| Heir-enabled vault, `short-clocks` test build | `3pwH161r4SZRH6nCHY4RUm7gk2NZqypyFJaUgv9a2duG` |

The claim program has the vault program's id compiled in (`VAULT_PROGRAM_ID` in
`programs/heir-claim/src/lib.rs`): it believes a tombstone only from that program. The two ids of
a pair therefore change together.

The `short-clocks` builds are the second pair, for tests on a local validator and on devnet: a day
lasts one second in both, each has its own id, and the `short-clocks` claim program believes the
`short-clocks` vault and no other. Neither can stand in for a real program. The tools know the two
pairs (`tools/src/programs.ts`) and tell them apart by the program that owns a vault.

Until 2026-11-13 the four ids were placeholders with no private key (the SHA-256 of a label).
Local tests never needed more; a deployment does, because a program refuses to run at an address
other than the one it declares.

## Mainnet

Mainnet has a pair of its own, and the vault and the registry have mainnet ids too
([`mainnet.md`](mainnet.md)). Each has a deployment keypair, made on 2026-11-15 and kept by the
project owner outside every repository.

| program | id |
|---|---|
| `heir-claim`, built with `mainnet` | `L8EWcWfZbPu3iWNSkShaFJYwLgQ5vAdjLQNzP2DY8Yf` |
| Heir-enabled vault (lamport-vault built with `mainnet,succession`) | `3XsnTrQJ5XmFyEyVauMmMseHph4wXkn6QWUZCRPjuEEX` |
| vault (lamport-vault built with `mainnet`) | `7EiE5pRP5byrY7mzvUBfXS2UD8GwGtPhbGne6D1BTR5H` |
| registry (pq-registry built with `mainnet`) | `9MYg9uqYBrTPXA6MNRZ6cbpwHSissY3496Y84iofTaNF` |

## Deployed

Nothing yet, on any cluster.

| cluster | program | id | deployed | sha256 of the program file | upgrade authority |
|---|---|---|---|---|---|

Devnet only. Mainnet is the project owner's decision, after an audit.

## Keys

- The four program keypairs matter once: at the first deployment to a cluster. After that the
  address is taken, and what controls the program is its upgrade authority.
- The devnet upgrade authority is a key made for devnet alone. It holds test SOL and nothing else.
- None of these files is in a repository, a CI secret or a log.
