# @h1w0rld/dsh-messenger-ru

Форк плагина [@syncended/dsh-messenger](https://www.npmjs.com/package/@syncended/dsh-messenger) 0.14.2 —
Telegram-бот для DeepSeek Harness, доработанный под русский язык, голос и свои фичи.
С версии `0.14.2-ru.3` пакет носит собственное имя **`@h1w0rld/dsh-messenger-ru`**
(id записи в дереве Cordis остался `messenger`, чтобы настройки/привязки не трогались).

**Репозиторий — источник истины.** Исполнение — `/root/.dsh/profiles/web/node_modules/@h1w0rld/dsh-messenger-ru`.
Патчить руками в node_modules больше нельзя: только через коммит сюда + `./deploy.sh`.

## Что уже есть (наследие патчей 09–10.2026)

- **Мульти-STT панель `/stt` — 4 режима**: Vosk small-ru (~90 МБ, офлайн) / браузер Chrome (Google Web Speech) / T-one (~140 МБ) / GigaAM (~230 МБ) — on-demand через sherpa. Активен только рантайм выбранного режима, при переключении остальное с диска удаляется и скачивается заново. Скрипты панели (`stt/scripts/ensure-model.sh`, `stt/scripts/transcribe.py`, `stt/chrome-src/`) едут вместе с плагином; модели — кэш в `/opt/stt` (env `MESSENGER_STT_SCRIPTS_DIR` переопределяет каталог скриптов).
- **Resident whisper-демон** (2026-09-23): воркер faster-whisper и модель живут в RAM, пока выбран local; выгрузка только при смене режима/шатдауне.
- `python/worker.py` — локальный декодер аудио + faster-whisper JSONL-воркер (tiny…large-v3).
- Русифицированный UI моста, `/voice_cancel`, `/stt`, статистика `/root/.dsh/voice/stt-stats.json`.
- Всё из upstream 0.14.2: bind чат↔сессия, `/menu`, `ask_user_question` кнопками, картинки, `messenger_notify`, `messenger_send_image`.

## Фичи в работе

1. **Голосовые ответы (TTS)** — инструмент `messenger_send_voice`: edge-tts (ru-RU, бесплатно, без ключей) → ffmpeg → OGG/Opus → `sendVoice` в привязанные чаты.
2. **Rich-форматирование** — готово: тексты с таблицами/чек-листами уходят через Bot API 10.1 `sendRichMessage` (нативные таблицы, лимит 32768), с фолбэком на старый HTML-пайплайн.
3. **Склейка альбомов** — готово: N фото одного media_group → один промпт с одной подписью (буфер 1.5с, лимит 10, неуспешные загрузки считаются и отмечаются в промпте).

## Фичи 2026-09-27: файлы-пути, форум-темы, дежурство, команды

Переняли лучшее у конкурентов (dsh-message-gateway, goodandready-gateway, telegram-duty, multiagent, sympoies) — одним патчем моста:

- **Файлы как путь-хендл** (`kind: 'file'`): документы, видео, GIF-анимации, аудио, видеокружки и стикеры скачиваются в стейджинг `$DSH_HOME/messenger/files/`, агент получает промпт с путём (`📎 Входящий файл… Путь: …`) и читает сам. 20 МиБ-лимит обходится опцией **`telegram.apiBaseUrl`**: укажите адрес Local Bot API Server (например `http://127.0.0.1:8081`) — лимит скачивания становится 2000 МиБ.
- **Форум-темы → сессии**: в форум-группе каждая тема = отдельная сессия и отдельная привязка (`chatId#t<N>`, слот отправителя `topic:N`). Меню, кнопки, прогресс и ответы уходят строго в свою тему; темы изолированы друг от друга.
- **Режим «на телефоне»**: `/away` в любом авторизованном чате включает пересылку вопросов (`ask_user_question`, в т.ч. подтверждения) из **всех сессий без привязки к чату** в этот чат — с кнопками и автоотклонением через 10 минут; `/back` выключает. Состояние переживает рестарт (`$DSH_HOME/messenger/duty.json`).
- **`/goal [текст]`** — создание/просмотр цели сессии через штатный реестр команд хоста (`commands.execute`); создания лимитируются: **не больше 3 в час** на чат; `/goal clear|pause|resume|edit` — управление.
- **`/compact`** — штатная компакция сессии из чата; **`/compact_status`** — заполненность контекста (%, порог 80%).
- **`/diag`** — диагностика: бот, allowlist+claim, лимит файлов, TTS/STT, дежурство, доступность реестра команд, привязка чата, последние 5 ошибок (кольцо на 20).
- **`/voice on|off`** — пер-чат переключатель TTS: выключенный чат пропускается `messenger_send_voice` (prefs в `$DSH_HOME/messenger/voice-prefs.json`).
- **`/cd`** — «сменить папку»: список воркспейсов → переход на самую свежую сессию этого воркспейса.
- **`/claim <код>`** — онбординг оператора без правки конфига: задайте `telegram.claimCode` в настройках, отправьте `/claim <код>` боту в личке — чат и пользователь добавляются в allowlist (переживает рестарт, `$DSH_HOME/messenger/claimed-users.json`). Работает ещё до того, как чат есть в `allowedChatIds`.


## Структура

| Путь | Что это |
|---|---|
| `dist/` | основной код плагина (читаемый ESM): `bridge.js` — ядро моста, `telegram.js` — Bot API, `voice.js`/`whisper-runtime.js` — STT, `images.js` — картинки |
| `lib/` | host-часть upstream |
| `python/worker.py` | локальный STT-воркер |
| `stt/scripts/` | lifecycle-скрипты STT-режимов (`ensure-model.sh`, `transcribe.py`) — часть пакета |
| `stt/chrome-src/` | npm-исходники браузерного STT (puppeteer-core + stt.js) — часть пакета |
| `attic/` | исторические `.bak-*` патчей (для справки; живая история — git) |
| `docs/` | ассеты upstream |
| `deploy.sh` | репо → профиль (+ проверка sharp-стаба), `--restart` для рестарта dsh |
| `restore.sh` | профиль → репо (спасение рукопатчей; временная мера) |

## Деплой

```bash
cd /opt/projects/dsh-messenger-ru
./deploy.sh --restart     # скопировать в профиль и перезапустить dsh
```

После любых `npm/pnpm`-операций в профиле — проверить `sharp`-стаб в /opt/dsh (deploy.sh проверяет сам).

## Как разрабатывать

1. Правки — здесь, в репо. `git add -A && git commit -m "..."`.
2. `./deploy.sh --restart`.
3. Проверка в Telegram.
4. Откат: `git checkout <prev> && ./deploy.sh --restart`.

Токен бота — в `/opt/dsh/telegram.env` (DSH_TELEGRAM_TOKEN), привязки чатов — `/root/.dsh/telegram-channel-bindings.json`, статистика STT — `/root/.dsh/voice/`.

## Upstream

README оригинального плагина: [README.upstream.md](README.upstream.md). Версию upstream не поднимать без разбора
своих патчей: при обновлении придётся переносить vosk/T-one/GigaAM-панель, resident-режим и русификацию.
