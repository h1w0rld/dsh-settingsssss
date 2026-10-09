import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { decodeImage, IMAGE_BYTE_LIMIT } from './images.js';
const NEVER_ABORTED = new AbortController().signal;
function projectionValues(summary) {
    return (summary.projections?.values ?? {});
}
function contextFrom(values) {
    return {
        ...values.contextPressure,
        ...values.contextBreakdown,
        ...values.tokenUsage,
    };
}
function permissionFrom(values, service) {
    const projected = values.permissions;
    const options = projected?.options?.filter((option) => option.value !== 'custom')
        ?? service.names.map((name) => service.optionOf(name));
    return {
        current: projected?.currentValue ?? service.defaultPreset,
        options,
    };
}
export function sessionTitle(summary) {
    const title = projectionValues(summary).title?.trim();
    if (title)
        return title;
    if (summary.cwd) {
        const normalized = summary.cwd.replace(/[\\/]+$/, '');
        const leaf = normalized.split(/[\\/]/).pop();
        if (leaf)
            return leaf;
    }
    return 'Untitled session';
}
export class DshControl {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    async listSessions() {
        const listed = await this.ctx.sessionController.list({}, NEVER_ABORTED);
        return listed.items.filter((item) => item.origin !== 'subagent');
    }
    async listWorkspaces() {
        return this.ctx.workspaceRegistry.list().map((workspace) => ({
            workspaceId: workspace.id,
            path: workspace.path,
            title: workspace.title,
            sessionIds: workspace.sessionIds,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
        }));
    }
    async workspaceTitle(cwd) {
        if (cwd === undefined)
            return undefined;
        const stripped = cwd.replace(/[\\/]+$/, '');
        const normalized = stripped || cwd;
        const workspaces = await this.listWorkspaces();
        const matched = workspaces.find((workspace) => {
            const workspaceStripped = workspace.path.replace(/[\\/]+$/, '');
            return (workspaceStripped || workspace.path) === normalized;
        });
        if (matched?.title.trim())
            return matched.title.trim();
        return normalized.split(/[\\/]/).pop() || normalized;
    }
    async createSession(workspaceId) {
        const created = await this.ctx.sessionController.create(workspaceId === undefined ? {} : { workspaceId });
        return String(created.sessionId);
    }
    async prompt(sessionId, text, mode, image, signal = NEVER_ABORTED, extraImages = []) {
        const content = text ? [{ type: 'text', text }] : [];
        const allImages = image !== undefined ? [image, ...extraImages] : extraImages;
        for (const item of allImages) {
            content.push({
                type: 'image', mediaType: item.mimeType, data: Buffer.from(item.bytes).toString('base64'),
            });
        }
        await this.ctx.sessionController.prompt({
            requestId: randomUUID(),
            sessionId: SessionId(sessionId),
            mode,
            content,
        }, signal);
    }
    async image(sessionId, image) {
        if (!Number.isSafeInteger(image.attachment.bytes) || image.attachment.bytes <= 0 || image.attachment.bytes > IMAGE_BYTE_LIMIT) {
            throw new Error('Response image exceeds messenger limits.');
        }
        const result = await this.ctx.sessionController.attachment({
            sessionId: SessionId(sessionId), attachmentId: image.attachment.attachmentId,
        });
        return decodeImage(result.data);
    }
    async models(sessionId) {
        const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId));
        if ('error' in resolved)
            throw resolved.error;
        const catalog = await this.ctx.sessionController.modelCatalog();
        const current = {
            provider: resolved.agent.options.provider ?? catalog.default.provider,
            model: resolved.agent.options.model ?? catalog.default.model,
            ...(resolved.agent.options.reasoningEffort === undefined
                ? catalog.default.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: catalog.default.reasoningEffort }
                : { reasoningEffort: String(resolved.agent.options.reasoningEffort) }),
        };
        return {
            current,
            routable: catalog.routableProviders.includes(current.provider),
            groups: catalog.groups,
            failures: catalog.failures,
        };
    }
    async selectModel(sessionId, provider, model, reasoningEffort) {
        const selected = await this.ctx.sessionController.selectModel({
            sessionId: SessionId(sessionId),
            provider,
            model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        });
        return selected.selected;
    }
    async snapshot(sessionId) {
        const model = await this.models(sessionId);
        const summaries = await this.listSessions();
        const summary = summaries.find((item) => String(item.sessionId) === sessionId);
        if (summary === undefined)
            throw new Error(`Session ${sessionId} was not found.`);
        const values = projectionValues(summary);
        return {
            summary,
            model,
            permission: permissionFrom(values, this.ctx.permissionPresets),
            context: contextFrom(values),
        };
    }
    async permission(sessionId) {
        const snapshot = await this.snapshot(sessionId);
        return snapshot.permission;
    }
    async setPermission(sessionId, preset) {
        const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId));
        if ('error' in resolved)
            throw resolved.error;
        this.ctx.permissionPresets.set(resolved.agent.session, preset);
    }
    async cancel(sessionId) {
        const agent = this.ctx.agents.get(SessionId(sessionId));
        if (agent === undefined || agent.status !== 'running')
            return false;
        await this.ctx.sessionController.cancel({
            sessionId: SessionId(sessionId),
        });
        return true;
    }
    status(sessionId) {
        const agent = this.ctx.agents.get(SessionId(sessionId));
        return agent?.status ?? 'dormant';
    }
    static groups(models) {
        return models.groups;
    }
}
export function visibleAssistantText(event) {
    if (event.type !== 'assistant/message' || event.surfaceOp !== 'append')
        return undefined;
    const text = event.data.message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();
    return text || undefined;
}
//# sourceMappingURL=control.js.map