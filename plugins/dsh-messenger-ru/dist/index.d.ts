import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { MessengerBridge } from './bridge.js';
import { type VoiceConfig } from './voice.js';
export { MessengerBridge, parseCommand } from './bridge.js';
export { LocalWhisperTranscriber, DEFAULT_VOICE_CONFIG } from './voice.js';
export type { VoiceConfig, VoiceTranscriber } from './voice.js';
export { TelegramAdapter, TelegramApiError, splitTelegramText } from './telegram.js';
export { DurableMessengerBindingStore, MemoryMessengerBindingStore, messengerBindingDomainSpec, messengerBindingIdentity, messengerBindingKey, messengerBindingRecordSchema, } from './store.js';
export type { MessengerBindingRecord, MessengerBindingStore } from './store.js';
export type { InboundMessengerMessage, InboundVoiceMessage, InboundImageMessage, MessengerImage, MessengerAdapter, ParsedCommand, } from './types.js';
export declare const name = "messenger";
export declare const inject: string[];
export declare const MESSENGER_SETTINGS_NAMESPACE = "messenger";
export declare const TELEGRAM_BOT_TOKEN_REF = "TELEGRAM_BOT_TOKEN";
export interface TelegramConfig {
    enabled: boolean;
    tokenRef: string;
    allowedChatIds: string[];
    allowedUserIds: string[];
    privateChatsOnly: boolean;
    pollTimeoutSeconds: number;
    requestTimeoutMs: number;
    /** Empty = cloud Bot API; http(s) base = Local Bot API Server (2000 MiB file downloads). */
    apiBaseUrl: string;
    /** Shared secret for /claim <code> operator pairing; empty disables /claim. */
    claimCode: string;
}
export interface Config {
    telegram: TelegramConfig;
    /** Optional for compatibility with existing entry configurations. */
    voice?: VoiceConfig;
}
export declare const Config: z<Config>;
export declare function installQuestionAnswerer(ctx: Context, bridge: MessengerBridge): () => boolean;
export declare function validateMessengerConfig(config: Config): void;
export declare function apply(ctx: Context, entryConfig: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map