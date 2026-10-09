import { credentialRef } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import { MessengerBridge, QuestionAnsweredElsewhere } from './bridge.js';
import { DurableMessengerBindingStore, } from './store.js';
import { TelegramAdapter } from './telegram.js';
import { DEFAULT_VOICE_CONFIG, LocalWhisperTranscriber } from './voice.js';
import { installNotificationTool } from './notifications.js';
import { installImageTool } from './image-tool.js';
import { installVoiceTool } from './voice-tool.js';
import { openNotificationStore } from './notification-store.js';
export { MessengerBridge, parseCommand } from './bridge.js';
export { LocalWhisperTranscriber, DEFAULT_VOICE_CONFIG } from './voice.js';
export { TelegramAdapter, TelegramApiError, splitTelegramText } from './telegram.js';
export { DurableMessengerBindingStore, MemoryMessengerBindingStore, messengerBindingDomainSpec, messengerBindingIdentity, messengerBindingKey, messengerBindingRecordSchema, } from './store.js';
export const name = 'messenger';
export const inject = [
    'agents',
    'sessionController',
    'workspaceRegistry',
    'credentials',
    'permissionPresets',
    'settings',
    'tools',
    'storageDomain',
    'fs',
    'attachments',
];
export const MESSENGER_SETTINGS_NAMESPACE = 'messenger';
export const TELEGRAM_BOT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN';
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/;
const TELEGRAM_USER_ID_PATTERN = /^\d+$/;
export const Config = z.object({
    telegram: z.object({
        enabled: z.boolean().default(false),
        tokenRef: z.string().default(TELEGRAM_BOT_TOKEN_REF),
        allowedChatIds: z.array(z.string().pattern(TELEGRAM_CHAT_ID_PATTERN)).default([]),
        allowedUserIds: z.array(z.string().pattern(TELEGRAM_USER_ID_PATTERN)).default([]),
        privateChatsOnly: z.boolean().default(true),
        pollTimeoutSeconds: z.number().min(1).max(50).default(30),
        requestTimeoutMs: z.number().min(1_000).max(120_000).default(15_000),
        // --- PATCH: files/forums/duty/commands (2026-09-27) ---
        // Empty = the classic cloud Bot API (20 MiB file downloads). A http(s) base
        // such as http://127.0.0.1:8081 points at a Local Bot API Server and lifts
        // the path-handle file download limit to 2000 MiB.
        apiBaseUrl: z.string().default(''),
        // Shared secret for /claim <code> pairing from Telegram without editing allowlists.
        claimCode: z.string().default(''),
    }),
    voice: z.object({
        enabled: z.boolean().default(true),
        model: z.union(['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo']).default('small'),
        device: z.union(['auto', 'cpu', 'cuda']).default('auto'),
    }).default(DEFAULT_VOICE_CONFIG),
});
export function installQuestionAnswerer(ctx, bridge) {
    return ctx.on('user-questions/request', async (request, next) => {
        if (request.agent === undefined)
            return next();
        const sessionId = String(request.agent.id);
        const originalSignal = request.signal;
        originalSignal?.throwIfAborted();
        const controller = new AbortController();
        let rejectAborted;
        const aborted = new Promise((_, reject) => { rejectAborted = reject; });
        const abort = () => {
            controller.abort(originalSignal?.reason);
            rejectAborted(originalSignal?.reason);
        };
        originalSignal?.addEventListener('abort', abort, { once: true });
        // Cordis next() shares this request object. Give both answerers a local
        // lifetime so the winner dismisses the other UI without aborting the turn.
        request.signal = controller.signal;
        const unavailable = new Error('No messenger question recipient');
        try {
            const messenger = Promise.resolve().then(() => bridge.askQuestion(sessionId, request.questions, controller.signal)).then((answer) => {
                if (answer === undefined)
                    throw unavailable;
                return answer;
            });
            const downstream = Promise.resolve().then(() => next());
            const firstAnswer = Promise.any([messenger, downstream]).catch((error) => {
                // Preserve the Host's error taxonomy instead of leaking AggregateError.
                const [messengerError, downstreamError] = error.errors;
                if (messengerError === unavailable)
                    throw downstreamError;
                if (downstreamError?.code === 'NO_PROVIDER')
                    throw messengerError;
                throw downstreamError;
            });
            const answer = await Promise.race([firstAnswer, aborted]);
            controller.abort(new QuestionAnsweredElsewhere());
            return answer;
        }
        finally {
            controller.abort();
            originalSignal?.removeEventListener('abort', abort);
            // Keep the completed local lifetime on this event: Remote projection
            // may consume the queued request only after an answer has already won.
        }
    }, { prepend: true });
}
async function startTelegramRuntime(ctx, config, controller, bindingStore, beforeActivate, notificationStore, voiceConfig) {
    if (config.allowedChatIds.length === 0) {
        ctx.logger.warn('messenger: allowedChatIds is empty; all Telegram messages will be ignored');
    }
    const outbound = new Set();
    const sessionEventTails = new Map();
    let acceptingOutbound = true;
    let polling = Promise.resolve();
    let disposeQuestionAnswerer;
    let disposeSessionEvents;
    let bridge;
    let stopped = false;
    const stop = async () => {
        if (stopped)
            return;
        stopped = true;
        acceptingOutbound = false;
        disposeSessionEvents?.();
        disposeQuestionAnswerer?.();
        controller.abort(new Error('messenger Telegram runtime stopped'));
        const disposingBridge = bridge?.dispose();
        await Promise.allSettled([polling, ...outbound]);
        await disposingBridge;
    };
    const tokenRef = credentialRef(TELEGRAM_BOT_TOKEN_REF);
    const adapter = new TelegramAdapter({
        token: async () => {
            const resolved = await ctx.credentials.resolve(tokenRef);
            if (resolved === undefined) {
                throw new Error(`messenger: credential ${TELEGRAM_BOT_TOKEN_REF} is not configured in DSH`);
            }
            if (!TELEGRAM_BOT_TOKEN_PATTERN.test(resolved.value)) {
                throw new Error('messenger: configured Telegram credential is not a bot token');
            }
            return resolved.value;
        },
        pollTimeoutSeconds: config.pollTimeoutSeconds,
        requestTimeoutMs: config.requestTimeoutMs,
        // --- PATCH: files/forums/duty/commands (2026-09-27) ---
        apiBaseUrl: config.apiBaseUrl,
        signal: controller.signal,
        onError: (error, retryDelayMs) => {
            if (retryDelayMs === 0) {
                ctx.logger.warn('messenger: Telegram update handler failed: %o', error);
            }
            else {
                ctx.logger.warn('messenger: Telegram operation failed; retrying in %d ms: %o', retryDelayMs, error);
            }
            // --- PATCH: /diag error ring ---
            try {
                bridge?.recordError?.(`${retryDelayMs === 0 ? 'обработчик' : 'Telegram API'}: ${error instanceof Error ? error.message : String(error)}`);
            }
            catch { /* diagnostics must never break transport */ }
        },
    });
    try {
        await adapter.validate(controller.signal);
        bridge = new MessengerBridge(ctx, {
            allowedChatIds: config.allowedChatIds,
            allowedUserIds: config.allowedUserIds,
            privateChatsOnly: config.privateChatsOnly,
            notificationStore,
            // --- PATCH: files/forums/duty/commands (2026-09-27) ---
            claimCode: config.claimCode,
            ...(voiceConfig.enabled ? { voice: new LocalWhisperTranscriber(voiceConfig) } : {}),
        }, bindingStore);
        bridge.registerAdapter(adapter);
        await beforeActivate();
        if (controller.signal.aborted)
            throw controller.signal.reason;
        // The previous runtime must drain mutations before taking the new snapshot.
        await bridge.restoreBindings();
    }
    catch (error) {
        await stop();
        throw error;
    }
    const readyBridge = bridge;
    if (readyBridge === undefined)
        throw new Error('messenger: bridge initialization failed');
    disposeQuestionAnswerer = installQuestionAnswerer(ctx, readyBridge);
    disposeSessionEvents = ctx.on('session/event', (session, event) => {
        if (!acceptingOutbound)
            return;
        const sessionId = String(session.id);
        const previous = sessionEventTails.get(sessionId) ?? Promise.resolve();
        const task = previous
            .catch(() => undefined)
            .then(() => readyBridge.onSessionEvent(sessionId, event));
        sessionEventTails.set(sessionId, task);
        outbound.add(task);
        void task
            .catch((error) => {
            if (!controller.signal.aborted) {
                ctx.logger.warn('messenger: failed to mirror session event: %o', error);
            }
        })
            .finally(() => {
            outbound.delete(task);
            if (sessionEventTails.get(sessionId) === task)
                sessionEventTails.delete(sessionId);
        });
    });
    polling = adapter
        .start(async (message) => {
        try {
            await readyBridge.handle(message);
        }
        catch (error) {
            if (!controller.signal.aborted) {
                ctx.logger.warn('messenger: Telegram message handling failed: %o', error);
                // --- PATCH: /diag error ring ---
                try {
                    readyBridge.recordError?.(`обработка апдейта: ${error instanceof Error ? error.message : String(error)}`);
                }
                catch { /* diagnostics must never break transport */ }
            }
        }
    }, controller.signal)
        .catch((error) => {
        if (!controller.signal.aborted) {
            ctx.logger.error('messenger: Telegram polling stopped: %o', error);
        }
    });
    ctx.logger.info('messenger: Telegram adapter connected using credential %s', TELEGRAM_BOT_TOKEN_REF);
    return {
        get bridge() { return stopped ? undefined : bridge; },
        stop,
    };
}
export function validateMessengerConfig(config) {
    const voice = config.voice ?? DEFAULT_VOICE_CONFIG;
    if (typeof voice.enabled !== 'boolean'
        || !['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'].includes(voice.model)
        || !['auto', 'cpu', 'cuda'].includes(voice.device)) {
        throw new Error('Invalid local Whisper voice settings');
    }
    const telegram = config.telegram;
    if (telegram.tokenRef !== TELEGRAM_BOT_TOKEN_REF) {
        throw new Error(`Telegram credential reference must be ${TELEGRAM_BOT_TOKEN_REF}`);
    }
    if (!Number.isInteger(telegram.pollTimeoutSeconds)) {
        throw new Error('Telegram long-poll timeout must be an integer');
    }
    if (!Number.isInteger(telegram.requestTimeoutMs)) {
        throw new Error('Telegram request timeout must be an integer');
    }
    if (telegram.enabled && telegram.allowedChatIds.length === 0) {
        throw new Error('Telegram requires at least one allowed chat ID when enabled');
    }
    if (telegram.enabled
        && !telegram.privateChatsOnly
        && telegram.allowedUserIds.length === 0) {
        throw new Error('Telegram group access requires at least one allowed user ID');
    }
    // --- PATCH: files/forums/duty/commands (2026-09-27) ---
    if (telegram.apiBaseUrl !== '' && !/^https?:\/\//i.test(telegram.apiBaseUrl.trim())) {
        throw new Error('Telegram apiBaseUrl must be empty or start with http:// or https://');
    }
    if (telegram.claimCode !== '' && (telegram.claimCode.trim().length < 4
        || telegram.claimCode.trim().length > 128
        || /\s/.test(telegram.claimCode.trim()))) {
        throw new Error('Telegram claimCode must be 4-128 characters without whitespace (or empty to disable /claim)');
    }
}
function telegramAccessPolicy(config) {
    return JSON.stringify({
        allowedChatIds: [...new Set(config.allowedChatIds)].sort(),
        allowedUserIds: [...new Set(config.allowedUserIds)].sort(),
        privateChatsOnly: config.privateChatsOnly,
    });
}
export async function apply(ctx, entryConfig) {
    let source = () => entryConfig;
    let active;
    let activeAccessPolicy;
    let candidate;
    let disposed = false;
    let generation = 0;
    let tail = Promise.resolve();
    const bindingStore = await DurableMessengerBindingStore.open(ctx);
    const reconcile = () => {
        const requestedGeneration = ++generation;
        candidate?.abort(new Error('messenger configuration superseded'));
        const run = tail.then(async () => {
            if (disposed || requestedGeneration !== generation)
                return;
            const current = source();
            try {
                validateMessengerConfig(current);
            }
            catch (error) {
                await active?.stop();
                active = undefined;
                activeAccessPolicy = undefined;
                ctx.logger.error('messenger: configuration is invalid: %o', error);
                return;
            }
            if (!current.telegram.enabled) {
                await active?.stop();
                active = undefined;
                activeAccessPolicy = undefined;
                ctx.logger.info('messenger: Telegram adapter is disabled');
                return;
            }
            const requestedAccessPolicy = telegramAccessPolicy(current.telegram);
            let previous = active;
            if (previous !== undefined && activeAccessPolicy !== requestedAccessPolicy) {
                await previous.stop();
                if (active === previous)
                    active = undefined;
                activeAccessPolicy = undefined;
                previous = undefined;
            }
            const controller = new AbortController();
            candidate = controller;
            try {
                const next = await startTelegramRuntime(ctx, current.telegram, controller, bindingStore, async () => {
                    if (disposed || requestedGeneration !== generation) {
                        controller.abort(new Error('messenger configuration superseded'));
                        throw controller.signal.reason;
                    }
                    await previous?.stop();
                    if (active === previous)
                        active = undefined;
                }, notificationStore, current.voice ?? DEFAULT_VOICE_CONFIG);
                if (disposed || requestedGeneration !== generation) {
                    await next.stop();
                    return;
                }
                active = next;
                activeAccessPolicy = requestedAccessPolicy;
            }
            catch (error) {
                if (!controller.signal.aborted) {
                    ctx.logger.error('messenger: Telegram adapter could not start: %o', error);
                }
            }
            finally {
                if (candidate === controller)
                    candidate = undefined;
            }
        });
        tail = run.catch((error) => {
            ctx.logger.error('messenger: configuration reconciliation failed: %o', error);
        });
        return tail;
    };
    ctx.effect(() => async () => {
        disposed = true;
        generation += 1;
        candidate?.abort(new Error('messenger plugin disposed'));
        const errors = [];
        try {
            await tail;
        }
        catch (error) {
            errors.push(error);
        }
        try {
            await active?.stop();
        }
        catch (error) {
            errors.push(error);
        }
        active = undefined;
        activeAccessPolicy = undefined;
        try {
            await bindingStore.close();
        }
        catch (error) {
            errors.push(error);
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, 'messenger runtime disposal failed');
        }
    }, 'messenger.runtime');
    let notificationStore;
    try {
        notificationStore = await openNotificationStore(ctx);
        const activeBridges = () => {
            const bridge = disposed ? undefined : active?.bridge;
            return bridge === undefined ? [] : [bridge];
        };
        installNotificationTool(ctx, activeBridges);
        installImageTool(ctx, activeBridges);
        installVoiceTool(ctx, activeBridges);
    }
    catch (error) {
        await bindingStore.close();
        throw error;
    }
    const unwrapDoc = (doc) => {
        const out = {};
        for (const key of Object.keys(doc ?? {})) {
            const v = doc[key];
            out[key] = (v && typeof v === 'object' && typeof v.get === 'function') ? v.get() : v;
        }
        return out;
    };
    if (typeof ctx.settings?.register === 'function') {
        const settings = ctx.settings.register(MESSENGER_SETTINGS_NAMESPACE, Config, {
            base: entryConfig,
            validate: validateMessengerConfig,
        });
                source = () => unwrapDoc(settings.get());
        settings.watch(() => reconcile());
    }
    else {
        // PATCH: dsh 0.1.7 has no ctx.settings.register — fall back to the static
        // entryConfig (volatile fields of the plugin entry's Config, see cordis.patch.yml).
        source = () => unwrapDoc(entryConfig);
    }
    ctx.on('credentials/reference-updated', (ref) => {
        if (String(ref) === TELEGRAM_BOT_TOKEN_REF)
            void reconcile();
    });
    await reconcile();
}
//# sourceMappingURL=index.js.map//#region PATCH:messenger-volatile-config — telegram/voice as live form fields (dsh 0.1.7 entry forms)
// dsh 0.1.7 serves settings through volatile fields of the plugin entry's Config;
// without this the messenger settings page stays unavailable. See
// /opt/dsh-upgrade-backup-20260927/messenger-server-volatile-patch.mjs
for (const key of ["telegram", "voice"]) {
  const child = Config.dict?.[key] ?? Config.inner?.[key];
  if (child?.meta) child.meta.volatile = true;
}
//#endregion
