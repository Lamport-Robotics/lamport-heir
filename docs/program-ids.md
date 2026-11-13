# Program ids

Nothing is deployed. The ids below are placeholders with **no private key**: each is the SHA-256 of
the label next to it, written in base58. Local tests load the programs at them, which needs no key.
They cannot be deployed to, on any cluster.

| program | id | label hashed |
|---|---|---|
| `heir-claim` | `2SbWfdn3N5LqZz4nwcJuUkD9DhPDJyMusSNqyWaUWUDd` | `lamport-heir/placeholder-program-id/heir-claim/v1` |
| Heir-enabled vault (lamport-vault built with `succession`) | `HK1QPbqjkozJHB74QuGaduYzAtqBe9hry3nV64LmpCsb` | `lamport-heir/placeholder-program-id/heir-vault/v1` |
| Heir-enabled vault, `short-clocks` test build | `DGe6SeUVApXcN7j3X613SeTmazXGqtAuFSn7RQWBiDDS` | `lamport-heir/placeholder-program-id/heir-vault-short-clocks/v1` |
| `heir-claim`, `short-clocks` test build | `HzoHmRyCtxv8nd9u9NpnLTJcJssGJvyvbjeWBY7BMXPD` | `lamport-heir/placeholder-program-id/heir-claim-short-clocks/v1` |

```sh
node -e 'const b=require("crypto").createHash("sha256").update(process.argv[1]).digest();
let n=BigInt("0x"+b.toString("hex")),s="";const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
while(n>0n){s=A[Number(n%58n)]+s;n/=58n}console.log(s)' lamport-heir/placeholder-program-id/heir-claim/v1
```

The claim program has the vault program's id compiled in (`VAULT_PROGRAM_ID` in
`programs/heir-claim/src/lib.rs`): it believes a tombstone only from that program. The two ids
therefore change together.

## Before devnet

A deployment needs real keypairs, and those are the project owner's to generate and keep. The
builder needs only the public keys. The change is then one commit per repository: `declare_id!` and
`VAULT_PROGRAM_ID` here, the `succession` build's `declare_id!` in lamport-vault.
