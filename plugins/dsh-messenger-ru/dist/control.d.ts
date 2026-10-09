import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { ModelCatalogFailure, ModelProviderGroup, ModelSelection, SessionSummary, SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { AssistantImage } from './images.js';
import type { MessengerImage } from './types.js';
export interface SessionModels {
    readonly current: ModelSelection;
    readonly routable: boolean;
    readonly groups: readonly ModelProviderGroup[];
    readonly failures: readonly ModelCatalogFailure[];
}
export interface WorkspaceView {
    readonly workspaceId: WorkspaceId;
    readonly path: string;
    readonly title: string;
    readonly sessionIds: readonly SessionId[];
    readonly createdAt: string;
    readonly updatedAt: string;
}
export interface SessionContextInfo {
    readonly pressureTokens?: number;
    readonly projectedTokens?: number;
    readonly contextWindow?: number;
    readonly systemTokens?: number;
    readonly toolsTokens?: number;
    readonly messageTokens?: number;
    readonly uncachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}
export interface PermissionView {
    readonly current: string;
    readonly options: readonly {
        readonly value: string;
        readonly name: string;
        readonly description?: string;
    }[];
}
export interface SessionSnapshot {
    readonly summary: SessionSummary;
    readonly model: SessionModels;
    readonly permission: PermissionView;
    readonly context: SessionContextInfo;
}
export interface ControlContext {
    readonly agents: AgentRegistry;
    readonly sessionController: SessionController;
    readonly workspaceRegistry: WorkspaceRegistry;
    readonly permissionPresets: PermissionPresetService;
}
export declare function sessionTitle(summary: SessionSummary): string;
export declare class DshControl {
    private readonly ctx;
    constructor(ctx: ControlContext);
    listSessions(): Promise<SessionSummary[]>;
    listWorkspaces(): Promise<WorkspaceView[]>;
    workspaceTitle(cwd: string | undefined): Promise<string | undefined>;
    createSession(workspaceId?: WorkspaceId): Promise<string>;
    prompt(sessionId: string, text: string, mode: 'queue' | 'steer', image?: MessengerImage, signal?: AbortSignal): Promise<void>;
    image(sessionId: string, image: AssistantImage): Promise<MessengerImage>;
    models(sessionId: string): Promise<SessionModels>;
    selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<ModelSelection>;
    snapshot(sessionId: string): Promise<SessionSnapshot>;
    permission(sessionId: string): Promise<PermissionView>;
    setPermission(sessionId: string, preset: string): Promise<void>;
    cancel(sessionId: string): Promise<boolean>;
    status(sessionId: string): 'running' | 'idle' | 'dormant';
    static groups(models: SessionModels): readonly ModelProviderGroup[];
}
export declare function visibleAssistantText(event: SessionEvent): string | undefined;
//# sourceMappingURL=control.d.ts.map