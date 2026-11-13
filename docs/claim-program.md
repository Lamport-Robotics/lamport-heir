# The claim program

`programs/heir-claim`. It holds what a Lamport Vault releases, for the heirs the owner named.

A vault's succession names one address. When the vault releases, that address receives the vault's
SOL and becomes the only place its tokens can be swept to (lamport-vault's `sweep_closed`). Naming a
**plan** account of this program as that address adds a contingent heir, who may claim if the primary
heir does not.

- No admin, authority, pause or fee. Nobody can change a plan.
- A plan's terms are fixed by its address.
- Funds leave a plan in two ways only, `claim_sol` and `claim_token`. Each needs the signature of an
  heir the terms name, and each works only after the vault's own tombstone says it released to this
  plan.

Not deployed anywhere. Not audited.

## A plan and its terms

```
terms       = vault: Pubkey || primary: HeirRef || contingent: HeirRef || contingent_delay_secs: u64le     106 bytes
HeirRef     = kind: u8 || value: [u8; 32]                                                                   33 bytes
terms_hash  = sha256("lamport-heir/plan/v1" || terms)
plan        = PDA ["plan", terms_hash] of this program
```

| `kind` | means | `value` |
|---|---|---|
| 0 | no heir (contingent position only) | 32 zero bytes |
| 1 | an address, public from the start | the address |
| 2 | a hashed heir, private until they claim | `sha256("lamport-heir/heir/v1" \|\| salt[32] \|\| address)` |

A hashed heir claims by signing and passing the salt. **A lost salt blocks the claim for good**, so
the claim kit prints it.

Rules for terms (`Terms::validate`): a vault; a primary heir; a contingent heir different from the
primary, or none; a contingent delay of 0 with no contingent heir, and from 30 days to 100 years
with one.

The `Plan` account, 181 bytes:

| offset | field | bytes | |
|---|---|---|---|
| 0 | discriminator | 8 | `sha256("account:Plan")[..8]` |
| 8 | `version` | 1 | 1 |
| 9 | `bump` | 1 | |
| 10 | `terms_hash` | 32 | |
| 42 | `terms.vault` | 32 | |
| 74 | `terms.primary` | 33 | |
| 107 | `terms.contingent` | 33 | |
| 140 | `terms.contingent_delay_secs` | 8 | |
| 148 | `created_ts` | 8 | |
| 156 | `activated` | 1 | |
| 157 | `activated_ts` | 8 | |
| 165 | `closed_slot` | 8 | from the vault's tombstone |
| 173 | `contingent_clock_ts` | 8 | where the contingent delay counts from |

A plan is never closed. Sweeps and late SOL can reach a closed vault's heir at any time, so the plan
keeps its rent (about 0.002 SOL) and stays claimable.

## Instructions

| instruction | accounts, in order | who signs |
|---|---|---|
| `init_plan(terms_hash, terms)` | payer (w), plan (w), vault, instructions sysvar, system program; then any heirs who sign | payer, and heirs who prove control by signing |
| `activate()` | plan (w), vault | nobody |
| `claim_sol(salt: Option<[u8;32]>)` | plan (w), heir (w) | the heir |
| `claim_token(salt: Option<[u8;32]>, close_account: bool)` | plan (w), heir (w), plan's token account (w), destination token account (w), mint, token program; then anything the mint's transfer hook needs | the heir |

In `claim_sol` and `claim_token` the fee payer may be someone other than the heir.

### `init_plan`

Creates the plan. Anyone may pay.

- `terms_hash` must be the hash of `terms`. It is passed separately so the PDA seed is a plain
  argument.
- The vault must be an open vault of the Heir-enabled vault program. A mistyped vault address fails
  here, before anything depends on the plan.
- One other state of the vault is accepted: **it has already released to this very plan.** The
  vault program cannot tell a plan that was never created from a wallet that was never used, so a
  vault can be armed to a plan's address with no plan there, and would then release to an address
  no key controls. The owner signed for that address, and only these terms produce it, so the plan
  may be created late, by anyone who knows the terms. No heir has to prove control then: a proof
  guards against naming an address nobody controls before funds depend on it, and here the funds
  are already there. Demanding one would let a primary heir who can no longer sign keep the
  contingent heir out. A vault that released anywhere else lets no plan be created for it.
- **Every heir named by address must prove they control it.** Either is enough:
  1. They sign this transaction, as the payer or as an extra account.
  2. The transaction carries an instruction for Solana's Ed25519 program that verified their
     signature over the acceptance message:

     ```
     Lamport Heir: I control this address and accept being named an heir in plan <plan address>.
     ```

     The heir can sign that with any wallet's message signing, at any time, and hand the signature
     to whoever creates the plan. They need no SOL and need not be online. The same text inside an
     off-chain message envelope (bytes that start with `\xffsolana offchain` and end with the text,
     at most 128 bytes longer) is accepted too, which is what a hardware wallet signs.

  `init_plan` reads the Ed25519 instruction from the instructions sysvar. It only counts an entry
  whose signature, key and message all sit in that same instruction; an entry that points into
  another instruction proves nothing.
- Hashed heirs prove nothing on chain. Showing their address is what hashing avoids, so the owner's
  app checks their signature itself.

### `activate`

Records that the vault released to this plan. It believes one thing: an 81-byte tombstone at the
vault's address, owned by the Heir-enabled vault program, whose `heir` is this plan. The contingent
delay counts from the moment it runs, because a tombstone holds a slot and not a time. Anyone may
call it, including the contingent heir, and calling it again changes nothing.

### `claim_sol` and `claim_token`

- **The primary heir** may claim at any time after activation, and is never shut out.
- **The contingent heir** may claim once `now >= contingent_clock_ts + contingent_delay_secs`. The
  clock starts at activation and restarts every time the primary heir claims. A primary who is still
  claiming keeps the contingent heir out; a primary who stops leaves the rest to the contingent heir
  after the delay.
- Everyone else is refused.

`claim_sol` sends every lamport above the plan's own rent to the signer. It can be called again when
more arrives.

`claim_token` sends the whole balance of one token account the plan owns to a token account **the
signer owns**, for Token and Token-2022. With `close_account` it also closes the plan's account, its
rent to the signer. Closing is the caller's choice because some accounts cannot be closed yet: a
Token-2022 account holding withheld transfer fees has to be harvested first. The tokens can always be
claimed with `close_account` unset and the empty account closed by a later call.

## Errors

| code | name | |
|---|---|---|
| 6000 | `InvalidTerms` | no vault, no primary heir, or an unknown heir kind |
| 6001 | `TermsHashMismatch` | |
| 6002 | `InvalidContingentDelay` | |
| 6003 | `SameHeirTwice` | |
| 6004 | `NotALiveVault` | the vault in the terms is not an open vault of the vault program, nor one that released to this plan |
| 6005 | `HeirNotProven` | |
| 6006 | `WrongInstructionsSysvar` | |
| 6007 | `WrongVault` | not the vault the plan names |
| 6008 | `VaultNotClosed` | |
| 6009 | `NotATombstone` | |
| 6010 | `TombstoneNamesAnother` | the vault released to another address |
| 6011 | `NotActivated` | |
| 6012 | `NotAnHeir` | also a hashed heir without its salt |
| 6013 | `ContingentTooEarly` | |
| 6014 | `NothingToClaim` | |
| 6015 | `InvalidTokenProgram` | |
| 6016 | `NotPlanTokenAccount` | |
| 6017 | `WrongMint` | |
| 6018 | `DestinationNotHeirs` | the destination token account is not the signer's |
| 6019 | `Overflow` | |

## Build and test

```sh
cargo test --workspace                                              # unit tests, on the host
cargo build-sbf --manifest-path programs/heir-claim/Cargo.toml     # target/deploy/heir_claim.so
cd tests/svm && cargo test                                          # the built program in LiteSVM
```

`cargo build-sbf` comes with the Solana tools (agave 2.3.x in CI) and fetches platform-tools v1.56,
the version `programs/heir-claim/Cargo.toml` pins. The LiteSVM tests load the `.so`, so build first.
Most of them fabricate the vault's accounts (an open vault, a tombstone). `tests/release.rs` does
not: there the Heir-enabled vault program itself, built from the pinned submodule, runs beside the
claim program, and the claim program reads what the vault program wrote. Build both first with
`node tools/scripts/build-programs.mjs`.

The program also has a `short-clocks` test build (own program id, a day lasts one second) for the
end-to-end run on a local validator and for devnet: [`release-tools.md`](release-tools.md).

The byte layouts are pinned by `kat/claim_encoding.json`, which the TypeScript client writes and
`programs/heir-claim/tests/encoding.rs` checks against the program's own types.
