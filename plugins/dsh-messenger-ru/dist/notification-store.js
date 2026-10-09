import { randomBytes } from 'node:crypto';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
export const NOTIFICATION_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_NOTIFICATION_LINKS = 4096;
const identifier = z.string().min(1);
const subscriptionSchema = z.object({
    id: identifier,
    transport: identifier,
    chatId: identifier,
    chatKind: z.enum(['private', 'group', 'supergroup', 'channel']).optional(),
    senderId: identifier,
    senderAliases: z.array(identifier).optional(),
}).strict();
const linkSchema = z.object({
    token: identifier,
    subscriptionId: identifier,
    transport: identifier,
    chatId: identifier,
    senderId: identifier,
    sessionId: identifier,
    expiresAt: z.number().int().nonnegative(),
}).strict();
const stateSchema = z.object({
    subscriptions: z.array(subscriptionSchema),
    links: z.array(linkSchema).max(MAX_NOTIFICATION_LINKS),
}).strict().superRefine((state, ctx) => {
    const ids = new Set();
    const chats = new Set();
    const tokens = new Set();
    for (const item of state.subscriptions) {
        const chat = JSON.stringify([item.transport, item.chatId]);
        if (ids.has(item.id) || chats.has(chat)) {
            ctx.addIssue({ code: 'custom', message: 'Duplicate notification subscription' });
        }
        ids.add(item.id);
        chats.add(chat);
    }
    for (const item of state.links) {
        const owner = state.subscriptions.find((s) => s.id === item.subscriptionId);
        if (tokens.has(item.token) || !owner || owner.transport !== item.transport ||
            owner.chatId !== item.chatId || owner.senderId !== item.senderId) {
            ctx.addIssue({ code: 'custom', message: 'Invalid notification link ownership' });
        }
        tokens.add(item.token);
    }
});
const notificationDomain = defineDomain({
    name: 'messenger_notifications',
    version: 1,
    global: {
        schema: stateSchema,
        initial: { subscriptions: [], links: [] },
    },
    tables: {},
});
/** One shared store per plugin instance; the save callback must be durable. */
export class NotificationStore {
    save;
    now;
    state;
    tail = Promise.resolve();
    closed = false;
    constructor(initial, save, now = Date.now) {
        this.save = save;
        this.now = now;
        this.state = stateSchema.parse(initial);
    }
    list(transport) {
        return structuredClone(this.state.subscriptions.filter((s) => s.transport === transport));
    }
    get(transport, chatId) {
        const item = this.state.subscriptions.find((s) => s.transport === transport && s.chatId === chatId);
        return item && structuredClone(item);
    }
    subscribe(message) {
        return this.change((state) => {
            const previous = state.subscriptions.find((s) => s.transport === message.transport && s.chatId === message.chatId);
            const sameOwner = previous?.senderId === message.senderId;
            const subscription = subscriptionSchema.parse({
                id: sameOwner ? previous.id : randomBytes(18).toString('base64url'),
                transport: message.transport,
                chatId: message.chatId,
                chatKind: message.chatKind,
                senderId: message.senderId,
                senderAliases: message.senderAliases && [...message.senderAliases],
            });
            state.subscriptions = state.subscriptions.filter((s) => s.transport !== message.transport || s.chatId !== message.chatId);
            state.subscriptions.push(subscription);
            if (previous && !sameOwner) {
                state.links = state.links.filter((link) => link.subscriptionId !== previous.id);
            }
            return subscription;
        });
    }
    unsubscribe(transport, chatId) {
        return this.change((state) => {
            const previous = state.subscriptions.find((s) => s.transport === transport && s.chatId === chatId);
            if (!previous)
                return;
            state.subscriptions = state.subscriptions.filter((s) => s.id !== previous.id);
            state.links = state.links.filter((link) => link.subscriptionId !== previous.id);
        });
    }
    createLink(subscription, sessionId) {
        return this.change((state) => {
            const owner = state.subscriptions.find((s) => s.id === subscription.id);
            if (!owner || owner.transport !== subscription.transport ||
                owner.chatId !== subscription.chatId || owner.senderId !== subscription.senderId) {
                throw new Error('Notification subscription is no longer current');
            }
            let token;
            do {
                token = randomBytes(24).toString('base64url');
            } while (state.links.some((link) => link.token === token));
            state.links.push(linkSchema.parse({
                token,
                subscriptionId: owner.id,
                transport: owner.transport,
                chatId: owner.chatId,
                senderId: owner.senderId,
                sessionId,
                expiresAt: this.now() + NOTIFICATION_LINK_TTL_MS,
            }));
            // Insertion order is persisted; evict the oldest issued records first.
            state.links = state.links.slice(-MAX_NOTIFICATION_LINKS);
            return token;
        });
    }
    link(token) {
        const item = this.state.links.find((link) => link.token === token);
        return item && item.expiresAt > this.now() ? structuredClone(item) : undefined;
    }
    /** Drain compound read-modify-write operations before closing persistence. */
    async flush() { await this.tail; }
    /** Stop accepting mutations immediately, then drain already accepted work. */
    async close() {
        this.closed = true;
        await this.flush();
    }
    change(mutate) {
        if (this.closed)
            return Promise.reject(new Error('Notification store is closed'));
        const operation = this.tail.then(async () => {
            const next = structuredClone(this.state);
            next.links = next.links.filter((link) => link.expiresAt > this.now());
            const result = mutate(next);
            const validated = stateSchema.parse(next);
            await this.save(structuredClone(validated));
            this.state = validated;
            return structuredClone(result);
        });
        this.tail = operation.then(() => undefined, () => undefined);
        return operation;
    }
}
/** Requires the host's `storageDomain` service (DSH base provides it). */
export async function openNotificationStore(ctx) {
    const domain = await ctx.storageDomain.open(notificationDomain);
    let store;
    try {
        store = new NotificationStore(domain.global.get(), (state) => domain.global.set(state));
    }
    catch (error) {
        await domain.close();
        throw error;
    }
    ctx.effect(() => async () => {
        // Cordis runs separate effect disposers concurrently, including runtime stop.
        // Reject late mutations while draining accepted operations before backend close.
        await store.close();
        await domain.close();
    }, 'messenger.notification-store');
    return store;
}
//# sourceMappingURL=notification-store.js.map