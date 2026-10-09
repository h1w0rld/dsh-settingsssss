# @h1w0rld/dsh-harness-guard

Защита на уровне хоста DSH: опасные (RED) вызовы инструментов требуют
подтверждения пользователя через approval-сервис — независимо от «ума» модели
(в т.ч. слабой локальной). Работает хуком `tools/pre-execute` (waterfall):
безопасное — `next()`, опасное — `{kind:'ask', reason}` (в web-UI показывается
подтверждение; без approval-сервиса/агента ядро деградирует в deny), ошибки
плагина — fail-open `next()`.

## Что блокирует (rule → ask)

- `rm-rf-top` — rm -rf по корню/верхнеуровневым каталогам и нераскрытым переменным
- `disk` / `dd-device` — mkfs/wipefs/fdisk*/parted/mount/umount/swap*/chattr, dd of=/dev/*
- `firewall` — iptables/ip6tables/nft (-F/-X/-P/-D/flush), ufw disable|reset|delete|default
- `docker-destructive` — prune/volume rm/rm -f/network rm/compose down -v
- `systemctl` / `dsh-restart` — stop|disable|mask|kill системных служб; рестарт dsh (обрывает сессию)
- `power` — shutdown/reboot/poweroff/halt/init 0|6
- `git-force-push`, `git-clean`, `chmod-top`, `kill` (init/killall node/pkill dsh|node)
- `pipe-to-shell` — curl|wget … | sh/bash
- `sql-destructive` — DROP DATABASE/TABLE, TRUNCATE
- `protected-file` — запись/правка AGENTS.md, cordis.patch.yml, package.json профиля,
  pnpm-workspace.yaml, patches/, skills-manager/state.json, /etc/fstab, /etc/systemd/,
  /etc/ssh/, backups/, golden.manifest, сам каталог плагина (write/edit и bash-редиректы)
- `skill-write` — skill_manage action=create|patch (read/list не трогаем)

Всё остальное (ls/cat/grep/find/git status/docker ps/systemctl status/journalctl и т.п.)
проходит без вопросов.

## Отключить

В cordis.patch.yml профиля: `config: { mode: off }` — хук сразу возвращает `next()`.

## Расширять

Правила — чистая функция `classify(exec)` в `lib/rules.js`: добавить паттерн в
`bashRed()` (bash) или ветку по `exec.name`. Тесты — `test/rules.test.mjs`
(`node --test`). При ложном срабатывании правится правило, не тест.
