// messenger-ru TTS patch (2026-10): edge-tts synthesis + OGG/Opus conversion for sendVoice.
// Zero added dependencies: ws resolves from the profile's hoisted node_modules,
// ffmpeg must exist on the host (checked lazily).
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const WebSocketImpl = (() => {
    try {
        return require('ws');
    }
    catch {
        return undefined;
    }
})();

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const BASE_HEADERS = {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
};
const WSS_HEADERS = {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: EDGE_ORIGIN,
    ...BASE_HEADERS,
};
const WIN_EPOCH_SECONDS = 116_444_73600;
export const MAX_TTS_TEXT_CHARS = 10_000;
export const TTS_BYTE_LIMIT = 20 * 1024 * 1024;

export const DEFAULT_TTS_VOICE = 'ru-RU-DmitryNeural';
export const TTS_VOICE_PRESETS = Object.freeze({
    dmitry: 'ru-RU-DmitryNeural',
    svetlana: 'ru-RU-SvetlanaNeural',
    'en-guy': 'en-US-GuyNeural',
    'en-aria': 'en-US-AriaNeural',
});

function escapeSsml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** edge-tts DRM token: SHA-256 over 100-ns ticks snapped to 5 minutes, uppercase hex. */
function secMsGec(skewSeconds = 0) {
    const ticks = Math.floor((Date.now() / 1000 + skewSeconds + WIN_EPOCH_SECONDS) * 1e7);
    const snapped = ticks - (ticks % 3_000_000_000);
    return createHash('sha256').update(`${snapped}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function wsUrl(skewSeconds) {
    const connectionId = randomUUID().replaceAll('-', '');
    return 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
        + `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
        + `&Sec-MS-GEC=${secMsGec(skewSeconds)}`
        + `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
        + `&ConnectionId=${connectionId}`;
}

/** JS-style UTC string the service expects (plus the trailing Z Microsoft's client adds). */
function edgeTimestamp() {
    return new Date().toUTCString()
        .replace(/GMT$/, 'GMT+0000 (Coordinated Universal Time)') + 'Z';
}

function ssmlPayload(text, voice, rate, pitch) {
    const requestId = randomUUID().replaceAll('-', '');
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ru-RU'>`
        + `<voice name='${escapeSsml(voice)}'>`
        + `<prosody pitch='${escapeSsml(pitch)}' rate='${escapeSsml(rate)}' volume='+0%'>`
        + `${escapeSsml(text)}</prosody></voice></speak>`;
    return 'X-RequestId:' + requestId + '\r\nContent-Type:application/ssml+xml\r\n'
        + 'X-Timestamp:' + edgeTimestamp() + '\r\nPath:ssml\r\n\r\n' + ssml;
}

function configMessage() {
    return 'X-Timestamp:' + edgeTimestamp()
        + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}';
}

/**
 * Synthesize speech with the Edge read-aloud service. Resolves { bytes, mimeType: 'audio/mpeg' }
 * or rejects with an Error carrying a short human-readable reason.
 */
export async function synthesizeSpeech({ text, voice, rate, pitch, signal, timeoutMs = 60_000 }) {
    if (typeof text !== 'string' || !text.trim())
        throw new Error('text must be a non-empty string.');
    if (text.length > MAX_TTS_TEXT_CHARS)
        throw new Error(`text exceeds ${MAX_TTS_TEXT_CHARS} characters; split the speech into several calls.`);
    if (WebSocketImpl === undefined)
        throw new Error('TTS requires the ws package (hoisted in the DSH web profile); it was not found.');
    const resolvedVoice = typeof voice === 'string' && voice.trim()
        ? TTS_VOICE_PRESETS[voice.trim().toLowerCase()] ?? voice.trim()
        : DEFAULT_TTS_VOICE;
    const resolvedRate = typeof rate === 'string' && rate.trim() ? rate.trim() : '+0%';
    const resolvedPitch = typeof pitch === 'string' && pitch.trim() ? pitch.trim() : '+0Hz';
    // The service rejects SSML requests over 4096 bytes: split on safe boundaries and concatenate.
    const chunks = splitTextByByteLength(text, 4_000);
    const audio = [];
    for (const chunk of chunks) {
        const part = await connectAndSynthesize({
            text: chunk, voice: resolvedVoice, rate: resolvedRate, pitch: resolvedPitch, signal, timeoutMs, skewSeconds: 0,
        });
        audio.push(part.bytes);
    }
    return { bytes: Buffer.concat(audio), mimeType: 'audio/mpeg', voiceUsed: resolvedVoice };
}

function splitTextByByteLength(text, limit) {
    const encoded = Buffer.from(text, 'utf8');
    if (encoded.byteLength <= limit)
        return [text];
    const chunks = [];
    let remaining = encoded;
    while (remaining.byteLength > limit) {
        let cut = remaining.subarray(0, limit).lastIndexOf(0x0A);
        if (cut < 1)
            cut = remaining.subarray(0, limit).lastIndexOf(0x20);
        if (cut < 1) {
            // Avoid splitting a multi-byte UTF-8 sequence.
            cut = limit;
            while (cut > 1 && (remaining[cut] & 0xC0) === 0x80)
                cut -= 1;
        }
        const piece = remaining.subarray(0, cut).toString('utf8').trim();
        if (piece)
            chunks.push(piece);
        remaining = remaining.subarray(cut);
    }
    const tail = remaining.toString('utf8').trim();
    if (tail)
        chunks.push(tail);
    return chunks;
}

async function connectAndSynthesize({ text, voice, rate, pitch, signal, timeoutMs, skewSeconds }) {
    if (signal?.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error('TTS aborted.');
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const ws = new WebSocketImpl(wsUrl(skewSeconds), {
        headers: {
            ...WSS_HEADERS,
            Cookie: `muid=${randomUUID().replaceAll('-', '').toUpperCase()};`,
        },
    });
    const audioChunks = [];
    let settle;
    let settled = false;
    const done = new Promise((resolve, reject) => {
        settle = (error, value) => {
            if (settled)
                return;
            settled = true;
            if (error !== undefined)
                reject(error);
            else
                resolve(value);
        };
    });
    const finish = () => {
        try {
            ws.close();
        }
        catch {
        }
    };
    requestSignal.addEventListener('abort', () => {
        settle(new Error('TTS aborted.'));
        finish();
    }, { once: true });
    ws.on('open', () => {
        ws.send(configMessage(), () => {
            ws.send(ssmlPayload(text, voice, rate, pitch));
        });
    });
    ws.on('message', (data, isBinary) => {
        if (settled)
            return;
        try {
            if (isBinary) {
                const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
                if (buffer.byteLength < 2)
                    return;
                const headerLength = buffer.readUInt16BE(0);
                const payload = buffer.subarray(2 + headerLength);
                if (payload.byteLength > 0)
                    audioChunks.push(Buffer.from(payload));
                return;
            }
            const message = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
            if (message.includes('Path:turn.end')) {
                finish();
                settle(undefined, { bytes: Buffer.concat(audioChunks), mimeType: 'audio/mpeg' });
            }
        }
        catch (error) {
            finish();
            settle(error instanceof Error ? error : new Error('TTS message parse failure.'));
        }
    });
    ws.on('error', (error) => {
        if (settled)
            return;
        const description = String(error?.message ?? error);
        if (skewSeconds === 0 && /403|Unauthorized/i.test(description)) {
            // DRM clock skew: retry once with a five-minute offset before giving up.
            connectAndSynthesize({ text, voice, rate, pitch, signal, timeoutMs, skewSeconds: -300 })
                .then((value) => settle(undefined, value))
                .catch((retryError) => settle(retryError));
            return;
        }
        finish();
        settle(new Error(`TTS connection failed: ${description}`));
    });
    ws.on('close', () => {
        if (!settled)
            settle(new Error('TTS connection closed before audio completed.'));
    });
    try {
        return await done;
    }
    finally {
        finish();
    }
}

/** Convert MP3 bytes to OGG/Opus (48 kHz mono) for Telegram sendVoice via ffmpeg on the host. */
export function mp3ToOggOpus(mp3, signal, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
        if (!(mp3 instanceof Uint8Array) || mp3.byteLength === 0) {
            reject(new Error('TTS produced no audio bytes.'));
            return;
        }
        const child = spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-i', 'pipe:0',
            '-map_metadata', '-1',
            '-c:a', 'libopus', '-b:a', '56k', '-ar', '48000', '-ac', '1',
            '-f', 'ogg', 'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = [];
        let stderr = '';
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => {
            if (stderr.length < 2_000)
                stderr += chunk.toString('utf8');
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        const onAbort = () => child.kill('SIGKILL');
        signal?.addEventListener('abort', onAbort, { once: true });
        child.on('error', (error) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(new Error(`ffmpeg launch failed: ${error.message}. Is ffmpeg installed on the host?`));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            const bytes = Buffer.concat(chunks);
            if (signal?.aborted) {
                reject(signal.reason instanceof Error ? signal.reason : new Error('TTS conversion aborted.'));
                return;
            }
            if (code !== 0 || bytes.byteLength === 0) {
                reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().slice(0, 400) || 'no output'}`));
                return;
            }
            resolve({ bytes, mimeType: 'audio/ogg' });
        });
        child.stdin.on('error', () => {
        });
        child.stdin.end(Buffer.from(mp3));
    });
}
