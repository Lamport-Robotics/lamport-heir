#!/usr/bin/env bash
# Deploys one pair of Heir programs to devnet and checks what landed.
#
#   scripts/deploy-devnet.sh            the short-clocks TEST pair (a day lasts a second)
#   scripts/deploy-devnet.sh --real     the pair with real durations
#
# Devnet only: the script refuses any other cluster. Running it again is safe: a program that is
# already on chain as the file that was built is left alone. It needs the Solana CLI, python3, the programs built
# (`npm run build:programs`), and the deployment keys in $LAMPORT_HEIR_DEVNET_KEYS (default
# ~/.config/lamport/heir-devnet): deployer.json, which pays and becomes the upgrade authority, and
# one key file per program. The key files never leave that folder and are never printed. Each
# deploy writes through a buffer account whose key file is kept there too, so that a deploy the
# network interrupted is resumed by running the script again, and the command-line tool has no
# recovery phrase to print.
#
# The vault needs about 2 SOL of rent and the claim program about 1.4; the script prints the exact
# figure before it sends anything. Devnet's command-line faucet is closed; test SOL comes from
# https://faucet.solana.com, by hand.
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

# What is on chain at a program id, asked of the endpoint itself: "absent", or the sha256 of its code and
# its upgrade authority. An endpoint that does not answer stops the script; it is never read as "absent".
# (The same reading as deploy-mainnet.sh.)
onchain() {
  python3 -I - "$URL" "$1" <<'PY'
import base64, hashlib, json, sys, urllib.request
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(b: bytes) -> str:
    n, s = int.from_bytes(b, "big"), ""
    while n:
        n, r = divmod(n, 58)
        s = ALPHABET[r] + s
    return "1" * (len(b) - len(b.lstrip(bytes(1)))) + s
def account(url: str, address: str):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getAccountInfo", "params": [address, {"encoding": "base64", "commitment": "confirmed"}]}).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    answer = json.load(urllib.request.urlopen(request, timeout=120))
    if "result" not in answer:
        sys.exit(f"the endpoint did not answer for {address}: {answer.get('error')}")
    value = answer["result"]["value"]
    return None if value is None else (value["owner"], base64.b64decode(value["data"][0]))
url, program = sys.argv[1:3]
LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"
found = account(url, program)
if found is None:
    print("absent")
    sys.exit(0)
owner, data = found
# a program account of the upgradeable loader: u32 2, then the address of its data account
if owner != LOADER or len(data) != 36 or int.from_bytes(data[:4], "little") != 2:
    sys.exit(f"{program} exists and is not a program of the upgradeable loader: look at it before anything else")
programdata = account(url, b58(data[4:36]))
if programdata is None:
    sys.exit(f"{program} has no data account: look at it before anything else")
raw = programdata[1]
# the data account: u32 3, u64 slot, Option<Pubkey> authority (1 + 32), then the code and zero padding
if int.from_bytes(raw[:4], "little") != 3 or raw[45:49] != b"\x7fELF":
    sys.exit(f"{program}: its data account does not hold a program")
print(hashlib.sha256(raw[45:].rstrip(bytes(1))).hexdigest(), b58(raw[13:45]) if raw[12] == 1 else "none")
PY
}
built_hash() { python3 -I -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read().rstrip(bytes(1))).hexdigest())' "$1"; }

state() { # <id> <so>: absent, same (this file is what is on chain) or other
  local seen; seen="$(onchain "$1")" || exit 1
  case "$seen" in
    absent) echo absent ;;
    "$(built_hash "$2") "*) echo same ;;
    *) echo other ;;
  esac
}
VAULT_STATE="$(state "$VAULT_ID" "$DIR/lamport_vault.so")" || exit 1
CLAIM_STATE="$(state "$CLAIM_ID" "$DIR/heir_claim.so")" || exit 1

# a program that is already this file costs nothing more; one that is absent, or is another build, needs its rent
# in hand while it is written (for another build the rent comes back when the upgrade lands)
NEED=0
[ "$VAULT_STATE" = same ] || NEED=$(( NEED + $(rent "$DIR/lamport_vault.so") ))
[ "$CLAIM_STATE" = same ] || NEED=$(( NEED + $(rent "$DIR/heir_claim.so") ))
[ "$NEED" -eq 0 ] || NEED=$(( NEED + 50000000 )) # and something for the fees of a few hundred transactions
HAVE=$(solana balance --url "$URL" --lamports "$DEPLOYER" | awk '{print $1}')
echo "pair       $WHAT"
echo "vault      $VAULT_ID   $(bytes "$DIR/lamport_vault.so") bytes   on chain: $VAULT_STATE"
echo "claim      $CLAIM_ID   $(bytes "$DIR/heir_claim.so") bytes   on chain: $CLAIM_STATE"
echo "deployer   $DEPLOYER   holds $HAVE lamports, what is left to deploy needs about $NEED"
[ "$HAVE" -ge "$NEED" ] || fail "not enough test SOL: send $(( (NEED - HAVE) / 1000000000 + 1 )) more to $DEPLOYER (https://faucet.solana.com)"

deploy() { # <program key file> <id> <so> <state>
  echo; echo "== $2"
  if [ "$4" = same ]; then
    echo "already on chain, and it is this file: nothing sent"
  else
    local buffer; buffer="$KEYS/buffer-$(basename "$1")"
    [ -f "$buffer" ] || { solana-keygen new --no-bip39-passphrase --silent --outfile "$buffer" >/dev/null 2>&1; chmod 600 "$buffer"; }
    solana program deploy --url "$URL" --keypair "$KEYS/deployer.json" --program-id "$1" --upgrade-authority "$KEYS/deployer.json" \
      --buffer "$buffer" --max-sign-attempts 60 --use-rpc "$3"
    rm -f "$buffer" # the buffer became the program: its key is of no further use
  fi
  # the endpoint may be a moment behind the deploy it just confirmed
  local seen="" tries=0
  while :; do
    seen="$(onchain "$2")" || exit 1
    [ "$seen" != absent ] && break
    tries=$(( tries + 1 )); [ "$tries" -lt 30 ] || fail "$2 is not on chain after the deploy"
    sleep 2
  done
  [ "${seen%% *}" = "$(built_hash "$3")" ] || fail "what is on chain at $2 is not $3"
  [ "${seen##* }" = "$DEPLOYER" ] || fail "the upgrade authority of $2 is ${seen##* }, not the deployer"
  echo "on chain   sha256 ${seen%% *}  (the file that was built)"
  echo "authority  ${seen##* }"
}
deploy "$VAULT_KEY" "$VAULT_ID" "$DIR/lamport_vault.so" "$VAULT_STATE"
deploy "$CLAIM_KEY" "$CLAIM_ID" "$DIR/heir_claim.so" "$CLAIM_STATE"
echo; echo "done. Record both in docs/program-ids.md, then run the cycle: node scripts/cycle.ts --rpc $URL --keypair $KEYS/deployer.json"
