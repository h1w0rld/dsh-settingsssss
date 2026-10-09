---
name: dsh-update
description: "Use when просят обновить DSH/харнес или плагины, проверить совместимость плагинов: «обнови DSH». Ядро через npm в /opt/dsh, плагины через pnpm, systemd-рестарт. Смежные: просто рестарт сервиса без обновления — scope-guard (systemctl restart dsh.service)."
---

# Обновление DSH (DeepSeek Harness)

## Топология стенда
- **Ядро**: npm-пакет `@deepseek-ai/dsh` в `/opt/dsh`, бинарник `/usr/local/bin/dsh`, сервис `dsh.service` (`ExecStart=/usr/local/bin/dsh web --no-open`, WorkingDirectory=/opt/projects).
- **Профиль плагинов**: `/root/.dsh/profiles/web` (package.json + pnpm). Плагины ставятся туда, НЕ в /opt/dsh.
- **Кастомные плагины** (file:-ссылки):
  - `@h1w0rld/dsh-messenger-ru` → `/opt/projects/harness/dsh-messenger-ru` (Telegram-бот, токен в /opt/dsh/telegram.env)
  - `@h1w0rld/dsh-recovery-resume` → `/opt/projects/harness/dsh-recovery-resume` (peers пустые — совместим всегда)
- **ВАЖНО (2026-09-30): DSH грузит кастомный плагин из УСТАНОВЛЕННОЙ КОПИИ** `/root/.dsh/profiles/web/node_modules/@h1w0rld/dsh-messenger-ru/`, а НЕ из file:-исходников. Починил исходники — скопируй результат и в копию (`cp -r dist "$P/"`), иначе сервис продолжит падать со старым кодом. Правки надо вносить/синхронизировать в ОБОИХ местах; исходники = истина, профильная копия = рабочая.

## Порядок обновления
1. `npm view @deepseek-ai/dsh version` — последняя версия; `versions --json` — весь список.
2. Проверить готовность плагинов: для каждого store-плагина `npm view <pkg> peerDependencies --json` — поддерживает ли новую версию ядра. Несовместимые DSH просто скипает с warning'ом (не падает).
3. Бэкап: config_backup (встроенный в DSH инструмент).
4. Ядро: `cd /opt/dsh && npm install @deepseek-ai/dsh@<точная версия>` — **rc-версии НЕ подтягиваются ни `npm update`, ни caret-диапазоном** (semver считает prerelease вне диапазона). Только явная установка версии.
5. Плагины: `cd /root/.dsh/profiles/web && pnpm add <pkg>@<версия> ...` — **все последующие install/update — ОБЯЗАТЕЛЬНО с `--ignore-scripts`** при наличии file:-плагинов (см. ловушки).
6. Проверка до рестарта: `/opt/dsh/node_modules/.bin/dsh web --dump-config >/dev/null 2>/tmp/d.err; echo $?` → 0, в /tmp/d.err нет `incompatible`/`skipping` (кроме осознанных).
7. Рестарт: `setsid bash -c 'sleep 2; systemctl restart dsh.service' &` — рестарт УБЬЁТ текущую сессию агента (норма, recovery-resume восстановит).
8. Проверка после: `dsh --version`; `systemctl is-active dsh.service`; journalctl на ошибки; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080` (401 = жив); Telegram-бот: параллельный `curl getUpdates` → 409 Conflict = бот поллит (токен в /opt/dsh/telegram.env).

## ЛОВУШКИ (проверено на практике)
- **pnpm install БЕЗ --ignore-scripts запускает prepare file:-плагинов**. У messenger-ru `prepare` = `pnpm clean && tsc`, а `tsc` не установлен → `dist/` стирается, плагин уничтожен. Это касается ЛЮБОГО `pnpm install` в исходниках плагина (например, при доставании зависимостей для локального импорт-теста) — не только в профиле. Восстановление: `git restore dist` в исходниках (проверить, что HEAD содержит нужное: `git show HEAD:dist/bridge.js | grep -c gigaam`) + повторно наложить несохранённые патчи + скопировать dist в профильную копию (см. Топологию) + `pnpm install --ignore-scripts` (только в профиле).
- **HEAD может НЕ содержать все рабочие патчи** (2026-09-30: guard `ctx.settings.register` был несохранённым и потерялся вместе с dist; восстановлен и закоммичен `ea9d489`). После восстановления dist обязательно проверить наличие известных патчей: `git show HEAD:dist/index.js | grep -c "typeof ctx.settings"` ≥ 1, иначе наложить вручную.
- **`dist/` messenger-ru — каноничный исходник**: tsconfig.build.json отсутствует, lib/ содержит только client.js, билд-скрипты нерабочие. Все правки — прямо в dist/, коммитить в git.
- **Формальная несовместимость peer-версий**: `/opt/dsh/node_modules/.bin/dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version <ver ядра> --accept-risk`.
- **Профиль-оверлей** `/root/.dsh/profiles/web/cordis.patch.yml`: невалидный YAML молча ломает весь оверлей (видно в warnings config_backup). Валидатор — сам `dsh web --dump-config` (стандартный js-yaml не знает тегов `!!js`).
- **`ctx.settings.register` отсутствует** в 0.1.7 — messenger-ru имеет fallback на статический entryConfig (dist/index.js, блок `typeof ctx.settings?.register === 'function'`; закоммичен 2026-09-30 в `ea9d489` — до этого существовал только в несохранённых правках и терялся при порче dist).
- Диск 9.8 ГБ: перед npm install `df -h /`, при нехватке `npm cache clean --force`.
- file:-пути в profile package.json должны указывать на `/opt/projects/harness/{dsh-messenger-ru,dsh-recovery-resume}` (бывали битые).

## После мажорного обновления
Проверить живость кастомных функций: Telegram-бот (сообщение + /stt-панель с gigaam), recovery-resume (журнал «бут-скан»), русский язык UI, сайдбар. Поднять peerDependencies кастомных плагинов под новое ядро, убрать несуществующие пакеты, переустановить с --ignore-scripts. Сверить список пакетов @deepseek-ai/* в /opt/dsh/node_modules (в 0.2.0 исчез @deepseek-ai/dsh-client-runtime).

## История
- 2026-09-30: инцидент — `pnpm install` в исходниках messenger-ru стёр dist + потерялся несохранённый guard `ctx.settings.register`; восстановлено, guard закоммичен (`ea9d489`). Уточнена топология: сервис грузит плагин из профильной копии node_modules, не из file:-исходников. Скилл дополнен.
- 2026-09-29: обновлено до 0.2.0-rc.2 + все плагины до последних (advisor 0.5.4, sidebar 0.24.1, dshmarket 1.66.6, config-manager 0.1.66, russian-lang 0.3.19, dsh-context 0.60.0, task-board 0.4.4, skills-manager 1.1.5 через allow-version). Бот проверен 409-тестом.

## Патчи сторонних плагинов и pnpm-политики
- Патчи: `/dsh/.dsh/profiles/web/patches/`, реестр — секция `patchedDependencies` в `pnpm-workspace.yaml` (сейчас: `dsh-memory-evolve@0.1.0`, `@linxin666/dsh-client-ui-task-board`).
- Ключ патча привязан к версии → после обновления плагина патч может НЕ примениться молча.
- ШАГ ПОСЛЕ ОБНОВЛЕНИЯ: запустить `/opt/projects/harness/tools/check-patches.sh` (только чтение); при расхождении — пересобрать патч (`pnpm patch` / `pnpm patch-commit`) или убрать устаревшую запись.
- `minimumReleaseAgeExclude` в `pnpm-workspace.yaml` хранит версии плагинов — обновлять вместе с версиями.
- Перед обновлением — бэкап `profiles/web/{package.json,pnpm-workspace.yaml,pnpm-lock.yaml,patches}`.
- Пользовательские правки описаний в `/dsh/.agents/skills` перезаписываются при обновлении стороннего скилла → после обновлений прогонять `tools/skill-lint.py` и `tools/skill-eval/skill-eval.py` (если есть).
