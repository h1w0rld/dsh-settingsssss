#!/usr/bin/env bash
# harness-export.sh — ПЕРЕЗАПИСЫВАЕТ дерево этого репо из живых файлов стенда.
# ЗАПУСКАТЬ ВРУЧНУЮ ПОЛЬЗОВАТЕЛЕМ: guard запросит подтверждение (читаются защищённые пути).
# Скрипт сам НЕ пушит: после запуска — git add -A && git commit && git push.
# Опция --secrets: зашифрованный бандл реальных секретов /root/dsh-secrets.tar.enc
#   (openssl enc -aes-256-cbc -pbkdf2 -salt, пароль интерактивно; в репо НЕ попадает).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="/dsh/.agents/skills"
DSH_HOME="/dsh/.dsh"
HARNESS_DIR="/opt/projects/harness"
DSH_ROOT="/opt/dsh"
SECRETS=0
[ "${1:-}" = "--secrets" ] && SECRETS=1

log() { echo "[export] $*"; }

# 0) сохранить сам экспортный скрипт (шаг 7 пересоздаёт tools/ целиком)
tmp_script="$(mktemp)"
cp -a "$REPO_DIR/tools/harness-export.sh" "$tmp_script"
trap 'rm -f "$tmp_script"' EXIT

# 1) скиллы (без node_modules и *.bak*)
log "skills <- $SKILLS_SRC"
rm -rf "$REPO_DIR/staging/skills" && mkdir -p "$REPO_DIR/staging/skills"
tar -C "$SKILLS_SRC" --exclude=node_modules --exclude='*.bak*' -cf - . | tar -C "$REPO_DIR/staging/skills" -xf -
rm -rf "$REPO_DIR/skills" && mv "$REPO_DIR/staging/skills" "$REPO_DIR/skills" && rm -rf "$REPO_DIR/staging"

# 2) AGENTS.md и skills-manager state.json (защищённые пути: guard спросит)
log "AGENTS.md + state.json <- $DSH_HOME"
cp -a "$DSH_HOME/AGENTS.md" "$REPO_DIR/profile/AGENTS.md"
cp -a "$DSH_HOME/skills-manager/state.json" "$REPO_DIR/profile/state.json"
chmod 600 "$REPO_DIR/profile/AGENTS.md" "$REPO_DIR/profile/state.json"

# 3) профиль web: package.json, pnpm-workspace.yaml, patches
log "profile web <- $DSH_HOME/profiles/web"
cp -a "$DSH_HOME/profiles/web/package.json" "$DSH_HOME/profiles/web/pnpm-workspace.yaml" "$REPO_DIR/profile/"
mkdir -p "$REPO_DIR/profile/patches"
cp -a "$DSH_HOME/profiles/web/patches/." "$REPO_DIR/profile/patches/"
rm -f "$REPO_DIR"/profile/patches/*.PARTIAL

# 4) cordis.patch.yml -> template с санитизацией значений (sed)
log "cordis.patch.yml -> profile/cordis.patch.yml.template (санитизация)"
sed -E \
  -e "s/4478239[2]5/\${TELEGRAM_ALLOWED_CHAT_ID}/g" \
  -e "s/(claimCode:[[:space:]]*')[^']*(')/\1\${CLAIM_CODE}\2/g" \
  -e "s#bot[0-9]{6,}:[A-Za-z0-9_-]+#\${TELEGRAM_BOT_TOKEN}#g" \
  -e "s/sk-[A-Za-z0-9_-]{20,}/\${PROVIDER_API_KEY}/g" \
  -e "s/ghp_[A-Za-z0-9]{20,}/\${GITHUB_TOKEN}/g" \
  "$DSH_HOME/profiles/web/cordis.patch.yml" > "$REPO_DIR/profile/cordis.patch.yml.template"
# контроль: в шаблоне не должно остаться литеральных секретов
if grep -nE "sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|bot[0-9]{6,}:" "$REPO_DIR/profile/cordis.patch.yml.template"; then
  echo "ОШИБКА: в шаблоне остались секреты — проверь вручную, шаблон НЕ перезаписан корректно"; exit 1
fi

# 5) плагины (dist включать: pnpm install стирает его через prepare)
# dsh-guard здесь НЕ копируется: он живёт в /opt/dsh/dsh-guard и берётся шагом 6
log "plugins <- $HARNESS_DIR"
for name in dsh-messenger-ru dsh-recovery-resume dsh-harness-guard; do
  tmp="$(mktemp -d)"
  tar -C "$HARNESS_DIR/$name" --exclude=node_modules --exclude=.git -cf - . | tar -C "$tmp" -xf -
  rm -rf "$REPO_DIR/plugins/$name"
  mkdir -p "$REPO_DIR/plugins/$name"
  cp -a "$tmp/." "$REPO_DIR/plugins/$name/"
  rm -rf "$tmp"
done

# 6) сторож dsh-guard: только скрипт (state/backups/quarantine/guard.env НЕ копировать)
log "dsh-guard.py <- $DSH_ROOT/dsh-guard"
mkdir -p "$REPO_DIR/plugins/dsh-guard"
cp -a "$DSH_ROOT/dsh-guard/dsh-guard.py" "$REPO_DIR/plugins/dsh-guard/dsh-guard.py"

# 7) tools и notes (сам экспортный скрипт восстанавливаем из временной копии)
log "tools, notes <- $HARNESS_DIR"
rm -rf "$REPO_DIR/tools" "$REPO_DIR/notes"
cp -a "$HARNESS_DIR/tools" "$REPO_DIR/tools"
cp -a "$HARNESS_DIR/notes" "$REPO_DIR/notes"
cp -a "$tmp_script" "$REPO_DIR/tools/harness-export.sh"
chmod +x "$REPO_DIR/tools/harness-export.sh"

# 7.5) санитизация chat id в трёх файлах (чтобы повторный экспорт не вернул id)
log "санитизация CHAT_ID (3 файла)"
sed -i -E "s/4478239[2]5/\${TELEGRAM_ALLOWED_CHAT_ID}/g" \
  "$REPO_DIR/plugins/dsh-messenger-ru/cordis.patch.yml" \
  "$REPO_DIR/notes/dsh-restart.md"
# dsh-guard.py: литеральный id -> чтение из переменной окружения (минимальная правка)
sed -i -E \
  -e 's/"CHAT_ID": "4478239[2]5"/"CHAT_ID": ""/' \
  -e 's/^CHAT_ID = ENV\["CHAT_ID"\]$/CHAT_ID = os.environ.get("DSH_GUARD_CHAT_ID") or ENV["CHAT_ID"]/' \
  "$REPO_DIR/plugins/dsh-guard/dsh-guard.py"
if grep -rn "4478239[2]5" "$REPO_DIR" --exclude-dir=.git; then
  echo "ОШИБКА: в экспорте остался chat id — санитизация не сработала"; exit 1
fi

# 7.6) санитизация личного пути стенда: /opt/projects/harness -> /opt/projects/<harness>
log "санитизация HARNESS_DIR (личный путь в текстовых файлах, кроме этого скрипта)"
find "$REPO_DIR" -path "$REPO_DIR/.git" -prune -o -type f -print0 \
  | grep -zv "^$REPO_DIR/tools/harness-export.sh$" \
  | xargs -0 -r grep -lIFa "/opt/projects/harness" \
  | xargs -0 -r sed -i "s#/opt/projects/harness#/opt/projects/<harness>#g"
if grep -rn "opt/projects/harness" "$REPO_DIR" --exclude-dir=.git --exclude=harness-export.sh; then
  echo "ОШИБКА: в экспорте остался личный путь — санитизация не сработала"; exit 1
fi

# 8) итог
log "git diff --stat:"
git -C "$REPO_DIR" diff --stat || true
git -C "$REPO_DIR" status --short | head -40 || true

if [ "$SECRETS" = 1 ]; then
  log "шифрованный бандл секретов -> /root/dsh-secrets.tar.enc (в репо не попадает)"
  tar -C / -czf - \
    "root/secrets.env" \
    "opt/dsh/telegram.env" \
    "opt/dsh/llm.env" \
    "opt/dsh/dsh-guard/guard.env" \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -out /root/dsh-secrets.tar.enc
  log "готово: /root/dsh-secrets.tar.enc (расшифровка: openssl enc -d -aes-256-cbc -pbkdf2 -in /root/dsh-secrets.tar.enc | tar -C / -xzf -)"
fi
log "готово. далее вручную: git add -A && git commit && git push"
