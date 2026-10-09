# dsh-settings — снимок окружения DSH (VPS)

Публичная (обезличенная) версия настроек DSH (DeepSeek Harness) для чистого Debian/Ubuntu VPS:
скиллы, профиль web (patch-слой cordis.patch.yml), плагины, сторож dsh-guard, tools и шаблоны systemd.
Все личные значения (токены, id чатов, IP, домены) вынесены в плейсхолдеры и `/root/secrets.env`.

## Быстрый старт (чистый стенд)

```bash
apt update && apt install -y git
git clone https://github.com/<owner>/dsh-settings-public.git && cd dsh-settings-public
cp secrets.env.example /root/secrets.env && nano /root/secrets.env   # вписать реальные значения
./install.sh            # сначала можно: ./install.sh --dry-run
# в конце install.sh напечатает: systemctl restart dsh.service — выполнить ВРУЧНУЮ
```

Ядро DSH сам install.sh **не ставит** (способ установки в снимке не зафиксирован) —
скрипт остановится с подсказкой; поставь ядро по официальной инструкции
`github.com/deepseek-ai/deepseek-harness`, затем перезапусти install.sh.

## Состав репо

- `install.sh` — идемпотентная раскатка (флаги `--dry-run`, `--yes`; корни: `DSH_ROOT`, `DSH_HOME`, `SKILLS_DIR`, `PROJECTS_DIR`, `SYSTEMD_DIR`, `SECRETS_FILE`). Перед записью поверх существующего — бэкап в `/root/dsh-install-backup-<ts>/`.
- `secrets.env.example` — имена переменных (Telegram, провайдеры LLM, guard). Значения — только в `/root/secrets.env`.
- `profile/` — AGENTS.md, skills-manager state.json, package.json/pnpm-workspace.yaml профиля web, patches (включая `dsh-memory-evolve@0.1.0.patch`), `cordis.patch.yml.template` (плейсхолдеры `${...}`, значения подставляет install.sh через envsubst).
- `skills/` — каталог скиллов (→ `$SKILLS_DIR`).
- `plugins/` — dsh-messenger-ru (с dist/), dsh-recovery-resume, dsh-harness-guard, dsh-guard (только скрипт).
- `systemd/` — шаблон `dsh.service` (User root, `dsh web --no-open`, EnvironmentFile) + опциональный drop-in для VPN-доступа + `guard.env.example`.
- `tools/` — проверки/бэкап/восстановление (`harness-check.sh`, `harness-backup.sh`, `harness-restore.sh`).

`harness-export.sh` пересобирает дерево из живых файлов, санитизирует cordis.patch.yml
(id чатов/claimCode/токены → плейсхолдеры), копирует patches целиком (включая
`dsh-memory-evolve@0.1.0.patch` — read-тул режет длинные строки, поэтому только cp),
печатает `git diff --stat` и сам не пушит. `--secrets` — зашифрованный бандл
секретов в `/root/dsh-secrets.tar.enc` (openssl aes-256-cbc + pbkdf2, пароль интерактивно, в репо не попадает).

## Откат

- Бэкапы install.sh: `/root/dsh-install-backup-<ts>/` — скопировать обратно поверх.
- На живом стенде: `tools/harness-restore.sh` (сначала dry-run), проверка — `tools/harness-check.sh`.

## Правила AGENTS (кратко)

Скиллы — первым шагом; вопрос — это только вопрос (действия после явного «делай»);
не уверен в факте — проверь; ничего лишнего; перед «готово» — проверка фактом;
не менять AGENTS.md, cordis.patch.yml, tools/harness-*, backups/ без явной просьбы;
сбои — сначала harness-check.sh, откат — harness-restore.sh.

## Guard и сторож

- `dsh-harness-guard` (mode ask) на стенде блокирует bash-команды с защищёнными путями — это защита, не обходить.
- `dsh-guard` — сторож здоровья (canary-проверки, алерты в Telegram через токен из `TG_ENV`); install.sh ставит только скрипт и `guard.env` из шаблона (без state/backups).

## Известные ограничения

- Рестарт dsh.service всегда вручную: install.sh не перезапускает сервис.
- Ключи провайдеров вводит пользователь в `/root/secrets.env`; скрипт проверяет только наличие обязательных.
- `dsh-memory-evolve@0.1.0.patch` export-скрипт копирует целиком (cp), а не через read-тул.
- Способ установки ядра DSH в репо не зафиксирован — install.sh останавливается с подсказкой.
- Drop-in для VPN (`systemd/dsh.service.d/vpn.conf.example`) опционален и закомментирован.
