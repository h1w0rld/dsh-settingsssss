#!/usr/bin/env bash
# Обратный деплой: затянуть ТЕКУЩЕЕ состояние плагина из профиля в этот репо.
# Использовать, если патчи делались руками в node_modules (так больше делать не надо).
set -euo pipefail

SRC="${DSH_HOME:-/dsh/.dsh}/profiles/web/node_modules/@h1w0rld/dsh-messenger-ru"
[ -d "$SRC" ] || SRC="${DSH_HOME:-/dsh/.dsh}/profiles/web/node_modules/@syncended/dsh-messenger"
DST="$(cd "$(dirname "$0")" && pwd)"

echo "==> Импорт текущего состояния $SRC -> $DST"
for f in dist lib python stt package.json cordis.patch.yml LICENSE README.md; do
  if [ -e "$SRC/$f" ]; then
    rsync -a --exclude '.bak-*' --exclude 'node_modules/' "$SRC/$f" "$DST/" 2>/dev/null || cp -r "$SRC/$f" "$DST/"
  fi
done
# новые бэкапы .bak-* — в attic/
mkdir -p "$DST/attic"
mv "$DST"/dist/*.bak-* "$DST/attic/" 2>/dev/null || true
git -C "$DST" status --short
echo "==> Проверь diff и закоммить: git -C $DST add -A && git -C $DST commit"
