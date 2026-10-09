#!/usr/bin/env bash
# verify-patches.sh — сверка sha256 патчей репо и живого профиля web.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LIVE="/dsh/.dsh/profiles/web/patches"
rc=0
for f in "$REPO_DIR"/profile/patches/*; do
  base="$(basename "$f")"
  if [ ! -f "$LIVE/$base" ]; then
    echo "DIFF: $base отсутствует в $LIVE"; rc=1; continue
  fi
  a="$(sha256sum "$f" | awk '{print $1}')"
  b="$(sha256sum "$LIVE/$base" | awk '{print $1}')"
  if [ "$a" = "$b" ]; then
    echo "OK: $base $a"
  else
    echo "DIFF: $base repo=$a live=$b"; rc=1
  fi
done
# и обратное: файлы в live, которых нет в репо
for f in "$LIVE"/*; do
  base="$(basename "$f")"
  [ -f "$REPO_DIR/profile/patches/$base" ] || { echo "DIFF: $base только в live"; rc=1; }
done
[ "$rc" = 0 ] && echo "ALL OK" || echo "FAILED"
exit "$rc"
