#!/usr/bin/env bash
# Deploys one pair of Heir programs to devnet and checks what landed.
#
#   scripts/deploy-devnet.sh            the short-clocks TEST pair (a day lasts a second)
#   scripts/deploy-devnet.sh --real     the pair with real durations
#
# Devnet only: the script refuses any other cluster. It needs the Solana CLI, the programs built
# (`npm run build:programs`), and the deployment keys in $LAMPORT_HEIR_DEVNET_KEYS (default
# ~/.config/lamport/heir-devnet): deployer.json, which pays and becomes the upgrade authority, and
# one key file per program. The key files never leave that folder and are never printed.
#
# A program of about 390 KB needs about 2.7 SOL of rent, the claim program about 1.9. Devnet's
# command-line faucet is closed; test SOL comes from https://faucet.solana.com, by hand.
set -euo pipefail

URL=https://api.devnet.solana.com
DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
KEYS="${LAMPORT_HEIR_DEVNET_KEYS:-$HOME/.config/lamport/heir-devnet}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "${1:-}" = "--real" ]; then
  DIR="$ROOT/target/deploy"; VAULT_KEY="$KEYS/vault.json"; CLAIM_KEY="$KEYS/claim.json"; WHAT="real durations"
  VAULT_ID=$(grep -o 'LAMPORT_VAULT_HEIR_PROGRAM_ID = new PublicKey("[^"]*' "$ROOT/vendor/lamport-vault/sdk/packages/vault/src/succession.ts" | cut -d'"' -f2)
  CLAIM_ID=$(grep -o 'HEIR_CLAIM_PROGRAM_ID = new PublicKey("[^"]*' "$ROOT/tools/src/programs.ts" | cut -d'"' -f2)
else
  DIR="$ROOT/target/deploy-short-clocks"; VAULT_KEY="$KEYS/vault-short-clocks.json"; CLAIM_KEY="$KEYS/claim-short-clocks.json"; WHAT="short-clocks TEST build"
  VAULT_ID=$(grep -o 'LAMPORT_VAULT_HEIR_SHORT_CLOCKS_PROGRAM_ID = new PublicKey("[^"]*' "$ROOT/vendor/lamport-vault/sdk/packages/vault/src/succession.ts" | cut -d'"' -f2)
  CLAIM_ID=$(grep -o 'HEIR_CLAIM_SHORT_CLOCKS_PROGRAM_ID = new PublicKey("[^"]*' "$ROOT/tools/src/programs.ts" | cut -d'"' -f2)
fi

fail() { echo "deploy-devnet: $*" >&2; exit 1; }
for f in "$KEYS/deployer.json" "$VAULT_KEY" "$CLAIM_KEY" "$DIR/lamport_vault.so" "$DIR/heir_claim.so"; do [ -f "$f" ] || fail "$f is missing"; done
[ "$(solana genesis-hash --url "$URL")" = "$DEVNET_GENESIS" ] || fail "$URL is not devnet"
# the key files must be the keys of the ids the source declares, or the programs would refuse to run where they land
[ "$(solana-keygen pubkey "$VAULT_KEY")" = "$VAULT_ID" ] || fail "$VAULT_KEY is not the key of the vault id in the source ($VAULT_ID)"
[ "$(solana-keygen pubkey "$CLAIM_KEY")" = "$CLAIM_ID" ] || fail "$CLAIM_KEY is not the key of the claim id in the source ($CLAIM_ID)"

DEPLOYER=$(solana-keygen pubkey "$KEYS/deployer.json")
bytes() { wc -c < "$1" | tr -d ' '; }
rent() { solana rent --url "$URL" --lamports "$(( $(bytes "$1") + 45 ))" | awk '/Rent-exempt minimum/ {print $3}'; }
NEED=$(( $(rent "$DIR/lamport_vault.so") + $(rent "$DIR/heir_claim.so") + 50000000 ))
HAVE=$(solana balance --url "$URL" --lamports "$DEPLOYER" | awk '{print $1}')
echo "pair       $WHAT"
echo "vault      $VAULT_ID   $(bytes "$DIR/lamport_vault.so") bytes"
echo "claim      $CLAIM_ID   $(bytes "$DIR/heir_claim.so") bytes"
echo "deployer   $DEPLOYER   holds $HAVE lamports, the two deployments need about $NEED"
[ "$HAVE" -ge "$NEED" ] || fail "not enough test SOL: send $(( (NEED - HAVE) / 1000000000 + 1 )) more to $DEPLOYER (https://faucet.solana.com)"

deploy() { # <program key file> <id> <so>
  echo; echo "== $2"
  solana program deploy --url "$URL" --keypair "$KEYS/deployer.json" --program-id "$1" --upgrade-authority "$KEYS/deployer.json" "$3"
  local dump; dump="$(mktemp)"
  solana program dump --url "$URL" "$2" "$dump" > /dev/null
  # the chain pads a program's account; compare the file's own length
  local want got; want=$(shasum -a 256 "$3" | cut -d' ' -f1); got=$(head -c "$(bytes "$3")" "$dump" | shasum -a 256 | cut -d' ' -f1); rm -f "$dump"
  [ "$want" = "$got" ] || fail "what is on chain at $2 is not $3"
  echo "on chain   sha256 $got  (the file that was built)"
  solana program show --url "$URL" "$2" | grep -E "Authority|Last Deployed|Data Length"
}
deploy "$VAULT_KEY" "$VAULT_ID" "$DIR/lamport_vault.so"
deploy "$CLAIM_KEY" "$CLAIM_ID" "$DIR/heir_claim.so"
echo; echo "done. Record both in docs/program-ids.md, then run the cycle: node scripts/cycle.ts --rpc $URL --keypair $KEYS/deployer.json"
