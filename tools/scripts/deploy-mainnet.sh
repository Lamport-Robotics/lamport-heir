#!/usr/bin/env bash
# Puts the four programs on mainnet from the builds CI made, checks what landed against those
# builds, and, as a separate step, makes them unchangeable.
#
#   scripts/deploy-mainnet.sh            checks everything and says what it would do. Sends nothing.
#   scripts/deploy-mainnet.sh --deploy   deploys what is not on chain yet, then checks it
#   scripts/deploy-mainnet.sh --burn     removes the upgrade authority of each program. Cannot be undone.
#
# This is the project owner's to run. --deploy spends real SOL from the deployer wallet as rent.
# Until --burn that rent can be had back, by closing a program, which ends its id for good; after
# --burn it never comes back and nobody, the owner included, can change the code: a bug is then
# fixed only by new programs that people move to.
#
# The programs (docs/program-ids.md, and lamport-vault's docs/VERIFY.md):
#
#   vault        lamport-vault built with `mainnet`               the vault
#   heir-vault   lamport-vault built with `mainnet,succession`    the Heir-enabled vault
#   registry     pq-registry built with `mainnet`
#   heir-claim   heir-claim built with `mainnet`                  believes heir-vault's tombstones only
#
# LAMPORT_MAINNET_PROGRAMS="heir-vault heir-claim" limits a run to some of them.
#
# What is deployed is never a local build. It is the artifact of the `verify` workflow for the
# commit this checkout is at (lamport-heir) and for the commit its lamport-vault submodule is
# pinned to, fetched with `gh`. The same hash is what CI compares with the cluster when the
# `mainnet-<version>` tags are pushed afterwards.
#
# Keys: $LAMPORT_MAINNET_KEYS (default ~/.config/lamport/mainnet) holds deployer.json, which pays
# and is the upgrade authority until --burn, and one key file per program. They never leave that
# folder and are never printed. Each deploy writes through a buffer account whose key file is kept
# there too, so that a deploy the network interrupted is resumed by running --deploy again, and
# the command-line tool has no recovery phrase to print.
#
# LAMPORT_MAINNET_RPC is the endpoint the chain is read through (default the public one). If its
# address carries a key, the key is never shown: everything this script and the tools it runs
# print passes a filter that leaves the endpoint's scheme and host and nothing else of it.
#
# LAMPORT_MAINNET_SEND says how the few hundred writes of a deploy are sent:
#   validators   straight to the validators, the command-line tool's own default, and the default
#                here. On devnet, 2026-11-17, a program took seconds this way where the public
#                endpoint had let about 30 of 380 writes through in ten minutes.
#   rpc          through the endpoint (--use-rpc): for a provider that forwards with stake, on a
#                plan that allows a few hundred sends a minute. Refused for the public endpoint.
# A deploy that stops half way loses nothing: --deploy again carries on from its buffer, with
# either setting.
set -euo pipefail

PUBLIC_URL=https://api.mainnet-beta.solana.com
URL="${LAMPORT_MAINNET_RPC:-$PUBLIC_URL}"
# all of the endpoint that is ever printed: its scheme and host
SHOWN_URL="$(printf '%s' "$URL" | sed -E 's#^([a-z]+://[^/?]+).*$#\1#')"
hide() {
  HIDE_URL="$URL" HIDE_AS="$SHOWN_URL" python3 -I -u -c '
import os, re, sys
url, shown = os.environ["HIDE_URL"], os.environ["HIDE_AS"]
for line in sys.stdin:
    line = line.replace(url, shown)
    line = re.sub(r"((?:api[-_]?key|access[-_]?token|token)=)[^&\s\")]+", r"\1<hidden>", line, flags=re.I)
    sys.stdout.write(line)
    sys.stdout.flush()
'
}
# the script runs itself once more with everything it prints, errors included, passing that filter
if [ -z "${LAMPORT_MAINNET_FILTERED:-}" ]; then
  LAMPORT_MAINNET_FILTERED=1 bash "$0" "$@" 2>&1 | hide
  exit "${PIPESTATUS[0]}"
fi
MAINNET_GENESIS=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
KEYS="${LAMPORT_MAINNET_KEYS:-$HOME/.config/lamport/mainnet}"
CU_PRICE="${LAMPORT_MAINNET_CU_PRICE:-20000}" # micro-lamports per compute unit, so the writes land
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VAULT_REPO=Lamport-Robotics/lamport-vault
HEIR_REPO=Lamport-Robotics/lamport-heir

mode=check
for arg in "$@"; do
  case "$arg" in
    --deploy) mode=deploy ;;
    --burn) mode=burn ;;
    *) echo "unknown option: $arg" >&2; exit 64 ;;
  esac
done

fail() { echo "deploy-mainnet: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
for tool in solana solana-keygen gh python3 git; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on PATH"; done
SEND="${LAMPORT_MAINNET_SEND:-validators}"
case "$SEND" in
  validators) use_rpc=""; how="straight to the validators" ;;
  rpc) use_rpc="--use-rpc"; how="through the endpoint" ;;
  *) fail "LAMPORT_MAINNET_SEND is \"$SEND\": it is validators or rpc" ;;
esac
if [ "$SEND" = rpc ] && [ "$URL" = "$PUBLIC_URL" ]; then
  fail "LAMPORT_MAINNET_SEND=rpc needs a provider's endpoint in LAMPORT_MAINNET_RPC: the public one lets too few writes through"
fi

# name | repository | artifact prefix | file in the artifact | program id | the devnet id the same source declares without `mainnet`
table() {
  cat <<EOF
heir-vault|$VAULT_REPO|lamport_vault-mainnet-heir|lamport_vault.so|3XsnTrQJ5XmFyEyVauMmMseHph4wXkn6QWUZCRPjuEEX|3mJU9ozZByXsHavMGfzdwDLFs9YuFaMA3jabaLwczxAV
heir-claim|$HEIR_REPO|heir_claim-mainnet|heir_claim.so|L8EWcWfZbPu3iWNSkShaFJYwLgQ5vAdjLQNzP2DY8Yf|cvxRorjDzekSCcAyiinzgALnBT1dTuUdVvEraPeDkUW
vault|$VAULT_REPO|lamport_vault-mainnet|lamport_vault.so|7EiE5pRP5byrY7mzvUBfXS2UD8GwGtPhbGne6D1BTR5H|B7dNdVV8shrKgqx7A5JvBQBp7vsTyQTLrdAdeiLKwXqH
registry|$VAULT_REPO|pq_registry-mainnet|pq_registry.so|9MYg9uqYBrTPXA6MNRZ6cbpwHSissY3496Y84iofTaNF|48J2BtWFjEUbGPYf1yMPBkHxpy4dLo69gK2znQR2q2ad
EOF
}
wanted="${LAMPORT_MAINNET_PROGRAMS:-heir-vault heir-claim vault registry}"
for name in $wanted; do table | grep -q "^$name|" || fail "unknown program \"$name\" in LAMPORT_MAINNET_PROGRAMS"; done
rows() { table | while IFS= read -r row; do case " $wanted " in *" ${row%%|*} "*) echo "$row" ;; esac; done; }

say "the cluster"
[ "$(solana genesis-hash --url "$URL")" = "$MAINNET_GENESIS" ] || fail "$URL is not mainnet"
echo "mainnet-beta, through $URL"

say "the commits"
[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || fail "this checkout has changes in no commit; a deployment is of a commit anyone can check out"
git -C "$ROOT" fetch -q origin main
heir_sha="$(git -C "$ROOT" rev-parse HEAD)"
[ "$heir_sha" = "$(git -C "$ROOT" rev-parse origin/main)" ] || fail "this checkout is not at lamport-heir's main; a deployment is of main"
vault_sha="$(git -C "$ROOT/vendor/lamport-vault" rev-parse HEAD)"
[ "$vault_sha" = "$(git -C "$ROOT" ls-tree HEAD vendor/lamport-vault | awk '{print $3}')" ] || fail "vendor/lamport-vault is not at the commit this checkout pins; run git submodule update"
echo "lamport-heir   $heir_sha"
echo "lamport-vault  $vault_sha (the commit lamport-heir pins)"

say "the keys"
[ -f "$KEYS/deployer.json" ] || fail "$KEYS/deployer.json is missing"
deployer="$(solana-keygen pubkey "$KEYS/deployer.json")"
rows | while IFS='|' read -r name _ _ _ id _; do
  [ -f "$KEYS/$name.json" ] || fail "$KEYS/$name.json is missing"
  # the key file must be the key of the id the source declares, or the program would refuse to run where it lands
  [ "$(solana-keygen pubkey "$KEYS/$name.json")" = "$id" ] || fail "$KEYS/$name.json is not the key of $id"
  echo "$name is $id"
done
echo "deployer is $deployer"

say "the builds, from CI"
art="$ROOT/target/mainnet-artifacts"
mkdir -p "$art"
rows | while IFS='|' read -r name repo prefix file id devnet_id; do
  case "$repo" in "$VAULT_REPO") sha="$vault_sha" ;; *) sha="$heir_sha" ;; esac
  dir="$art/$prefix-$sha"
  if [ ! -f "$dir/$file" ]; then
    run="$(gh run list --repo "$repo" --workflow verify.yml --commit "$sha" --status success --json databaseId --jq '.[0].databaseId // empty')"
    [ -n "$run" ] || fail "no successful verify run for $repo at $sha yet: the commit has to be on main and its build finished"
    rm -rf "$dir"
    gh run download "$run" --repo "$repo" --name "$prefix-$sha" --dir "$dir" >/dev/null || fail "could not download $prefix-$sha from $repo"
  fi
  [ -f "$dir/$file" ] || fail "$dir/$file is missing from the artifact"
  # a build carries its own id: the mainnet one has to be in it, and the devnet one the same source declares must not be.
  # the claim program also carries the one vault program it believes: that has to be the mainnet Heir-enabled vault
  python3 -I - "$dir/$file" "$id" "$devnet_id" "$name" <<'PY' || exit 1
import hashlib, sys
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def raw(address: str) -> bytes:
    n = 0
    for c in address:
        n = n * 58 + ALPHABET.index(c)
    return n.to_bytes(32, "big")
def carries(elf: bytes, address: str) -> bool:
    """An id is in a program either whole, as data, or as the four 8-byte immediates the compiler
    loads it with: each is one lddw, its low half, four bytes of the next slot's header, its high half."""
    b = raw(address)
    return b in elf or all(b[i:i + 4] + bytes(4) + b[i + 4:i + 8] in elf for i in range(0, 32, 8))
path, mainnet_id, devnet_id, name = sys.argv[1:5]
elf = open(path, "rb").read()
if elf[:4] != b"\x7fELF":
    sys.exit(f"{name}: the artifact is not a program")
must, must_not = [mainnet_id], [devnet_id]
if name == "heir-claim":
    must.append("3XsnTrQJ5XmFyEyVauMmMseHph4wXkn6QWUZCRPjuEEX")      # the mainnet Heir-enabled vault
    must_not.append("3mJU9ozZByXsHavMGfzdwDLFs9YuFaMA3jabaLwczxAV")  # the devnet one
for address in must:
    if not carries(elf, address):
        sys.exit(f"{name}: the build does not carry the mainnet id {address}")
for address in must_not:
    if carries(elf, address):
        sys.exit(f"{name}: the build carries the devnet id {address}: it is not the mainnet build")
print(f"{name:<11} {hashlib.sha256(elf.rstrip(bytes(1))).hexdigest()}  {len(elf)} bytes")
PY
done

# what is on chain for a program: "absent", or "<hash of the code> <authority, or none>".
# Asked of the endpoint directly, so that it does not depend on how the command-line tool is set up
# on this machine. An answer that cannot be read stops the script: a failed question is never
# taken for "absent", because the next step would then be to deploy again.
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
so_of() { # the artifact file of a row
  local repo="$1" prefix="$2" file="$3" sha
  case "$repo" in "$VAULT_REPO") sha="$vault_sha" ;; *) sha="$heir_sha" ;; esac
  echo "$art/$prefix-$sha/$file"
}

say "what is on chain"
need=0
state_file="$(mktemp)"
rows | while IFS='|' read -r name repo prefix file id _; do
  so="$(so_of "$repo" "$prefix" "$file")"
  state="$(onchain "$id")"
  if [ "$state" = absent ]; then
    lamports="$(solana rent --url "$URL" --lamports "$(( $(wc -c < "$so") + 45 ))" | awk '/Rent-exempt minimum/ {print $3}')"
    echo "$name: not deployed. Rent $(python3 -I -c 'import sys; print(int(sys.argv[1]) / 1e9)' "$lamports") SOL"
    echo "$name absent $lamports" >> "$state_file"
  else
    hash="${state%% *}"; authority="${state##* }"
    if [ "$hash" = "$(built_hash "$so")" ]; then match=MATCH; else match=MISMATCH; fi
    echo "$name: deployed, $match with the CI build, upgrade authority $authority"
    echo "$name $match $authority" >> "$state_file"
  fi
done
need="$(awk '$2 == "absent" {s += $3} END {print s + 0}' "$state_file")"
balance="$(solana balance "$deployer" --url "$URL" --lamports | awk '{print $1}')"
# on top of the rent: a deploy is a few hundred transactions, and the buffer's rent is held until it becomes the program's
margin=50000000
echo
python3 -I - "$need" "$balance" "$margin" "$deployer" <<'PY'
import sys
need, balance, margin, deployer = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
print(f"rent still to pay   {need / 1e9:.4f} SOL")
print(f"deployer holds      {balance / 1e9:.4f} SOL  ({deployer})")
if need and balance < need + margin:
    print(f"short by            {(need + margin - balance) / 1e9:.4f} SOL, counting {margin / 1e9} SOL for fees")
PY

if [ "$mode" = check ]; then
  echo
  echo "Nothing was sent. --deploy deploys what is not on chain; --burn makes what is there unchangeable."
  rm -f "$state_file"; exit 0
fi

if [ "$mode" = deploy ]; then
  [ "$need" -gt 0 ] || { echo; echo "Everything named is already on chain."; rm -f "$state_file"; exit 0; }
  [ "$balance" -ge "$(( need + margin ))" ] || fail "the deployer does not hold enough for the rent and the fees"
  rows | while IFS='|' read -r name repo prefix file id _; do
    grep -q "^$name absent " "$state_file" || continue
    so="$(so_of "$repo" "$prefix" "$file")"
    say "deploying $name at $id, its writes sent $how"
    buffer="$KEYS/buffer-$name.json"
    [ -f "$buffer" ] || { solana-keygen new --no-bip39-passphrase --silent --outfile "$buffer" >/dev/null 2>&1; chmod 600 "$buffer"; }
    solana program deploy "$so" --url "$URL" --keypair "$KEYS/deployer.json" --program-id "$KEYS/$name.json" \
      --upgrade-authority "$KEYS/deployer.json" --buffer "$buffer" --with-compute-unit-price "$CU_PRICE" --max-sign-attempts 60 ${use_rpc:+"$use_rpc"}
    # the deploy is confirmed when the tool returns; give the endpoint a minute to show it
    state=absent
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do state="$(onchain "$id")"; [ "$state" = absent ] || break; sleep 5; done
    [ "$state" != absent ] || fail "$name is not on chain after the deploy"
    [ "${state%% *}" = "$(built_hash "$so")" ] || fail "$name on chain is NOT the CI build. Do not use it, and do not burn its authority."
    [ "${state##* }" = "$deployer" ] || fail "$name has upgrade authority ${state##* }, not the deployer"
    echo "$name: on chain, MATCH with the CI build"
  done
  rm -f "$state_file"
  echo
  echo "Deployed. The deployer can still change these programs. When you have looked at them, --burn ends that."
  exit 0
fi

# --burn
[ "$need" -eq 0 ] || fail "not everything named is deployed; --burn is for when all of it is"
if grep -q " MISMATCH " "$state_file"; then fail "something on chain is not the CI build; nothing was changed"; fi
rows | while IFS='|' read -r name _ _ _ id _; do
  authority="$(awk -v n="$name" '$1 == n {print $3}' "$state_file")"
  if [ "$authority" = none ]; then echo "$name: already unchangeable"; continue; fi
  [ "$authority" = "$deployer" ] || fail "$name has upgrade authority $authority, not the deployer; nothing more was changed"
  say "removing the upgrade authority of $name ($id). This cannot be undone."
  solana program set-upgrade-authority "$id" --final --url "$URL" --keypair "$KEYS/deployer.json" --upgrade-authority "$KEYS/deployer.json"
  state="$(onchain "$id")"
  [ "${state##* }" = none ] || fail "$name still has upgrade authority ${state##* }"
  echo "$name: unchangeable"
done
rm -f "$state_file"
echo
echo "Done. Nobody can change these programs. What is left in the deployer wallet is yours to move:"
solana balance "$deployer" --url "$URL"
