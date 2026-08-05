#!/usr/bin/env bash
# sync-appliers.sh — push the shared schema pieces out to sibling checkouts
# (the vendoring convention promised in Dingo/Docs/plans/2026-08-02-dingo-studio-design.md).
#
# What syncs, and which copy is canonical:
#   schemes/*.json, behaviors/*.json  — CANONICAL HERE. The preset pairs are
#     authored/edited in Studio and vendored into the apps verbatim:
#       DingoNav/schemes + DingoNav/behaviors      (SW-precached, offline)
#       Dingo/web/public/schemes + …/behaviors     (Plan fetches at runtime)
#   js/applier-nav.js — CANONICAL HERE for the ES-module form. DingoNav's
#     adopted copy (2026-08-05, PR #53) is a *translation* into its inline
#     single-file runtime, not a verbatim vendor — it is NOT overwritten by
#     this script; keep the two aligned by hand when the token vocabulary
#     grows (Nav naming: overlays.breadcrumb → colCrumb; day tokens only).
#   Dingo/web/src/scheme/applier.ts — Plan's TS port; also a translation,
#     also hand-aligned. This script only reminds you it exists.
#
# Usage: ./sync-appliers.sh [path-to-workspace-root]
#   Default workspace root is the parent of this checkout; siblings are
#   detected by name (case-insensitive): dingonav, dingo.

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="${1:-$(dirname "$here")}"

find_sibling() { # case-insensitive directory match under $root
  local want="$1" d
  for d in "$root"/*/; do
    [ -d "$d" ] || continue
    if [ "$(basename "$d" | tr '[:upper:]' '[:lower:]')" = "$want" ]; then echo "${d%/}"; return; fi
  done
}

sync_presets() { # $1 = target repo root, $2 = subdir prefix ('' or web/public)
  local target="$1" prefix="$2" dest
  for kind in schemes behaviors; do
    dest="$target${prefix:+/$prefix}/$kind"
    mkdir -p "$dest"
    cp "$here/$kind"/*.json "$dest/"
    echo "  $kind/ → ${dest#$root/}"
  done
}

nav="$(find_sibling dingonav)"
dingo="$(find_sibling dingo)"

if [ -n "$nav" ]; then
  echo "DingoNav ($nav):"
  sync_presets "$nav" ""
  echo "  (reminder: index.html applier + sw.js SHELL list are hand-aligned — bump the SW CACHE if presets changed)"
else
  echo "DingoNav: no sibling checkout found under $root — skipped"
fi

if [ -n "$dingo" ]; then
  echo "Dingo ($dingo):"
  sync_presets "$dingo" "web/public"
  echo "  (reminder: web/src/scheme/applier.ts is a hand-aligned TS port)"
else
  echo "Dingo: no sibling checkout found under $root — skipped"
fi

echo "done."
