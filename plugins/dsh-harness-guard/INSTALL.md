# Установка @h1w0rld/dsh-harness-guard

Образец — так установлен соседний @h1w0rld/dsh-recovery-resume (см. сравнение
`/opt/projects/<harness>/dsh-recovery-resume` ↔ `/dsh/.dsh/profiles/web/node_modules/@h1w0rld/dsh-recovery-resume`).
`dsh plugin add` — обёртка над `pnpm add` (проверено: `dsh plugin add --profile web --help`
показывает Usage: pnpm add). Установка требует рестарта dsh — НЕ выполнять без
явного согласия пользователя.

## Шаги

1. Проверить место: `df -h /` (пакет ~десятки КБ, зависимостей нет).
2. Проверить, что источник на месте: `ls /opt/projects/<harness>/dsh-harness-guard/lib/index.js`.
3. Установить как file:-зависимость профиля:
   ```
   dsh plugin --profile web add file:/opt/projects/<harness>/dsh-harness-guard
   ```
   Это допишет в `/dsh/.dsh/profiles/web/package.json` строку вида
   `"@h1w0rld/dsh-harness-guard": "file:../../../../opt/projects/<harness>/dsh-harness-guard"`
   (как у recovery-resume/messenger-ru) и зальёт пакет в
   `/dsh/.dsh/profiles/web/node_modules/@h1w0rld/dsh-harness-guard`.
4. Роутер: `dsh.bundle.patch` из package.json → `cordis.patch.yml` плагина
   (insert id: harness-guard, name @h1w0rld/dsh-harness-guard, config mode: ask).
   `dsh plugin add` применяет его сам; проверить появление в
   `/dsh/.dsh/profiles/web/cordis.patch.yml` (или в скомпилированном ростере).
5. Рестарт хоста: `systemctl restart dsh.service` (ОБРЫВАЕТ СЕССИИ — согласие
   пользователя обязательно).

## Проверка после рестарта

1. Лог загрузки: `journalctl -u dsh.service -n 200 | grep harness-guard`
   → строка `[harness-guard] apply() — плагин загружен (v0.1.0, mode=ask)`.
2. Живой тест в сессии агента:
   - безопасное: `ls -la` / `df -h /` — выполняется без вопросов;
   - RED: `systemctl restart dsh.service` (или `rm -rf /tmp/x --` нет, взять
     `iptables -L` → нет; взять например `docker system prune` — только спросить,
     НЕ соглашаться) — должно появиться подтверждение (ask); при отказе — deny.

## Откат

1. `dsh plugin --profile web remove @h1w0rld/dsh-harness-guard`
   (уберёт зависимость из package.json профиля и node_modules).
2. Убедиться, что insert harness-guard исчез из cordis.patch.yml профиля
   (если остался — удалить блок вручную по бэкапу).
3. `systemctl restart dsh.service` (опять обрывает сессии).
4. Проверка: `journalctl -u dsh.service -n 200 | grep harness-guard` — пусто.
