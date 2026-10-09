import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { InboundTextMessage, MessengerChatKind } from './types.js';
export interface Subscription {
    id: string;
    transport: string;
    chatId: string;
    chatKind?: MessengerChatKind | undefined;
    senderId: string;
    senderAliases?: readonly string[] | undefined;
}
export interface NotificationLink {
    token: string;
    subscriptionId: string;
    transport: string;
    chatId: string;
    senderId: string;
    sessionId: string;
    expiresAt: number;
}
export declare const NOTIFICATION_LINK_TTL_MS: number;
export declare const MAX_NOTIFICATION_LINKS = 4096;
declare const stateSchema: z.ZodObject<{
    subscriptions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        transport: z.ZodString;
        chatId: z.ZodString;
        chatKind: z.ZodOptional<z.ZodEnum<{
            private: "private";
            group: "group";
            supergroup: "supergroup";
            channel: "channel";
        }>>;
        senderId: z.ZodString;
        senderAliases: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    links: z.ZodArray<z.ZodObject<{
        token: z.ZodString;
        subscriptionId: z.ZodString;
        transport: z.ZodString;
        chatId: z.ZodString;
        senderId: z.ZodString;
        sessionId: z.ZodString;
        expiresAt: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type NotificationState = z.infer<typeof stateSchema>;
/** One shared store per plugin instance; the save callback must be durable. */
export declare class NotificationStore {
    private readonly save;
    private readonly now;
    private state;
    private tail;
    private closed;
    constructor(initial: unknown, save: (state: NotificationState) => Promise<void>, now?: () => number);
    list(transport: string): Subscription[];
    get(transport: string, chatId: string): Subscription | undefined;
    subscribe(message: InboundTextMessage): Promise<Subscription>;
    unsubscribe(transport: string, chatId: string): Promise<void>;
    createLink(subscription: Subscription, sessionId: string): Promise<string>;
    link(token: string): NotificationLink | undefined;
    /** Drain compound read-modify-write operations before closing persistence. */
    flush(): Promise<void>;
    /** Stop accepting mutations immediately, then drain already accepted work. */
    close(): Promise<void>;
    private change;
}
/** Requires the host's `storageDomain` service (DSH base provides it). */
export declare function openNotificationStore(ctx: Context): Promise<NotificationStore>;
export {};
//# sourceMappingURL=notification-store.d.ts.map