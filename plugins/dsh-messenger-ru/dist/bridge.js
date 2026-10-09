import { randomUUID } from 'node:crypto';
import { DshControl, sessionTitle, visibleAssistantText } from './control.js';
import { splitTelegramText } from './telegram.js';
import { abortable, voiceAbortError } from './voice.js';
import { IMAGE_BYTE_LIMIT, MAX_REPLY_IMAGES, messengerImage, visibleAssistantImages } from './images.js';
import { MemoryMessengerBindingStore, messengerBindingIdentity, messengerBindingKey, } from './store.js';
// --- cloud STT patch (2026-09-23): Gemini via freellmapi, switched by /stt ---
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const CLOUD_STT_STATE_DIR = process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'voice')
    : join(process.env.HOME ?? '/root', '.dsh', 'voice');
const CLOUD_STT_STATE_FILE = join(CLOUD_STT_STATE_DIR, 'stt-mode.json');
function readSttMode() {
    try {
        const raw = JSON.parse(readFileSync(CLOUD_STT_STATE_FILE, 'utf8'));
        const mode = raw?.mode;
        return STT_MODES.includes(mode) ? mode : 'local';
    }
    catch {
        return 'local';
    }
}
function writeSttMode(mode) {
    try {
        mkdirSync(CLOUD_STT_STATE_DIR, { recursive: true });
        writeFileSync(CLOUD_STT_STATE_FILE, JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    }
    catch { /* best effort */ }
}
const CLOUD_STT_STATS_FILE = join(CLOUD_STT_STATE_DIR, 'stt-stats.json');
function readSttStats() {
    try {
        const raw = JSON.parse(readFileSync(CLOUD_STT_STATS_FILE, 'utf8'));
        return raw && typeof raw === 'object' ? raw : {};
    }
    catch {
        return {};
    }
}
function recordSttStat(mode, elapsedMs, chars) {
    try {
        const stats = readSttStats();
        const entry = stats[mode] ?? { count: 0, chars: 0, totalMs: 0, lastAt: null };
        entry.count += 1;
        entry.chars += chars;
        entry.totalMs += elapsedMs;
        entry.lastAt = new Date().toISOString();
        entry.lastMs = elapsedMs;
        stats[mode] = entry;
        mkdirSync(CLOUD_STT_STATE_DIR, { recursive: true });
        writeFileSync(CLOUD_STT_STATS_FILE, JSON.stringify(stats, null, 2) + '\n');
    }
    catch { /* best effort */ }
}
function formatSttStatsLine(entry) {
    if (!entry || !entry.count)
        return 'нет данных';
    const avgSec = (entry.totalMs / entry.count / 1000).toFixed(1);
    const last = entry.lastAt ? new Date(entry.lastAt).toLocaleString('ru-RU') : '—';
    return `${entry.count} расшифровок · ср. ${avgSec} с · ${entry.chars} симв. · последний: ${last}`;
}
async function cloudTranscribe(audio, signal) {
    const apiKey = process.env.FREELLM_BALANCE_KEY;
    if (!apiKey)
        throw new Error('Cloud STT is not configured: FREELLM_BALANCE_KEY is missing.');
    const model = process.env.MESSENGER_CLOUD_STT_MODEL || 'gemini-2.5-flash';
    const body = JSON.stringify({
        model,
        messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Transcribe this voice message verbatim in its original language. Reply with the transcript only, no commentary. If there is no speech, reply with a single dash.' },
                    { type: 'input_audio', input_audio: { data: Buffer.from(audio).toString('base64'), format: 'ogg' } },
                ],
            }],
        max_tokens: 8192,
    });
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const res = await fetch('http://127.0.0.1:3001/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body,
            signal: controller.signal,
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Cloud STT failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
        }
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string')
            throw new Error('Cloud STT returned no transcript.');
        return text.trim() === '-' ? '' : text.trim();
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
    }
}
// --- browser STT patch (2026-09-25): free Google Web Speech via headless Chrome ---
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const STT_SCRIPT = process.env.MESSENGER_STT_SCRIPT || '/opt/stt/chrome/stt.js';
const STT_LANG = process.env.MESSENGER_STT_LANG || 'ru-RU';
function abortableExecFile(file, args, signal) {
    return new Promise((resolve, reject) => {
        const child = execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
            signal?.removeEventListener('abort', onAbort);
            if (error)
                reject(Object.assign(new Error(`${file} failed: ${String(error.message).slice(0, 300)}`), { code: error.code }));
            else
                resolve(stdout);
        });
        const onAbort = () => {
            try {
                child.kill('SIGKILL');
            }
            catch { /* already gone */ }
            reject(voiceAbortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
async function browserTranscribe(audio, signal) {
    const dir = mkdtempSync(join(tmpdir(), 'webstt-'));
    try {
        const rawPath = join(dir, 'voice.ogg');
        writeFileSync(rawPath, audio);
        const stdout = await abortableExecFile('node', [STT_SCRIPT, rawPath, STT_LANG], signal);
        return stdout.trim();
    }
    finally {
        try {
            rmSync(dir, { recursive: true, force: true });
        }
        catch { /* best effort */ }
    }
}
// --- end browser STT patch ---
// --- local STT patch (2026-10-03): vosk + on-demand sherpa engines (T-one, GigaAM) ---
// 2026-09-27 (ru.3): STT-скрипты едут вместе с плагином (stt/scripts), а не живут
// только в /opt/stt. Приоритет: env MESSENGER_STT_SCRIPTS_DIR → пакет → /opt/stt
// (фолбэк для старых установок). Модели по-прежнему качаются on-demand в /opt/stt.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const PKG_STT_SCRIPTS_DIR = fileURLToPath(new URL('../stt/scripts', import.meta.url));
const STT_SCRIPTS_DIR = process.env.MESSENGER_STT_SCRIPTS_DIR
    ?? (existsSync(join(PKG_STT_SCRIPTS_DIR, 'ensure-model.sh')) ? PKG_STT_SCRIPTS_DIR : '/opt/stt/scripts');
const SHERPA_ENSURE_SCRIPT = join(STT_SCRIPTS_DIR, 'ensure-model.sh');
const SHERPA_TRANSCRIBE_SCRIPT = join(STT_SCRIPTS_DIR, 'transcribe.py');
const SHERPA_MODES = {
    tone: { label: 'T-one (T-Bank)', downloadNote: '~140 МБ' },
    gigaam: { label: 'GigaAM v2 (Сбер)', downloadNote: '~230 МБ' },
};
// Every mode's runtime, including the browser mode's Chrome runtime. Strict
// disk policy (user request 2026-10-03): everything lives under /opt/stt and
// ONLY the ACTIVE mode's runtime may exist on disk; the others are deleted on
// every switch and re-downloaded on demand (vosk included, chrome included).
const STT_MODELS = {
    vosk: { label: 'Vosk small-ru', downloadNote: '~90 МБ' },
    ...SHERPA_MODES,
    chrome: { label: 'Chrome-рантайм (Google Web Speech)', downloadNote: '~430 МБ' },
};
const STT_MODES = ['local', 'browser', 'tone', 'gigaam'];
const STT_ENGINE_OF_MODE = { local: 'vosk', browser: 'chrome', tone: 'tone', gigaam: 'gigaam' };
function sherpaModelPresentSync(engine) {
    try {
        return execFileSync('bash', [SHERPA_ENSURE_SCRIPT, engine, 'present'], { encoding: 'utf8' }).trim() === 'yes';
    }
    catch {
        return false;
    }
}
function sherpaRunSync(args, timeoutMs = 900_000) {
    return execFileSync('bash', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}
// Strict one-model disk policy (user request 2026-10-03): remove the files of
// every model except the active one. Returns the removed engine names.
function enforceOnlyActiveModelSync(activeEngine) {
    const removed = [];
    for (const engine of Object.keys(STT_MODELS)) {
        if (engine === activeEngine || !sherpaModelPresentSync(engine))
            continue;
        try {
            sherpaRunSync([SHERPA_ENSURE_SCRIPT, engine, 'remove'], 120_000);
            removed.push(engine);
        }
        catch { /* best effort cleanup */ }
    }
    return removed;
}
// Deduplicate concurrent downloads of the same model (e.g. two voice jobs sent
// in a row): both callers await one shared wget/unpack instead of racing.
const activeModelEnsures = new Map();
function ensureModel(engine) {
    if (sherpaModelPresentSync(engine))
        return Promise.resolve();
    let pending = activeModelEnsures.get(engine);
    if (!pending) {
        pending = execFileP('bash', [SHERPA_ENSURE_SCRIPT, engine, 'ensure'], 900_000)
            .finally(() => activeModelEnsures.delete(engine));
        activeModelEnsures.set(engine, pending);
    }
    return pending;
}
function execFileP(file, args, timeoutMs = 900_000) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
            if (error)
                reject(Object.assign(new Error(`${file} failed: ${String(error.message).slice(0, 300)}`), { code: error.code }));
            else
                resolve(stdout);
        });
    });
}
async function localTranscribe(engine, audio, signal) {
    const dir = mkdtempSync(join(tmpdir(), 'localstt-'));
    try {
        const rawPath = join(dir, 'voice.ogg');
        writeFileSync(rawPath, audio);
        const stdout = await abortableExecFile('python3', [SHERPA_TRANSCRIBE_SCRIPT, engine, rawPath], signal);
        return stdout.trim();
    }
    finally {
        try {
            rmSync(dir, { recursive: true, force: true });
        }
        catch { /* best effort */ }
    }
}
// --- end local STT patch ---
// --- end cloud STT patch ---
// --- PATCH: files/forums/duty/commands (2026-09-27): shared state under $DSH_HOME/messenger ---
import { SessionId } from '@deepseek-ai/dsh-session';
const MESSENGER_STATE_DIR = process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'messenger')
    : join(process.env.HOME ?? '/root', '.dsh', 'messenger');
const DUTY_TIMEOUT_MS = 10 * 60_000;
const GOAL_HOURLY_LIMIT = 3;
function readJsonState(fileName) {
    try {
        const raw = JSON.parse(readFileSync(join(MESSENGER_STATE_DIR, fileName), 'utf8'));
        return raw && typeof raw === 'object' ? raw : undefined;
    }
    catch {
        return undefined;
    }
}
function writeJsonState(fileName, value) {
    try {
        mkdirSync(MESSENGER_STATE_DIR, { recursive: true });
        writeFileSync(join(MESSENGER_STATE_DIR, fileName), JSON.stringify(value, null, 2) + '\n');
    }
    catch { /* best effort */ }
}
function humanBytes(value) {
    if (!Number.isFinite(value) || value <= 0)
        return '?';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}
function sanitizeFileName(name) {
    const stripped = String(name ?? 'file').split(/[\\/]/).pop() ?? 'file';
    const cleaned = stripped.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
    return (cleaned || 'file').slice(0, 120);
}
function fileExtensionForMime(mimeType) {
    const map = {
        'application/pdf': 'pdf',
        'application/zip': 'zip',
        'application/gzip': 'gz',
        'text/plain': 'txt',
        'text/csv': 'csv',
        'text/markdown': 'md',
        'application/json': 'json',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'audio/mpeg': 'mp3',
        'audio/ogg': 'ogg',
    };
    if (typeof mimeType === 'string' && map[mimeType] !== undefined)
        return map[mimeType];
    if (typeof mimeType === 'string' && /^[a-z0-9.+/-]+$/i.test(mimeType)) {
        const subtype = mimeType.split('/').pop() ?? '';
        if (/^[a-z0-9]{1,8}$/i.test(subtype))
            return subtype;
    }
    return 'bin';
}
/** Persist an inbound file to the messenger staging area; returns its path handle. */
function saveInboundFile(fileMeta, bytes, destinationChatId) {
    const dir = join(MESSENGER_STATE_DIR, 'files', sanitizeFileName(destinationChatId).replace(/#/g, '_'));
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const base = sanitizeFileName(fileMeta.fileName ?? `file-${stamp}`);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : `.${fileExtensionForMime(fileMeta.mimeType)}`;
    let path = join(dir, `${stamp}-${stem}${ext}`);
    let attempt = 2;
    while (existsSync(path)) {
        path = join(dir, `${stamp}-${stem}-${attempt}${ext}`);
        attempt += 1;
    }
    writeFileSync(path, bytes);
    return { path, name: `${stem}${ext}`, bytes: bytes.byteLength };
}
function filePromptBlock(saved, fileMeta) {
    const kindLabels = {
        document: 'документ',
        video: 'видео',
        animation: 'GIF-анимация',
        audio: 'аудио',
        video_note: 'видеокружок',
        sticker: 'стикер',
    };
    const lines = [
        `📎 Входящий файл из Telegram (${kindLabels[fileMeta.mediaKind] ?? fileMeta.mediaKind}): ${saved.name}`,
        `Размер: ${humanBytes(saved.bytes)}${fileMeta.mimeType === undefined ? '' : ` · MIME: ${fileMeta.mimeType}`}`
            + (fileMeta.durationSeconds === undefined ? '' : ` · Длительность: ${Math.round(fileMeta.durationSeconds)} с`),
        `Путь (файл уже скачан, доступен для чтения): ${saved.path}`,
    ];
    return lines.join('\n');
}
// --- end files/forums/duty/commands patch ---
/** Ends a mirrored question without cancelling the agent's turn. */
export class QuestionAnsweredElsewhere extends Error {
    constructor() {
        super('Question answered in another interface.');
        this.name = 'QuestionAnsweredElsewhere';
    }
}
const CALLBACK_TTL_MS = 10 * 60_000;
const QUESTION_CALLBACK_TTL_MS = 24 * 60 * 60_000;
const SESSION_PAGE_SIZE = 7;
const WORKSPACE_PAGE_SIZE = 7;
const MODEL_PAGE_SIZE = 8;
// Keep decorative heartbeats sparse; streaming and animation share one edit budget.
const PROGRESS_EDIT_INTERVAL_MS = 3_000;
const PROGRESS_ANIMATION_INTERVAL_MS = 15_000;
const TYPING_REFRESH_MS = 4_000;
const DEFAULT_PROGRESS_LIMIT = 4_096;
const PROGRESS_SPINNER_FRAMES = ['✦', '✧', '✶', '✳', '✢', '✳', '✶', '✧'];
const THINKING_LABELS = [
    'Думаю',
    'Изучаю',
    'Разбираюсь',
    'Составляю план',
    'Иду по следу',
    'Прорабатываю',
    'Проверяю детали',
    'Связываю воедино',
    'Сужаю круг',
    'Продвигаюсь',
    'Присматриваюсь',
    'Разбираю по полочкам',
    'Ищу нить',
    'Смотрю по частям',
    'Собираю воедино',
    'Перепроверяю',
];
const THINKING_LABEL_FRAME_SPAN = 3;
export function parseCommand(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/'))
        return undefined;
    const separator = trimmed.search(/\s/);
    const rawName = (separator < 0 ? trimmed : trimmed.slice(0, separator)).slice(1);
    const name = rawName.toLowerCase();
    if (name.length === 0)
        return undefined;
    return {
        name,
        argument: separator < 0 ? '' : trimmed.slice(separator).trim(),
    };
}
function bindingKey(transport, chatId, senderId) {
    return messengerBindingKey(transport, chatId, senderId);
}
const bindingIdentity = messengerBindingIdentity;
// --- PATCH: forum-topic destination helpers (2026-09-27) ---
/** Topic-qualified destination of an inbound message (`chat#tN`), else the raw chat id. */
function chatDestination(message) {
    return message.chatDest ?? message.chatId;
}
/** Binding sender slot: `topic:N` inside forum topics, else the raw sender id. */
function controlSender(message) {
    return message.senderKey ?? message.senderId;
}
function rawChatId(destination) {
    const hash = destination.indexOf('#t');
    return hash > 0 ? destination.slice(0, hash) : destination;
}
function bindingDestinationKey(transport, chatId) {
    return JSON.stringify([transport, chatId]);
}
function progressKey(transport, chatId, sessionId) {
    return JSON.stringify([transport, chatId, sessionId]);
}
function shortId(sessionId) {
    return sessionId.length <= 10 ? sessionId : `…${sessionId.slice(-8)}`;
}
function truncateLabel(value, limit) {
    const characters = Array.from(value);
    return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join('')}…`;
}
function compactNumber(value) {
    if (value === undefined)
        return '—';
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
function contextLabel(projected, window) {
    if (projected === undefined && window === undefined)
        return 'не измерено';
    if (window === undefined)
        return `${compactNumber(projected)} токенов`;
    const percentage = projected === undefined ? undefined : Math.round((projected / window) * 100);
    return `${compactNumber(projected)}/${compactNumber(window)}${percentage === undefined ? '' : ` (${percentage}%)`}`;
}
function stateTag(state) {
    if (state === 'running')
        return '🟢 работает';
    if (state === 'idle')
        return '⚪ свободна';
    return '💤 спит';
}
function permissionTag(permission) {
    if (permission === 'danger-full-access')
        return '🔓 полный доступ';
    if (permission === 'workspace-write')
        return '✏️ воркспейс';
    if (permission === 'read-only')
        return '👁 только чтение';
    return `🛡 ${permission.replaceAll('-', ' ')}`;
}
function helpText() {
    return [
        'Управление DSH через Telegram',
        '',
        '/menu — панель управления',
        '/sessions или /resume — выбрать сессию',
        '/new — выбрать воркспейс и создать новую сессию',
        '/status — панель статуса текущей сессии',
        '/model — выбрать провайдера и модель',
        '/reasoning — режим рассуждений',
        '/permission — пресет прав DSH',
        '/context — контекст и расход токенов',
        '/steer <текст> — направить активный ход',
        '/cancel — отменить активный ход',
        '/voice_cancel — отменить ожидающие расшифровки',
        '/stt — панель выбора расшифровки: Vosk / браузер (Google) / T-one / GigaAM',
        // --- PATCH: files/forums/duty/commands (2026-09-27) ---
        '/goal [текст] — цель сессии (статус, /goal clear|pause|resume); создание — не больше 3 в час',
        '/compact — сжать контекст текущей сессии',
        '/compact_status — насколько забит контекст сессии',
        '/away — режим «на телефоне»: вопросы сессий без привязки приходят сюда (таймаут 10 мин)',
        '/back — выключить режим «на телефоне»',
        '/voice on|off — голосовые ответы (TTS) для этого чата',
        '/diag — диагностика мессенджера',
        '/cd — перейти на сессию другого воркспейса (как cd по папкам)',
        '/claim <код> — стать оператором по коду из настроек мессенджера',
        '/unbind — отвязать сессию',
        '/notifications on|off — уведомления хоста вкл/выкл',
        '/help — эта справка',
        '',
        'Любой другой текст уходит в привязанную сессию DSH.',
        'Картинки PNG/JPEG/WebP/GIF (до 20 МиБ) уходят вместе с подписью; выбирайте модель с поддержкой изображений.',
        'Попросите агента вызвать messenger_send_image, чтобы вернуть готовую картинку в этот чат.',
        'Документы, видео, аудио и стикеры принимаются как путь-хендл: файл скачивается на хост, агенту передаётся путь.',
        'В форум-группах каждая тема — отдельная сессия: привязки, меню и ответы живут внутри своей темы.',
    ].join('\n');
}
function actionSessionId(action) {
    switch (action.kind) {
        case 'models':
        case 'provider-models':
        case 'select-model':
        case 'reasoning':
        case 'question-select':
        case 'question-toggle':
        case 'question-submit':
        case 'select-reasoning':
        case 'permission':
        case 'select-permission':
        case 'confirm-permission':
        case 'context':
        case 'cancel':
            return action.sessionId;
        default:
            return undefined;
    }
}
function callbackKeyboard(rows) {
    return rows;
}
function safeToolName(name) {
    const compact = name.replace(/[^A-Za-z0-9_./:-]/g, ' ').replace(/\s+/g, ' ').trim();
    return (compact || 'tool').slice(0, 80);
}
function concise(value, limit = 72) {
    const compact = value.replace(/\s+/g, ' ').trim();
    const characters = Array.from(compact);
    return characters.length <= limit ? compact : `${characters.slice(0, limit - 1).join('')}…`;
}
function toolArguments(raw) {
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
function stringArgument(args, key) {
    const value = args?.[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function humanizeToolName(name) {
    const leaf = name.split(/[./:]/).filter(Boolean).at(-1) ?? 'tool';
    const words = leaf.replaceAll('_', ' ').replaceAll('-', ' ').trim();
    return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Tool';
}
function quoted(value) {
    return `“${concise(value, 56)}”`;
}
function summarizeToolCall(name, rawArguments) {
    const args = toolArguments(rawArguments);
    const leaf = name.split(/[./:]/).filter(Boolean).at(-1)?.toLowerCase() ?? name.toLowerCase();
    const filePath = stringArgument(args, 'file_path');
    const path = stringArgument(args, 'path');
    const target = filePath ?? path;
    if (leaf === 'read' && target !== undefined) {
        const offset = typeof args?.offset === 'number' ? args.offset : undefined;
        const limit = typeof args?.limit === 'number' ? args.limit : undefined;
        const window = offset === undefined
            ? ''
            : ` · lines ${offset}${limit === undefined ? '+' : `–${offset + Math.max(0, limit - 1)}`}`;
        return `Reading ${concise(target)}${window}`;
    }
    if (leaf === 'read_image' && target !== undefined)
        return `Inspecting ${concise(target)}`;
    if ((leaf === 'write' || leaf === 'edit') && target !== undefined) {
        return `${leaf === 'write' ? 'Writing' : 'Editing'} ${concise(target)}`;
    }
    if (leaf === 'glob') {
        const pattern = stringArgument(args, 'pattern');
        const where = stringArgument(args, 'path');
        if (pattern !== undefined)
            return `Finding ${quoted(pattern)}${where === undefined ? '' : ` in ${concise(where, 44)}`}`;
    }
    if (leaf === 'grep') {
        const pattern = stringArgument(args, 'pattern');
        const where = stringArgument(args, 'path');
        if (pattern !== undefined)
            return `Searching for ${quoted(pattern)}${where === undefined ? '' : ` in ${concise(where, 40)}`}`;
    }
    if (leaf === 'bash') {
        const description = stringArgument(args, 'description');
        return description === undefined ? 'Выполняю команду' : concise(description);
    }
    if (leaf === 'web_search') {
        const queries = args?.queries;
        if (Array.isArray(queries)) {
            const first = queries.find((query) => typeof query === 'string' && query.trim().length > 0);
            if (first !== undefined)
                return `Searching the web for ${quoted(first)}`;
        }
        return 'Searching the web';
    }
    if (leaf === 'skill') {
        const skill = stringArgument(args, 'name');
        if (skill !== undefined)
            return `Loading ${concise(skill, 48)} guidance`;
    }
    if (leaf === 'subagent' || leaf === 'subagent_fork') {
        const description = stringArgument(args, 'description');
        return description === undefined ? 'Delegating a task' : `Delegating · ${concise(description, 52)}`;
    }
    if (leaf === 'todo_write')
        return 'Updating the plan';
    if (leaf === 'ask_user_question')
        return 'Preparing a question';
    if (leaf === 'job_output')
        return 'Checking background work';
    if (leaf === 'create_goal' || leaf === 'update_goal')
        return 'Updating the goal';
    return humanizeToolName(safeToolName(name));
}
function elapsedSuffix(startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
    return seconds < 2 ? '' : ` · ${seconds}s`;
}
function progressActivity(state) {
    const waiting = state.status.includes('❓ Waiting for your answer');
    if (waiting)
        return '❓ Waiting for your answer';
    const tools = state.toolOrder
        .map((callId) => state.tools.get(callId))
        .filter((tool) => tool !== undefined);
    const active = [...tools].reverse().find((tool) => tool.outcome === 'running');
    const spinner = PROGRESS_SPINNER_FRAMES[state.animationFrame % PROGRESS_SPINNER_FRAMES.length];
    const thinking = THINKING_LABELS[(state.thinkingOffset
        + Math.floor(state.animationFrame / THINKING_LABEL_FRAME_SPAN)) % THINKING_LABELS.length];
    const label = active?.label ?? (state.phase === 'responding' ? 'Writing the response' : thinking);
    const startedAt = active?.startedAt ?? state.startedAt;
    // The animated spinner lives at the end of the line and the activity line is
    // rendered last, so frame width changes never shift the message's leading text.
    return `${label}…${elapsedSuffix(startedAt)} ${spinner}`;
}
function pushStatus(state, line) {
    for (let index = state.status.length - 1; index >= 0; index -= 1) {
        if (state.status[index] === line)
            state.status.splice(index, 1);
    }
    state.status.push(line);
}
function replaceStatus(state, prefix, line) {
    for (let index = state.status.length - 1; index >= 0; index -= 1) {
        if (state.status[index]?.startsWith(prefix))
            state.status.splice(index, 1);
    }
    pushStatus(state, line);
}
function progressDetails(state) {
    const waiting = state.status.includes('❓ Waiting for your answer');
    const tools = state.toolOrder
        .map((callId) => state.tools.get(callId))
        .filter((tool) => tool !== undefined);
    const active = [...tools].reverse().find((tool) => tool.outcome === 'running');
    const toolLines = tools
        .filter((tool) => tool !== active)
        .slice(-3)
        .map((tool) => `${tool.outcome === 'running' ? '◌' : tool.outcome === 'completed' ? '✓' : '×'} ${tool.label}`);
    const statusLines = state.status
        .filter((line) => !waiting || line !== '❓ Waiting for your answer')
        .slice(-2);
    return [...toolLines, ...statusLines].slice(-4).join('\n');
}
function clipPlainTail(value, limit, measure) {
    if (measure(value) <= limit)
        return value;
    if (limit <= 0)
        return '';
    const characters = Array.from(value);
    let low = 0;
    let high = characters.length;
    let best = measure('…') <= limit ? '…' : '';
    while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const candidate = count === 0 ? '…' : `…${characters.slice(-count).join('')}`;
        if (measure(candidate) <= limit) {
            best = candidate;
            low = count + 1;
        }
        else {
            high = count - 1;
        }
    }
    return best;
}
function progressText(state) {
    const rawBody = state.text.trim();
    const activity = state.turnEnded ? '' : progressActivity(state);
    const details = progressDetails(state);
    const placeholder = state.turnEnded ? 'Готово.' : '';
    const limit = state.adapter.textLimit ?? DEFAULT_PROGRESS_LIMIT;
    const measure = (value) => (state.adapter.textLength?.(value) ?? Array.from(value).length);
    const renderBody = (value) => (value && state.adapter.renderText !== undefined ? state.adapter.renderText(value) : value);
    // Response body leads; the status trail and the animated activity line are
    // pinned to the message tail so the leading text never shifts mid-stream.
    const compose = (body) => [
        body || placeholder,
        details,
        activity,
    ].filter(Boolean).join('\n\n');
    const rendered = compose(renderBody(rawBody));
    if (measure(rendered) <= limit)
        return rendered;
    if (!rawBody)
        return clipPlainTail(rendered, limit, measure);
    const rawCharacters = Array.from(rawBody);
    let low = 0;
    let high = rawCharacters.length;
    let best = '';
    while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const candidate = count === 0
            ? ''
            : `${count < rawCharacters.length ? '…\n' : ''}${rawCharacters.slice(-count).join('')}`;
        const candidateRendered = compose(renderBody(candidate));
        if (measure(candidateRendered) <= limit) {
            best = candidateRendered;
            low = count + 1;
        }
        else {
            high = count - 1;
        }
    }
    return best || clipPlainTail(compose(''), limit, measure);
}
export class MessengerBridge {
    ctx;
    bindingStore;
    allowedChatIds;
    allowedUserIds;
    privateChatsOnly;
    bindings = new Map();
    bindingUpdatedAt = new Map();
    bindingRevisions = new Map();
    adapters = new Map();
    outboundQueues = new Map();
    actionQueues = new Map();
    callbacks = new Map();
    progress = new Map();
    questionRequests = new Map();
    pendingQuestions = new Map();
    questionRetries = new Map();
    questionRetryDelays = new Map();
    resolvingQuestions = new Set();
    control;
    notificationStore;
    voice;
    voiceJobs = new Map();
    imageController = new AbortController();
    activeImageDownloads = 0;
    mirroredImageMessages = new Set();
    albumBuffers = new Map();
    nextThinkingOffset = 0;
    disposed = false;
    // --- PATCH: files/forums/duty/commands (2026-09-27) ---
    claimCode = '';
    claimedUserIds = new Set();
    claimedChatIds = new Set();
    duty;
    voicePrefs = new Map();
    activeFileDownloads = 0;
    recentErrors = [];
    goalLog = new Map();
    dutyTimers = new Map();
    constructor(ctx, options, bindingStore = new MemoryMessengerBindingStore()) {
        this.ctx = ctx;
        this.bindingStore = bindingStore;
        this.allowedChatIds = new Set(options.allowedChatIds);
        this.allowedUserIds = new Set(options.allowedUserIds);
        this.privateChatsOnly = options.privateChatsOnly;
        this.control = new DshControl(ctx);
        this.notificationStore = options.notificationStore;
        this.voice = options.voice;
        // --- PATCH: files/forums/duty/commands (2026-09-27) ---
        this.claimCode = typeof options.claimCode === 'string' ? options.claimCode.trim() : '';
        const claimed = readJsonState('claimed-users.json');
        for (const id of Array.isArray(claimed?.users) ? claimed.users : [])
            if (typeof id === 'string')
                this.claimedUserIds.add(id);
        for (const id of Array.isArray(claimed?.chats) ? claimed.chats : [])
            if (typeof id === 'string')
                this.claimedChatIds.add(id);
        const rawDuty = readJsonState('duty.json');
        if (rawDuty !== undefined && typeof rawDuty.transport === 'string'
            && typeof rawDuty.chatId === 'string' && typeof rawDuty.senderId === 'string') {
            this.duty = {
                transport: rawDuty.transport,
                chatId: rawDuty.chatId,
                ...(rawDuty.chatKind === undefined ? {} : { chatKind: rawDuty.chatKind }),
                senderId: rawDuty.senderId,
                ...(rawDuty.authorizedAs === undefined ? {} : { authorizedAs: rawDuty.authorizedAs }),
                ...(typeof rawDuty.enabledAt === 'string' ? { enabledAt: rawDuty.enabledAt } : {}),
            };
        }
        const prefs = readJsonState('voice-prefs.json');
        for (const [key, value] of Object.entries(prefs ?? {}))
            if (value === 'on' || value === 'off')
                this.voicePrefs.set(key, value);
    }
    async restoreBindings() {
        const sessions = new Map((await this.control.listSessions()).map((session) => [
            String(session.sessionId),
            session,
        ]));
        this.bindings.clear();
        this.bindingUpdatedAt.clear();
        this.bindingRevisions.clear();
        for (const record of this.bindingStore.list()) {
            if (!this.adapters.has(record.transport))
                continue;
            if (!this.authorizedBinding(record)) {
                try {
                    await this.bindingStore.delete(record.transport, record.chatId, record.senderId);
                }
                catch (error) {
                    this.ctx.logger.warn('messenger: failed to remove a revoked persisted binding: %o', error);
                }
                continue;
            }
            const session = sessions.get(record.sessionId);
            if (session === undefined
                || (record.sessionCwd !== undefined && record.sessionCwd !== session.cwd)) {
                try {
                    await this.bindingStore.delete(record.transport, record.chatId, record.senderId);
                }
                catch (error) {
                    this.ctx.logger.warn('messenger: failed to remove a stale persisted binding: %o', error);
                }
                continue;
            }
            const key = bindingKey(record.transport, record.chatId, record.senderId);
            this.bindings.set(key, record.sessionId);
            this.bindingUpdatedAt.set(key, record.updatedAt);
            this.bindingRevisions.set(key, 1);
        }
    }
    registerAdapter(adapter) {
        if (this.adapters.has(adapter.id)) {
            throw new Error(`Messenger adapter "${adapter.id}" is already registered`);
        }
        this.adapters.set(adapter.id, adapter);
    }
    async handle(message) {
        if (this.disposed)
            return;
        const adapter = this.adapters.get(message.transport);
        if (adapter === undefined)
            throw new Error(`Unknown messenger adapter "${message.transport}"`);
        // Claim bootstrap: /claim is reachable before any allowlist entry exists,
        // so a fresh operator can pair from the phone without editing config files.
        if (message.kind === 'message' && message.chatKind === 'private'
            && parseCommand(message.text)?.name === 'claim') {
            const claimCommand = parseCommand(message.text);
            await this.handleClaim(adapter, message.chatId, message.chatKind, message.senderId, claimCommand.argument);
            return;
        }
        if (!this.authorized(message)) {
            this.ctx.logger.warn('messenger: ignored unauthorized %s chat %s from user %s', message.transport, message.chatId, message.senderId);
            if (message.kind === 'callback_query') {
                await adapter.answerCallback(message.callbackQueryId, 'Not authorized.', true);
            }
            return;
        }
        // Forum topics and every per-destination control share one destination/sender-slot pair.
        const dest = chatDestination(message);
        const senderKey = controlSender(message);
        if (message.kind === 'callback_query') {
            await this.handleCallback(adapter, message);
            return;
        }
        const key = bindingKey(adapter.id, dest, senderKey);
        if (message.kind === 'image') {
            await this.enqueueImage(adapter, message, key);
            return;
        }
        if (message.kind === 'voice') {
            await this.enqueueAction(key, () => this.acceptVoice(adapter, message, key));
            return;
        }
        // --- PATCH: files-as-path-handles (2026-09-27) ---
        if (message.kind === 'file') {
            await this.enqueueAction(key, () => this.handleFile(adapter, message, key));
            return;
        }
        if (parseCommand(message.text) === undefined && !this.bindings.has(key)) {
            await adapter.sendText(dest, 'Сессия не выбрана. Используйте /resume для выбора или /new для создания.', { keyboard: this.mainKeyboard(adapter.id, dest, senderKey) });
            return;
        }
        await this.enqueueAction(key, () => this.handleTextMessage(adapter, message));
    }
    async enqueueImage(adapter, message, key) {
        const groupId = message.mediaGroupId;
        if (typeof groupId !== 'string' || groupId === '') {
            await this.enqueueAction(key, () => this.handleImage(adapter, message, key));
            return;
        }
        // Album glue: Telegram delivers an album as N independent updates; collect them for a
        // short window and submit ONE prompt with all images under the single caption.
        const albumKey = `${adapter.id}:${chatDestination(message)}:${controlSender(message)}:${groupId}`;
        let buffer = this.albumBuffers.get(albumKey);
        if (buffer === undefined) {
            buffer = { messages: [], timer: undefined };
            this.albumBuffers.set(albumKey, buffer);
        }
        buffer.messages.push(message);
        if (buffer.timer !== undefined)
            clearTimeout(buffer.timer);
        const flush = () => {
            this.albumBuffers.delete(albumKey);
            const ordered = [...buffer.messages].sort((a, b) => Number(a.messageId) - Number(b.messageId));
            void this.enqueueAction(key, () => this.flushAlbum(adapter, ordered))
                .catch(() => { });
        };
        if (buffer.messages.length >= 10) {
            flush();
            return;
        }
        buffer.timer = setTimeout(flush, 1500);
    }
    async flushAlbum(adapter, messages) {
        const first = messages[0];
        const dest = chatDestination(first);
        const key = bindingKey(adapter.id, dest, controlSender(first));
        const sessionId = this.bindings.get(key);
        const revision = this.bindingRevisions.get(key);
        if (sessionId === undefined) {
            await adapter.sendText(dest, 'Сессия не выбрана. Используйте /resume или /new перед отправкой изображения.');
            return;
        }
        if (this.pendingQuestions.has(key)) {
            await adapter.sendText(dest, 'Сначала ответьте на открытый вопрос (текстом или кнопками), затем отправьте альбом заново.');
            return;
        }
        if (adapter.downloadImage === undefined) {
            await adapter.sendText(dest, 'Загрузка изображений недоступна для этого мессенджера.');
            return;
        }
        const oversized = messages.find((m) => m.image.sizeBytes !== undefined
            && (!Number.isSafeInteger(m.image.sizeBytes) || m.image.sizeBytes <= 0 || m.image.sizeBytes > IMAGE_BYTE_LIMIT));
        if (oversized !== undefined) {
            await adapter.sendText(dest, 'Изображение не должно быть пустым и тяжелее 20 МиБ.');
            return;
        }
        if (this.activeImageDownloads + messages.length > 8) {
            await adapter.sendText(dest, 'Загрузчик изображений занят. Попробуйте чуть позже.');
            return;
        }
        this.activeImageDownloads += messages.length;
        const signal = AbortSignal.any([this.imageController.signal, AbortSignal.timeout(60_000)]);
        try {
            const images = [];
            let failed = 0;
            for (const item of messages) {
                try {
                    images.push(messengerImage(await abortable(adapter.downloadImage(item, signal), signal)));
                }
                catch {
                    failed += 1;
                }
            }
            if (this.disposed)
                return;
            if (images.length === 0) {
                await adapter.sendText(dest, 'Не удалось загрузить изображения. Пришлите заново PNG, JPEG, WebP или GIF до 20 МиБ.');
                return;
            }
            if (this.bindings.get(key) !== sessionId || this.bindingRevisions.get(key) !== revision || this.pendingQuestions.has(key)) {
                await adapter.sendText(dest, 'Выбранная сессия или вопрос изменились. Отправьте альбом заново.');
                return;
            }
            const caption = messages.map((m) => m.text).find((t) => typeof t === 'string' && t.trim() !== '') ?? '';
            let text = caption;
            if (failed > 0)
                text = (text ? `${text}\n\n` : '') + `(не удалось загрузить ${failed} из ${messages.length} изображений — при необходимости отправьте их отдельно)`;
            await this.handleUserText(adapter, { ...first, kind: 'message', text }, images[0], this.imageController.signal, images.slice(1));
        }
        finally {
            this.activeImageDownloads -= messages.length;
        }
    }
    async handleImage(adapter, message, key) {
        const sessionId = this.bindings.get(key);
        const revision = this.bindingRevisions.get(key);
        if (sessionId === undefined) {
            await adapter.sendText(chatDestination(message), 'Сессия не выбрана. Используйте /resume или /new перед отправкой изображения.');
            return;
        }
        if (this.pendingQuestions.has(key)) {
            await adapter.sendText(chatDestination(message), 'Сначала ответьте на открытый вопрос (текстом или кнопками), затем отправьте изображение заново.');
            return;
        }
        if (adapter.downloadImage === undefined) {
            await adapter.sendText(chatDestination(message), 'Загрузка изображений недоступна для этого мессенджера.');
            return;
        }
        const size = message.image.sizeBytes;
        if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0 || size > IMAGE_BYTE_LIMIT)) {
            await adapter.sendText(chatDestination(message), 'Изображение не должно быть пустым и тяжелее 20 МиБ.');
            return;
        }
        if (this.activeImageDownloads >= 8) {
            await adapter.sendText(chatDestination(message), 'Загрузчик изображений занят. Попробуйте чуть позже.');
            return;
        }
        this.activeImageDownloads += 1;
        const signal = AbortSignal.any([this.imageController.signal, AbortSignal.timeout(60_000)]);
        try {
            const image = messengerImage(await abortable(adapter.downloadImage(message, signal), signal));
            if (this.disposed)
                return;
            if (this.bindings.get(key) !== sessionId || this.bindingRevisions.get(key) !== revision || this.pendingQuestions.has(key)) {
                await adapter.sendText(chatDestination(message), 'Выбранная сессия или вопрос изменились. Отправьте изображение заново.');
                return;
            }
            // Captions are prompt content, never commands or answers to a text-only question.
            // The download deadline ends here. Once Host prompt admission starts it
            // may be noncancelable; disposal drains that accepted action like text prompts.
            await this.handleUserText(adapter, { ...message, kind: 'message' }, image, this.imageController.signal);
        }
        catch {
            if (!this.disposed)
                await adapter.sendText(chatDestination(message), 'Не удалось загрузить изображение. Пришлите корректный PNG, JPEG, WebP или GIF до 20 МиБ.');
        }
        finally {
            this.activeImageDownloads -= 1;
        }
    }
    // --- PATCH: files-as-path-handles (2026-09-27): any accepted media becomes a
    // downloaded read-only path handle; the agent reads it with its own file tools.
    async handleFile(adapter, message, key) {
        const dest = chatDestination(message);
        const sessionId = this.bindings.get(key);
        if (sessionId === undefined) {
            await adapter.sendText(dest, 'Нет выбранной сессии. Используйте /resume или /new перед отправкой файла.');
            return;
        }
        if (this.pendingQuestions.has(key)) {
            await adapter.sendText(dest, 'Сначала ответьте на ожидающий вопрос текстом или кнопками, затем отправьте файл снова.');
            return;
        }
        if (adapter.downloadFileMessage === undefined) {
            await adapter.sendText(dest, 'Приём файлов недоступен для этого транспорта.');
            return;
        }
        const size = message.file.sizeBytes;
        if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0)) {
            await adapter.sendText(dest, 'Некорректный размер файла.');
            return;
        }
        if (this.activeFileDownloads >= 4) {
            await adapter.sendText(dest, 'Очередь загрузки файлов занята. Попробуйте чуть позже.');
            return;
        }
        this.activeFileDownloads += 1;
        const revision = this.bindingRevisions.get(key);
        const signal = AbortSignal.any([this.imageController.signal, AbortSignal.timeout(600_000)]);
        try {
            const bytes = await abortable(adapter.downloadFileMessage(message, signal), signal);
            if (this.disposed)
                return;
            const saved = saveInboundFile(message.file, bytes, dest);
            if (this.bindings.get(key) !== sessionId || this.bindingRevisions.get(key) !== revision
                || this.pendingQuestions.has(key)) {
                await adapter.sendText(dest, 'Выбранная сессия или вопрос изменились — отправьте файл ещё раз.');
                return;
            }
            const caption = typeof message.text === 'string' ? message.text.trim() : '';
            const text = caption === ''
                ? filePromptBlock(saved, message.file)
                : `${caption}\n\n${filePromptBlock(saved, message.file)}`;
            await this.handleUserText(adapter, { ...message, kind: 'message', text });
        }
        catch (error) {
            this.recordError(`файл: ${this.errorMessage(error)}`);
            if (!this.disposed) {
                await adapter.sendText(dest, `Не удалось принять файл: ${this.errorMessage(error).slice(0, 300)}`);
            }
        }
        finally {
            this.activeFileDownloads -= 1;
        }
    }
    cancelVoice(key, jobId) {
        let count = 0;
        for (const job of this.voiceJobs.values()) {
            if (job.key !== key || (jobId !== undefined && job.id !== jobId) || job.controller.signal.aborted)
                continue;
            job.controller.abort(new Error('Voice transcription cancelled.'));
            count += 1;
        }
        return count;
    }
    voiceTargetCurrent(job) {
        return !this.disposed && !job.controller.signal.aborted
            && this.bindings.get(job.key) === job.sessionId
            && (this.bindingRevisions.get(job.key) ?? 0) === job.bindingRevision
            && this.pendingQuestions.get(job.key) === job.question
            && job.question?.index === job.questionIndex
            && (job.question === undefined || !this.resolvingQuestions.has(job.question.rpcId));
    }
    async acceptVoice(adapter, message, key) {
        const sessionId = this.bindings.get(key);
        if (sessionId === undefined) {
            await adapter.sendText(chatDestination(message), 'Сессия не выбрана. Используйте /resume или /new перед отправкой голосового.');
            return;
        }
        if (this.voice === undefined || adapter.downloadVoice === undefined) {
            await adapter.sendText(chatDestination(message), 'Локальная расшифровка отключена или недоступна. Включите её в настройках мессенджера или смените режим через /stt.');
            return;
        }
        const { durationSeconds, sizeBytes } = message.voice;
        if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 300
            || (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 20 * 1024 * 1024))) {
            await adapter.sendText(chatDestination(message), 'Голосовые — не длиннее 5 минут и не тяжелее 20 МиБ.');
            return;
        }
        if (this.voiceJobs.size >= 8 || [...this.voiceJobs.values()].filter((job) => job.key === key).length >= 3) {
            await adapter.sendText(chatDestination(message), 'Очередь расшифровки заполнена. Дождитесь окончания или используйте /voice_cancel.');
            return;
        }
        const question = this.pendingQuestions.get(key);
        const job = {
            id: randomUUID(), key, controller: new AbortController(), sessionId,
            bindingRevision: this.bindingRevisions.get(key) ?? 0,
            question, questionIndex: question?.index, task: Promise.resolve(),
        };
        // Wait for every earlier live job: a cancelled middle job can finish before
        // its predecessor and must not let a later successful transcript overtake it.
        const previous = Promise.all([...this.voiceJobs.values()]
            .filter((candidate) => candidate.key === key).map((candidate) => candidate.task)).then(() => { });
        this.voiceJobs.set(job.id, job);
        // Do not await long-running work on the adapter's chat tail or action queue.
        job.task = this.runVoice(adapter, message, job, previous).catch(() => {
            if (!this.disposed)
                this.ctx.logger.warn('messenger: could not deliver voice transcription status');
        }).finally(() => {
            this.voiceJobs.delete(job.id);
            for (const [token, record] of this.callbacks) {
                if (record.action.kind === 'voice-cancel' && record.action.jobId === job.id)
                    this.callbacks.delete(token);
            }
        });
    }
    async runVoice(adapter, message, job, previous) {
        const keyboard = callbackKeyboard([[
                this.button(adapter.id, chatDestination(message), controlSender(message), 'Отменить расшифровку', { kind: 'voice-cancel', jobId: job.id }),
            ]]);
        const sttMode = readSttMode();
        const browserMode = sttMode === 'browser';
        const sttStatusText = browserMode
            ? '🎙 Браузерная расшифровка (Google Web Speech)… /voice_cancel — отмена.'
            : sttMode === 'local'
                ? '🎙 Локальная расшифровка (Vosk small-ru)… /voice_cancel — отмена.'
                : `🎙 Локальная расшифровка (${SHERPA_MODES[sttMode].label})… /voice_cancel — отмена.`;
        const handlePromise = adapter.sendText(chatDestination(message), sttStatusText, { keyboard })
            .catch(() => undefined);
        let latestStatus;
        let timer;
        let edits = Promise.resolve();
        let finished = false;
        const progress = (text) => {
            if (finished || this.disposed || job.controller.signal.aborted)
                return;
            latestStatus = text;
            if (timer !== undefined)
                return;
            timer = setTimeout(() => {
                timer = undefined;
                edits = edits.then(async () => {
                    const handle = await handlePromise;
                    if (finished || this.disposed || job.controller.signal.aborted || handle === undefined || latestStatus === undefined)
                        return;
                    const status = latestStatus;
                    latestStatus = undefined;
                    await adapter.editText(chatDestination(message), handle.messageId, `🎙 ${status.slice(0, 600)}`, keyboard);
                }).catch(() => undefined);
            }, PROGRESS_EDIT_INTERVAL_MS);
        };
        const finish = async (text) => {
            finished = true;
            if (timer !== undefined)
                clearTimeout(timer);
            await edits;
            if (this.disposed)
                return;
            const handle = await handlePromise;
            if (this.disposed)
                return;
            if (handle !== undefined) {
                try {
                    if (adapter.replaceText !== undefined)
                        await adapter.replaceText(chatDestination(message), handle.messageId, text, []);
                    else if (text.length <= 3500)
                        await adapter.editText(chatDestination(message), handle.messageId, text, []);
                    else {
                        await adapter.editText(chatDestination(message), handle.messageId, '🎙 Расшифровка готова.', []);
                        if (!this.disposed)
                            await adapter.sendText(chatDestination(message), text);
                    }
                    return;
                }
                catch { /* A deleted status message must not swallow the result. */ }
            }
            if (this.disposed)
                return;
            try {
                await adapter.sendText(chatDestination(message), text);
            }
            catch {
                this.ctx.logger.warn('messenger: could not deliver voice transcription status');
            }
        };
        try {
            const sttStartedAt = Date.now();
            // Submit synchronously before awaiting Telegram presentation to preserve arrival order.
            const text = (await (browserMode
                ? (async () => {
                    progress('Загрузка аудио…');
                    if (!this.voiceTargetCurrent(job))
                        throw new Error('Выбранная сессия или вопрос изменились. Отправьте голосовое заново.');
                    const audio = await abortable(adapter.downloadVoice(message, job.controller.signal), job.controller.signal);
                    if (!(audio instanceof Uint8Array) || !audio.byteLength || audio.byteLength > 20 * 1024 * 1024)
                        throw new Error('Аудио голосового не должно быть пустым и тяжелее 20 МиБ.');
                    // Strict one-model disk policy: the browser mode's runtime is
                    // lazy too — clean up everything else, install chrome if missing.
                    enforceOnlyActiveModelSync('chrome');
                    if (!sherpaModelPresentSync('chrome')) {
                        const info = STT_MODELS.chrome;
                        progress(`Устанавливаю ${info.label} (${info.downloadNote}), это может занять пару минут…`);
                        try {
                            await ensureModel('chrome');
                        }
                        catch (error) {
                            throw new Error(`Не удалось установить ${info.label}: ${String(error?.message ?? error).slice(0, 250)}`);
                        }
                    }
                    progress('Расшифровка (Google Web Speech)…');
                    return await abortable(browserTranscribe(audio, job.controller.signal), job.controller.signal);
                })()
                : (async () => {
                    progress('Загрузка аудио…');
                    if (!this.voiceTargetCurrent(job))
                        throw new Error('Выбранная сессия или вопрос изменились. Отправьте голосовое заново.');
                    const audio = await abortable(adapter.downloadVoice(message, job.controller.signal), job.controller.signal);
                    if (!(audio instanceof Uint8Array) || !audio.byteLength || audio.byteLength > 20 * 1024 * 1024)
                        throw new Error('Аудио голосового не должно быть пустым и тяжелее 20 МиБ.');
                    const engine = sttMode === 'local' ? 'vosk' : sttMode;
                    // Strict one-model disk policy: remove every non-active model
                    // first (frees space), then fetch the active one if missing.
                    enforceOnlyActiveModelSync(engine);
                    if (!sherpaModelPresentSync(engine)) {
                        const info = STT_MODELS[engine];
                        progress(`Скачиваю модель ${info.label} (${info.downloadNote})…`);
                        try {
                            await ensureModel(engine);
                        }
                        catch (error) {
                            throw new Error(`Не удалось скачать модель ${info.label}: ${String(error?.message ?? error).slice(0, 250)}`);
                        }
                    }
                    progress(`Расшифровка (${STT_MODELS[engine].label})…`);
                    return await abortable(localTranscribe(engine, audio, job.controller.signal), job.controller.signal);
                })())).trim();
            recordSttStat(sttMode, Date.now() - sttStartedAt, text.length);
            if (job.controller.signal.aborted)
                throw job.controller.signal.reason;
            if (!text)
                throw new Error('Речь не распознана. Попробуйте записать ещё раз.');
            if (text.length > 32_000)
                throw new Error('Расшифровка слишком длинная. Пришлите запись покороче.');
            await abortable(previous, job.controller.signal);
            if (job.controller.signal.aborted)
                throw job.controller.signal.reason;
            await finish(`🎙 Recognized:\n\n${text}`);
            if (this.disposed)
                return;
            await this.enqueueAction(job.key, async () => {
                if (!this.voiceTargetCurrent(job)) {
                    await adapter.sendText(chatDestination(message), 'Расшифровка не отправлена: отмена или смена сессии/вопроса. При необходимости отправьте текст заново.');
                    return;
                }
                await this.handleUserText(adapter, { ...message, kind: 'message', text });
            });
        }
        catch (error) {
            await finish(job.controller.signal.aborted
                ? '🎙 Расшифровка голоса отменена.'
                : `🎙 Could not transcribe: ${this.errorMessage(error).slice(0, 600)}`);
        }
        finally {
            finished = true;
            if (timer !== undefined)
                clearTimeout(timer);
            await edits;
        }
    }
    async handleTextMessage(adapter, message) {
        const dest = chatDestination(message);
        const senderKey = controlSender(message);
        const command = parseCommand(message.text);
        if (command?.name === 'voice_cancel') {
            const key = bindingKey(adapter.id, dest, senderKey);
            const count = this.cancelVoice(key);
            await adapter.sendText(dest, count > 0
                ? '🎙 Расшифровка голоса отменена.' : 'No pending voice transcriptions.');
            return;
        }
        if (command?.name === 'stt') {
            await this.sendSttPanel(adapter, dest, senderKey);
            return;
        }
        if (command?.name === 'notifications') {
            await this.handleNotificationsCommand(adapter, message, command.argument);
            return;
        }
        if (command !== undefined) {
            await this.handleCommand(adapter, dest, message.chatKind, senderKey, this.authorizationIdentity(message), command);
            return;
        }
        await this.handleUserText(adapter, message);
    }
    buildSttPanel(adapter, chatId, senderId) {
        const mode = readSttMode();
        const stats = readSttStats();
        const activeLine = mode === 'browser'
            ? '🌐 АКТИВНО: браузер — Google Web Speech (бесплатно, Chrome-рантайм ~430 МБ)'
            : mode === 'local'
                ? '💻 АКТИВНО: локально — Vosk small-ru (офлайн, ~90 МБ)'
                : `⚙️ АКТИВНО: локально — ${SHERPA_MODES[mode].label} (офлайн, ${SHERPA_MODES[mode].downloadNote})`;
        const noteLine = `💾 На диске хранится только рантайм активного режима: при переключении всё остальное автоматически удаляется, а выбранное при необходимости скачивается заново (Vosk ~90 МБ, T-one ~140 МБ, GigaAM ~230 МБ, Chrome ~430 МБ).`;
        const text = [
            '🎙 Расшифровка голосовых — выбор модели',
            '',
            activeLine,
            '',
            `🌐 Браузер (Google): ${formatSttStatsLine(stats.browser)}`,
            `💻 Vosk (локально): ${formatSttStatsLine(stats.local)}`,
            `⚡ T-one (T-Bank): ${formatSttStatsLine(stats.tone)}`,
            `🔵 GigaAM (Сбер): ${formatSttStatsLine(stats.gigaam)}`,
            '',
            noteLine,
        ].join('\n');
        const mark = (target) => target === mode ? '✅ ' : '';
        const rows = [[
                this.button(adapter.id, chatId, senderId, `${mark('local')}💻 Vosk`, { kind: 'stt-mode', mode: 'local' }),
                this.button(adapter.id, chatId, senderId, `${mark('browser')}🌐 Браузер`, { kind: 'stt-mode', mode: 'browser' }),
            ], [
                this.button(adapter.id, chatId, senderId, `${mark('tone')}⚡ T-one`, { kind: 'stt-mode', mode: 'tone' }),
                this.button(adapter.id, chatId, senderId, `${mark('gigaam')}🔵 GigaAM`, { kind: 'stt-mode', mode: 'gigaam' }),
            ]];
        return { text, rows };
    }
    async sendSttPanel(adapter, chatId, senderId) {
        const mode = readSttMode();
        const stats = readSttStats();
        const activeLine = mode === 'browser'
            ? '🌐 АКТИВНО: браузер — Google Web Speech (бесплатно, Chrome-рантайм ~430 МБ)'
            : mode === 'local'
                ? '💻 АКТИВНО: локально — Vosk small-ru (офлайн, ~90 МБ)'
                : `⚙️ АКТИВНО: локально — ${SHERPA_MODES[mode].label} (офлайн, ${SHERPA_MODES[mode].downloadNote})`;
        const noteLine = `💾 На диске хранится только рантайм активного режима: при переключении всё остальное автоматически удаляется, а выбранное при необходимости скачивается заново (Vosk ~90 МБ, T-one ~140 МБ, GigaAM ~230 МБ, Chrome ~430 МБ).`;
        const text = [
            '🎙 Расшифровка голосовых — выбор модели',
            '',
            activeLine,
            '',
            `🌐 Браузер (Google): ${formatSttStatsLine(stats.browser)}`,
            `💻 Vosk (локально): ${formatSttStatsLine(stats.local)}`,
            `⚡ T-one (T-Bank): ${formatSttStatsLine(stats.tone)}`,
            `🔵 GigaAM (Сбер): ${formatSttStatsLine(stats.gigaam)}`,
            '',
            noteLine,
        ].join('\n');
        const localAction = { kind: 'stt-mode', mode: 'local' };
        const browserAction = { kind: 'stt-mode', mode: 'browser' };
        const toneAction = { kind: 'stt-mode', mode: 'tone' };
        const gigaamAction = { kind: 'stt-mode', mode: 'gigaam' };
        const rows = [[
                this.button(adapter.id, chatId, senderId, `${mode === 'local' ? '✅ ' : ''}💻 Vosk`, localAction),
                this.button(adapter.id, chatId, senderId, `${mode === 'browser' ? '✅ ' : ''}🌐 Браузер`, browserAction),
            ], [
                this.button(adapter.id, chatId, senderId, `${mode === 'tone' ? '✅ ' : ''}⚡ T-one`, toneAction),
                this.button(adapter.id, chatId, senderId, `${mode === 'gigaam' ? '✅ ' : ''}🔵 GigaAM`, gigaamAction),
            ]];
        const sent = await adapter.sendText(chatId, text, { keyboard: callbackKeyboard(rows) });
        // Let the buttons edit this panel in place when possible.
        if (sent?.messageId !== undefined) {
            localAction.panelMessageId = sent.messageId;
            browserAction.panelMessageId = sent.messageId;
            toneAction.panelMessageId = sent.messageId;
            gigaamAction.panelMessageId = sent.messageId;
        }
    }
    /** Content only: transcripts must never pass through the command parser. */
    async handleUserText(adapter, message, image, signal, extraImages = []) {
        const dest = chatDestination(message);
        const key = bindingKey(message.transport, dest, controlSender(message));
        const pendingQuestion = this.pendingQuestions.get(key);
        if (pendingQuestion !== undefined) {
            try {
                await this.answerQuestionWithText(pendingQuestion, message.text);
            }
            catch (error) {
                await adapter.sendText(dest, `Could not submit that answer: ${this.errorMessage(error)}. Please try again.`);
            }
            return;
        }
        const sessionId = this.bindings.get(key);
        if (sessionId === undefined) {
            await adapter.sendText(dest, 'Сессия не выбрана. Используйте /resume для выбора или /new для создания.', { keyboard: this.mainKeyboard(message.transport, dest, controlSender(message)) });
            return;
        }
        const sharedProgressAlreadyActive = this.progress.has(progressKey(adapter.id, dest, sessionId));
        void this.beginProgress(adapter, dest, controlSender(message), sessionId)
            .catch((error) => {
            this.ctx.logger.warn('messenger: failed to show progress before submitting prompt: %o', error);
        });
        try {
            await this.control.prompt(sessionId, message.text, 'queue', image, signal, extraImages);
        }
        catch (error) {
            if (sharedProgressAlreadyActive) {
                await adapter.sendText(chatDestination(message), `Could not queue that prompt: ${this.errorMessage(error)}`);
            }
            else {
                await this.failProgress(adapter, chatDestination(message), controlSender(message), sessionId, error);
            }
        }
    }
    async onSessionEvent(sessionId, event) {
        if (this.disposed)
            return;
        const states = this.progressStates(sessionId);
        if (states.length === 0 && this.hasBindings(sessionId) && (event.type === 'turn/start'
            || event.type === 'assistant/chunk'
            || event.type === 'tool/call')) {
            this.beginProgressForBindings(sessionId);
        }
        const active = this.progressStates(sessionId);
        const images = visibleAssistantImages(event);
        if (images.length > 0 && this.hasBindings(sessionId) && !this.canSendImage(sessionId)) {
            await this.sendToBindings(sessionId, 'This messenger cannot deliver image attachments. Open the response in DSH to view them.');
        }
        if (images.length > 0 && event.type === 'assistant/message' && this.canSendImage(sessionId)) {
            const identity = JSON.stringify([sessionId, event.data.message.id]);
            if (!this.mirroredImageMessages.has(identity)) {
                this.mirroredImageMessages.add(identity);
                if (this.mirroredImageMessages.size > 512)
                    this.mirroredImageMessages.delete(this.mirroredImageMessages.values().next().value);
                const version = this.imageBindingVersion(sessionId);
                for (const image of images.slice(0, MAX_REPLY_IMAGES)) {
                    if (this.disposed)
                        return;
                    if (this.imageBindingVersion(sessionId) !== version)
                        break;
                    try {
                        const resolved = await abortable(this.control.image(sessionId, image), AbortSignal.any([this.imageController.signal, AbortSignal.timeout(60_000)]));
                        if (this.disposed || this.imageBindingVersion(sessionId) !== version)
                            continue;
                        const result = await this.sendImage(sessionId, resolved);
                        if (result.failed > 0)
                            await this.sendToBindings(sessionId, 'Could not deliver an image from the response. It may have been partially delivered; it will not be retried automatically.');
                        for (const state of active)
                            state.imageCount += result.sent > 0 ? 1 : 0;
                    }
                    catch {
                        if (!this.disposed)
                            await this.sendToBindings(sessionId, 'Could not load or deliver an image from the response.');
                    }
                }
                if (!this.disposed && images.length > MAX_REPLY_IMAGES)
                    await this.sendToBindings(sessionId, `Additional images omitted: limit of ${MAX_REPLY_IMAGES} images per response.`);
            }
        }
        if (this.disposed)
            return;
        if (active.length === 0) {
            const finalText = visibleAssistantText(event);
            if (finalText !== undefined)
                await this.sendToBindings(sessionId, finalText);
            return;
        }
        if (event.type === 'assistant/chunk') {
            if (event.data.chunk.type === 'text-delta') {
                for (const state of active) {
                    state.text += event.data.chunk.text;
                    state.phase = 'responding';
                }
            }
            else if (event.data.chunk.type === 'reasoning-delta') {
                for (const state of active)
                    state.phase = 'thinking';
            }
            this.scheduleProgressEdits(active);
            return;
        }
        if (event.type === 'assistant/message') {
            const text = visibleAssistantText(event);
            if (text !== undefined) {
                for (const state of active) {
                    state.text = text;
                    state.phase = 'responding';
                }
            }
            if (event.data.interrupted) {
                for (const state of active)
                    pushStatus(state, '⏹ Interrupted');
            }
            this.scheduleProgressEdits(active);
            return;
        }
        if (event.type === 'tool/call') {
            const name = safeToolName(event.data.name);
            const callId = String(event.data.callId);
            const label = summarizeToolCall(name, event.data.arguments);
            for (const state of active) {
                state.tools.set(callId, {
                    callId,
                    name,
                    label,
                    startedAt: event.time,
                    outcome: 'running',
                });
                const previous = state.toolOrder.indexOf(callId);
                if (previous >= 0)
                    state.toolOrder.splice(previous, 1);
                state.toolOrder.push(callId);
                state.phase = 'thinking';
            }
            this.scheduleProgressEdits(active);
            return;
        }
        if (event.type === 'tool/result') {
            const callId = String(event.data.message.source.callId);
            for (const state of active) {
                const tool = state.tools.get(callId);
                if (tool !== undefined) {
                    tool.completedAt = event.time;
                    tool.outcome = event.data.error === undefined ? 'completed' : 'failed';
                }
                else {
                    state.tools.set(callId, {
                        callId,
                        name: 'tool',
                        label: 'Tool call',
                        startedAt: event.time,
                        completedAt: event.time,
                        outcome: event.data.error === undefined ? 'completed' : 'failed',
                    });
                    state.toolOrder.push(callId);
                }
                state.phase = 'thinking';
            }
            this.scheduleProgressEdits(active);
            return;
        }
        if (event.type === 'turn/end') {
            for (const state of active) {
                state.turnEnded = true;
                if (event.data.reason.kind === 'aborted')
                    pushStatus(state, '⏹ Cancelled');
                if (event.data.reason.kind === 'error')
                    pushStatus(state, '❌ Turn failed');
                if (event.data.reason.kind === 'blocked')
                    pushStatus(state, '⏸ Blocked');
                if (event.data.reason.kind === 'max-tokens')
                    pushStatus(state, '⚠️ Output limit reached');
                if (this.progress.get(state.key) === state)
                    this.progress.delete(state.key);
            }
            for (const state of active) {
                void this.finalizeProgress(state).catch((error) => {
                    this.ctx.logger.warn('messenger: failed to finalize progress for one binding: %o', error);
                });
            }
        }
    }
    notificationRecipients() {
        return [...this.adapters.keys()].flatMap((transport) => this.notificationStore?.list(transport) ?? [])
            .filter((subscription) => this.authorized(subscription));
    }
    // --- PATCH: duty mode / claim / voice prefs / error ring (2026-09-27) ---
    dutyDestination() {
        if (this.duty === undefined)
            return undefined;
        const adapter = this.adapters.get(this.duty.transport);
        if (adapter === undefined)
            return undefined;
        return { adapter, ...this.duty };
    }
    dutyAuthorized() {
        const duty = this.duty;
        if (duty === undefined)
            return false;
        if (!this.allowedChatIds.has(rawChatId(duty.chatId)) && !this.claimedChatIds.has(rawChatId(duty.chatId)))
            return false;
        if (duty.chatKind === 'private')
            return true;
        const identity = duty.authorizedAs ?? duty.senderId;
        return !this.privateChatsOnly
            && (this.allowedUserIds.has(identity) || this.claimedUserIds.has(identity));
    }
    persistDuty() {
        writeJsonState('duty.json', this.duty ?? null);
    }
    persistClaimed() {
        writeJsonState('claimed-users.json', {
            users: [...this.claimedUserIds],
            chats: [...this.claimedChatIds],
        });
    }
    voicePrefKey(transport, chatId) {
        return `${transport}:${chatId}`;
    }
    voicePrefOn(transport, chatId) {
        return this.voicePrefs.get(this.voicePrefKey(transport, chatId)) !== 'off';
    }
    setVoicePref(transport, chatId, value) {
        const key = this.voicePrefKey(transport, chatId);
        if (value === 'on')
            this.voicePrefs.delete(key);
        else
            this.voicePrefs.set(key, 'off');
        writeJsonState('voice-prefs.json', Object.fromEntries(this.voicePrefs));
    }
    recordError(text) {
        const entry = { at: new Date().toLocaleTimeString('ru-RU'), text: String(text).slice(0, 300) };
        this.recentErrors.push(entry);
        if (this.recentErrors.length > 20)
            this.recentErrors.shift();
    }
    canSendImage(sessionId) {
        return !this.disposed && this.bindingRecipients(sessionId).some(({ transport }) => this.adapters.get(transport)?.sendImage !== undefined);
    }
    /** Process-local binding fence for file exports prepared asynchronously. */
    imageBindingVersion(sessionId) {
        return JSON.stringify(this.bindingRecipients(sessionId).map(({ key }) => [key, this.bindingRevisions.get(key)]).sort());
    }
    /** Explicit export to current session bindings, never notification subscribers. */
    async sendImage(sessionId, image, signal) {
        if (!this.canSendImage(sessionId))
            throw new Error('No image-capable messenger chat is bound to this session.');
        const validated = messengerImage(image.bytes);
        const requestSignal = AbortSignal.any([this.imageController.signal, ...(signal === undefined ? [] : [signal])]);
        const recipients = this.bindingRecipients(sessionId).map((recipient) => ({
            ...recipient, revision: this.bindingRevisions.get(recipient.key),
        }));
        const results = await Promise.all(recipients.map(({ key, transport, chatId, revision }) => this.enqueueOutbound(progressKey(transport, chatId, sessionId), async () => {
            const adapter = this.adapters.get(transport);
            if (requestSignal.aborted || this.disposed || this.bindings.get(key) !== sessionId
                || this.bindingRevisions.get(key) !== revision || adapter?.sendImage === undefined)
                return 'skipped';
            try {
                await adapter.sendImage(chatId, validated, requestSignal);
                return 'sent';
            }
            catch {
                this.ctx.logger.warn('messenger: image delivery failed; not retrying an uncertain send');
                return 'failed';
            }
        })));
        return results.reduce((counts, result) => { counts[result] += 1; return counts; }, { sent: 0, failed: 0, skipped: 0 });
    }
    canNotify(sessionId) {
        return !this.disposed && (this.notificationStore === undefined
            ? this.hasBindings(sessionId) : this.notificationRecipients().length > 0);
    }
    canSendVoice(sessionId) {
        return !this.disposed && this.bindingRecipients(sessionId).some(({ transport, chatId }) => this.adapters.get(transport)?.sendVoice !== undefined
            && this.voicePrefOn(transport, chatId));
    }
    /** Same binding fence as images: voice exports must not survive a rebinding either. */
    async sendVoice(sessionId, audio, signal) {
        if (!this.canSendVoice(sessionId))
            throw new Error('No voice-capable messenger chat is bound to this session.');
        const validated = { bytes: audio.bytes, mimeType: 'audio/ogg' };
        const requestSignal = AbortSignal.any([this.imageController.signal, ...(signal === undefined ? [] : [signal])]);
        const fence = this.imageBindingVersion(sessionId);
        const recipients = this.bindingRecipients(sessionId).map((recipient) => ({
            ...recipient, revision: this.bindingRevisions.get(recipient.key),
        }));
        const results = await Promise.all(recipients.map(({ key, transport, chatId, revision }) => this.enqueueOutbound(progressKey(transport, chatId, sessionId), async () => {
            const adapter = this.adapters.get(transport);
            if (requestSignal.aborted || this.disposed || this.bindings.get(key) !== sessionId
                || this.bindingRevisions.get(key) !== revision || adapter?.sendVoice === undefined
                || !this.voicePrefOn(transport, chatId)
                || this.imageBindingVersion(sessionId) !== fence)
                return 'skipped';
            try {
                await adapter.sendVoice(chatId, validated, requestSignal);
                return 'sent';
            }
            catch {
                this.ctx.logger.warn('messenger: voice delivery failed; not retrying an uncertain send');
                return 'failed';
            }
        })));
        return results.reduce((counts, result) => { counts[result] += 1; return counts; }, { sent: 0, failed: 0, skipped: 0 });
    }
    async handleNotificationsCommand(adapter, message, argument) {
        const store = this.notificationStore;
        if (store === undefined) {
            await adapter.sendText(chatDestination(message), 'Постоянные уведомления недоступны.');
            return;
        }
        let response;
        try {
            switch (argument.toLowerCase()) {
                case 'on':
                    await store.subscribe(message);
                    response = '🔔 Уведомления включены для этого чата. Любая автоматика или top-level сессия хоста может писать сюда статусы, независимо от выбранной сессии. '
                        + 'В группе их увидят все. Подписка переживает рестарт и /unbind. '
                        + 'Отписка: /notifications off.';
                    break;
                case 'off':
                    await store.unsubscribe(adapter.id, message.chatId);
                    response = '🔕 Уведомления выключены. Старые кнопки уведомлений больше не действуют.';
                    break;
                default: {
                    const subscribed = store.get(adapter.id, message.chatId) !== undefined;
                    response = `Уведомления: ${subscribed ? 'on' : 'off'}.\n/notifications on — получать статусы автоматики хоста без выбора сессии.\n/notifications off — отписаться.\nОткрытие сессии из уведомления — всегда по явной кнопке.`;
                }
            }
        }
        catch (error) {
            this.ctx.logger.warn('messenger: notification subscription could not be saved: %o', error);
            await adapter.sendText(chatDestination(message), 'Не удалось сохранить настройки уведомлений. Попробуйте ещё раз.');
            return;
        }
        // A failed acknowledgement must not misreport a successfully persisted subscription.
        await adapter.sendText(chatDestination(message), response);
    }
    async notifySubscribers(sessionId, text, signal) {
        const store = this.notificationStore;
        const recipients = this.notificationRecipients();
        if (recipients.length === 0)
            throw new Error('No notification subscribers. Send /notifications on in an allowed bot chat first.');
        const sends = recipients.map((subscription) => this.enqueueOutbound(bindingDestinationKey(subscription.transport, subscription.chatId), async () => {
            const current = () => !this.disposed && !signal?.aborted
                && store.get(subscription.transport, subscription.chatId)?.id === subscription.id;
            if (!current())
                return false;
            const token = await store.createLink(subscription, sessionId);
            if (!current())
                return false;
            const adapter = this.adapters.get(subscription.transport);
            await adapter.sendText(subscription.chatId, adapter.renderText?.(text) ?? text, {
                keyboard: [[{ text: 'Открыть сессию', callbackData: `n:${token}` }]],
            });
            return true;
        }));
        const results = await Promise.allSettled(sends);
        return {
            sent: results.filter((result) => result.status === 'fulfilled' && result.value).length,
            failed: results.filter((result) => result.status === 'rejected').length,
            skipped: results.filter((result) => result.status === 'fulfilled' && !result.value).length,
        };
    }
    /** Send to durable subscribers; standalone library bridges without a store retain legacy binding delivery. */
    async notify(sessionId, text, signal) {
        if (this.disposed)
            throw new Error('Messenger bridge is disposed.');
        if (!text.trim() || text.length > 16_000) {
            throw new Error('Notification text must contain 1–16000 characters and not be blank.');
        }
        signal?.throwIfAborted();
        if (this.notificationStore !== undefined)
            return this.notifySubscribers(sessionId, text, signal);
        const sends = [];
        for (const { key, transport, chatId } of this.bindingRecipients(sessionId)) {
            const adapter = this.adapters.get(transport);
            if (adapter === undefined)
                continue;
            const revision = this.bindingRevisions.get(key);
            sends.push(this.enqueueOutbound(key, async () => {
                // A queued send must not outlive unbind/rebind, shutdown, or cancellation.
                if (this.disposed || signal?.aborted
                    || this.bindings.get(key) !== sessionId
                    || this.bindingRevisions.get(key) !== revision)
                    return false;
                await adapter.sendText(chatId, adapter.renderText?.(text) ?? text);
                return true;
            }));
        }
        if (sends.length === 0) {
            throw new Error('No messenger chat is bound to this session. Use /resume or /new in the bot first.');
        }
        const results = await Promise.allSettled(sends);
        return {
            sent: results.filter((result) => result.status === 'fulfilled' && result.value).length,
            failed: results.filter((result) => result.status === 'rejected').length,
            skipped: results.filter((result) => result.status === 'fulfilled' && !result.value).length,
        };
    }
    async askQuestion(sessionId, questions, signal) {
        if (this.disposed || questions.length === 0)
            return undefined;
        // Duty mode keeps unbound sessions answerable: their questions render in the
        // operator chat instead of dropping to the web UI (or hanging forever).
        const bound = this.hasBindings(sessionId);
        if (!bound && !this.dutyAuthorized())
            return undefined;
        signal?.throwIfAborted();
        const rpcId = `messenger-${randomUUID()}`;
        let resolveAnswer;
        let rejectAnswer;
        const answerPromise = new Promise((resolve, rejectPromise) => {
            resolveAnswer = resolve;
            rejectAnswer = rejectPromise;
        });
        let submitted = false;
        const submit = async (answer) => {
            if (submitted)
                return false;
            submitted = true;
            resolveAnswer(answer);
            return true;
        };
        const reject = (reason) => {
            if (submitted)
                return;
            submitted = true;
            rejectAnswer(reason);
        };
        const abort = () => {
            // A local answer already won; advanceQuestion owns its settlement.
            if (submitted)
                return;
            reject(signal?.reason ?? new Error('question request aborted'));
            void this.onQuestionResolved(rpcId, signal?.reason instanceof QuestionAnsweredElsewhere ? 'answered' : 'cancelled').catch((error) => {
                this.ctx.logger.warn('messenger: failed to close user question: %o', error);
            });
        };
        signal?.addEventListener('abort', abort, { once: true });
        // Registration is synchronous before the first transport await. Do not
        // block answers/cancellation on a slow Telegram send; cleanup drains it.
        void this.onQuestionRequested(rpcId, sessionId, questions, submit, reject, !bound).catch(reject);
        if (signal?.aborted)
            abort();
        try {
            return await answerPromise;
        }
        finally {
            signal?.removeEventListener('abort', abort);
        }
    }
    async onQuestionRequested(rpcId, sessionId, questions, submit = async () => false, reject = () => undefined, dutyForward = false) {
        if (this.disposed || questions.length === 0)
            return;
        const rpcKey = String(rpcId);
        const request = this.questionRequests.get(rpcKey) ?? {
            rpcId,
            sessionId,
            questions,
            submit,
            reject,
            dutyForward,
        };
        this.questionRequests.set(rpcKey, request);
        const progress = this.progressStates(sessionId);
        for (const state of progress) {
            this.stopTyping(state);
            this.stopAnimation(state);
            if (!state.status.includes('❓ Waiting for your answer')) {
                pushStatus(state, '❓ Waiting for your answer');
            }
        }
        for (const state of progress) {
            void this.flushProgress(state).catch((error) => {
                this.ctx.logger.warn('messenger: failed to pause progress for user question: %o', error);
            });
        }
        await this.promotePendingQuestion(request);
    }
    async promotePendingQuestion(request, inlineKey) {
        const occupiedDestinations = new Set([...this.pendingQuestions.values()]
            .filter((state) => state.sessionId === request.sessionId)
            .map((state) => bindingDestinationKey(state.adapter.id, state.chatId)));
        const starts = [];
        for (const { key, transport, chatId } of this.bindingRecipients(request.sessionId)) {
            const destination = bindingDestinationKey(transport, chatId);
            if (occupiedDestinations.has(destination))
                continue;
            occupiedDestinations.add(destination);
            const start = () => this.startQuestionForBinding(key, request);
            starts.push(key === inlineKey ? start() : this.enqueueAction(key, start));
        }
        // Duty fallback: an unbound session's question renders in the operator chat
        // with the 10-minute auto-decline timer.
        if (starts.length === 0 && request.dutyForward === true) {
            const duty = this.dutyDestination();
            if (duty !== undefined && this.dutyAuthorized()) {
                const dutyKey = bindingKey(duty.transport, duty.chatId, duty.senderId);
                const destination = bindingDestinationKey(duty.transport, duty.chatId);
                if (!occupiedDestinations.has(destination)) {
                    occupiedDestinations.add(destination);
                    const start = () => this.startQuestionForBinding(dutyKey, request, { allowUnbound: true, dutyTimeoutMs: DUTY_TIMEOUT_MS });
                    starts.push(dutyKey === inlineKey ? start() : this.enqueueAction(dutyKey, start));
                }
            }
        }
        const started = await Promise.allSettled(starts);
        for (const result of started) {
            if (result.status === 'rejected') {
                this.ctx.logger.warn('messenger: failed to show user question: %o', result.reason);
            }
        }
    }
    async onQuestionResolved(questionRpcId, outcome = 'answered') {
        const rpcId = String(questionRpcId);
        this.resolvingQuestions.add(rpcId);
        try {
            const keys = [...this.pendingQuestions.values()]
                .filter((state) => String(state.rpcId) === rpcId)
                .map((state) => state.key);
            await Promise.allSettled(keys.map((key) => this.enqueueAction(key, async () => undefined)));
            await this.settleQuestion(rpcId, outcome, outcome === 'answered' ? '✅ Question resolved.' : '⏹ Question cancelled.');
        }
        finally {
            this.resolvingQuestions.delete(rpcId);
        }
    }
    async settleQuestion(rpcId, outcome, resolvedText, inlineKey) {
        const request = this.questionRequests.get(rpcId);
        const resolvedStates = [];
        for (const state of this.pendingQuestions.values()) {
            if (String(state.rpcId) === rpcId)
                resolvedStates.push(state);
        }
        if (request === undefined && resolvedStates.length === 0)
            return false;
        this.questionRequests.delete(rpcId);
        this.clearQuestionRetriesForRpc(rpcId);
        const dutyTimer = this.dutyTimers.get(rpcId);
        if (dutyTimer !== undefined) {
            clearTimeout(dutyTimer);
            this.dutyTimers.delete(rpcId);
        }
        for (const state of resolvedStates) {
            this.clearQuestionCallbacks(state);
            this.pendingQuestions.delete(state.key);
        }
        const sessionId = request?.sessionId ?? resolvedStates[0]?.sessionId;
        const stillPending = sessionId !== undefined && [...this.questionRequests.values()].some((candidate) => candidate.sessionId === sessionId);
        await Promise.allSettled(resolvedStates.map((state) => (state.handle === undefined
            ? Promise.resolve()
            : state.adapter.editText(state.chatId, state.handle.messageId, resolvedText, []))));
        if (sessionId !== undefined) {
            const progress = this.progressStates(sessionId);
            for (const state of progress) {
                const waiting = state.status.lastIndexOf('❓ Waiting for your answer');
                if (!stillPending && waiting >= 0)
                    state.status.splice(waiting, 1);
                if (!stillPending) {
                    pushStatus(state, outcome === 'answered' ? '✅ Answered' : '⏹ Question cancelled');
                    if (!state.turnEnded && outcome === 'answered') {
                        this.startTyping(state);
                        this.startAnimation(state);
                    }
                }
            }
            this.scheduleProgressEdits(progress);
        }
        if (sessionId !== undefined) {
            const next = [...this.questionRequests.values()].find((candidate) => candidate.sessionId === sessionId);
            if (next !== undefined)
                await this.promotePendingQuestion(next, inlineKey);
        }
        // Duty queue: the freed operator chat goes to the next unbound session's question.
        const dutyNext = [...this.questionRequests.values()].find((candidate) => candidate.dutyForward === true
            && String(candidate.rpcId) !== rpcId
            && ![...this.pendingQuestions.values()].some((state) => state.sessionId === candidate.sessionId));
        if (dutyNext !== undefined)
            await this.promotePendingQuestion(dutyNext, inlineKey);
        return true;
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.imageController.abort();
        this.mirroredImageMessages.clear();
        for (const job of this.voiceJobs.values())
            job.controller.abort(new Error('Messenger bridge disposed.'));
        const disposingVoice = this.voice?.dispose();
        for (const request of this.questionRequests.values()) {
            request.reject(new Error('messenger bridge disposed'));
        }
        for (const state of this.progress.values())
            this.stopProgressTimers(state);
        this.progress.clear();
        this.callbacks.clear();
        this.questionRequests.clear();
        this.pendingQuestions.clear();
        for (const retry of this.questionRetries.values())
            clearTimeout(retry.timer);
        this.questionRetries.clear();
        this.questionRetryDelays.clear();
        this.resolvingQuestions.clear();
        for (const buffer of this.albumBuffers.values())
            if (buffer.timer !== undefined)
                clearTimeout(buffer.timer);
        this.albumBuffers.clear();
        for (const timer of this.dutyTimers.values())
            clearTimeout(timer);
        this.dutyTimers.clear();
        await Promise.allSettled([
            disposingVoice,
            ...[...this.voiceJobs.values()].map((job) => job.task),
            ...this.actionQueues.values(),
            ...this.outboundQueues.values(),
        ]);
    }
    authorized(message) {
        // Claimed chats/users extend the configured allowlists at runtime (/claim).
        if (!this.allowedChatIds.has(message.chatId) && !this.claimedChatIds.has(message.chatId))
            return false;
        if (message.chatKind === 'private')
            return true;
        const senderIds = message.senderAliases ?? [message.senderId];
        return !this.privateChatsOnly
            && senderIds.some((id) => this.allowedUserIds.has(id) || this.claimedUserIds.has(id));
    }
    async handleNotificationCallback(adapter, message) {
        const store = this.notificationStore;
        const token = message.data.slice(2);
        const link = store?.link(token);
        const valid = () => link !== undefined && store?.link(token) !== undefined
            && link.transport === adapter.id && link.chatId === message.chatId
            && link.senderId === message.senderId
            && store.get(adapter.id, message.chatId)?.id === link.subscriptionId;
        if (!valid() || link === undefined) {
            await adapter.answerCallback(message.callbackQueryId, 'This notification expired or belongs to another subscriber.', true);
            return;
        }
        try {
            await adapter.answerCallback(message.callbackQueryId);
        }
        catch (error) {
            this.ctx.logger.warn('messenger: failed to acknowledge notification button: %o', error);
        }
        await this.enqueueAction(bindingKey(adapter.id, chatDestination(message), controlSender(message)), async () => {
            if (!valid())
                return;
            try {
                await this.bindSession(adapter, chatDestination(message), message.chatKind, controlSender(message), this.authorizationIdentity(message), link.sessionId, valid);
            }
            catch (error) {
                this.ctx.logger.warn('messenger: could not open notification session: %o', error);
                await adapter.sendText(chatDestination(message), 'Не удалось открыть сессию из уведомления: удалена или подписка изменилась. Выберите другую через /resume.');
            }
        });
    }
    authorizedBinding(record) {
        if (!this.allowedChatIds.has(record.chatId) && !this.claimedChatIds.has(record.chatId))
            return false;
        if (record.chatKind === 'private')
            return true;
        const identity = record.authorizedAs ?? record.senderId;
        return !this.privateChatsOnly
            && (this.allowedUserIds.has(identity) || this.claimedUserIds.has(identity));
    }
    authorizationIdentity(message) {
        if (message.chatKind === 'private')
            return undefined;
        const senderIds = message.senderAliases ?? [message.senderId];
        return senderIds.find((id) => this.allowedUserIds.has(id) || this.claimedUserIds.has(id));
    }
    async handleCallback(adapter, message) {
        if (message.data.startsWith('n:')) {
            await this.handleNotificationCallback(adapter, message);
            return;
        }
        const token = message.data.startsWith('m:') ? message.data.slice(2) : '';
        const record = this.callbacks.get(token);
        if (record === undefined || record.expiresAt < Date.now()) {
            if (record !== undefined)
                this.callbacks.delete(token);
            await adapter.answerCallback(message.callbackQueryId, 'This control expired. Open /menu again.', true);
            return;
        }
        if (record.transport !== adapter.id
            || record.chatId !== chatDestination(message)
            || record.senderId !== controlSender(message)) {
            await adapter.answerCallback(message.callbackQueryId, 'This control belongs to another operator.', true);
            return;
        }
        const key = bindingKey(adapter.id, chatDestination(message), controlSender(message));
        const target = actionSessionId(record.action);
        if (target !== undefined && (this.bindings.get(key) !== target
            || (this.bindingRevisions.get(key) ?? 0) !== record.bindingRevision)) {
            this.callbacks.delete(token);
            await adapter.answerCallback(message.callbackQueryId, 'This control is stale. Open /menu again.', true);
            return;
        }
        this.callbacks.delete(token);
        try {
            await adapter.answerCallback(message.callbackQueryId);
        }
        catch (error) {
            this.ctx.logger.warn('messenger: failed to answer claimed callback: %o', error);
        }
        await this.enqueueAction(key, async () => {
            try {
                await this.runAction(adapter, chatDestination(message), message.chatKind, controlSender(message), this.authorizationIdentity(message), record.action, record.bindingRevision);
            }
            catch (error) {
                await adapter.sendText(chatDestination(message), `Could not complete that action: ${this.errorMessage(error)}`);
            }
        });
    }
    async runAction(adapter, chatId, chatKind, senderId, authorizedAs, action, expectedBindingRevision) {
        const target = actionSessionId(action);
        const key = bindingKey(adapter.id, chatId, senderId);
        if (target !== undefined && (this.bindings.get(key) !== target
            || (this.bindingRevisions.get(key) ?? 0) !== expectedBindingRevision)) {
            throw new Error('This control is stale because the selected session changed.');
        }
        switch (action.kind) {
            case 'voice-cancel': {
                const count = this.cancelVoice(key, action.jobId);
                await adapter.sendText(chatId, count > 0 ? '🎙 Расшифровка голоса отменена.' : 'Эта расшифровка уже завершена.');
                return;
            }
            case 'stt-mode': {
                const mode = STT_MODES.includes(action.mode) ? action.mode : 'local';
                const previousMode = readSttMode();
                if (previousMode !== mode) {
                    // Strict one-model disk policy (user request 2026-10-03):
                    // only the newly selected mode's runtime may stay on disk.
                    // Remove ALL others first (vosk and chrome included) so the
                    // download gets maximum free space; removed runtimes are
                    // re-downloaded on demand when the user switches back. If
                    // the download fails, the mode file stays on the previous
                    // mode and the next voice message re-fetches it.
                    const activeEngine = STT_ENGINE_OF_MODE[mode] ?? 'chrome';
                    enforceOnlyActiveModelSync(activeEngine);
                    if (!sherpaModelPresentSync(activeEngine)) {
                        const info = STT_MODELS[activeEngine];
                        const eta = activeEngine === 'chrome' ? 'это может занять пару минут' : 'это занимает до минуты';
                        await adapter.sendText(chatId, `⬇️ Устанавливаю ${info.label} (${info.downloadNote}), ${eta}…`);
                        try {
                            await ensureModel(activeEngine);
                        }
                        catch (error) {
                            throw new Error(`Не удалось скачать модель ${info.label}: ${String(error?.message ?? error).slice(0, 250)}. Режим остался прежним (${previousMode}); освободите место на диске и повторите.`);
                        }
                    }
                    writeSttMode(mode);
                    if (mode !== 'local' && previousMode === 'local') {
                        // Leaving local Whisper: free its resident worker if any.
                        try {
                            await this.voice?.stopRuntime?.();
                        }
                        catch { /* nothing running is fine */ }
                    }
                }
                const panel = this.buildSttPanel(adapter, chatId, senderId);
                if (action.panelMessageId !== undefined) {
                    try {
                        await adapter.editText(chatId, action.panelMessageId, panel.text, callbackKeyboard(panel.rows));
                        return;
                    }
                    catch { /* edited message deleted → fall back to a fresh panel */ }
                }
                await adapter.sendText(chatId, panel.text, { keyboard: callbackKeyboard(panel.rows) });
                return;
            }
            case 'menu':
                await this.showDashboard(adapter, chatId, senderId);
                return;
            case 'sessions':
                await this.showSessions(adapter, chatId, senderId, action.page);
                return;
            case 'bind':
                await this.bindSession(adapter, chatId, chatKind, senderId, authorizedAs, action.sessionId);
                return;
            case 'new':
                await this.showWorkspaces(adapter, chatId, senderId, 0);
                return;
            case 'workspaces':
                await this.showWorkspaces(adapter, chatId, senderId, action.page);
                return;
            case 'create':
                await this.createSession(adapter, chatId, chatKind, senderId, authorizedAs, action.workspaceId);
                return;
            case 'models':
                await this.showModels(adapter, chatId, senderId, action.sessionId);
                return;
            case 'provider-models':
                await this.showProviderModels(adapter, chatId, senderId, action.sessionId, action.provider, action.page);
                return;
            case 'select-model':
                await this.selectModel(adapter, chatId, senderId, action.sessionId, action.provider, action.model);
                return;
            case 'reasoning':
                await this.showReasoning(adapter, chatId, senderId, action.sessionId);
                return;
            case 'select-reasoning':
                await this.selectReasoning(adapter, chatId, senderId, action.sessionId, action.effort);
                return;
            case 'question-select':
                await this.selectQuestionOption(key, action.questionRpcId, action.questionId, action.label);
                return;
            case 'question-toggle':
                await this.toggleQuestionOption(key, action.questionRpcId, action.questionId, action.label);
                return;
            case 'question-submit':
                await this.submitQuestionSelection(key, action.questionRpcId, action.questionId);
                return;
            case 'permission':
                await this.showPermissions(adapter, chatId, senderId, action.sessionId);
                return;
            case 'select-permission':
                if (action.preset === 'danger-full-access') {
                    await adapter.sendText(chatId, '«Полный доступ» отключает песочницу воркспейса и подтверждения для этой сессии. Включить?', { keyboard: callbackKeyboard([[
                                this.button(adapter.id, chatId, senderId, 'Включить полный доступ', {
                                    kind: 'confirm-permission',
                                    sessionId: action.sessionId,
                                    preset: action.preset,
                                }),
                                this.button(adapter.id, chatId, senderId, 'Отмена', { kind: 'menu' }),
                            ]]) });
                    return;
                }
                await this.setPermission(adapter, chatId, senderId, action.sessionId, action.preset);
                return;
            case 'confirm-permission':
                await this.setPermission(adapter, chatId, senderId, action.sessionId, action.preset);
                return;
            case 'context':
                await this.showContext(adapter, chatId, senderId, action.sessionId);
                return;
            case 'cancel':
                await this.cancel(adapter, chatId, senderId, action.sessionId);
        }
    }
    async handleCommand(adapter, chatId, chatKind, senderId, authorizedAs, command) {
        try {
            switch (command.name) {
                case 'start':
                case 'menu':
                case 'status':
                    await this.showDashboard(adapter, chatId, senderId);
                    return;
                case 'help':
                    await adapter.sendText(chatId, helpText(), {
                        keyboard: this.mainKeyboard(adapter.id, chatId, senderId),
                    });
                    return;
                case 'sessions':
                    await this.showSessions(adapter, chatId, senderId, 0);
                    return;
                case 'resume':
                case 'use':
                    if (command.argument) {
                        await this.bindSession(adapter, chatId, chatKind, senderId, authorizedAs, command.argument);
                    }
                    else {
                        await this.showSessions(adapter, chatId, senderId, 0);
                    }
                    return;
                case 'new':
                    await this.showWorkspaces(adapter, chatId, senderId, 0);
                    return;
                case 'model':
                    await this.showModels(adapter, chatId, senderId);
                    return;
                case 'reasoning':
                    await this.showReasoning(adapter, chatId, senderId);
                    return;
                case 'permission':
                    await this.showPermissions(adapter, chatId, senderId);
                    return;
                case 'context':
                    await this.showContext(adapter, chatId, senderId);
                    return;
                case 'unbind': {
                    const key = bindingKey(adapter.id, chatId, senderId);
                    const previousSessionId = this.bindings.get(key);
                    await this.bindingStore.delete(adapter.id, chatId, senderId);
                    this.bindings.delete(key);
                    this.bindingUpdatedAt.delete(key);
                    const pending = this.pendingQuestions.get(key);
                    if (pending !== undefined)
                        this.clearQuestionCallbacks(pending);
                    this.pendingQuestions.delete(key);
                    this.clearQuestionRetry(key);
                    this.bindingRevisions.set(key, (this.bindingRevisions.get(key) ?? 0) + 1);
                    if (previousSessionId !== undefined) {
                        const request = [...this.questionRequests.values()].find((candidate) => candidate.sessionId === previousSessionId);
                        if (request !== undefined)
                            await this.promotePendingQuestion(request);
                    }
                    await adapter.sendText(chatId, 'Привязка снята.', {
                        keyboard: this.mainKeyboard(adapter.id, chatId, senderId),
                    });
                    return;
                }
                case 'cancel':
                    await this.cancel(adapter, chatId, senderId);
                    return;
                case 'steer': {
                    const sessionId = this.binding(adapter.id, chatId, senderId);
                    if (command.argument.length === 0) {
                        await adapter.sendText(chatId, 'Использование: /steer <текст>');
                        return;
                    }
                    await this.control.prompt(sessionId, command.argument, 'steer');
                    await adapter.sendText(chatId, `Указание передано в ${shortId(sessionId)}.`);
                    return;
                }
                // --- PATCH: files/forums/duty/commands (2026-09-27) ---
                case 'goal': {
                    const sessionId = this.binding(adapter.id, chatId, senderId);
                    const argument = command.argument.trim();
                    const isCreate = argument !== '' && !/^(clear|pause|resume|edit)(\s|$)/i.test(argument);
                    if (isCreate)
                        this.checkGoalLimit(`${chatId}:${senderId}`);
                    const result = await this.platformCommand(sessionId, argument === '' ? '/goal' : `/goal ${argument}`);
                    await adapter.sendText(chatId, `${result.kind === 'success' ? '🎯' : '⚠️'} ${result.text}\n(сессия ${shortId(sessionId)})`);
                    return;
                }
                case 'compact': {
                    const sessionId = this.binding(adapter.id, chatId, senderId);
                    const result = await this.platformCommand(sessionId, '/compact');
                    await adapter.sendText(chatId, `${result.kind === 'success' ? '🗜' : '⚠️'} ${result.text}\n(сессия ${shortId(sessionId)})`);
                    return;
                }
                case 'compact-status':
                case 'compact_status': {
                    const sessionId = this.binding(adapter.id, chatId, senderId);
                    await adapter.sendText(chatId, await this.compactStatusText(sessionId));
                    return;
                }
                case 'away': {
                    this.duty = {
                        transport: adapter.id,
                        chatId,
                        ...(chatKind === undefined ? {} : { chatKind }),
                        senderId,
                        ...(authorizedAs === undefined ? {} : { authorizedAs }),
                        enabledAt: new Date().toISOString(),
                    };
                    this.persistDuty();
                    await adapter.sendText(chatId, [
                        '📵 Режим «на телефоне» включён.',
                        '',
                        'Вопросы и подтверждения сессий БЕЗ привязки к чату будут приходить сюда с кнопками.',
                        'Таймаут — 10 минут, потом автоотклонение. Сессии с привязкой отвечают в своих чатах как обычно.',
                        '',
                        '/back — выключить режим.',
                    ].join('\n'));
                    return;
                }
                case 'back': {
                    if (this.duty === undefined) {
                        await adapter.sendText(chatId, 'Режим «на телефоне» не включён.');
                        return;
                    }
                    this.duty = undefined;
                    this.persistDuty();
                    await adapter.sendText(chatId, '🖥 Режим «на телефоне» выключен: вопросы неподключённых сессий больше не приходят сюда.');
                    return;
                }
                case 'voice': {
                    const argument = command.argument.trim().toLowerCase();
                    if (argument === 'on' || argument === 'вкл' || argument === 'вкл.') {
                        this.setVoicePref(adapter.id, chatId, 'on');
                        await adapter.sendText(chatId, '🔊 Голосовые ответы (TTS) включены для этого чата.');
                        return;
                    }
                    if (argument === 'off' || argument === 'выкл' || argument === 'выкл.') {
                        this.setVoicePref(adapter.id, chatId, 'off');
                        await adapter.sendText(chatId, '🔇 Голосовые ответы (TTS) выключены для этого чата: messenger_send_voice будет его пропускать.');
                        return;
                    }
                    await adapter.sendText(chatId, `Голосовые ответы (TTS): ${this.voicePrefOn(adapter.id, chatId) ? 'вкл' : 'выкл'}.\n/voice on — включить · /voice off — выключить.`);
                    return;
                }
                case 'diag':
                    await this.showDiag(adapter, chatId, senderId);
                    return;
                case 'cd':
                    await this.showCdWorkspaces(adapter, chatId, senderId);
                    return;
                case 'claim':
                    await this.handleClaim(adapter, chatId, chatKind, senderId, command.argument);
                    return;
                default:
                    await adapter.sendText(chatId, `Unknown command /${command.name}. Use /help.`);
            }
        }
        catch (error) {
            this.recordError(`/${command.name}: ${this.errorMessage(error)}`);
            await adapter.sendText(chatId, `Could not complete that action: ${this.errorMessage(error)}`);
        }
    }
    // --- PATCH: platform command passthrough (2026-09-27) ---
    /** Run a registered platform command (e.g. /compact, /goal) through the sanctioned registry. */
    async platformCommand(sessionId, line, timeoutMs = 300_000) {
        const registry = this.ctx.get?.('commands');
        if (registry === undefined || typeof registry.execute !== 'function') {
            throw new Error('Реестр команд недоступен (служба commands не активна).');
        }
        const agent = this.ctx.agents.get(SessionId(sessionId));
        if (agent === undefined) {
            throw new Error(`Сессия ${shortId(sessionId)} сейчас не активна (dormant): команде нужен живой агент. Пришлите в сессию любое сообщение и повторите.`);
        }
        const execution = await registry.execute(agent, line, [], AbortSignal.timeout(timeoutMs));
        if (execution === undefined) {
            throw new Error('Команда не зарегистрирована в реестре (командные плагины хоста неактивны).');
        }
        return execution.result;
    }
    /** Rolling 3-creations-per-hour guard for /goal creates, keyed per destination. */
    checkGoalLimit(limitKey) {
        const now = Date.now();
        const stamps = (this.goalLog.get(limitKey) ?? []).filter((at) => now - at < 3_600_000);
        if (stamps.length >= GOAL_HOURLY_LIMIT) {
            const retryAt = new Date((stamps[0] ?? now) + 3_600_000);
            throw new Error(`Лимит целей: не больше ${GOAL_HOURLY_LIMIT} созданий в час. Следующее создание — после ${retryAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.`);
        }
        stamps.push(now);
        this.goalLog.set(limitKey, stamps);
    }
    async compactStatusText(sessionId) {
        const snapshot = await this.control.snapshot(sessionId);
        const context = snapshot.context;
        const projected = context.projectedTokens ?? context.pressureTokens;
        const window = context.contextWindow;
        const percentage = projected !== undefined && window !== undefined && window > 0
            ? Math.round((projected / window) * 100)
            : undefined;
        const threshold = window !== undefined && window > 0 ? Math.round(window * 0.8) : undefined;
        return [
            `📊 Контекст сессии ${shortId(sessionId)}`,
            '',
            projected === undefined
                ? `Занято: ${compactNumber(projected)} · окно: ${compactNumber(window)} (измерение недоступно)`
                : `Занято: ${compactNumber(projected)} из ${compactNumber(window)}${percentage === undefined ? '' : ` (${percentage}%)`}`,
            threshold === undefined
                ? 'Порог 80% назвать не могу: окно контекста неизвестно.'
                : projected === undefined
                    ? `Порог 80% ≈ ${compactNumber(threshold)} токенов.`
                    : projected >= threshold
                        ? `Порог 80% (≈${compactNumber(threshold)}) достигнут — рекомендую /compact.`
                        : `Порог 80% ≈ ${compactNumber(threshold)}: до него свободно ~${compactNumber(threshold - projected)}.`,
        ].join('\n');
    }
    async showDiag(adapter, chatId, senderId) {
        const uptimeSeconds = Math.floor(process.uptime());
        const uptime = uptimeSeconds >= 3600
            ? `${Math.floor(uptimeSeconds / 3600)} ч ${Math.floor((uptimeSeconds % 3600) / 60)} мин`
            : `${Math.floor(uptimeSeconds / 60)} мин`;
        const registry = this.ctx.get?.('commands');
        const sttMode = readSttMode();
        const sttLabel = sttMode === 'browser' ? 'браузер (Google Web Speech)'
            : sttMode === 'local' ? 'Vosk small-ru'
                : (SHERPA_MODES[sttMode]?.label ?? sttMode);
        const boundSession = this.bindings.get(bindingKey(adapter.id, chatId, senderId));
        const duty = this.duty;
        const lines = [
            '🩺 Диагностика мессенджера',
            '',
            `Бот: @${adapter.botUsername ?? '?'} · время работы процесса: ${uptime}`,
            `Доступ: чатов ${this.allowedChatIds.size + this.claimedChatIds.size} (allowlist ${this.allowedChatIds.size} + claim ${this.claimedChatIds.size}) · пользователей ${this.allowedUserIds.size + this.claimedUserIds.size} · приватные only: ${this.privateChatsOnly ? 'да' : 'нет'}`,
            `Приём файлов: путь-хендл · лимит ${adapter.fileLimitLabel?.() ?? '20 МБ'} · загрузок ${this.activeFileDownloads}/4`,
            `Голосовые ответы (TTS): ${this.voicePrefOn(adapter.id, chatId) ? 'вкл для этого чата' : 'выкл для этого чата'} · /voice on|off`,
            `Расшифровка (STT): ${sttLabel}`,
            `Режим «на телефоне»: ${duty === undefined ? 'выкл' : `вкл → ${duty.chatId}`}`,
            `Реестр команд: ${registry === undefined || typeof registry.execute !== 'function' ? 'недоступен' : 'доступен'} · /compact /goal`,
            `Привязка этого чата: ${boundSession === undefined ? 'нет' : shortId(boundSession)}`,
            `Скачивания: фото ${this.activeImageDownloads}/8 · войсы ${this.voiceJobs.size}/8`,
            '',
            `Последние ошибки (${this.recentErrors.length}/20):`,
            ...(this.recentErrors.length === 0 ? ['• нет'] : this.recentErrors.slice(-5).map((entry) => `• ${entry.at} — ${entry.text}`)),
        ];
        await adapter.sendText(chatId, lines.join('\n'));
    }
    /** /cd: switch the chat to the most recent session of another workspace directory. */
    async showCdWorkspaces(adapter, chatId, senderId) {
        const [workspaces, sessions] = await Promise.all([this.control.listWorkspaces(), this.control.listSessions()]);
        const mostRecentByCwd = new Map();
        for (const session of sessions) {
            if (session.cwd === undefined)
                continue;
            const normalized = session.cwd.replace(/[\\/]+$/, '');
            // list() is activity-ordered, so the first hit is the most recent session.
            if (!mostRecentByCwd.has(normalized))
                mostRecentByCwd.set(normalized, session);
        }
        const rows = [];
        const lines = ['📁 Сменить рабочую папку — перейти на сессию воркспейса', ''];
        let clickable = 0;
        for (const workspace of workspaces) {
            const normalized = workspace.path.replace(/[\\/]+$/, '');
            const target = mostRecentByCwd.get(normalized);
            if (target !== undefined) {
                rows.push([this.button(adapter.id, chatId, senderId, truncateLabel(`📁 ${workspace.title} → ${shortId(String(target.sessionId))}`, 60), { kind: 'bind', sessionId: String(target.sessionId) })]);
                clickable += 1;
            }
            else {
                lines.push(`• ${workspace.title} — сессий нет (создайте через /new)`);
            }
        }
        for (const row of rows)
            lines.push(`• ${row[0].text}`);
        if (clickable === 0)
            lines.push('', 'Активных сессий в воркспейсах нет. /new создаёт сессию в выбранной папке.');
        rows.push([this.button(adapter.id, chatId, senderId, 'Все сессии', { kind: 'sessions', page: 0 })]);
        await adapter.sendText(chatId, lines.join('\n'), { keyboard: callbackKeyboard(rows.slice(0, 21)) });
    }
    async handleClaim(adapter, chatId, chatKind, senderId, argument) {
        if (chatKind !== undefined && chatKind !== 'private') {
            await adapter.sendText(chatId, 'Команда /claim работает только в личном чате с ботом.');
            return;
        }
        if (this.claimCode === '') {
            await adapter.sendText(chatId, 'Режим claim недоступен: задайте код в настройках (Settings → Messengers → telegram → Claim code).');
            return;
        }
        if (argument.trim() !== this.claimCode) {
            this.recordError(`claim: неверный код (пользователь ${senderId})`);
            this.ctx.logger.warn('messenger: rejected claim attempt from user %s', senderId);
            await adapter.sendText(chatId, '❌ Неверный код.');
            return;
        }
        if (this.claimedUserIds.has(senderId) && this.claimedChatIds.has(chatId)) {
            await adapter.sendText(chatId, '✅ Этот чат уже добавлен в список операторов.');
            return;
        }
        this.claimedUserIds.add(senderId);
        this.claimedChatIds.add(chatId);
        this.persistClaimed();
        this.ctx.logger.info('messenger: claim accepted for user %s in chat %s', senderId, chatId);
        await adapter.sendText(chatId, [
            '✅ Доступ выдан: этот чат и ваш пользователь добавлены в список операторов (переживает перезапуски).',
            '',
            'Личный чат уже работает: /new или /sessions для выбора сессии.',
            'Для групп: включите privateChatsOnly=false в настройках мессенджера — тогда claim-права действуют и в группах.',
        ].join('\n'));
    }
    async startQuestionForBinding(key, request, opts = {}) {
        const existing = this.pendingQuestions.get(key);
        if (existing !== undefined)
            return;
        const rpcId = String(request.rpcId);
        if (this.questionRequests.get(rpcId) !== request || this.resolvingQuestions.has(rpcId))
            return;
        const { transport, chatId, senderId } = bindingIdentity(key);
        const adapter = this.adapters.get(transport);
        if (adapter === undefined)
            return;
        // Duty questions ride the operator's binding key without belonging to the
        // operator's bound session; allowUnbound marks that virtual recipient.
        if (!opts.allowUnbound && this.bindings.get(key) !== request.sessionId)
            return;
        const state = {
            ...request,
            key,
            adapter,
            chatId,
            senderId,
            index: 0,
            answers: [],
            selected: new Set(),
            callbackTokens: new Set(),
        };
        try {
            await this.renderQuestion(state);
            this.pendingQuestions.set(key, state);
            this.clearQuestionRetry(key);
            if (opts.dutyTimeoutMs !== undefined)
                this.armDutyTimeout(rpcId, request, opts.dutyTimeoutMs);
        }
        catch (error) {
            this.clearQuestionCallbacks(state);
            if (this.questionRequests.get(rpcId) === request) {
                this.scheduleQuestionRetry(key, request);
            }
            throw error;
        }
    }
    // --- PATCH: duty auto-decline timer (2026-09-27) ---
    armDutyTimeout(rpcId, request, timeoutMs) {
        const timer = setTimeout(() => {
            this.dutyTimers.delete(rpcId);
            const stillPending = this.questionRequests.get(rpcId) === request
                && [...this.pendingQuestions.values()].some((state) => String(state.rpcId) === rpcId);
            if (!stillPending)
                return;
            void this.settleQuestion(rpcId, 'timeout', '⏰ Автоотклонение: 10 минут без ответа.').finally(() => {
                request.reject(new Error('Duty approval timed out after 10 minutes; the turn continues without approval.'));
            });
        }, timeoutMs);
        timer.unref?.();
        this.dutyTimers.set(rpcId, timer);
    }
    clearQuestionRetry(key) {
        const retry = this.questionRetries.get(key);
        if (retry !== undefined)
            clearTimeout(retry.timer);
        this.questionRetries.delete(key);
        this.questionRetryDelays.delete(key);
    }
    scheduleQuestionRetry(key, request) {
        const rpcId = String(request.rpcId);
        const current = this.questionRetries.get(key);
        if (current?.rpcId === rpcId)
            return;
        if (current !== undefined)
            clearTimeout(current.timer);
        const delayMs = this.questionRetryDelays.get(key) ?? 500;
        const timer = setTimeout(() => {
            this.questionRetries.delete(key);
            const { transport, chatId } = bindingIdentity(key);
            const destination = bindingDestinationKey(transport, chatId);
            const destinationOccupied = [...this.pendingQuestions.values()].some((state) => state.sessionId === request.sessionId
                && bindingDestinationKey(state.adapter.id, state.chatId) === destination);
            const stillSelected = this.bindingRecipients(request.sessionId).some((recipient) => recipient.key === key);
            if (this.disposed
                || this.questionRequests.get(rpcId) !== request
                || destinationOccupied
                || !stillSelected
                || this.bindings.get(key) !== request.sessionId) {
                this.questionRetryDelays.delete(key);
                return;
            }
            void this.enqueueAction(key, () => this.startQuestionForBinding(key, request))
                .catch((error) => {
                this.ctx.logger.warn('messenger: question retry failed: %o', error);
            });
        }, delayMs);
        timer.unref?.();
        this.questionRetries.set(key, { rpcId, timer, delayMs });
        this.questionRetryDelays.set(key, Math.min(delayMs * 2, 5_000));
    }
    clearQuestionRetriesForRpc(rpcId) {
        for (const [key, retry] of this.questionRetries) {
            if (retry.rpcId !== rpcId)
                continue;
            clearTimeout(retry.timer);
            this.questionRetries.delete(key);
            this.questionRetryDelays.delete(key);
        }
    }
    async renderQuestion(state) {
        const rpcId = String(state.rpcId);
        if (this.resolvingQuestions.has(rpcId) || this.questionRequests.get(rpcId)?.rpcId !== state.rpcId) {
            throw new Error('This question is no longer active.');
        }
        const question = state.questions[state.index];
        if (question === undefined)
            return;
        const options = question.options ?? [];
        const heading = question.header?.trim() || `Question ${state.index + 1}/${state.questions.length}`;
        const instructions = options.length === 0
            ? 'Reply with your answer.'
            : question.multiSelect === true
                ? 'Select any number of options, then submit. You can also reply with custom text.'
                : 'Choose one option, or reply with custom text.';
        const optionDetails = options
            .filter((option) => option.description?.trim())
            .map((option) => `• ${option.label} — ${option.description.trim()}`);
        const dutyNote = state.dutyForward === true
            ? `❗ Сессия ${shortId(String(state.sessionId))} — без привязки к чату (режим «на телефоне»)`
            : undefined;
        const text = [
            `❓ ${heading}`,
            ...(dutyNote === undefined ? [] : [dutyNote]),
            '',
            question.question,
            ...(question.detail?.trim() ? ['', question.detail.trim()] : []),
            ...(optionDetails.length === 0 ? [] : ['', ...optionDetails]),
            '',
            instructions,
        ].join('\n');
        const nextTokens = new Set();
        const questionButton = (buttonText, action) => {
            const button = this.button(state.adapter.id, state.chatId, state.senderId, buttonText, action, QUESTION_CALLBACK_TTL_MS);
            nextTokens.add(button.callbackData.slice(2));
            return button;
        };
        const rows = options.map((option) => [questionButton(`${state.selected.has(option.label) ? '✓ ' : ''}${truncateLabel(option.label, 52)}`, question.multiSelect === true
                ? {
                    kind: 'question-toggle',
                    sessionId: state.sessionId,
                    questionRpcId: String(state.rpcId),
                    questionId: question.id,
                    label: option.label,
                }
                : {
                    kind: 'question-select',
                    sessionId: state.sessionId,
                    questionRpcId: String(state.rpcId),
                    questionId: question.id,
                    label: option.label,
                })]);
        if (question.multiSelect === true)
            rows.push([questionButton(state.selected.size === 0 ? 'Submit without selection' : `Submit · ${state.selected.size} selected`, {
                    kind: 'question-submit',
                    sessionId: state.sessionId,
                    questionRpcId: String(state.rpcId),
                    questionId: question.id,
                })]);
        rows.push([questionButton('Отменить ход', { kind: 'cancel', sessionId: state.sessionId })]);
        const keyboard = callbackKeyboard(rows);
        const renderedText = state.adapter.renderText?.(text) ?? text;
        const editLimit = state.adapter.textLimit ?? DEFAULT_PROGRESS_LIMIT;
        const renderedLength = state.adapter.textLength?.(renderedText)
            ?? Array.from(renderedText).length;
        try {
            if (state.handle === undefined || renderedLength > editLimit) {
                state.handle = await state.adapter.sendText(state.chatId, renderedText, { keyboard });
            }
            else {
                await state.adapter.editText(state.chatId, state.handle.messageId, renderedText, keyboard);
            }
        }
        catch (error) {
            for (const token of nextTokens)
                this.callbacks.delete(token);
            throw error;
        }
        if (this.resolvingQuestions.has(rpcId) || this.questionRequests.get(rpcId)?.rpcId !== state.rpcId) {
            for (const token of nextTokens)
                this.callbacks.delete(token);
            // Resolution can win while the initial send is still in flight, before
            // this state is visible to settleQuestion. Retire that late keyboard too.
            if (state.handle !== undefined) {
                await state.adapter.editText(state.chatId, state.handle.messageId, '✅ Question closed.', []);
            }
            throw new Error('This question is no longer active.');
        }
        for (const token of state.callbackTokens)
            this.callbacks.delete(token);
        state.callbackTokens.clear();
        for (const token of nextTokens)
            state.callbackTokens.add(token);
    }
    clearQuestionCallbacks(state) {
        for (const token of state.callbackTokens)
            this.callbacks.delete(token);
        state.callbackTokens.clear();
    }
    currentQuestion(key, questionRpcId, questionId) {
        const state = this.pendingQuestions.get(key);
        const question = state?.questions[state.index];
        if (state === undefined
            || this.resolvingQuestions.has(questionRpcId)
            || String(state.rpcId) !== questionRpcId
            || question === undefined
            || question.id !== questionId) {
            throw new Error('This question is no longer active.');
        }
        return { state, question };
    }
    async selectQuestionOption(key, questionRpcId, questionId, label) {
        const { state, question } = this.currentQuestion(key, questionRpcId, questionId);
        if (question.multiSelect === true || !(question.options ?? []).some((option) => option.label === label)) {
            throw new Error('This option is no longer available.');
        }
        await this.advanceQuestion(state, { id: question.id, selected: [label] });
    }
    async toggleQuestionOption(key, questionRpcId, questionId, label) {
        const { state, question } = this.currentQuestion(key, questionRpcId, questionId);
        if (question.multiSelect !== true || !(question.options ?? []).some((option) => option.label === label)) {
            throw new Error('This option is no longer available.');
        }
        const wasSelected = state.selected.has(label);
        if (wasSelected)
            state.selected.delete(label);
        else
            state.selected.add(label);
        try {
            await this.renderQuestion(state);
        }
        catch (error) {
            if (wasSelected)
                state.selected.add(label);
            else
                state.selected.delete(label);
            throw error;
        }
    }
    async submitQuestionSelection(key, questionRpcId, questionId) {
        const { state, question } = this.currentQuestion(key, questionRpcId, questionId);
        if (question.multiSelect !== true)
            throw new Error('This question is not multi-select.');
        await this.advanceQuestion(state, { id: question.id, selected: [...state.selected] });
    }
    async answerQuestionWithText(state, text) {
        if (this.resolvingQuestions.has(String(state.rpcId))) {
            await state.adapter.sendText(state.chatId, 'Этот вопрос уже закрыт.');
            return;
        }
        const custom = text.trim();
        const question = state.questions[state.index];
        if (question === undefined)
            return;
        if (custom.length === 0) {
            await state.adapter.sendText(state.chatId, 'Ответ не может быть пустым.');
            return;
        }
        await this.advanceQuestion(state, {
            id: question.id,
            selected: question.multiSelect === true ? [...state.selected] : [],
            custom,
        });
    }
    async advanceQuestion(state, answer) {
        const answers = [...state.answers, answer];
        if (state.index + 1 < state.questions.length) {
            const previousIndex = state.index;
            const previousSelected = [...state.selected];
            state.answers.push(answer);
            state.index += 1;
            state.selected.clear();
            try {
                await this.renderQuestion(state);
            }
            catch (error) {
                state.answers.pop();
                state.index = previousIndex;
                state.selected.clear();
                for (const label of previousSelected)
                    state.selected.add(label);
                throw error;
            }
            return;
        }
        let accepted;
        try {
            accepted = await state.submit({ answers });
        }
        catch (error) {
            await this.renderQuestion(state);
            throw error;
        }
        const settled = await this.settleQuestion(String(state.rpcId), 'answered', accepted ? '✅ Ответ отправлен.' : '✅ Ответ дан в другом месте.', state.key);
        if (!settled && state.handle !== undefined) {
            await state.adapter.editText(state.chatId, state.handle.messageId, accepted ? '✅ Ответ отправлен.' : '✅ Ответ дан в другом месте.', []);
        }
    }
    async showSessions(adapter, chatId, senderId, requestedPage) {
        const sessions = await this.control.listSessions();
        if (sessions.length === 0) {
            await adapter.sendText(chatId, 'Сессий пока нет. Создайте первую.', {
                keyboard: callbackKeyboard([[
                        this.button(adapter.id, chatId, senderId, 'Новая сессия', { kind: 'new' }),
                    ]]),
            });
            return;
        }
        const pages = Math.ceil(sessions.length / SESSION_PAGE_SIZE);
        const page = Math.max(0, Math.min(requestedPage, pages - 1));
        const selected = this.bindings.get(bindingKey(adapter.id, chatId, senderId));
        const rows = sessions
            .slice(page * SESSION_PAGE_SIZE, (page + 1) * SESSION_PAGE_SIZE)
            .map((session) => [this.button(adapter.id, chatId, senderId, `${String(session.sessionId) === selected ? '✓' : session.running ? '🟢' : '⚪'} ${sessionTitle(session).slice(0, 52)}`, { kind: 'bind', sessionId: String(session.sessionId) })]);
        const navigation = [];
        if (page > 0)
            navigation.push(this.button(adapter.id, chatId, senderId, '‹ Пред.', { kind: 'sessions', page: page - 1 }));
        if (page + 1 < pages)
            navigation.push(this.button(adapter.id, chatId, senderId, 'След. ›', { kind: 'sessions', page: page + 1 }));
        if (navigation.length > 0)
            rows.push(navigation);
        rows.push([
            this.button(adapter.id, chatId, senderId, 'Новая сессия', { kind: 'new' }),
            this.button(adapter.id, chatId, senderId, 'Меню', { kind: 'menu' }),
        ]);
        await adapter.sendText(chatId, `Выбор сессии · страница ${page + 1}/${pages}`, {
            keyboard: callbackKeyboard(rows),
        });
    }
    async bindSession(adapter, chatId, chatKind, senderId, authorizedAs, sessionId, stillValid = () => true) {
        const sessions = await this.control.listSessions();
        const summary = sessions.find((session) => String(session.sessionId) === sessionId);
        if (summary === undefined)
            throw new Error(`Сессия ${sessionId} не найдена.`);
        // Reading the model directory uses the canonical resume path for dormant sessions.
        await this.control.models(sessionId);
        if (this.disposed || !stillValid())
            throw new Error('Управление этой сессией больше не действует.');
        const key = bindingKey(adapter.id, chatId, senderId);
        const previousSessionId = this.bindings.get(key);
        const previousRecord = this.bindingStore.list().find((record) => record.transport === adapter.id && record.chatId === chatId && record.senderId === senderId);
        const updatedAt = new Date().toISOString();
        await this.bindingStore.put({
            transport: adapter.id,
            chatId,
            ...(chatKind === undefined ? {} : { chatKind }),
            senderId,
            ...(authorizedAs === undefined ? {} : { authorizedAs }),
            sessionId,
            ...(summary.cwd === undefined ? {} : { sessionCwd: summary.cwd }),
            updatedAt,
        });
        if (!stillValid()) {
            if (previousRecord !== undefined)
                await this.bindingStore.put(previousRecord);
            else
                await this.bindingStore.delete(adapter.id, chatId, senderId);
            throw new Error('Управление этой сессией больше не действует.');
        }
        // An accepted write remains durable across shutdown; do not restart UI work.
        if (this.disposed)
            return;
        const previousQuestion = this.pendingQuestions.get(key);
        if (previousQuestion !== undefined)
            this.clearQuestionCallbacks(previousQuestion);
        this.pendingQuestions.delete(key);
        this.clearQuestionRetry(key);
        this.bindings.set(key, sessionId);
        this.bindingUpdatedAt.set(key, updatedAt);
        this.bindingRevisions.set(key, (this.bindingRevisions.get(key) ?? 0) + 1);
        if (previousSessionId !== undefined && previousSessionId !== sessionId) {
            const previousRequest = [...this.questionRequests.values()].find((request) => request.sessionId === previousSessionId);
            if (previousRequest !== undefined) {
                await this.promotePendingQuestion(previousRequest);
            }
        }
        await this.showDashboard(adapter, chatId, senderId);
        const pending = [...this.questionRequests.values()].find((request) => request.sessionId === sessionId);
        if (pending !== undefined)
            await this.promotePendingQuestion(pending, key);
    }
    async showWorkspaces(adapter, chatId, senderId, requestedPage) {
        const workspaces = await this.control.listWorkspaces();
        const pages = Math.max(1, Math.ceil(workspaces.length / WORKSPACE_PAGE_SIZE));
        const page = Math.max(0, Math.min(requestedPage, pages - 1));
        const rows = workspaces
            .slice(page * WORKSPACE_PAGE_SIZE, (page + 1) * WORKSPACE_PAGE_SIZE)
            .map((workspace) => [this.button(adapter.id, chatId, senderId, truncateLabel(`🗂 ${workspace.title} · ${workspace.path}`, 60), { kind: 'create', workspaceId: workspace.workspaceId })]);
        const navigation = [];
        if (page > 0)
            navigation.push(this.button(adapter.id, chatId, senderId, '‹ Пред.', { kind: 'workspaces', page: page - 1 }));
        if (page + 1 < pages)
            navigation.push(this.button(adapter.id, chatId, senderId, 'След. ›', { kind: 'workspaces', page: page + 1 }));
        if (navigation.length > 0)
            rows.push(navigation);
        rows.push([this.button(adapter.id, chatId, senderId, 'Каталог хоста по умолчанию', { kind: 'create' })]);
        rows.push([this.button(adapter.id, chatId, senderId, 'Отмена', { kind: 'menu' })]);
        await adapter.sendText(chatId, workspaces.length === 0
            ? 'Зарегистрированных воркспейсов нет. Создать сессию в каталоге хоста по умолчанию?'
            : `Выбор воркспейса для новой сессии · страница ${page + 1}/${pages}`, { keyboard: callbackKeyboard(rows) });
    }
    async createSession(adapter, chatId, chatKind, senderId, authorizedAs, workspaceId) {
        await adapter.sendTyping(chatId);
        const sessionId = await this.control.createSession(workspaceId);
        const key = bindingKey(adapter.id, chatId, senderId);
        const previousSessionId = this.bindings.get(key);
        const updatedAt = new Date().toISOString();
        try {
            const summary = (await this.control.listSessions()).find((session) => String(session.sessionId) === sessionId);
            await this.bindingStore.put({
                transport: adapter.id,
                chatId,
                ...(chatKind === undefined ? {} : { chatKind }),
                senderId,
                ...(authorizedAs === undefined ? {} : { authorizedAs }),
                sessionId,
                ...(summary?.cwd === undefined ? {} : { sessionCwd: summary.cwd }),
                updatedAt,
            });
        }
        catch (error) {
            throw new Error(`Сессия ${shortId(sessionId)} создана, но привязку сохранеть не удалось. Откройте /sessions и привяжите её, затем повторите /new.`, { cause: error });
        }
        const previousQuestion = this.pendingQuestions.get(key);
        if (previousQuestion !== undefined)
            this.clearQuestionCallbacks(previousQuestion);
        this.pendingQuestions.delete(key);
        this.clearQuestionRetry(key);
        this.bindings.set(key, sessionId);
        this.bindingUpdatedAt.set(key, updatedAt);
        this.bindingRevisions.set(key, (this.bindingRevisions.get(key) ?? 0) + 1);
        if (previousSessionId !== undefined && previousSessionId !== sessionId) {
            const previousRequest = [...this.questionRequests.values()].find((request) => request.sessionId === previousSessionId);
            if (previousRequest !== undefined) {
                await this.promotePendingQuestion(previousRequest);
            }
        }
        await adapter.sendText(chatId, `Создана сессия ${shortId(sessionId)}.`);
        await this.showDashboard(adapter, chatId, senderId);
        const pending = [...this.questionRequests.values()].find((request) => request.sessionId === sessionId);
        if (pending !== undefined)
            await this.promotePendingQuestion(pending, key);
    }
    async showDashboard(adapter, chatId, senderId) {
        const sessionId = this.bindings.get(bindingKey(adapter.id, chatId, senderId));
        if (sessionId === undefined) {
            await adapter.sendText(chatId, 'DeepSeek Harness\n\nСессия не выбрана. Вернитесь к существующей или создайте новую.', { keyboard: this.mainKeyboard(adapter.id, chatId, senderId) });
            return;
        }
        const snapshot = await this.control.snapshot(sessionId);
        const state = this.control.status(sessionId);
        const selection = snapshot.model.current;
        const workspaceTitle = await this.control.workspaceTitle(snapshot.summary.cwd);
        const text = [
            sessionTitle(snapshot.summary),
            '',
            [
                stateTag(state),
                permissionTag(snapshot.permission.current),
                `🧠 ${contextLabel(snapshot.context.projectedTokens ?? snapshot.context.pressureTokens, snapshot.context.contextWindow)}`,
            ].join('  •  '),
            `${selection.provider}/${selection.model}  •  ${selection.reasoningEffort ?? 'по умолчанию'}`,
            ...(workspaceTitle === undefined ? [] : [`📁 ${workspaceTitle}`]),
        ].join('\n');
        const rows = [
            [
                this.button(adapter.id, chatId, senderId, 'Сессии', { kind: 'sessions', page: 0 }),
                this.button(adapter.id, chatId, senderId, 'Новая', { kind: 'new' }),
            ],
            [
                this.button(adapter.id, chatId, senderId, 'Модель', { kind: 'models', sessionId }),
                this.button(adapter.id, chatId, senderId, 'Рассуждения', { kind: 'reasoning', sessionId }),
            ],
            [
                this.button(adapter.id, chatId, senderId, 'Права', { kind: 'permission', sessionId }),
                this.button(adapter.id, chatId, senderId, 'Контекст', { kind: 'context', sessionId }),
            ],
        ];
        if (state === 'running')
            rows.push([
                this.button(adapter.id, chatId, senderId, 'Отменить ход', { kind: 'cancel', sessionId }),
            ]);
        await adapter.sendText(chatId, text, { keyboard: callbackKeyboard(rows) });
    }
    async showModels(adapter, chatId, senderId, sessionId = this.binding(adapter.id, chatId, senderId)) {
        const directory = await this.control.models(sessionId);
        const rows = directory.groups.map((group) => [this.button(adapter.id, chatId, senderId, `${directory.current.provider === group.id ? '✓ ' : ''}${truncateLabel(group.name, 44)} · ${group.models.length}`, { kind: 'provider-models', sessionId, provider: group.id, page: 0 })]);
        rows.push([this.button(adapter.id, chatId, senderId, 'Назад', { kind: 'menu' })]);
        await adapter.sendText(chatId, [
            'Выберите провайдера',
            '',
            `Текущая  ${directory.current.provider}/${directory.current.model}`,
        ].join('\n'), { keyboard: callbackKeyboard(rows) });
    }
    async showProviderModels(adapter, chatId, senderId, sessionId, provider, requestedPage) {
        const directory = await this.control.models(sessionId);
        const group = directory.groups.find((candidate) => candidate.id === provider);
        if (group === undefined)
            throw new Error(`Провайдер ${provider} больше недоступен.`);
        const pages = Math.max(1, Math.ceil(group.models.length / MODEL_PAGE_SIZE));
        const page = Math.max(0, Math.min(requestedPage, pages - 1));
        const rows = group.models
            .slice(page * MODEL_PAGE_SIZE, (page + 1) * MODEL_PAGE_SIZE)
            .map((model) => [this.button(adapter.id, chatId, senderId, `${directory.current.provider === group.id && directory.current.model === model.id ? '✓ ' : ''}${truncateLabel(model.name, 50)}`, { kind: 'select-model', sessionId, provider: group.id, model: model.id })]);
        const navigation = [];
        if (page > 0)
            navigation.push(this.button(adapter.id, chatId, senderId, '‹ Пред.', { kind: 'provider-models', sessionId, provider, page: page - 1 }));
        if (page + 1 < pages)
            navigation.push(this.button(adapter.id, chatId, senderId, 'След. ›', { kind: 'provider-models', sessionId, provider, page: page + 1 }));
        if (navigation.length > 0)
            rows.push(navigation);
        rows.push([
            this.button(adapter.id, chatId, senderId, 'Провайдеры', { kind: 'models', sessionId }),
            this.button(adapter.id, chatId, senderId, 'Меню', { kind: 'menu' }),
        ]);
        await adapter.sendText(chatId, `${group.name} · модели · ${page + 1}/${pages}`, { keyboard: callbackKeyboard(rows) });
    }
    async selectModel(adapter, chatId, senderId, sessionId, provider, model) {
        const selected = await this.control.selectModel(sessionId, provider, model);
        await adapter.sendText(chatId, `Модель: ${selected.provider}/${selected.model}.`);
        await this.showReasoning(adapter, chatId, senderId, sessionId);
    }
    async showReasoning(adapter, chatId, senderId, sessionId = this.binding(adapter.id, chatId, senderId)) {
        const directory = await this.control.models(sessionId);
        const group = directory.groups.find((candidate) => candidate.id === directory.current.provider);
        const model = group?.models.find((candidate) => candidate.id === directory.current.model);
        const efforts = model?.reasoning?.efforts ?? [];
        const modelIndex = group?.models.findIndex((candidate) => candidate.id === directory.current.model) ?? -1;
        const modelPage = modelIndex < 0 ? 0 : Math.floor(modelIndex / MODEL_PAGE_SIZE);
        const back = group === undefined
            ? { kind: 'models', sessionId }
            : { kind: 'provider-models', sessionId, provider: group.id, page: modelPage };
        if (efforts.length === 0) {
            await adapter.sendText(chatId, [
                `${directory.current.provider}/${directory.current.model}`,
                '',
                'У этой модели режим рассуждений провайдера по умолчанию.',
            ].join('\n'), {
                keyboard: callbackKeyboard([[
                        this.button(adapter.id, chatId, senderId, 'Модели', back),
                        this.button(adapter.id, chatId, senderId, 'Меню', { kind: 'menu' }),
                    ]]),
            });
            return;
        }
        const buttons = [this.button(adapter.id, chatId, senderId, `${directory.current.reasoningEffort === undefined ? '✓ ' : ''}По умолчанию`, { kind: 'select-reasoning', sessionId }), ...efforts.map((effort) => this.button(adapter.id, chatId, senderId, `${directory.current.reasoningEffort === effort.id ? '✓ ' : ''}${truncateLabel(effort.name, 26)}`, { kind: 'select-reasoning', sessionId, effort: effort.id }))];
        const rows = [];
        for (let index = 0; index < buttons.length; index += 2) {
            rows.push(buttons.slice(index, index + 2));
        }
        rows.push([
            this.button(adapter.id, chatId, senderId, 'Модели', back),
            this.button(adapter.id, chatId, senderId, 'Меню', { kind: 'menu' }),
        ]);
        await adapter.sendText(chatId, [
            'Рассуждения',
            `${directory.current.provider}/${directory.current.model}`,
            '',
            `Текущий  •  ${directory.current.reasoningEffort ?? 'по умолчанию'}`,
        ].join('\n'), { keyboard: callbackKeyboard(rows) });
    }
    async selectReasoning(adapter, chatId, senderId, sessionId, effort) {
        const directory = await this.control.models(sessionId);
        const selected = await this.control.selectModel(sessionId, directory.current.provider, directory.current.model, effort);
        await adapter.sendText(chatId, `Режим рассуждений: ${selected.reasoningEffort ?? 'режим провайдера'}.`);
        await this.showDashboard(adapter, chatId, senderId);
    }
    async showPermissions(adapter, chatId, senderId, sessionId = this.binding(adapter.id, chatId, senderId)) {
        const permission = await this.control.permission(sessionId);
        const rows = permission.options.map((option) => [this.button(adapter.id, chatId, senderId, `${permission.current === option.value ? '✓ ' : ''}${option.name}`, { kind: 'select-permission', sessionId, preset: option.value })]);
        rows.push([this.button(adapter.id, chatId, senderId, 'Назад', { kind: 'menu' })]);
        await adapter.sendText(chatId, `Пресет прав: ${permission.current}`, {
            keyboard: callbackKeyboard(rows),
        });
    }
    async setPermission(adapter, chatId, senderId, sessionId, preset) {
        await this.control.setPermission(sessionId, preset);
        await adapter.sendText(chatId, `Пресет прав установлен: ${preset}.`);
        await this.showDashboard(adapter, chatId, senderId);
    }
    async showContext(adapter, chatId, senderId, sessionId = this.binding(adapter.id, chatId, senderId)) {
        const snapshot = await this.control.snapshot(sessionId);
        const context = snapshot.context;
        await adapter.sendText(chatId, [
            `Контекст · ${sessionTitle(snapshot.summary)}`,
            `Прогноз следующего промпта: ${compactNumber(context.projectedTokens)} токенов`,
            `Последний замер провайдера: ${compactNumber(context.pressureTokens)} токенов`,
            `Окно контекста: ${compactNumber(context.contextWindow)} токенов`,
            '',
            'Примерный состав',
            `Система: ${compactNumber(context.systemTokens)}`,
            `Инструменты: ${compactNumber(context.toolsTokens)}`,
            `Сообщения: ${compactNumber(context.messageTokens)}`,
            '',
            'Суммарный расход у провайдера',
            `Ввод без кэша: ${compactNumber(context.uncachedInputTokens)}`,
            `Чтение/запись кэша: ${compactNumber(context.cacheReadTokens)}/${compactNumber(context.cacheWriteTokens)}`,
            `Вывод: ${compactNumber(context.outputTokens)}`,
        ].join('\n'), {
            keyboard: callbackKeyboard([[
                    this.button(adapter.id, chatId, senderId, 'Обновить', { kind: 'context', sessionId }),
                    this.button(adapter.id, chatId, senderId, 'Новая сессия', { kind: 'new' }),
                ], [this.button(adapter.id, chatId, senderId, 'Назад', { kind: 'menu' })]]),
        });
    }
    async cancel(adapter, chatId, senderId, sessionId = this.binding(adapter.id, chatId, senderId)) {
        const cancelled = await this.control.cancel(sessionId);
        await adapter.sendText(chatId, cancelled ? `Запрошена отмена для ${shortId(sessionId)}.` : 'Нет активного хода для отмены.', { keyboard: this.mainKeyboard(adapter.id, chatId, senderId) });
    }
    mainKeyboard(transport, chatId, senderId) {
        return callbackKeyboard([[
                this.button(transport, chatId, senderId, 'Сессии', { kind: 'sessions', page: 0 }),
                this.button(transport, chatId, senderId, 'Новая сессия', { kind: 'new' }),
            ]]);
    }
    button(transport, chatId, senderId, text, action, ttlMs = CALLBACK_TTL_MS) {
        this.pruneCallbacks();
        const token = randomUUID().replaceAll('-', '');
        this.callbacks.set(token, {
            transport,
            chatId,
            senderId,
            bindingRevision: this.bindingRevisions.get(bindingKey(transport, chatId, senderId)) ?? 0,
            expiresAt: Date.now() + ttlMs,
            action,
        });
        return { text, callbackData: `m:${token}` };
    }
    pruneCallbacks() {
        const now = Date.now();
        for (const [token, record] of this.callbacks) {
            if (record.expiresAt < now)
                this.callbacks.delete(token);
        }
    }
    binding(transport, chatId, senderId) {
        const sessionId = this.bindings.get(bindingKey(transport, chatId, senderId));
        if (sessionId === undefined)
            throw new Error('No session selected. Use /resume or /new.');
        return sessionId;
    }
    bindingRecipients(sessionId) {
        const destinations = new Map();
        for (const [key, boundSessionId] of this.bindings) {
            if (boundSessionId !== sessionId)
                continue;
            const identity = bindingIdentity(key);
            const destination = bindingDestinationKey(identity.transport, identity.chatId);
            const candidate = {
                key,
                ...identity,
                updatedAt: this.bindingUpdatedAt.get(key) ?? '',
            };
            const current = destinations.get(destination);
            if (current === undefined
                || current.updatedAt < candidate.updatedAt
                || (current.updatedAt === candidate.updatedAt && current.key < candidate.key))
                destinations.set(destination, candidate);
        }
        return [...destinations.values()];
    }
    async beginProgress(adapter, chatId, senderId, sessionId) {
        const key = progressKey(adapter.id, chatId, sessionId);
        const previous = this.progress.get(key);
        if (previous !== undefined) {
            await previous.ready;
            return previous;
        }
        const thinkingOffset = this.nextThinkingOffset;
        this.nextThinkingOffset = (this.nextThinkingOffset + 1) % THINKING_LABELS.length;
        const state = {
            key,
            adapter,
            chatId,
            sessionId,
            startedAt: Date.now(),
            ready: Promise.resolve(),
            text: '',
            imageCount: 0,
            status: [],
            tools: new Map(),
            toolOrder: [],
            phase: 'thinking',
            thinkingOffset,
            animationFrame: 0,
            animationTimer: undefined,
            editTimer: undefined,
            typingTimer: undefined,
            flushInFlight: false,
            flushRequested: false,
            lastEditAt: Date.now(),
            turnEnded: false,
            finalizing: false,
        };
        this.progress.set(key, state);
        const waitingForAnswer = [...this.questionRequests.values()].some((request) => request.sessionId === sessionId);
        if (waitingForAnswer)
            pushStatus(state, '❓ Waiting for your answer');
        else {
            this.startTyping(state);
            this.startAnimation(state);
        }
        const initialText = progressText(state);
        state.lastRendered = initialText;
        state.ready = adapter.sendText(chatId, initialText, {
            keyboard: callbackKeyboard([[
                    this.button(adapter.id, chatId, senderId, 'Отмена', { kind: 'cancel', sessionId }),
                ]]),
        }).then((handle) => {
            state.handle = handle;
            state.lastEditAt = Date.now();
            if (progressText(state) !== state.lastRendered)
                this.scheduleProgressEdits([state]);
        });
        try {
            await state.ready;
            return state;
        }
        catch (error) {
            this.stopProgressTimers(state);
            if (this.progress.get(key) === state)
                this.progress.delete(key);
            throw error;
        }
    }
    beginProgressForBindings(sessionId) {
        for (const { key, transport, chatId, senderId } of this.bindingRecipients(sessionId)) {
            const adapter = this.adapters.get(transport);
            if (adapter === undefined)
                continue;
            void this.beginProgress(adapter, chatId, senderId, sessionId)
                .catch((error) => {
                this.ctx.logger.warn('messenger: failed to start progress for one binding: %o', error);
            });
        }
    }
    progressStates(sessionId) {
        return [...this.progress.values()].filter((state) => state.sessionId === sessionId);
    }
    hasBindings(sessionId) {
        return [...this.bindings.values()].includes(sessionId);
    }
    scheduleProgressEdits(states, delayMs = PROGRESS_EDIT_INTERVAL_MS) {
        for (const state of states) {
            if (state.finalizing || state.handle === undefined || state.editTimer !== undefined)
                continue;
            state.editTimer = setTimeout(() => {
                state.editTimer = undefined;
                void this.flushProgress(state).catch((error) => this.logProgressError(error));
            }, delayMs);
            state.editTimer.unref?.();
        }
    }
    async flushProgress(state) {
        if (state.finalizing)
            return;
        if (state.flushInFlight) {
            state.flushRequested = true;
            return;
        }
        state.flushInFlight = true;
        try {
            do {
                state.flushRequested = false;
                await state.ready;
                if (state.handle === undefined || state.finalizing)
                    return;
                const remaining = state.lastEditAt + PROGRESS_EDIT_INTERVAL_MS - Date.now();
                if (remaining > 0) {
                    this.scheduleProgressEdits([state], remaining);
                    return;
                }
                await this.enqueueOutbound(state.key, async () => {
                    if (state.finalizing || this.disposed)
                        return;
                    const rendered = progressText(state);
                    if (rendered === state.lastRendered)
                        return;
                    try {
                        await state.adapter.editText(state.chatId, state.handle.messageId, rendered, state.turnEnded ? [] : undefined);
                        state.lastRendered = rendered;
                    }
                    finally {
                        // Also pace failures and slow requests; animation must not bypass
                        // the same budget as event-driven updates. Final delivery is exempt.
                        state.lastEditAt = Date.now();
                    }
                });
            } while (state.flushRequested && !state.finalizing);
        }
        finally {
            state.flushInFlight = false;
        }
    }
    async finalizeProgress(state) {
        state.finalizing = true;
        if (state.editTimer !== undefined) {
            clearTimeout(state.editTimer);
            state.editTimer = undefined;
        }
        this.stopProgressTimers(state);
        try {
            await state.ready;
            const rawFinalText = state.text.trim();
            const sourceFinalText = rawFinalText || (state.imageCount > 0 ? 'Готово.' : progressText(state));
            const finalText = rawFinalText
                ? state.adapter.renderText?.(rawFinalText) ?? rawFinalText
                : sourceFinalText;
            if (state.handle === undefined) {
                await state.adapter.sendText(state.chatId, finalText);
            }
            else if (state.adapter.replaceText !== undefined) {
                await this.enqueueOutbound(state.key, () => state.adapter.replaceText(state.chatId, state.handle.messageId, sourceFinalText, []));
            }
            else {
                const chunks = state.adapter.splitText?.(finalText) ?? splitTelegramText(finalText);
                await this.enqueueOutbound(state.key, async () => {
                    await state.adapter.editText(state.chatId, state.handle.messageId, chunks[0] ?? 'Готово.', []);
                    for (const chunk of chunks.slice(1))
                        await state.adapter.sendText(state.chatId, chunk);
                });
            }
        }
        finally {
            if (this.progress.get(state.key) === state)
                this.progress.delete(state.key);
        }
    }
    async failProgress(adapter, chatId, senderId, sessionId, error) {
        const key = progressKey(adapter.id, chatId, sessionId);
        const state = this.progress.get(key);
        if (state === undefined) {
            await adapter.sendText(chatId, `Could not send the prompt: ${this.errorMessage(error)}`);
            return;
        }
        state.text = '';
        pushStatus(state, `❌ Could not send prompt: ${this.errorMessage(error)}`);
        state.turnEnded = true;
        await this.finalizeProgress(state);
    }
    startAnimation(state) {
        if (state.animationTimer !== undefined || state.turnEnded || state.finalizing)
            return;
        state.animationTimer = setInterval(() => {
            state.animationFrame += 1;
            void this.flushProgress(state).catch((error) => this.logProgressError(error));
        }, PROGRESS_ANIMATION_INTERVAL_MS);
        state.animationTimer.unref?.();
    }
    stopAnimation(state) {
        if (state.animationTimer === undefined)
            return;
        clearInterval(state.animationTimer);
        state.animationTimer = undefined;
    }
    startTyping(state) {
        if (state.typingTimer !== undefined || state.turnEnded)
            return;
        void state.adapter.sendTyping(state.chatId).catch((error) => this.logProgressError(error));
        state.typingTimer = setInterval(() => {
            void state.adapter.sendTyping(state.chatId).catch((error) => this.logProgressError(error));
        }, TYPING_REFRESH_MS);
        state.typingTimer.unref?.();
    }
    stopTyping(state) {
        if (state.typingTimer === undefined)
            return;
        clearInterval(state.typingTimer);
        state.typingTimer = undefined;
    }
    stopProgressTimers(state) {
        this.stopTyping(state);
        this.stopAnimation(state);
        if (state.editTimer !== undefined) {
            clearTimeout(state.editTimer);
            state.editTimer = undefined;
        }
    }
    async sendToBindings(sessionId, text) {
        const sends = [];
        for (const { key, transport, chatId } of this.bindingRecipients(sessionId)) {
            const adapter = this.adapters.get(transport);
            if (adapter !== undefined)
                sends.push(this.enqueueOutbound(key, () => adapter.sendText(chatId, adapter.renderText?.(text) ?? text)));
        }
        const results = await Promise.allSettled(sends);
        for (const result of results) {
            if (result.status === 'rejected') {
                this.ctx.logger.warn('messenger: failed to deliver assistant text to one binding: %o', result.reason);
            }
        }
    }
    enqueueAction(key, action) {
        const previous = this.actionQueues.get(key) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(() => {
            if (this.disposed)
                throw new Error('Messenger bridge is disposed.');
            return action();
        });
        this.actionQueues.set(key, current);
        void current.finally(() => {
            if (this.actionQueues.get(key) === current)
                this.actionQueues.delete(key);
        }).catch(() => undefined);
        return current;
    }
    enqueueOutbound(key, send) {
        const previous = this.outboundQueues.get(key) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(send);
        this.outboundQueues.set(key, current);
        void current.finally(() => {
            if (this.outboundQueues.get(key) === current)
                this.outboundQueues.delete(key);
        }).catch(() => undefined);
        return current;
    }
    logProgressError(error) {
        this.ctx.logger.warn('messenger: progressive transport update failed: %o', error);
    }
    errorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
}
//# sourceMappingURL=bridge.js.map