import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { MessengerChatKind } from './types.js';
export declare const messengerBindingRecordSchema: z.ZodObject<{
    transport: z.ZodString;
    chatId: z.ZodString;
    chatKind: z.ZodOptional<z.ZodEnum<{
        private: "private";
        group: "group";
        supergroup: "supergroup";
        channel: "channel";
    }>>;
    senderId: z.ZodString;
    authorizedAs: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodString;
    sessionCwd: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodString;
}, z.core.$strip>;
export interface MessengerBindingRecord {
    readonly transport: string;
    readonly chatId: string;
    readonly chatKind?: MessengerChatKind | undefined;
    readonly senderId: string;
    readonly authorizedAs?: string | undefined;
    readonly sessionId: string;
    readonly sessionCwd?: string | undefined;
    readonly updatedAt: string;
}
export type MessengerBindingKey = string & {
    readonly __messengerBindingKey: unique symbol;
};
export declare const messengerBindingDomainSpec: {
    name: string;
    version: number;
    layout: "per-record";
    invalidRecords: "backup-and-skip";
    tables: {
        bindings: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<MessengerBindingKey, MessengerBindingRecord>;
    };
};
export interface MessengerBindingIdentity {
    readonly transport: string;
    readonly chatId: string;
    readonly senderId: string;
}
export declare function messengerBindingKey(transport: string, chatId: string, senderId: string): MessengerBindingKey;
export declare function messengerBindingIdentity(key: string): MessengerBindingIdentity;
export interface MessengerBindingStore {
    list(): readonly MessengerBindingRecord[];
    put(record: MessengerBindingRecord): Promise<void>;
    delete(transport: string, chatId: string, senderId: string): Promise<boolean>;
    close(): Promise<void>;
}
export declare class MemoryMessengerBindingStore implements MessengerBindingStore {
    private readonly records;
    constructor(records?: readonly MessengerBindingRecord[]);
    list(): readonly MessengerBindingRecord[];
    put(record: MessengerBindingRecord): Promise<void>;
    delete(transport: string, chatId: string, senderId: string): Promise<boolean>;
    close(): Promise<void>;
}
export declare class DurableMessengerBindingStore implements MessengerBindingStore {
    private readonly domain;
    private readonly table;
    private constructor();
    static open(ctx: Pick<Context, 'storageDomain'>): Promise<DurableMessengerBindingStore>;
    list(): readonly MessengerBindingRecord[];
    put(record: MessengerBindingRecord): Promise<void>;
    delete(transport: string, chatId: string, senderId: string): Promise<boolean>;
    close(): Promise<void>;
}
//# sourceMappingURL=store.d.ts.map