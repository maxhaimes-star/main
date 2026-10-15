#!/usr/bin/env bash
# Fetches the Forge card database (cards, tokens, editions, formats, booster sheets) with a blobless,
# sparse, depth-1 clone, then builds data/carddb with scripts/build-carddb.ts.
#
# Fails soft: when anything goes wrong it prints a warning and exits 0, and the site runs with only
# the built-in cube (server/src/carddb.ts reports the database as unavailable).
#
# Env: FORGE_CACHE (clone dir, default .cache/forge), FORGE_REPO, FORGE_REF (branch, default master),
#      CARDDB_OUT (default data/carddb), CARDDB_STRICT=1 to fail hard instead.
set -uo pipefail
export GIT_TERMINAL_PROMPT=0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${FORGE_CACHE:-$ROOT/.cache/forge}"
REPO="${FORGE_REPO:-https://github.com/Card-Forge/forge.git}"
REF="${FORGE_REF:-master}"
OUT="${CARDDB_OUT:-$ROOT/data/carddb}"
RES=forge-gui/res
DIRS=("$RES/cardsfolder" "$RES/tokenscripts" "$RES/editions" "$RES/formats" "$RES/blockdata")

soft_fail() {
  echo "WARNING: card database build skipped ($1). The site will run with only the built-in cube." >&2
  [ "${CARDDB_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

command -v git >/dev/null 2>&1 || soft_fail "git not installed"

if [ -d "$CACHE/.git" ]; then
  echo "Updating Forge checkout in $CACHE"
  git -C "$CACHE" fetch --depth 1 --filter=blob:none origin "$REF" || soft_fail "git fetch failed"
  git -C "$CACHE" sparse-checkout set "${DIRS[@]}" || soft_fail "sparse-checkout failed"
  git -C "$CACHE" reset --hard FETCH_HEAD || soft_fail "checkout failed"
else
  echo "Cloning Forge ($REPO, $REF) into $CACHE"
  rm -rf "$CACHE"
  mkdir -p "$(dirname "$CACHE")"
  git clone --depth 1 --filter=blob:none --sparse --branch "$REF" "$REPO" "$CACHE" || soft_fail "git clone failed"
  git -C "$CACHE" sparse-checkout set "${DIRS[@]}" || soft_fail "sparse-checkout failed"
fi

[ -d "$CACHE/$RES/cardsfolder" ] || soft_fail "cardsfolder missing after checkout"
COMMIT="$(git -C "$CACHE" rev-parse HEAD 2>/dev/null || echo unknown)"

cd "$ROOT" || soft_fail "repo root missing"
npx tsx scripts/build-carddb.ts --forge "$CACHE/$RES" --out "$OUT" --commit "$COMMIT" || {
  rm -rf "$OUT"
  soft_fail "build-carddb failed"
}
du -sh "$OUT" 2>/dev/null || true
