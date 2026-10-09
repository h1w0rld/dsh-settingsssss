#!/usr/bin/env bash
# harness-restore.sh — восстановление «золотого набора» (B3).
# По умолчанию DRY-RUN: распаковка в tools/staging/p6-restore-tmp, diff по манифесту,
# НИКАКИХ записей в живые файлы. --apply — реальное восстановление
# (сначала снимок изменяемых файлов в backups/pre-restore-<ts>.tar.zst).
# Использование: harness-restore.sh [архив] [--apply] [--root DIR] [--help]
#   архив    по умолчанию — новейший backups/harness-golden-*.tar.zst
#   --root   подменить корни для теста: <root>/dsh = /dsh, <root>/harness = /opt/projects/harness
set -euo pipefail
ROOT=/opt/projects/harness
BK="$ROOT/backups"
STAGE="$ROOT/tools/staging/p6-restore-tmp"
APPLY=0; ARC=""; ALTROOT=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --root) : ;; --root=*) ALTROOT="${a#--root=}" ;;
    --help|-h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "неизвестный флаг: $a (--help)"; exit 2 ;;
    *) ARC="$a" ;;
  esac
done
DSH=/dsh; HR=$ROOT
if [ -n "$ALTROOT" ]; then ALTROOT=$(realpath -m "$ALTROOT"); DSH="$ALTROOT/dsh"; HR="$ALTROOT/harness"; mkdir -p "$DSH/.agents" "$DSH/.dsh" "$HR/tools" "$HR/notes"; fi
[ -n "$ARC" ] || ARC=$(ls -1t "$BK"/harness-golden-*.tar.zst 2>/dev/null | head -1)
[ -n "$ARC" ] && [ -f "$ARC" ] || { echo "нет архива (укажите путь или соберите harness-backup.sh)"; exit 1; }
case "$(realpath -e "$ARC")" in "$BK"/harness-golden-*.tar.zst) ;; *) echo "архив вне $BK/harness-golden-*: отказ"; exit 1 ;; esac
zstd -t "$ARC" || { echo "архив битый"; exit 1; }

rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -I zstd -xf "$ARC" -C "$STAGE"
G="$STAGE/golden"
[ -f "$G/MANIFEST.sha256" ] || { echo "в архиве нет MANIFEST.sha256"; exit 1; }

# --- маппинг путей из набора в живые ---
map() { # $1 = путь внутри golden (relative), echo живой путь
  case "$1" in
    ./AGENTS.md) echo "$DSH/.dsh/AGENTS.md" ;;
    ./dsh-agents-skills/*) echo "$DSH/.agents/skills/${1#./dsh-agents-skills/}" ;;
    ./profile-web-*) echo "/dsh/.dsh/profiles/web/${1#./profile-web-}" ;;
    ./profile-patches/*) echo "/dsh/.dsh/profiles/web/patches/${1#./profile-patches/}" ;;
    ./skills-manager-state.json) echo "/dsh/.dsh/skills-manager/state.json" ;;
    ./tools/*) echo "$HR/${1#./}" ;;
    ./notes/*) echo "$HR/${1#./}" ;;
    ./dsh-harness-guard/*) echo "$HR/${1#./}" ;;
    *) echo "" ;;
  esac
}

MODIFIED=0; ADDED=0; MISSING=0; LIST=""
while read -r sum path; do
  live=$(map "$path")
  [ -n "$live" ] || continue
  if [ ! -f "$live" ]; then
    [ "$ALTROOT" = "" ] && { MISSING=$((MISSING+1)); LIST="$LIST
  ОТСУТСТВУЕТ: $live"; } || { MISSING=$((MISSING+1)); LIST="$LIST
  ОТСУТСТВУЕТ: $live"; }
  elif [ "$(sha256sum "$live" | cut -d' ' -f1)" != "$sum" ]; then
    MODIFIED=$((MODIFIED+1)); LIST="$LIST
  ИЗМЕНЁН: $live"
  fi
done < "$G/MANIFEST.sha256"

# добавленные живые файлы, которых нет в наборе (только в зонах набора)
EXTRA=""
for d in "$DSH/.agents/skills" "$HR/tools" "$HR/notes" "$HR/dsh-harness-guard" "/dsh/.dsh/profiles/web/patches"; do
  [ -d "$d" ] || continue
  while IFS= read -r -d '' f; do
    rel=""
    case "$f" in
      "$DSH"/.agents/skills/*) rel="dsh-agents-skills/${f#"$DSH"/.agents/skills/}" ;;
      "$HR"/tools/*) rel="tools/${f#"$HR"/tools/}" ;;
      "$HR"/notes/*) rel="notes/${f#"$HR"/notes/}" ;;
      "$HR"/dsh-harness-guard/*) rel="dsh-harness-guard/${f#"$HR"/dsh-harness-guard/}" ;;
      *) rel="profile-patches/${f##*/}" ;;
    esac
    grep -qF -- " ./$rel" "$G/MANIFEST.sha256" 2>/dev/null || EXTRA="$EXTRA
  ДОБАВЛЕНО (нет в наборе): $f"
  done < <(find "$d" -type f \( -name '*.md' -o -name '*.json' -o -name '*.py' -o -name '*.sh' -o -name '*.mjs' -o -name '*.yml' \) ! -path '*/staging/*' ! -path '*/archive/*' ! -path '*/backup-*' ! -name '*.bak*' -print0 2>/dev/null)
done

echo "=== DRY-RUN сравнение с $ARC ==="
echo "изменено: $MODIFIED, отсутствует: $MISSING"
[ -n "$LIST" ] && printf '%s\n' "$LIST"
[ -n "$EXTRA" ] && { echo "лишние .md-файлы:"; printf '%s\n' "$EXTRA" | head -20; }
[ "$MODIFIED" = 0 ] && [ "$MISSING" = 0 ] && echo "живые файлы совпадают с золотым набором — восстанавливать нечего."

if [ "$APPLY" = 0 ]; then
  rm -rf "$STAGE"
  echo "DRY-RUN завершён, ничего не записано."
  exit 0
fi

[ "$ALTROOT" = "" ] || { echo "--apply с --root: восстановление в тестовое дерево"; }

# --- снимок текущего состояния изменяемых файлов ---
SNAP="$BK/pre-restore-$(date +%Y%m%d-%H%M%S).tar.zst"
SNAPLIST="$STAGE/snaplist.txt"
: > "$SNAPLIST"
while read -r sum path; do
  live=$(map "$path"); [ -n "$live" ] && [ -f "$live" ] && echo "$live" >> "$SNAPLIST"
done < "$G/MANIFEST.sha256"
tar -C / -cf - -T "$SNAPLIST" 2>/dev/null | zstd -3 -q -o "$SNAP"
chmod 600 "$SNAP"
echo "снимок до восстановления: $SNAP ($(($(stat -c%s "$SNAP")/1024)) КБ)"

# --- восстановление только файлов из набора ---
n=0
while read -r sum path; do
  live=$(map "$path"); [ -n "$live" ] || continue
  mkdir -p "$(dirname "$live")"
  cp -a "$G/$path" "$live"
  n=$((n+1))
done < "$G/MANIFEST.sha256"
echo "восстановлено файлов: $n"
rm -rf "$STAGE"
if [ "$ALTROOT" = "" ]; then
  echo "dsh не перезапускался; patchReload=live подхватит cordis.patch.yml; для плагинов/ядра: systemctl restart dsh.service — только с согласия пользователя."
fi
