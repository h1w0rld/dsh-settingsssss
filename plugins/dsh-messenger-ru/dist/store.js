import { Buffer } from 'node:buffer';
import { defineDomain, domainTable, } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
const messengerChatKindSchema = z.enum([
    'private',
    'group',
    'supergroup',
    'channel',
]);
export const messengerBindingRecordSchema = z.object({
    transport: z.string().min(1),
    chatId: z.string().min(1),
    chatKind: messengerChatKindSchema.optional(),
    senderId: z.string().min(1),
    authorizedAs: z.string().min(1).optional(),
    sessionId: z.string().min(1),
    sessionCwd: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
});
export const messengerBindingDomainSpec = defineDomain({
    name: 'messenger_bindings',
    version: 1,
    layout: 'per-record',
    invalidRecords: 'backup-and-skip',
    tables: {
        bindings: domainTable(messengerBindingRecordSchema),
    },
});
export function messengerBindingKey(transport, chatId, senderId) {
    const encoded = Buffer.from(JSON.stringify([transport, chatId, senderId]), 'utf8').toString('base64url');
    return `v1_${encoded}`;
}
export function messengerBindingIdentity(key) {
    if (!key.startsWith('v1_'))
        throw new Error('Invalid messenger binding identity.');
    const encoded = key.slice(3);
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed)
        || parsed.length !== 3
        || parsed.some((part) => typeof part !== 'string' || part.length === 0))
        throw new Error('Invalid messenger binding identity.');
    const [transport, chatId, senderId] = parsed;
    if (messengerBindingKey(transport, chatId, senderId) !== key) {
        throw new Error('Invalid messenger binding identity.');
    }
    return { transport, chatId, senderId };
}
export class MemoryMessengerBindingStore {
    records = new Map();
    constructor(records = []) {
        for (const record of records) {
            this.records.set(messengerBindingKey(record.transport, record.chatId, record.senderId), record);
        }
    }
    list() {
        return [...this.records.values()];
    }
    async put(record) {
        this.records.set(messengerBindingKey(record.transport, record.chatId, record.senderId), record);
    }
    async delete(transport, chatId, senderId) {
        return this.records.delete(messengerBindingKey(transport, chatId, senderId));
    }
    async close() { }
}
export class DurableMessengerBindingStore {
    domain;
    table;
    constructor(domain, table) {
        this.domain = domain;
        this.table = table;
    }
    static async open(ctx) {
        const domain = await ctx.storageDomain.open(messengerBindingDomainSpec);
        return new DurableMessengerBindingStore(domain, domain.table('bindings'));
    }
    list() {
        return [...this.table.entries()].map(([, record]) => record);
    }
    async put(record) {
        await this.table.put(messengerBindingKey(record.transport, record.chatId, record.senderId), record);
    }
    delete(transport, chatId, senderId) {
        return this.table.delete(messengerBindingKey(transport, chatId, senderId));
    }
    close() {
        return this.domain.close();
    }
}
//# sourceMappingURL=store.js.map