#!/usr/bin/env bash
# check-patches.sh — read-only проверка, что патчи из patchedDependencies реально применены.
# Exit 1 при расхождениях.
set -u
PROFILE=/dsh/.dsh/profiles/web
WS="$PROFILE/pnpm-workspace.yaml"

entries=$(python3 - "$WS" <<'PY'
import sys, yaml
ws = yaml.safe_load(open(sys.argv[1]))
pd = ws.get('patchedDependencies') or {}
for k, v in pd.items():
    print(f"{k}\t{v}")
PY
)

if [ -z "$entries" ]; then echo "нет patchedDependencies"; exit 0; fi

fail=0
printf "%-45s %-10s %s\n" "PATCH KEY" "STATUS" "DETAIL"
printf -- "------------------------------------------------------------\n"
while IFS=$'\t' read -r key path; do
    [ -z "$key" ] && continue
    patchfile="$PROFILE/$path"
    # pkg и версия из ключа 'pkg@ver' (учёт scope: @a/b@1.2.3)
    if [[ "$key" =~ ^(@[^/]+/[^@]+)@([^@]+)$ ]]; then
        pkg="${BASH_REMATCH[1]}"; ver="${BASH_REMATCH[2]}"
    elif [[ "$key" =~ ^(@[^/]+/[^@]+)$ ]]; then
        pkg="${BASH_REMATCH[1]}"; ver=""
    elif [[ "$key" =~ ^([^@]+)@([^@]+)$ ]]; then
        pkg="${BASH_REMATCH[1]}"; ver="${BASH_REMATCH[2]}"
    else
        pkg="$key"; ver=""
    fi
    pkgdir="$PROFILE/node_modules/$pkg"
    pkgjson="$pkgdir/package.json"

    if [ ! -f "$patchfile" ]; then
        printf "%-45s %-10s %s\n" "$key" "FAIL" "патч-файл отсутствует: $path"; fail=1; continue
    fi
    if [ ! -f "$pkgjson" ]; then
        printf "%-45s %-10s %s\n" "$key" "FAIL" "плагин не установлен: $pkg"; fail=1; continue
    fi
    inst=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$pkgjson")
    if [ -n "$ver" ] && [ "$ver" != "$inst" ]; then
        printf "%-45s %-10s %s\n" "$key" "FAIL" "версия ключа $ver != установленная $inst"; fail=1; continue
    fi
    # первая добавленная строка патча (не +++ заголовок)
    plus=$(grep -m1 '^+[^+]' "$patchfile" | cut -c2-)
    if [ -z "$plus" ]; then
        printf "%-45s %-10s %s\n" "$key" "FAIL" "в патче нет добавленных строк"; fail=1; continue
    fi
    # все файлы, изменённые патчем
    applied=yes; miss=""
    while IFS= read -r f; do
        # строки пути из --- a/... могут быть /dev/null; берём только существующие
        if [ -f "$f" ] && ! grep -qF -- "$plus" "$f"; then
            applied=no; miss="$f"
        fi
    done < <(grep '^+++ ' "$patchfile" | sed 's|^+++ b/||' | sed 's|^+++ ||')
    if [ "$applied" = yes ]; then
        printf "%-45s %-10s %s\n" "$key" "OK" "v=$inst, патч применён (маркер: ${plus:0:30})"
    else
        printf "%-45s %-10s %s\n" "$key" "FAIL" "маркер не найден в $miss"; fail=1
    fi
done <<< "$entries"

printf -- "------------------------------------------------------------\n"
if [ "$fail" = 0 ]; then echo "ИТОГ: все патчи в порядке"; exit 0
else echo "ИТОГ: есть расхождения (exit 1)"; exit 1; fi
