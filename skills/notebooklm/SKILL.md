---
name: notebooklm
description: "NotebookLM с VPS. Use when «спроси NotebookLM», ноутбуки, source-grounded answers: notebooklm-py CLI — вопросы с цитатами, источники/YouTube, аудио, квизы, mind map. Не Obsidian-заметки — см. obsidian-dataweave."
---

# NotebookLM через CLI (notebooklm-py)

Прямое управление Google NotebookLM (переименован в Gemini Notebook — тот же сервис) с VPS через библиотеку notebooklm-py (teng-lin/notebooklm-py, неофициальный API через undocumented Google endpoints).

## Окружение

- Venv: `/opt/projects/harness/notebooklm/.venv` (Python 3.12, notebooklm-py 0.8.4, extras [browser]+[headless])
- CLI: `/opt/projects/harness/notebooklm/.venv/bin/notebooklm`
- Профили/сессии: `/dsh/.notebooklm/profiles/<profile>/storage_state.json` (и master_token.json)
- Браузер для логина: системный google-chrome-stable (`--browser chrome`), НЕ скачивать Chromium через playwright (~170 МБ, диск критичен)

## Аутентификация

Проверка состояния:
```bash
.venv/bin/notebooklm auth check --test --json   # ждать "status": "ok"
```
Три способа получить сессию:
1. **master-token (рекомендовано для headless-сервера)**: `notebooklm login --master-token --account EMAIL` — один раз нужен браузерный знак-ин (oauth_token снимается через CDP с чужого Chrome: `--cdp-url http://localhost:9222`, или передаётся готовым `--oauth-token`); дальше куки минтятся сами, само-залечивается по крону (`notebooklm auth refresh --quiet`). master_token.json = полный доступ к аккаунту, chmod 600, лучше отдельный (не основной) Google-аккаунт.
2. **--browser-cookies chrome** — вытащить куки из залогиненного Chrome (на машине, где есть сессия).
3. **Интерактивный `notebooklm login --browser chrome`** — на VPS НЕ использовать (headless; Google не любит логины с датацентровых IP — риск капчи/флага аккаунта).

## Базовые команды

```bash
NBLM=/opt/projects/harness/notebooklm/.venv/bin/notebooklm
$NBLM list --json                          # список ноутбуков
$NBLM create "Имя"                         # создать ноутбук
$NBLM use <notebook_id>                    # выбрать активный
$NBLM source add "https://..."             # URL/YouTube/PDF/текст
$NBLM source add-research "тема" --import-all  # web research + импорт
$NBLM ask "вопрос" --json                  # ответ с цитатами из источников
$NBLM ask --prompt-file ./q.txt            # длинные вопросы — только через файл
$NBLM generate audio "стиль" --wait        # подкаст (Audio Overview)
$NBLM generate quiz / flashcards / slide-deck / mind-map / report / video
$NBLM download audio ./out.m4a             # артефакты (mp3/mp4/pdf/png/csv/json/md)
$NBLM note create / metadata --json / usage
```

## Питфоллы

- Неофициальный API: Google может поменять endpoints — при странном ответе сначала `auth check --test`, потом `pip install -U notebooklm-py`.
- Rate limits: массовые генерации делать с паузами.
- Диск: venv 207 МБ; перед pip/apt проверять `df -h`, при необходимости `/opt/disk-guardian/bin/disk-guardian.sh --force --ignore-cooldown`.
- Длинные тексты — только `--prompt-file`, не в argv.
- master_token.json хранит полный доступ к Google-аккаунту — никогда не выводить в чат/логи.
- Связь с obsidian-dataweave: тот использует эту же библиотеку; не дублировать установки.

## Процедура логина (headless-сервер, безопасно для аккаунта)

1. На машине пользователя (Мак) открыть Chrome с отладкой: `google-chrome --remote-debugging-port=9222` (отдельный профиль), залогиниться в Google (желательно отдельный аккаунт под автоматизацию).
2. Пробросить порт: `ssh -R 9222:localhost:9222 rtunnel@сервер` (или снять oauth_token локально и передать).
3. На сервере: `notebooklm login --master-token --account EMAIL --cdp-url http://localhost:9222`
4. Проверка: `notebooklm auth check --test --json`; далее крон `auth refresh --quiet` раз в сутки.