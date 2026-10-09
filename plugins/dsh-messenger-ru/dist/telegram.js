const TELEGRAM_TEXT_LIMIT = 4_096;
const TELEGRAM_FILE_BYTE_LIMIT = 20 * 1024 * 1024;
const TELEGRAM_PHOTO_BYTE_LIMIT = 10 * 1024 * 1024;
const MAX_FILE_DOWNLOAD_TIMEOUT_MS = 60_000;
const IMAGE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const POLL_BATCH_LIMIT = 32;
const MAX_PENDING_HANDLERS = 64;
const HANDLER_DRAIN_TIMEOUT_MS = 5_000;
const ALLOWED_UPDATES = ['message', 'callback_query'];
const OUTBOUND_OPERATIONS = new Set([
    'sendMessage', 'editMessageText', 'sendPhoto', 'sendDocument', 'sendVoice', 'sendRichMessage',
    'sendChatAction', 'answerCallbackQuery',
]);
// Bot API 10.1 rich messages: native tables/checklists, 32768-char cap. Used as an upgrade path
// from sendText when content benefits; every failure falls back to the classic HTML pipeline.
const TELEGRAM_RICH_TEXT_LIMIT = 32_768;
const RICH_TABLE_RE = /(^|\n)[^\n|]*\|[^\n|]*\|[^\n]*\n[^\n|]*\|?[\s:|-]+\|?[^\n]*(\n|$)/;
const RICH_CHECKLIST_RE = /(^|\n)\s*[-*+] \[[ xX]\] /;
function wantsRichMessage(text) {
    return RICH_TABLE_RE.test(text) || RICH_CHECKLIST_RE.test(text);
}
function splitRichText(text) {
    if (Buffer.byteLength(text, 'utf8') <= TELEGRAM_RICH_TEXT_LIMIT)
        return [text];
    const chunks = [];
    let remaining = text;
    while (Buffer.byteLength(remaining, 'utf8') > TELEGRAM_RICH_TEXT_LIMIT) {
        let cut = remaining.lastIndexOf('\n', TELEGRAM_RICH_TEXT_LIMIT);
        if (cut < 1)
            cut = remaining.lastIndexOf(' ', TELEGRAM_RICH_TEXT_LIMIT);
        if (cut < 1)
            cut = TELEGRAM_RICH_TEXT_LIMIT;
        const piece = remaining.slice(0, cut);
        chunks.push(piece);
        remaining = remaining.slice(cut);
    }
    if (remaining.trim())
        chunks.push(remaining);
    return chunks;
}
const BOT_COMMANDS = [
    { command: 'start', description: 'Подключить чат и показать меню' },
    { command: 'menu', description: 'Показать меню управления' },
    { command: 'sessions', description: 'Список сессий' },
    { command: 'resume', description: 'Перейти к сессии' },
    { command: 'new', description: 'Новая сессия' },
    { command: 'status', description: 'Статус текущей сессии' },
    { command: 'model', description: 'Выбрать модель' },
    { command: 'reasoning', description: 'Режим рассуждений модели' },
    { command: 'permission', description: 'Режим прав доступа' },
    { command: 'context', description: 'Заполненность контекста' },
    { command: 'steer', description: 'Передать указание активной сессии' },
    { command: 'cancel', description: 'Отменить текущую операцию' },
    { command: 'voice_cancel', description: 'Отменить расшифровку голоса' },
    { command: 'stt', description: 'Расшифровка голоса: Vosk / Chrome / T-one / GigaAM' },
    // --- PATCH: files/forums/duty/commands (2026-09-27) ---
    { command: 'goal', description: 'Цель сессии: /goal текст, /goal clear|pause|resume' },
    { command: 'compact', description: 'Сжать контекст текущей сессии' },
    { command: 'compact_status', description: 'Заполненность контекста сессии' },
    { command: 'away', description: 'Режим «на телефоне»: вопросы без привязки приходят сюда' },
    { command: 'back', description: 'Выключить режим «на телефоне»' },
    { command: 'voice', description: 'Голосовые ответы (TTS): /voice on|off' },
    { command: 'diag', description: 'Диагностика мессенджера' },
    { command: 'cd', description: 'Перейти на сессию другого воркспейса' },
    { command: 'claim', description: 'Доступ оператора по коду: /claim <код>' },
    { command: 'unbind', description: 'Отвязать текущую сессию' },
    { command: 'notifications', description: 'Уведомления хоста вкл/выкл' },
    { command: 'help', description: 'Справка по командам' },
];
// --- PATCH: files-as-path-handles + forum-topics (2026-09-27) ---
// Optional Bot API base (Local Bot API Server) lifts the 20 MiB download cap for
// path-handle files; the classic cloud endpoint keeps the strict cloud limits.
const DEFAULT_API_BASE = 'https://api.telegram.org';
const LOCAL_FILE_BYTE_LIMIT = 2000 * 1024 * 1024;
function apiBase(options) {
    const raw = typeof options.apiBaseUrl === 'string' ? options.apiBaseUrl.trim() : '';
    return raw === '' ? DEFAULT_API_BASE : raw.replace(/\/+$/, '');
}
function fileByteLimit(kind, options) {
    if (kind === 'file' && apiBase(options) !== DEFAULT_API_BASE)
        return LOCAL_FILE_BYTE_LIMIT;
    return TELEGRAM_FILE_BYTE_LIMIT;
}
/** Split a bridge destination `chatId` that may carry a forum-topic suffix (`<chat>#t<thread>`). */
function splitDestination(chatId) {
    const match = /^(.*)#t(\d+)$/.exec(chatId);
    if (match === null || match[1] === '')
        return { chatId };
    return { chatId: match[1], threadId: Number(match[2]) };
}
function threadBodyFields(threadId) {
    return threadId === undefined ? {} : { message_thread_id: threadId };
}
export class TelegramApiError extends Error {
    description;
    errorCode;
    retryAfter;
    error_code;
    retry_after;
    constructor(operation, description, details = {}) {
        super(`Telegram ${operation} failed: ${description}`);
        this.description = description;
        this.name = 'TelegramApiError';
        if (details.errorCode !== undefined) {
            this.errorCode = details.errorCode;
            this.error_code = details.errorCode;
        }
        if (details.retryAfter !== undefined) {
            this.retryAfter = details.retryAfter;
            this.retry_after = details.retryAfter;
        }
    }
}
function escapeTelegramHtml(value, attribute = false) {
    const escaped = value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    return attribute ? escaped.replaceAll('"', '&quot;') : escaped;
}
function markdownUrlEnd(source, start) {
    let depth = 1;
    for (let index = start; index < source.length; index += 1) {
        if (source[index] === '\\') {
            index += 1;
            continue;
        }
        if (source[index] === '(')
            depth += 1;
        if (source[index] === ')') {
            depth -= 1;
            if (depth === 0)
                return index;
        }
    }
    return -1;
}
function renderTelegramInline(source) {
    let rendered = '';
    let index = 0;
    const wrap = (delimiter, openTag, closeTag = openTag) => {
        if (!source.startsWith(delimiter, index))
            return false;
        const end = source.indexOf(delimiter, index + delimiter.length);
        if (end <= index + delimiter.length)
            return false;
        rendered += `<${openTag}>${renderTelegramInline(source.slice(index + delimiter.length, end))}</${closeTag}>`;
        index = end + delimiter.length;
        return true;
    };
    while (index < source.length) {
        if (source[index] === '\\'
            && index + 1 < source.length
            && /[\\`*_[\]{}()#+\-.!|>]/.test(source[index + 1])) {
            rendered += escapeTelegramHtml(source[index + 1]);
            index += 2;
            continue;
        }
        if (source[index] === '`') {
            const end = source.indexOf('`', index + 1);
            if (end > index + 1) {
                rendered += `<code>${escapeTelegramHtml(source.slice(index + 1, end))}</code>`;
                index = end + 1;
                continue;
            }
        }
        if (source[index] === '[') {
            const labelEnd = source.indexOf('](', index + 1);
            const urlEnd = labelEnd < 0 ? -1 : markdownUrlEnd(source, labelEnd + 2);
            if (labelEnd > index + 1 && urlEnd > labelEnd + 2) {
                const label = source.slice(index + 1, labelEnd);
                const url = source.slice(labelEnd + 2, urlEnd).trim();
                if (/^(?:https?:\/\/|tg:\/\/|mailto:)/i.test(url)) {
                    rendered += `<a href="${escapeTelegramHtml(url, true)}">${renderTelegramInline(label)}</a>`;
                }
                else {
                    rendered += `${renderTelegramInline(label)} (${escapeTelegramHtml(url)})`;
                }
                index = urlEnd + 1;
                continue;
            }
        }
        if (wrap('**', 'b')
            || wrap('__', 'b')
            || wrap('~~', 's')
            || wrap('||', 'span class="tg-spoiler"', 'span')
            || wrap('*', 'i'))
            continue;
        rendered += escapeTelegramHtml(source[index]);
        index += 1;
    }
    return rendered;
}
/** Convert common model Markdown into Telegram's supported HTML subset. */
export function renderTelegramMarkdown(text) {
    const lines = text.replaceAll('\r\n', '\n').split('\n');
    const rendered = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const fence = line.match(/^\s*```\s*([A-Za-z0-9_+.-]*)\s*$/);
        if (fence !== null) {
            const code = [];
            while (index + 1 < lines.length && !/^\s*```\s*$/.test(lines[index + 1])) {
                index += 1;
                code.push(lines[index]);
            }
            if (index + 1 < lines.length)
                index += 1;
            const language = fence[1]
                ? ` class="language-${escapeTelegramHtml(fence[1], true)}"`
                : '';
            rendered.push(`<pre><code${language}>${escapeTelegramHtml(code.join('\n'))}</code></pre>`);
            continue;
        }
        if (/^\s*>\s?/.test(line)) {
            const quote = [line.replace(/^\s*>\s?/, '')];
            while (index + 1 < lines.length && /^\s*>\s?/.test(lines[index + 1])) {
                index += 1;
                quote.push(lines[index].replace(/^\s*>\s?/, ''));
            }
            rendered.push(`<blockquote>${quote.map(renderTelegramInline).join('\n')}</blockquote>`);
            continue;
        }
        const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
        if (heading !== null) {
            rendered.push(`<b>${renderTelegramInline(heading[1])}</b>`);
            continue;
        }
        const bullet = line.match(/^\s*[-+*]\s+(.+)$/);
        if (bullet !== null) {
            rendered.push(`• ${renderTelegramInline(bullet[1])}`);
            continue;
        }
        rendered.push(renderTelegramInline(line));
    }
    return rendered.join('\n');
}
function telegramHtmlVisibleLength(html) {
    const tokens = html.match(/<[^>]+>|&(?:#\d+|#x[\da-f]+|[a-z]+);|[^<&]+|[<&]/gi) ?? [];
    let length = 0;
    for (const token of tokens) {
        if (token.startsWith('<'))
            continue;
        length += /^&(?:#\d+|#x[\da-f]+|[a-z]+);$/i.test(token) ? 1 : token.length;
    }
    return length;
}
/** Split generated Telegram HTML while closing and reopening formatting tags. */
export function splitTelegramHtml(html, limit = TELEGRAM_TEXT_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new TypeError('Telegram text limit must be a positive safe integer');
    }
    const tokens = html.match(/<[^>]+>|&(?:#\d+|#x[\da-f]+|[a-z]+);|[^<&]+|[<&]/gi) ?? [];
    const chunks = [];
    const open = [];
    let current = '';
    let visible = 0;
    const closeTags = () => [...open]
        .reverse()
        .map((tag) => `</${tag.name}>`)
        .join('');
    const reopenTags = () => open.map((tag) => tag.source).join('');
    const flush = () => {
        if (!current)
            return;
        chunks.push(`${current}${closeTags()}`);
        current = reopenTags();
        visible = 0;
    };
    const appendVisible = (value, width) => {
        if (visible > 0 && visible + width > limit)
            flush();
        current += value;
        visible += width;
    };
    for (const token of tokens) {
        if (token.startsWith('<')) {
            const closing = token.match(/^<\/([a-z0-9-]+)>$/i);
            if (closing !== null) {
                current += token;
                const last = open.at(-1);
                if (last?.name.toLowerCase() === closing[1].toLowerCase())
                    open.pop();
                continue;
            }
            const opening = token.match(/^<([a-z0-9-]+)(?:\s[^>]*)?>$/i);
            if (opening !== null) {
                current += token;
                open.push({ source: token, name: opening[1] });
                continue;
            }
            appendVisible(escapeTelegramHtml(token), token.length);
            continue;
        }
        if (/^&(?:#\d+|#x[\da-f]+|[a-z]+);$/i.test(token)) {
            appendVisible(token, 1);
            continue;
        }
        for (const character of token)
            appendVisible(character, character.length);
    }
    if (current)
        chunks.push(`${current}${closeTags()}`);
    return chunks.length > 0 ? chunks : [''];
}
export function splitTelegramText(text, limit = TELEGRAM_TEXT_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new TypeError('Telegram text limit must be a positive safe integer');
    }
    const remaining = Array.from(text);
    if (remaining.length <= limit)
        return [text];
    const chunks = [];
    while (remaining.length > limit) {
        const window = remaining.slice(0, limit + 1);
        const newline = window.lastIndexOf('\n');
        const whitespace = window.lastIndexOf(' ');
        const preferred = Math.max(newline, whitespace);
        const splitAt = preferred > 0 ? preferred : limit;
        chunks.push(remaining.splice(0, splitAt).join('').trimEnd());
        while (remaining[0] === ' ' || remaining[0] === '\n')
            remaining.shift();
    }
    if (remaining.length > 0)
        chunks.push(remaining.join(''));
    return chunks;
}
function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
function raceWithAbort(promise, signal) {
    return new Promise((resolve, reject) => {
        const rejectForAbort = () => {
            reject(signal.reason ?? new Error('Telegram operation aborted'));
        };
        if (signal.aborted)
            rejectForAbort();
        else
            signal.addEventListener('abort', rejectForAbort, { once: true });
        void promise.then((value) => {
            signal.removeEventListener('abort', rejectForAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener('abort', rejectForAbort);
            reject(error);
        });
    });
}
function senderName(user) {
    if (user === undefined)
        return undefined;
    if (user.username)
        return `@${user.username}`;
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    return name || undefined;
}
function replyMarkup(keyboard) {
    if (keyboard === undefined)
        return undefined;
    return {
        inline_keyboard: keyboard.map((row) => row.map((button) => ('callbackData' in button
            ? { text: button.text, callback_data: button.callbackData }
            : { text: button.text, url: button.url }))),
    };
}
function sortedUniqueUpdates(updates) {
    const byId = new Map();
    for (const update of updates)
        byId.set(update.update_id, update);
    return [...byId.values()].sort((left, right) => left.update_id - right.update_id);
}
function normalizeGroupCommand(text, chatKind, botUsername) {
    if (botUsername === undefined
        || (chatKind !== 'group' && chatKind !== 'supergroup'))
        return text;
    return text.replace(/^(\s*\/[A-Za-z0-9_]+)@([A-Za-z0-9_]+)(?=\s|$)/, (matched, command, suffix) => (suffix.toLowerCase() === botUsername.toLowerCase()
        ? command
        : matched));
}
function validFileSize(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function supportedImageMime(value) {
    return typeof value === 'string' && Object.hasOwn(IMAGE_EXTENSIONS, value);
}
function imageFile(value) {
    if (typeof value !== 'object' || value === null || !('file_id' in value))
        return undefined;
    if (typeof value.file_id !== 'string' || value.file_id.trim() === '')
        return undefined;
    const size = 'file_size' in value ? value.file_size : undefined;
    if (size !== undefined && !validFileSize(size))
        return undefined;
    return { fileId: value.file_id, ...(size === undefined ? {} : { sizeBytes: size }) };
}
function telegramImage(message) {
    if (message.photo !== undefined) {
        if (!Array.isArray(message.photo))
            return undefined;
        let largest;
        let largestArea = 0;
        for (const photo of message.photo) {
            const file = imageFile(photo);
            if (file === undefined
                || !Number.isSafeInteger(photo.width) || photo.width <= 0
                || !Number.isSafeInteger(photo.height) || photo.height <= 0
                || !Number.isSafeInteger(photo.width * photo.height))
                continue;
            const area = photo.width * photo.height;
            if (area > largestArea) {
                largestArea = area;
                largest = { ...file, mimeType: 'image/jpeg' };
            }
        }
        return largest;
    }
    const document = message.document;
    const file = imageFile(document);
    if (file === undefined || typeof document !== 'object' || document === null
        || !('mime_type' in document) || !supportedImageMime(document.mime_type))
        return undefined;
    return { ...file, mimeType: document.mime_type };
}
// --- PATCH: any-file inbound as a path handle (2026-09-27) ---
function fileFromMedia(value, mediaKind) {
    const file = imageFile(value);
    if (file === undefined || typeof value !== 'object' || value === null)
        return undefined;
    const mimeType = typeof value.mime_type === 'string' && value.mime_type !== '' ? value.mime_type : undefined;
    const fileName = typeof value.file_name === 'string' && value.file_name.trim() !== ''
        ? value.file_name.trim()
        : undefined;
    const duration = typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration >= 0
        ? value.duration
        : undefined;
    return {
        mediaKind,
        fileId: file.fileId,
        ...(file.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes }),
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(fileName === undefined ? {} : { fileName }),
        ...(duration === undefined ? {} : { durationSeconds: duration }),
    };
}
function stickerFileName(value, media) {
    const unique = typeof value.file_unique_id === 'string' && value.file_unique_id.trim() !== ''
        ? value.file_unique_id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'unknown'
        : 'unknown';
    const extension = media.mimeType === 'video/webm' ? 'webm'
        : media.mimeType === 'application/gzip' ? 'tgs'
            : 'webp';
    return `sticker-${unique}.${extension}`;
}
/** Any accepted media attachment becomes a downloaded path handle for the agent. */
function telegramFilePayload(message) {
    if (message.document !== undefined) {
        const document = message.document;
        if (typeof document === 'object' && document !== null && 'mime_type' in document
            && supportedImageMime(document.mime_type))
            return undefined; // image documents follow the vision path
        return fileFromMedia(document, 'document');
    }
    if (message.video !== undefined)
        return fileFromMedia(message.video, 'video');
    if (message.animation !== undefined)
        return fileFromMedia(message.animation, 'animation');
    if (message.audio !== undefined)
        return fileFromMedia(message.audio, 'audio');
    if (message.video_note !== undefined)
        return fileFromMedia(message.video_note, 'video_note');
    if (message.sticker !== undefined) {
        const media = fileFromMedia(message.sticker, 'sticker');
        if (media === undefined)
            return undefined;
        return { ...media, fileName: media.fileName ?? stickerFileName(message.sticker, media) };
    }
    return undefined;
}
/**
 * Shared inbound envelope fields: raw chat id (for allowlists), the topic-qualified
 * destination (`chat#tN`) that routes every outgoing send back into the forum topic,
 * and the binding sender slot (`topic:N` gives one shared session per topic).
 */
function inboundEnvelope(message, user) {
    const chat = message.chat;
    const isForum = chat.is_forum === true && (chat.type === 'supergroup' || chat.type === 'group');
    const threadId = isForum
        && typeof message.message_thread_id === 'number'
        && Number.isSafeInteger(message.message_thread_id) && message.message_thread_id > 0
        ? message.message_thread_id
        : undefined;
    const senderId = String(user.id);
    return {
        chatId: String(chat.id),
        isForum,
        senderId,
        ...(threadId === undefined ? {} : { threadId }),
        ...(threadId === undefined ? {} : { chatDest: `${String(chat.id)}#t${threadId}` }),
        senderKey: threadId === undefined ? senderId : `topic:${threadId}`,
    };
}
/** Never reflect Telegram URLs, credentials, or raw transport errors. */
function safeApiDescription(value, token, status) {
    if (typeof value !== 'string')
        return `HTTP ${status}`;
    const withoutUrls = value.replace(/https?:\/\/[^\s<>"']+/gi, '[redacted URL]');
    return (token ? withoutUrls.split(token).join('[redacted]') : withoutUrls)
        .replace(/\b\d{5,}:[A-Za-z0-9_-]+\b/g, '[redacted]');
}
function inboundUpdate(update, botUsername) {
    const message = update.message;
    // Media captions stay literal, even if a malformed update also has text.
    if (message !== undefined && (message.photo !== undefined || message.document !== undefined
        || message.video !== undefined || message.animation !== undefined || message.audio !== undefined
        || message.video_note !== undefined || message.sticker !== undefined)) {
        const user = message.from;
        if (user == null || !Number.isSafeInteger(user.id) || user.id <= 0
            || user.is_bot === true || message.sender_chat !== undefined
            || (message.caption !== undefined && typeof message.caption !== 'string'))
            return undefined;
        const image = telegramImage(message);
        const filePayload = image === undefined ? telegramFilePayload(message) : undefined;
        if (image === undefined && filePayload === undefined)
            return undefined;
        const envelope = inboundEnvelope(message, user);
        const name = senderName(user);
        const mediaGroupId = typeof message.media_group_id === 'string' && message.media_group_id !== ''
            ? { mediaGroupId: message.media_group_id } : {};
        if (image !== undefined) {
            return {
                kind: 'image', transport: 'telegram',
                messageId: String(message.message_id), ...envelope,
                chatKind: message.chat.type,
                ...(name === undefined ? {} : { senderName: name }),
                ...mediaGroupId,
                text: message.caption ?? '', image,
            };
        }
        return {
            kind: 'file', transport: 'telegram',
            messageId: String(message.message_id), ...envelope,
            chatKind: message.chat.type,
            ...(name === undefined ? {} : { senderName: name }),
            ...mediaGroupId,
            text: message.caption ?? '', file: filePayload,
        };
    }
    if (message?.text !== undefined) {
        const user = message.from;
        const envelope = inboundEnvelope(message, user ?? { id: message.chat.id });
        const name = senderName(user);
        return {
            kind: 'message',
            transport: 'telegram',
            messageId: String(message.message_id),
            ...envelope,
            chatKind: message.chat.type,
            ...(name === undefined ? {} : { senderName: name }),
            text: normalizeGroupCommand(message.text, message.chat.type, botUsername),
        };
    }
    if (message?.voice !== undefined) {
        const voice = message.voice;
        const user = message.from;
        if (voice === null
            || user == null
            || !Number.isSafeInteger(user.id) || user.id <= 0
            || user.is_bot === true || message.sender_chat !== undefined
            || typeof voice.file_id !== 'string' || voice.file_id.trim() === ''
            || typeof voice.duration !== 'number'
            || !Number.isFinite(voice.duration) || voice.duration < 0
            || (voice.file_size !== undefined && !validFileSize(voice.file_size)))
            return undefined;
        const envelope = inboundEnvelope(message, user);
        const name = senderName(user);
        return {
            kind: 'voice',
            transport: 'telegram',
            messageId: String(message.message_id),
            ...envelope,
            chatKind: message.chat.type,
            ...(name === undefined ? {} : { senderName: name }),
            text: '',
            voice: {
                fileId: voice.file_id,
                durationSeconds: voice.duration,
                ...(voice.file_size === undefined ? {} : { sizeBytes: voice.file_size }),
                ...(typeof voice.mime_type === 'string' ? { mimeType: voice.mime_type } : {}),
            },
        };
    }
    const callback = update.callback_query;
    if (callback?.message === undefined || callback.data === undefined) {
        return undefined;
    }
    const envelope = inboundEnvelope(callback.message, callback.from);
    const name = senderName(callback.from);
    return {
        kind: 'callback_query',
        transport: 'telegram',
        messageId: String(callback.message.message_id),
        ...envelope,
        chatKind: callback.message.chat.type,
        ...(name === undefined ? {} : { senderName: name }),
        text: callback.data,
        callbackQueryId: callback.id,
        data: callback.data,
    };
}
export class TelegramAdapter {
    options;
    id = 'telegram';
    textLimit = TELEGRAM_TEXT_LIMIT;
    fetchImpl;
    botUsername;
    commandsRegistered = false;
    // Telegram flood limits can span hours and affect multiple outgoing methods.
    // Fail fast during the pause: sleeping here would block chat command queues,
    // and automatically replaying multi-part sends could duplicate deliveries.
    outboundRetryAt = 0;
    checkOutboundCooldown(operation) {
        if (!OUTBOUND_OPERATIONS.has(operation))
            return;
        const remaining = this.outboundRetryAt - Date.now();
        if (remaining <= 0)
            return;
        const retryAfter = Math.ceil(remaining / 1_000);
        throw new TelegramApiError(operation, `Too Many Requests: retry after ${retryAfter}`, {
            errorCode: 429, retryAfter,
        });
    }
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
    }
    textLength(text) {
        return telegramHtmlVisibleLength(renderTelegramMarkdown(text));
    }
    async validate(signal) {
        await this.loadBotUsername(signal);
        await this.registerCommands(signal);
    }
    async start(onMessage, signal) {
        let offset;
        let retryDelay = DEFAULT_RETRY_DELAY_MS;
        let retained = [];
        const chatTails = new Map();
        const queued = new Set();
        const reportError = (error, delay) => {
            try {
                this.options.onError?.(error, delay);
            }
            catch {
                // Error reporting must not stop polling or a chat queue.
            }
        };
        const waitForCapacity = async (incoming) => {
            while (queued.size + incoming > MAX_PENDING_HANDLERS) {
                if (signal.aborted)
                    throw signal.reason;
                const pending = [...queued];
                if (pending.length === 0)
                    return;
                await raceWithAbort(Promise.race(pending), signal);
            }
        };
        const enqueue = (message) => {
            // Callback queries bypass a blocked chat tail so answerCallbackQuery and
            // cancellation buttons remain responsive. Opaque one-use actions in the
            // bridge provide their own replay and binding fences.
            if (message.kind === 'callback_query') {
                const current = onMessage(message)
                    .catch((error) => reportError(error, 0));
                queued.add(current);
                void current.finally(() => queued.delete(current));
                return;
            }
            const previous = chatTails.get(message.chatId) ?? Promise.resolve();
            const current = previous
                .then(() => onMessage(message))
                .catch((error) => reportError(error, 0));
            chatTails.set(message.chatId, current);
            queued.add(current);
            void current.finally(() => {
                queued.delete(current);
                if (chatTails.get(message.chatId) === current) {
                    chatTails.delete(message.chatId);
                }
            });
        };
        try {
            if (this.botUsername === undefined)
                await this.loadBotUsername(signal);
            if (!this.commandsRegistered)
                await this.registerCommands(signal);
            while (!signal.aborted) {
                try {
                    const fetched = retained.length > 0
                        ? retained
                        : await this.call('getUpdates', {
                            ...(offset === undefined ? {} : { offset }),
                            timeout: this.options.pollTimeoutSeconds,
                            limit: POLL_BATCH_LIMIT,
                            allowed_updates: ALLOWED_UPDATES,
                        }, signal);
                    const batch = sortedUniqueUpdates(fetched);
                    retained = [];
                    retryDelay = DEFAULT_RETRY_DELAY_MS;
                    if (batch.length === 0)
                        continue;
                    const last = batch[batch.length - 1];
                    if (last === undefined)
                        continue;
                    const nextOffset = last.update_id + 1;
                    // Apply backpressure before acknowledgement so confirmed, process-local
                    // work stays bounded. Unadmitted updates remain recoverable by Telegram.
                    await waitForCapacity(batch.length);
                    // Confirm the whole fetched batch before any handler can execute. The
                    // confirmation can itself return updates, which become the next batch
                    // rather than being discarded.
                    retained = await this.call('getUpdates', {
                        offset: nextOffset,
                        timeout: 0,
                        limit: POLL_BATCH_LIMIT,
                        allowed_updates: ALLOWED_UPDATES,
                    }, signal);
                    offset = nextOffset;
                    for (const update of batch) {
                        const message = inboundUpdate(update, this.botUsername);
                        if (message !== undefined)
                            enqueue(message);
                    }
                    // Let newly queued handlers start without waiting for their completion.
                    await Promise.resolve();
                }
                catch (error) {
                    if (signal.aborted)
                        break;
                    const delay = error instanceof TelegramApiError
                        && error.retryAfter !== undefined
                        ? error.retryAfter * 1_000
                        : retryDelay;
                    reportError(error, delay);
                    await abortableDelay(delay, signal);
                    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
                }
            }
        }
        catch (error) {
            if (!signal.aborted)
                throw error;
        }
        finally {
            if (queued.size > 0) {
                let timer;
                await Promise.race([
                    Promise.allSettled([...queued]),
                    new Promise((resolve) => {
                        timer = setTimeout(resolve, HANDLER_DRAIN_TIMEOUT_MS);
                        timer.unref?.();
                    }),
                ]);
                if (timer !== undefined)
                    clearTimeout(timer);
            }
        }
    }
    async sendText(chatId, text, options = {}) {
        // Rich upgrade (Bot API 10.1): only when content benefits (tables/checklists) and no
        // custom keyboard is requested. Any failure silently falls back to the HTML pipeline.
        if (options.keyboard === undefined && wantsRichMessage(text)) {
            try {
                return await this.sendRichText(chatId, text);
            }
            catch {
                // fall through to the classic path
            }
        }
        const chunks = splitTelegramHtml(renderTelegramMarkdown(text));
        let first;
        for (const [index, chunk] of chunks.entries()) {
            const handle = await this.sendHtmlText(chatId, chunk, index === 0 ? options.keyboard : undefined);
            first ??= handle;
        }
        return first;
    }
    async sendRichText(chatId, text, options = {}) {
        const chunks = splitRichText(text);
        const destination = splitDestination(chatId);
        let first;
        for (const [index, chunk] of chunks.entries()) {
            const markup = index === 0 && options.keyboard !== undefined ? replyMarkup(options.keyboard) : undefined;
            const sent = await this.call('sendRichMessage', {
                chat_id: destination.chatId,
                ...threadBodyFields(destination.threadId),
                rich_message: { markdown: chunk },
                ...(markup === undefined ? {} : { reply_markup: markup }),
            });
            if (sent === null || !Number.isSafeInteger(sent.message_id) || sent.message_id <= 0) {
                throw new TelegramApiError('sendRichMessage', 'invalid sent message');
            }
            first ??= { chatId, messageId: String(sent.message_id) };
        }
        return first;
    }
    async editText(chatId, messageId, text, keyboard) {
        const chunks = splitTelegramHtml(renderTelegramMarkdown(text));
        if (chunks.length !== 1) {
            throw new RangeError('Telegram edited text exceeds 4096 visible characters');
        }
        await this.editHtmlText(chatId, messageId, chunks[0], keyboard);
    }
    async replaceText(chatId, messageId, text, keyboard) {
        const chunks = splitTelegramHtml(renderTelegramMarkdown(text));
        await this.editHtmlText(chatId, messageId, chunks[0], keyboard);
        for (const chunk of chunks.slice(1))
            await this.sendHtmlText(chatId, chunk);
    }
    async sendHtmlText(chatId, html, keyboard) {
        const destination = splitDestination(chatId);
        const markup = replyMarkup(keyboard);
        const sent = await this.call('sendMessage', {
            chat_id: destination.chatId,
            ...threadBodyFields(destination.threadId),
            text: html,
            parse_mode: 'HTML',
            ...(markup === undefined ? {} : { reply_markup: markup }),
        });
        return { chatId, messageId: String(sent.message_id) };
    }
    async editHtmlText(chatId, messageId, html, keyboard) {
        const destination = splitDestination(chatId);
        const markup = replyMarkup(keyboard);
        try {
            await this.call('editMessageText', {
                chat_id: destination.chatId,
                message_id: messageId,
                text: html,
                parse_mode: 'HTML',
                ...(markup === undefined ? {} : { reply_markup: markup }),
            });
        }
        catch (error) {
            if (error instanceof TelegramApiError
                && error.description.toLowerCase().includes('message is not modified'))
                return;
            throw error;
        }
    }
    async answerCallback(callbackQueryId, text, showAlert) {
        await this.call('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            ...(text === undefined ? {} : { text }),
            ...(showAlert === undefined ? {} : { show_alert: showAlert }),
        });
    }
    async sendTyping(chatId) {
        const destination = splitDestination(chatId);
        await this.call('sendChatAction', {
            chat_id: destination.chatId,
            ...threadBodyFields(destination.threadId),
            action: 'typing',
        });
    }
    async sendImage(chatId, image, signal) {
        if (image == null || !(image.bytes instanceof Uint8Array) || image.bytes.byteLength === 0) {
            throw new TelegramApiError('sendImage', 'image must contain nonempty bytes');
        }
        if (!supportedImageMime(image.mimeType)) {
            throw new TelegramApiError('sendImage', 'unsupported image MIME type');
        }
        if (image.bytes.byteLength > TELEGRAM_FILE_BYTE_LIMIT) {
            throw new TelegramApiError('sendImage', 'image exceeds 20 MB limit');
        }
        const photo = (image.mimeType === 'image/png' || image.mimeType === 'image/jpeg')
            && image.bytes.byteLength <= TELEGRAM_PHOTO_BYTE_LIMIT;
        const destination = splitDestination(chatId);
        const body = new FormData();
        body.set('chat_id', destination.chatId);
        if (destination.threadId !== undefined)
            body.set('message_thread_id', String(destination.threadId));
        // Copy the exact view into owned bytes; never accept a URL, path, or Telegram file ID.
        body.set(photo ? 'photo' : 'document', new Blob([new Uint8Array(image.bytes)], {
            type: image.mimeType,
        }), `image.${IMAGE_EXTENSIONS[image.mimeType]}`);
        const operation = photo ? 'sendPhoto' : 'sendDocument';
        // A failed/aborted send may already have arrived: do not retry or fall back.
        const sent = await this.call(operation, body, signal);
        if (sent === null || !Number.isSafeInteger(sent.message_id) || sent.message_id <= 0) {
            throw new TelegramApiError(operation, 'invalid sent message');
        }
        return { chatId, messageId: String(sent.message_id) };
    }
    async sendVoice(chatId, audio, signal) {
        if (audio == null || !(audio.bytes instanceof Uint8Array) || audio.bytes.byteLength === 0) {
            throw new TelegramApiError('sendVoice', 'audio must contain nonempty bytes');
        }
        if (audio.mimeType !== 'audio/ogg') {
            throw new TelegramApiError('sendVoice', 'voice notes must be OGG/Opus');
        }
        if (audio.bytes.byteLength > TELEGRAM_FILE_BYTE_LIMIT) {
            throw new TelegramApiError('sendVoice', 'audio exceeds 20 MB limit');
        }
        const destination = splitDestination(chatId);
        const body = new FormData();
        body.set('chat_id', destination.chatId);
        if (destination.threadId !== undefined)
            body.set('message_thread_id', String(destination.threadId));
        body.set('voice', new Blob([new Uint8Array(audio.bytes)], { type: 'audio/ogg' }), 'voice.ogg');
        // A failed/aborted send may already have arrived: do not retry or fall back.
        const sent = await this.call('sendVoice', body, signal);
        if (sent === null || !Number.isSafeInteger(sent.message_id) || sent.message_id <= 0) {
            throw new TelegramApiError('sendVoice', 'invalid sent message');
        }
        return { chatId, messageId: String(sent.message_id) };
    }
    async downloadVoice(message, signal) {
        return this.downloadFile(message.voice, 'voice', signal);
    }
    async downloadImage(message, signal) {
        return this.downloadFile(message.image, 'image', signal);
    }
    /** Path-handle file download; honours the Local Bot API Server limit when configured. */
    async downloadFileMessage(message, signal) {
        return this.downloadFile(message.file, 'file', signal);
    }
    fileLimitLabel() {
        return apiBase(this.options) === DEFAULT_API_BASE
            ? '20 МБ (облачный Bot API)'
            : '2000 МБ (локальный Bot API Server)';
    }
    async downloadFile(metadata, kind, signal) {
        const operation = kind === 'voice' ? 'downloadVoice'
            : kind === 'image' ? 'downloadImage'
                : 'downloadFile';
        const limit = fileByteLimit(kind, this.options);
        const configuredTimeout = this.options.requestTimeoutMs;
        // Path-handle files may be large on a Local Bot API Server; give them a
        // generous deadline instead of the 60 s media cap.
        const timeout = kind === 'file'
            ? 600_000
            : Number.isFinite(configuredTimeout) && configuredTimeout > 0
                ? Math.min(Math.floor(configuredTimeout), MAX_FILE_DOWNLOAD_TIMEOUT_MS)
                : MAX_FILE_DOWNLOAD_TIMEOUT_MS;
        const controller = new AbortController();
        const requestSignal = AbortSignal.any([
            signal,
            ...(this.options.signal === undefined ? [] : [this.options.signal]),
            AbortSignal.timeout(timeout),
            controller.signal,
        ]);
        let reader;
        let downloadToken = typeof this.options.token === 'string' ? this.options.token : '';
        const checkSize = (size) => {
            if (size === undefined)
                return;
            if (!validFileSize(size))
                throw new TelegramApiError(operation, `invalid ${kind} size`);
            if (size > limit) {
                throw new TelegramApiError(operation, `${kind} exceeds ${Math.floor(limit / (1024 * 1024))} MB limit`);
            }
        };
        try {
            requestSignal.throwIfAborted();
            checkSize(metadata.sizeBytes);
            if (typeof metadata.fileId !== 'string' || metadata.fileId.trim() === '') {
                throw new TelegramApiError(operation, 'invalid Telegram file ID');
            }
            const file = await raceWithAbort(this.call('getFile', { file_id: metadata.fileId }, requestSignal), requestSignal);
            checkSize(file.file_size);
            const path = file.file_path;
            // Accept only relative Telegram file paths, never URLs, encoded separators,
            // dot segments, queries, fragments, backslashes, or redirect destinations.
            if (typeof path !== 'string' || path.length > 1024
                || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(path))
                throw new TelegramApiError(operation, 'invalid Telegram file path');
            const token = await this.resolveToken(operation, requestSignal);
            downloadToken = token;
            requestSignal.throwIfAborted();
            const response = await raceWithAbort(this.fetchImpl(`${apiBase(this.options)}/file/bot${token}/${path}`, { signal: requestSignal, redirect: 'error' }), requestSignal);
            if (!response.ok)
                throw new TelegramApiError(operation, `HTTP ${response.status}`);
            const contentLength = response.headers.get('content-length');
            if (contentLength !== null)
                checkSize(Number(contentLength));
            if (response.body === null)
                throw new TelegramApiError(operation, `missing ${kind} body`);
            reader = response.body.getReader();
            const chunks = [];
            let length = 0;
            while (true) {
                requestSignal.throwIfAborted();
                const chunk = await raceWithAbort(reader.read(), requestSignal);
                if (chunk.done)
                    break;
                length += chunk.value.byteLength;
                checkSize(length);
                chunks.push(chunk.value);
            }
            if ((kind === 'image' || kind === 'file') && length === 0)
                throw new TelegramApiError(operation, `empty ${kind} body`);
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return bytes;
        }
        catch (error) {
            if (requestSignal.aborted)
                throw new TelegramApiError(operation, 'request aborted or timed out');
            if (error instanceof TelegramApiError) {
                throw new TelegramApiError(operation, safeApiDescription(error.description, downloadToken, 0));
            }
            throw new TelegramApiError(operation, `${kind} request failed`);
        }
        finally {
            controller.abort();
            // Do not let an uncooperative stream delay cancellation or leak its error.
            if (reader !== undefined)
                void reader.cancel().catch(() => { });
        }
    }
    async resolveToken(operation, signal) {
        try {
            signal.throwIfAborted();
            return typeof this.options.token === 'string'
                ? this.options.token
                : await raceWithAbort(this.options.token(), signal);
        }
        catch {
            throw new TelegramApiError(operation, signal.aborted
                ? 'request aborted or timed out'
                : 'credential resolution failed');
        }
    }
    async loadBotUsername(signal) {
        const bot = await this.call('getMe', {}, signal);
        this.botUsername = bot.username?.replace(/^@/, '');
    }
    async registerCommands(signal) {
        await this.call('setMyCommands', { commands: BOT_COMMANDS }, signal);
        this.commandsRegistered = true;
    }
    async call(operation, body, signal) {
        const pollSeconds = operation === 'getUpdates'
            && 'timeout' in body
            && typeof body.timeout === 'number'
            ? body.timeout
            : 0;
        const timeoutMs = pollSeconds * 1_000 + this.options.requestTimeoutMs;
        const signals = [
            this.options.signal,
            signal,
            AbortSignal.timeout(timeoutMs),
        ].filter((candidate) => candidate !== undefined);
        const requestSignal = AbortSignal.any(signals);
        this.checkOutboundCooldown(operation);
        const token = await this.resolveToken(operation, requestSignal);
        this.checkOutboundCooldown(operation);
        const multipart = body instanceof FormData;
        let response;
        try {
            requestSignal.throwIfAborted();
            const pending = this.fetchImpl(`${apiBase(this.options)}/bot${token}/${operation}`, {
                method: 'POST',
                ...(multipart ? {} : { headers: { 'content-type': 'application/json' } }),
                body: multipart ? body : JSON.stringify(body),
                signal: requestSignal,
                redirect: 'error',
            });
            response = await (multipart ? raceWithAbort(pending, requestSignal) : pending);
        }
        catch {
            throw new TelegramApiError(operation, requestSignal.aborted
                ? 'request aborted or timed out'
                : 'network request failed');
        }
        let payload;
        try {
            const pending = response.json();
            const parsed = await (multipart ? raceWithAbort(pending, requestSignal) : pending);
            if (typeof parsed === 'object' && parsed !== null)
                payload = parsed;
        }
        catch {
            if (requestSignal.aborted)
                throw new TelegramApiError(operation, 'request aborted or timed out');
            // Fall through to the sanitized HTTP error below.
        }
        if (!response.ok || payload === undefined || !payload.ok) {
            if ((response.status === 429 || payload?.error_code === 429)
                && OUTBOUND_OPERATIONS.has(operation)) {
                const retryAfter = payload?.parameters?.retry_after;
                const delay = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1_000 : MAX_RETRY_DELAY_MS;
                this.outboundRetryAt = Math.max(this.outboundRetryAt, Date.now() + delay);
            }
            throw new TelegramApiError(operation, safeApiDescription(payload?.description, token, response.status), {
                ...(response.status === 429
                    ? { errorCode: 429 }
                    : typeof payload?.error_code === 'number' && Number.isSafeInteger(payload.error_code)
                        ? { errorCode: payload.error_code }
                        : {}),
                ...(typeof payload?.parameters?.retry_after === 'number'
                    && Number.isFinite(payload.parameters.retry_after)
                    && payload.parameters.retry_after >= 0
                    ? { retryAfter: payload.parameters.retry_after }
                    : {}),
            });
        }
        if (payload.result === undefined) {
            throw new TelegramApiError(operation, 'unknown API error');
        }
        return payload.result;
    }
}
//# sourceMappingURL=telegram.js.map