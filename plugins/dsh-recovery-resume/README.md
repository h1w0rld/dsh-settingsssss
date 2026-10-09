# @h1w0rld/dsh-recovery-resume (v0.2.0)

Форк [dsh-recovery-resume](https://github.com/flandre2233/dsh-recovery-resume) (flandre2233, 0.1.3),
доделанный для **DSH 0.1.7-rc.2 (format v4)**. Локальная копия: `/opt/projects/dsh-recovery-resume`.

## Что делает

После перезапуска DSH автоматически продолжает прерванные ходы сессий: агенту отправляется
сообщение с требованием **сначала проверить фактическое состояние** (не считать оборванный шаг
ни успешным, ни провальным), а затем продолжить задачу с правильного места.

## Что добавлено относительно базы 0.1.3

База рассчитывала только на «живых» агентов: в DSH агенты создаются лениво (кто-то должен открыть
сессию), поэтому после рестарта хук `agent/created` не стрелял и зависшие сессии висели вечно.

1. **Бут-активация холодных сессий** (`lib/index.js`, функции `startBootScan/bootScan/activateSession`):
   - скан `~/.dsh/sessions/*/**` в течение 20 минут после старта (период 7с, окно свежести лога 2ч);
   - журнал читается по поколениям **v4 → v3** (DSH 0.1.7 пишет `session.v4.jsonl.zstd`);
   - кандидат: открытый ход (turn/start без turn/end) или последний `turn/end reason=interrupted`;
     не subagent; леджер разрешает; не больше 5 активаций за бут;
   - активация штатным швом `ctx.agents.resume({resumeSessionId, agentOptions, setup})` — фабрика
     сама дописывает interrupted-closers (repair-on-resume), setup реплицирует `composeAgent`
     официального session-controller (`installModelSelection` + `presets.mount`).
2. **Совместимость с format v4**: source-сообщения `{kind: '<plugin>', plugin: ...}` — v4 запрещает
   `kind: 'plugin'` («producer-owned source kind»); у базы kind = имя плагина, что легально, но для
   единообразия оставлено собственное имя `@h1w0rld/dsh-recovery-resume`.
3. **Анти-гонка повторного инжекта** (`REINJECT_GUARD_MS = 30s`) и русифицированный промпт
   (`lib/logic.js → renderResumePrompt`) и журнал.

## Что сохранено от базы (осознанно)

- user stop (`turn/end reason=aborted/user`) — финал, не продолжается;
- перманентные ошибки (AUTH/QUOTA/CONTEXT_WINDOW/модель не найдена) — не продолжаются;
- 429/сеть/таймаут — продолжаются с бэкоффом;
- кросс-рестартный леджер `~/.dsh/recovery-attempts.json`: 3 продолжения подряд без прогресса → стоп;
- ре-авторизация active-goals после продолжения;
- ход «в полёте» (живой агент) не трогается.

## Установка

```bash
dsh plugin --profile web add file:/opt/projects/dsh-recovery-resume
systemctl restart dsh
```

Журнал: `journalctl -u dsh | grep recovery-resume`.
