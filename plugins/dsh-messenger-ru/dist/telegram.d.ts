import type { InboundImageMessage, InboundMessengerMessage, InboundVoiceMessage, MessengerAdapter, MessengerImage, MessengerInlineKeyboard, MessengerMessageHandle, SendTextOptions } from './types.js';
export interface TelegramAdapterOptions {
    readonly token: string | (() => Promise<string>);
    readonly pollTimeoutSeconds: number;
    readonly requestTimeoutMs: number;
    readonly signal?: AbortSignal;
    readonly fetch?: typeof globalThis.fetch;
    readonly onError?: (error: unknown, retryDelayMs: number) => void;
}
export declare class TelegramApiError extends Error {
    readonly description: string;
    readonly errorCode?: number;
    readonly retryAfter?: number;
    readonly error_code?: number;
    readonly retry_after?: number;
    constructor(operation: string, description: string, details?: {
        readonly errorCode?: number;
        readonly retryAfter?: number;
    });
}
/** Convert common model Markdown into Telegram's supported HTML subset. */
export declare function renderTelegramMarkdown(text: string): string;
/** Split generated Telegram HTML while closing and reopening formatting tags. */
export declare function splitTelegramHtml(html: string, limit?: number): string[];
export declare function splitTelegramText(text: string, limit?: number): string[];
export declare class TelegramAdapter implements MessengerAdapter {
    private readonly options;
    readonly id = "telegram";
    readonly textLimit = 4096;
    private readonly fetchImpl;
    private botUsername;
    private commandsRegistered;
    private outboundRetryAt;
    private checkOutboundCooldown;
    constructor(options: TelegramAdapterOptions);
    textLength(text: string): number;
    validate(signal?: AbortSignal): Promise<void>;
    start(onMessage: (message: InboundMessengerMessage) => Promise<void>, signal: AbortSignal): Promise<void>;
    sendText(chatId: string, text: string, options?: SendTextOptions): Promise<MessengerMessageHandle>;
    editText(chatId: string, messageId: string, text: string, keyboard?: MessengerInlineKeyboard): Promise<void>;
    replaceText(chatId: string, messageId: string, text: string, keyboard?: MessengerInlineKeyboard): Promise<void>;
    private sendHtmlText;
    private editHtmlText;
    answerCallback(callbackQueryId: string, text?: string, showAlert?: boolean): Promise<void>;
    sendTyping(chatId: string): Promise<void>;
    sendImage(chatId: string, image: MessengerImage, signal?: AbortSignal): Promise<MessengerMessageHandle>;
    downloadVoice(message: InboundVoiceMessage, signal: AbortSignal): Promise<Uint8Array>;
    downloadImage(message: InboundImageMessage, signal: AbortSignal): Promise<Uint8Array>;
    private downloadFile;
    private resolveToken;
    private loadBotUsername;
    private registerCommands;
    private call;
}
//# sourceMappingURL=telegram.d.ts.map