#!/usr/bin/env bash
# harness-backup.sh — «золотой бэкап» настроенного харнеса (B3).
# Собирает ОДИН архив backups/harness-golden-<ts>.tar.zst (tar | zstd -19 -T1, 600)
# с MANIFEST.sha256 внутри; снаружи — tools/golden.manifest (для harness-check.sh).
# Использование: harness-backup.sh [--keep N=2] [--help]
set -euo pipefail
ROOT=/opt/projects/<harness>
BK="$ROOT/backups"
TS=$(date +%Y%m%d-%H%M%S)
KEEP=2
for a in "$@"; do
  case "$a" in
    --keep) : ;; --keep=*) KEEP="${a#--keep=}" ;;
    --help|-h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "неизвестный аргумент: $a (--help)"; exit 2 ;;
  esac
done
[ -d "$BK" ] || { mkdir -p "$BK"; chmod 700 "$BK"; }

STAGE=$(mktemp -d "$ROOT/tools/staging/p6-backup-XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
G="$STAGE/golden"
mkdir -p "$G"

# --- сбор набора ---
mkdir -p "$G/dsh-agents-skills" "$G/profile-patches"
cp -a /dsh/.agents/skills/. "$G/dsh-agents-skills/"
find "$G/dsh-agents-skills" \( -name node_modules -o -name .git -o -name '*.bak*' \) -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$G/dsh-agents-skills" -name '*.bak*' -type f -delete 2>/dev/null || true
cp -a /dsh/.dsh/AGENTS.md "$G/AGENTS.md"
for f in cordis.patch.yml package.json pnpm-workspace.yaml; do
  [ -f "/dsh/.dsh/profiles/web/$f" ] && cp -a "/dsh/.dsh/profiles/web/$f" "$G/profile-web-$f"
done
[ -d /dsh/.dsh/profiles/web/patches ] && cp -a /dsh/.dsh/profiles/web/patches/. "$G/profile-patches/"
cp -a /dsh/.dsh/skills-manager/state.json "$G/skills-manager-state.json" 2>/dev/null || echo "WARN: skills-manager/state.json нет"
mkdir -p "$G/tools" "$G/notes"
# tools: скрипты + json-наборы, БЕЗ staging/backup-*/archive/__pycache__
find "$ROOT/tools" -maxdepth 1 -type f \( -name '*.py' -o -name '*.sh' -o -name '*.mjs' \) -exec cp -a {} "$G/tools/" \;
mkdir -p "$G/tools/skill-eval"
find "$ROOT/tools/skill-eval" -maxdepth 1 -name '*.json' -exec cp -a {} "$G/tools/skill-eval/" \;
cp -a "$ROOT"/notes/*.md "$G/notes/" 2>/dev/null || true
[ -d "$ROOT/dsh-harness-guard" ] && { mkdir -p "$G/dsh-harness-guard"; (cd "$ROOT/dsh-harness-guard" && tar cf - --exclude=node_modules --exclude=.git .) | tar xf - -C "$G/dsh-harness-guard"; }

# --- манифест ---
cd "$G"
find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256
cp MANIFEST.sha256 "$ROOT/tools/golden.manifest"

# --- предупреждение о секретах (значения не печатаем) ---
nsec=$(grep -Ein 'token|apikey|api_key|secret|password' "$G/profile-web-cordis.patch.yml" | wc -l)
[ "$nsec" -gt 0 ] && { echo "ПРЕДУПРЕЖДЕНИЕ: в cordis.patch.yml $nsec строк с token/apiKey/secret/password (значения НЕ печатаются). Архив держать приватным: НЕ отправлять в git/sync/чаты."; } || true

# --- архив ---
ARC="$BK/harness-golden-$TS.tar.zst"
tar -C "$STAGE" -cf - golden | zstd -19 -T1 -q -o "$ARC"
chmod 600 "$ARC"

# --- проверка ---
zstd -t "$ARC" && NFILES=$(tar -tf "$ARC" | grep -vc '/$')
SIZE_KB=$(( $(stat -c%s "$ARC") / 1024 ))
echo "OK: $ARC"
echo "файлов в архиве: $NFILES (манифест: $(wc -l < "$G/MANIFEST.sha256")); размер: ${SIZE_KB} КБ"

# --- ротация: строго по абсолютному пути и префиксу ---
i=0
ls -1t "$BK"/harness-golden-*.tar.zst 2>/dev/null | while read -r f; do
  i=$((i+1))
  rp=$(realpath -e "$f") || continue
  case "$rp" in "$BK"/harness-golden-*.tar.zst) ;; *) continue ;; esac
  [ "$i" -le "$KEEP" ] || rm -f -- "$rp"
done
echo "осталось архивов: $(ls -1 "$BK"/harness-golden-*.tar.zst | wc -l) (keep=$KEEP)"
