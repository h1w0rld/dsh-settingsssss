#!/usr/bin/env bash
# Деплой собранного плагина из этого репо в DSH-профиль web.
# Репозиторий — источник истины; профиль — место исполнения.
#
# Использование:
#   ./deploy.sh            # скопировать файлы в профиль
#   ./deploy.sh --restart  # деплой + systemctl restart dsh
#   ./restore.sh           # наоборот: втащить ТЕКУЩЕЕ состояние node_modules в репо (спасение патчей)
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DST="${DSH_HOME:-/dsh/.dsh}/profiles/web/node_modules/@h1w0rld/dsh-messenger-ru"
OLD="${DSH_HOME:-/dsh/.dsh}/profiles/web/node_modules/@syncended/dsh-messenger"

# Разовая миграция переименования (ru.3): старый путь @syncended/dsh-messenger
# переезжает на новое имя пакета @h1w0rld/dsh-messenger-ru.
if [ ! -d "$DST" ] && [ -d "$OLD" ]; then
  echo "==> Миграция: $OLD -> $DST (переименование пакета)"
  mkdir -p "$(dirname "$DST")"
  mv "$OLD" "$DST"
  rmdir "$(dirname "$OLD")" 2>/dev/null || true
fi

if [ ! -d "$DST" ]; then
  echo "ОШИБКА: $DST не найден. Плагин отсутствует в профиле?" >&2
  exit 1
fi

echo "==> Деплой $SRC -> $DST"
rsync -a --delete \
  --exclude '.bak-*' \
  --exclude 'node_modules/' \
  "$SRC/dist" "$SRC/lib" "$SRC/python" "$SRC/stt" "$DST/"
# package.json и cordis.patch.yml хардлинкнуты между репо и профилем;
# cp отказывается копировать файл на самого себя ("are the same file") — пропускаем.
for f in package.json cordis.patch.yml; do
  [ "$SRC/$f" -ef "$DST/$f" ] || cp -f "$SRC/$f" "$DST/"
done

echo "==> Проверка sharp-стаба (урок 27.09: npm-операции его перетирают)"
SHARP=/opt/dsh/node_modules/sharp
if [ -f "$SHARP/package.json" ] && grep -q '"name": "sharp"' "$SHARP/package.json" 2>/dev/null && [ ! -f "$SHARP/dist/sharp.cjs" ]; then
  echo "    sharp выглядит как Proxy-стаб (это осознанное состояние) — ok"
else
  echo "    ВНИМАНИЕ: состояние sharp нестандартное — проверь вручную: ls $SHARP"
fi

echo "==> Готово. Чтобы применить: systemctl restart dsh"
if [ "${1:-}" = "--restart" ]; then
  echo "==> Рестарт dsh"
  systemctl restart dsh
  sleep 2
  systemctl is-active dsh
fi
exit 0
