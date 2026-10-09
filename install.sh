#!/usr/bin/env bash
# install.sh — идемпотентная раскатка окружения DSH из этого репо на чистый VPS.
# Корни параметризуются: DSH_ROOT, DSH_HOME, SKILLS_DIR, PROJECTS_DIR, SYSTEMD_DIR,
# SECRETS_FILE, BACKUP_DIR (для песочницы переопределить всё внутрь одной каталога).
# Флаги: --dry-run (только показать действия), --yes (не спрашивать подтверждение).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_ROOT="${DSH_ROOT:-/opt/dsh}"
DSH_HOME="${DSH_HOME:-/dsh/.dsh}"
SKILLS_DIR="${SKILLS_DIR:-/dsh/.agents/skills}"
PROJECTS_DIR="${PROJECTS_DIR:-/opt/projects}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SECRETS_FILE="${SECRETS_FILE:-/root/secrets.env}"
BACKUP_DIR="${BACKUP_DIR:-/root/dsh-install-backup-$(date +%Y%m%d-%H%M%S)}"
HARNESS_DIR="$PROJECTS_DIR/harness"

DRY_RUN=0; ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "неизвестный флаг: $a"; exit 2 ;;
  esac
done

log()  { echo "[install] $*"; }
run()  { if [ "$DRY_RUN" = 1 ]; then echo "  (dry) $*"; else "$@"; fi; }

# --- 0. предусловия -------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then echo "ОШИБКА: запускать под root"; exit 1; fi
if ! grep -qiE '^(ID|ID_LIKE)=(debian|ubuntu)' /etc/os-release 2>/dev/null; then
  echo "ОШИБКА: поддерживаются только Debian/Ubuntu ($(grep PRETTY_NAME /etc/os-release 2>/dev/null || echo '?'))"; exit 1
fi
if [ "$DRY_RUN" = 0 ] && [ "$ASSUME_YES" = 0 ]; then
  echo "Корни: DSH_ROOT=$DSH_ROOT DSH_HOME=$DSH_HOME SKILLS_DIR=$SKILLS_DIR"
  echo "       PROJECTS_DIR=$PROJECTS_DIR SYSTEMD_DIR=$SYSTEMD_DIR SECRETS_FILE=$SECRETS_FILE"
  read -r -p "Продолжить? [y/N] " a; case "$a" in y|Y|yes|YES) ;; *) echo "отменено"; exit 1 ;; esac
fi

# --- 1. зависимости -------------------------------------------------------
NEED_APT=()
for c in curl git zstd envsubst; do command -v "$c" >/dev/null || NEED_APT+=("$( [ "$c" = envsubst ] && echo gettext-base || echo "$c")"); done
if [ "${#NEED_APT[@]}" -gt 0 ]; then
  log "apt-get install: ${NEED_APT[*]}"
  run apt-get update
  run apt-get install -y "${NEED_APT[@]}"
fi

NODE_MAJOR_REQUIRED=22; PNPM_REQUIRED="12.5.1"
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" = "$NODE_MAJOR_REQUIRED" ]; }
pnpm_ok() { command -v pnpm >/dev/null && [ "$(pnpm -v | cut -d. -f1)" = "${PNPM_REQUIRED%%.*}" ]; }
if ! node_ok || ! pnpm_ok; then
  cat <<EOF
ОШИБКА: нужен Node.js ${NODE_MAJOR_REQUIRED}.x и pnpm ${PNPM_REQUIRED}.
На стенде использовались node v22.22.3 + pnpm 12.5.1 (способ установки ядра в STEPLOG не зафиксирован).
Выполни вручную и перезапусти install.sh:
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
  corepack enable && corepack prepare pnpm@${PNPM_REQUIRED} --activate
EOF
  exit 1
fi

# Ядро DSH: способ установки в снимке не зафиксирован — не выдумываем.
if ! command -v dsh >/dev/null; then
  cat <<EOF
ОШИБКА: ядро DSH (команда dsh) не найдено. В репо нет способа его установки —
поставь ядро по официальной инструкции DeepSeek Harness (github.com/deepseek-ai/deepseek-harness)
и перезапусти install.sh. Раскатка профиля/плагинов без ядра не выполняется.
EOF
  exit 1
fi

# --- 2. секреты -----------------------------------------------------------
REQUIRED_SECRETS=(TELEGRAM_BOT_TOKEN DSH_TELEGRAM_TOKEN TELEGRAM_ALLOWED_USER_IDS TELEGRAM_ALLOWED_CHAT_ID)
if [ ! -f "$SECRETS_FILE" ]; then
  echo "ОШИБКА: нет $SECRETS_FILE — скопируй secrets.env.example и заполни:"; echo "  cp secrets.env.example $SECRETS_FILE && nano $SECRETS_FILE"; exit 1
fi
# shellcheck disable=SC1090
set -a; . "$SECRETS_FILE"; set +a
MISSING=()
for v in "${REQUIRED_SECRETS[@]}"; do [ -n "${!v:-}" ] || MISSING+=("$v"); done
# плейсхолдеры шаблона должны быть покрыты env
for ph in $(grep -oE '\$\{[A-Z_]+\}' "$REPO_DIR/profile/cordis.patch.yml.template" | sort -u | tr -d '${}'); do
  [ -n "${!ph:-}" ] || MISSING+=("$ph")
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "ОШИБКА: не хватает переменных в $SECRETS_FILE:"; printf '  %s\n' "${MISSING[@]}" | sort -u; exit 1
fi

# --- 3. бэкап перед записью поверх ---------------------------------------
backup_if_exists() {
  local p="$1"
  if [ -e "$p" ]; then
    local dst="$BACKUP_DIR$(dirname "$p")"
    log "бэкап: $p -> $BACKUP_DIR"
    run mkdir -p "$dst"
    run cp -a "$p" "$dst/"
  fi
}

# --- 4. раскатка ----------------------------------------------------------
log "1/8 скиллы -> $SKILLS_DIR"
run mkdir -p "$SKILLS_DIR"
backup_if_exists "$SKILLS_DIR"
run cp -a "$REPO_DIR/skills/." "$SKILLS_DIR/"

log "2/8 AGENTS.md -> $DSH_HOME/AGENTS.md"
run mkdir -p "$DSH_HOME"
backup_if_exists "$DSH_HOME/AGENTS.md"
run cp "$REPO_DIR/profile/AGENTS.md" "$DSH_HOME/AGENTS.md"
run chmod 600 "$DSH_HOME/AGENTS.md"

log "3/8 skills-manager state.json -> $DSH_HOME/skills-manager/state.json"
run mkdir -p "$DSH_HOME/skills-manager"
backup_if_exists "$DSH_HOME/skills-manager/state.json"
run cp "$REPO_DIR/profile/state.json" "$DSH_HOME/skills-manager/state.json"
run chmod 600 "$DSH_HOME/skills-manager/state.json"

log "4/8 профиль web -> $DSH_HOME/profiles/web"
WEB="$DSH_HOME/profiles/web"
run mkdir -p "$WEB/patches"
for f in package.json pnpm-workspace.yaml; do
  backup_if_exists "$WEB/$f"; run cp "$REPO_DIR/profile/$f" "$WEB/$f"
done
for p in "$REPO_DIR"/profile/patches/*; do
  base="$(basename "$p")"; target="$WEB/patches/${base%.PARTIAL}"
  backup_if_exists "$target"
  run cp "$p" "$target"   # dsh-memory-evolve копируется как есть (read-тул режет длинные строки — только cp)
done
backup_if_exists "$WEB/cordis.patch.yml"
if [ "$DRY_RUN" = 1 ]; then
  echo "  (dry) envsubst profile/cordis.patch.yml.template -> $WEB/cordis.patch.yml"
else
  envsubst '${TELEGRAM_ALLOWED_CHAT_ID} ${TELEGRAM_ALLOWED_USER_IDS}' \
    < "$REPO_DIR/profile/cordis.patch.yml.template" > "$WEB/cordis.patch.yml"
  chmod 600 "$WEB/cordis.patch.yml"
fi

log "5/8 плагины -> $HARNESS_DIR/<имя>"
for d in "$REPO_DIR"/plugins/*/; do
  name="$(basename "$d")"
  backup_if_exists "$HARNESS_DIR/$name"
  run mkdir -p "$HARNESS_DIR/$name"
  run cp -a "$d." "$HARNESS_DIR/$name/"
done

log "6/8 сторож dsh-guard -> $DSH_ROOT/dsh-guard (без state/backups/guard.env)"
run mkdir -p "$DSH_ROOT/dsh-guard"
backup_if_exists "$DSH_ROOT/dsh-guard/dsh-guard.py"
run cp "$REPO_DIR/plugins/dsh-guard/dsh-guard.py" "$DSH_ROOT/dsh-guard/dsh-guard.py"
backup_if_exists "$DSH_ROOT/dsh-guard/guard.env"
if [ "$DRY_RUN" = 1 ]; then
  echo "  (dry) envsubst guard.env.example -> $DSH_ROOT/dsh-guard/guard.env"
else
  envsubst '${TELEGRAM_ALLOWED_CHAT_ID}' < "$REPO_DIR/systemd/guard.env.example" > "$DSH_ROOT/dsh-guard/guard.env"
  chmod 600 "$DSH_ROOT/dsh-guard/guard.env"
fi

log "7/8 systemd: dsh.service + drop-ins, env-файлы $DSH_ROOT/*.env"
run mkdir -p "$SYSTEMD_DIR/dsh.service.d"
backup_if_exists "$SYSTEMD_DIR/dsh.service"
run cp "$REPO_DIR/systemd/dsh.service" "$SYSTEMD_DIR/dsh.service"
for f in "$REPO_DIR"/systemd/dsh.service.d/*.conf; do
  [ -e "$f" ] || continue
  backup_if_exists "$SYSTEMD_DIR/dsh.service.d/$(basename "$f")"
  run cp "$f" "$SYSTEMD_DIR/dsh.service.d/"
done
for pair in "telegram.env:TELEGRAM_BOT_TOKEN DSH_TELEGRAM_TOKEN TELEGRAM_ALLOWED_USER_IDS TELEGRAM_ALLOWED_CHAT_ID" \
            "llm.env:FREELLM_BALANCE_KEY FREELLM_FAST_KEY NEWAPI_KEY OPENROUTER_API_KEY LMSTUDIO_API_KEY HELPCODER_API_KEY ZAI_CODING_CN_API_KEY ANYMODEL_API_KEY TOKENATOR_API_KEY"; do
  fname="${pair%%:*}"; vars="${pair#*:}"
  backup_if_exists "$DSH_ROOT/$fname"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  (dry) запись $DSH_ROOT/$fname из $SECRETS_FILE"
  else
    : > "$DSH_ROOT/$fname"
    for v in $vars; do [ -n "${!v:-}" ] && printf '%s=%s\n' "$v" "${!v}" >> "$DSH_ROOT/$fname"; done
    chmod 600 "$DSH_ROOT/$fname"
  fi
done
if [ "$DRY_RUN" = 0 ] && [ "$SYSTEMD_DIR" = "/etc/systemd/system" ]; then run systemctl daemon-reload; fi

log "8/8 tools и notes -> $HARNESS_DIR"
run mkdir -p "$HARNESS_DIR"
for d in tools notes; do
  backup_if_exists "$HARNESS_DIR/$d"
  run cp -a "$REPO_DIR/$d" "$HARNESS_DIR/$d"
done

# --- 5. финал -------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  log "dry-run завершён, ничего не записано."
else
  log "запуск tools/harness-check.sh"
  if [ -f "$HARNESS_DIR/tools/harness-check.sh" ]; then bash "$HARNESS_DIR/tools/harness-check.sh" || log "ВНИМАНИЕ: harness-check.sh сообщил о проблемах (см. выше)"; fi
  echo "рестарт: systemctl restart dsh.service (сделать вручную)"
fi
