#!/usr/bin/env bash
# Puts the pages under /heir/ on the vault's site, and checks what is served afterwards.
#
#   HEIR_SITE_HOST=<ssh host> scripts/deploy-site.sh          # builds, checks, shows what would change; copies nothing
#   HEIR_SITE_HOST=<ssh host> scripts/deploy-site.sh --go     # copies, then compares every served file with the build
#
# The site is the vault's: a directory of static files behind Caddy (lamport-vault, web/README.md).
# This copies app/dist/heir/ into its heir/ folder and touches nothing else there.
#
# It refuses to publish:
#   - a test build (short clocks, or pointed at a local validator);
#   - pages for programs that are not on the cluster: a page that cannot work is worse than no page;
#   - anything, when the tree it was built from has changes that are in no commit.
#
# The cold signer needs two lines in the site's Caddyfile, because it carries its script inline and
# the site's policy for pages does not allow that. They are in docs/devnet.md, and the last check
# here fails until they are in place.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
host="${HEIR_SITE_HOST:-}"
site_dir="${HEIR_SITE_DIR:-/opt/lamportvault/site}"
site_url="${HEIR_SITE_URL:-https://vault.lamportrobotics.com}"
rpc="${LAMPORT_HEIR_RPC:-https://api.devnet.solana.com}"
go=0
for arg in "$@"; do
  case "$arg" in
    --go) go=1 ;;
    *) echo "unknown option: $arg" >&2; exit 64 ;;
  esac
done
[ -n "$host" ] || { echo "HEIR_SITE_HOST is not set: the ssh host the site is on" >&2; exit 64; }

say() { printf '\n== %s\n' "$*"; }
sha() { shasum -a 256 | cut -c1-64; }

say "the tree"
if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ]; then
  echo "there are changes in no commit; what is published has to be something anyone can check out" >&2
  exit 1
fi
commit="$(git -C "$repo" rev-parse HEAD)"
echo "commit $commit"

say "the programs these pages are for, on $rpc"
ids="$(cd "$repo/tools" && node --input-type=module -e 'import { PROGRAMS } from "./src/programs.ts"; console.log(PROGRAMS.vault.toBase58(), PROGRAMS.claim.toBase58())')"
for id in $ids; do
  answer="$(curl -sS "$rpc" -X POST -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$id\",{\"encoding\":\"base64\",\"dataSlice\":{\"offset\":0,\"length\":0}}]}")"
  if ! printf '%s' "$answer" | grep -q '"executable":true'; then
    echo "$id is not a program on this cluster. Deploy first (scripts/deploy-devnet.sh --real): nothing is published for a program that is not there." >&2
    exit 1
  fi
  echo "$id is deployed"
done

say "the build"
(cd "$repo/app" && env -u HEIR_CLOCK -u HEIR_RPC node build.mjs | grep -A4 '^dist/heir/')
dist="$repo/app/dist/heir"
if grep -q '127\.0\.0\.1\|localhost' "$dist/index.html" "$dist/claim.html"; then
  echo "this build talks to a local endpoint: it is a test build" >&2
  exit 1
fi

say "what would change on $host:$site_dir/heir/"
ssh -o BatchMode=yes "$host" "test -d '$site_dir'" || { echo "$site_dir is not there on $host" >&2; exit 1; }
rsync -rlc --delete --dry-run --itemize-changes "$dist/" "$host:$site_dir/heir/" || true

if [ "$go" != 1 ]; then
  echo
  echo "Nothing was copied. Run again with --go to publish."
  exit 0
fi

say "copying"
stamp="$(date -u +%Y%m%d-%H%M%S)"
# what is there now is kept beside the site, so that going back is one copy
ssh -o BatchMode=yes "$host" "if [ -d '$site_dir/heir' ]; then mkdir -p '$site_dir/../backups' && cp -a '$site_dir/heir' '$site_dir/../backups/heir-$stamp' && echo 'kept the old pages as backups/heir-$stamp'; fi"
# no --chmod here: the rsync that ships with macOS does not take one
rsync -rlc --delete "$dist/" "$host:$site_dir/heir/"
ssh -o BatchMode=yes "$host" "find '$site_dir/heir' -type d -exec chmod 2775 {} + && find '$site_dir/heir' -type f -exec chmod 664 {} + && printf '%s\n' '$commit' > '$site_dir/heir/COMMIT'"

say "what is served at $site_url/heir/"
failed=0
while IFS= read -r file; do
  rel="${file#"$dist"/}"
  local_hash="$(sha < "$file")"
  served_hash="$(curl -fsS "$site_url/heir/$rel" | sha || true)"
  if [ "$local_hash" = "$served_hash" ]; then echo "same      $rel"; else echo "DIFFERENT $rel"; failed=1; fi
done < <(find "$dist" -type f | sort)

# the cold signer carries its script inline: under the site's policy for pages it would not run
policy="$(curl -fsSI "$site_url/heir/signer.html" | tr -d '\r' | grep -i '^content-security-policy:' || true)"
if printf '%s' "$policy" | grep -q "connect-src 'none'" && ! printf '%s' "$policy" | grep -q "script-src 'self'"; then
  echo "the signer is served with its own policy: no network, its own script"
else
  echo "the signer is served with the policy for pages, under which it cannot run. Add the lines in docs/devnet.md to the site's Caddyfile." >&2
  failed=1
fi

[ "$failed" = 0 ] || { echo; echo "What is served is not what was built. Look before telling anyone." >&2; exit 1; }
echo
echo "Published commit $commit under $site_url/heir/"
