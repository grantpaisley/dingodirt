#!/usr/bin/env bash
# assemble-app.sh — build a deploy-ready artefact for a no-build app.
#
# Nav and Studio are served as static files and reach core/schemes,
# core/behaviors and core/appliers through symlinks. Symlinks do not survive
# a static host, so the deploy step copies with -L to dereference them into
# real files. This is the PAT-free replacement for the old cross-repo
# sync-appliers workflow: nothing is written back into any repo, the presets
# are simply assembled at deploy time from the one canonical copy.
#
# Nav additionally needs its service-worker cache name to change whenever the
# presets change — its SW is cache-first, so offline riders keep serving stale
# presets until the cache name moves. Rather than incrementing by hand (which
# the old workflow did, and which silently no-ops if someone forgets), the
# cache name gets a short content hash of the assembled presets appended:
#
#     dingonav-v67  ->  dingonav-v67-a1b2c3d4
#
# Manual vN bumps still work and still force a refresh; the hash covers the
# case where only a preset changed. Identical presets produce an identical
# hash, so a rebuild that changes nothing does NOT churn riders' caches.
#
# Usage: tools/assemble-app.sh <nav|studio> <output-dir>

set -euo pipefail

app="${1:?usage: assemble-app.sh <nav|studio> <output-dir>}"
out="${2:?usage: assemble-app.sh <nav|studio> <output-dir>}"

case "$app" in
  nav|studio) ;;
  *) echo "error: app must be 'nav' or 'studio' (got '$app')" >&2; exit 2 ;;
esac

repo="$(cd "$(dirname "$0")/.." && pwd)"
src="$repo/apps/$app"
[ -d "$src" ] || { echo "error: $src does not exist" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out"

# -L dereferences symlinks, so core/schemes etc. land as real files.
cp -RL "$src"/. "$out"/

# Fail loudly rather than shipping an app whose presets never arrived — a
# dangling link would otherwise produce a silently preset-less deploy.
for kind in schemes behaviors; do
  d="$out/$kind"
  [ -d "$d" ] || { echo "error: $kind/ missing from the artefact — is apps/$app/$kind a broken symlink?" >&2; exit 1; }
  count=$(find "$d" -name '*.json' | wc -l | tr -d ' ')
  [ "$count" -gt 0 ] || { echo "error: $kind/ assembled empty" >&2; exit 1; }
  echo "  $kind/: $count files"
  # A symlink surviving into the artefact means cp -L did not do its job.
  if find "$d" -type l | grep -q .; then
    echo "error: symlinks survived into the artefact — deploy would 404" >&2; exit 1
  fi
done

if [ "$app" = nav ]; then
  sw="$out/sw.js"
  [ -f "$sw" ] || { echo "error: sw.js missing from the nav artefact" >&2; exit 1; }

  # Hash the assembled presets, sorted for stability across filesystems.
  hash=$(find "$out/schemes" "$out/behaviors" -name '*.json' -print0 \
    | sort -z | xargs -0 cat | shasum -a 256 | cut -c1-8)

  before=$(grep -oE "dingonav-v[0-9]+(-[0-9a-f]{8})?" "$sw" | head -1)
  base=$(printf '%s' "$before" | grep -oE 'dingonav-v[0-9]+')
  after="$base-$hash"

  # Portable in-place edit (BSD and GNU sed disagree about -i).
  tmp="$(mktemp)"
  sed "s/${before}/${after}/g" "$sw" > "$tmp" && mv "$tmp" "$sw"

  echo "  sw.js cache: $before -> $after"
  grep -q "$after" "$sw" || { echo "error: SW cache name was not rewritten" >&2; exit 1; }
fi

echo "assembled apps/$app -> $out"
