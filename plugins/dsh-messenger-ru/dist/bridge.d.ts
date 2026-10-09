import type { Context } from '@deepseek-ai/cordis';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type { NotificationStore } from './notification-store.js';
import { type VoiceTranscriber } from './voice.js';
import { type MessengerBindingStore } from './store.js';
import type { InboundMessengerMessage, MessengerImage, MessengerAdapter, ParsedCommand } from './types.js';
/** Ends a mirrored question without cancelling the agent's turn. */
export declare class QuestionAnsweredElsewhere extends Error {
    constructor();
}
export type BridgeContext = {
    readonly agents: AgentRegistry;
    readonly sessionController: SessionController;
    readonly workspaceRegistry: WorkspaceRegistry;
    readonly permissionPresets: PermissionPresetService;
    readonly logger: Context['logger'];
};
export interface MessengerBridgeOptions {
    /** Bridge owns this service and disposes it with the runtime. */
    readonly voice?: VoiceTranscriber;
    readonly notificationStore?: NotificationStore;
    readonly allowedChatIds: readonly string[];
    readonly allowedUserIds: readonly string[];
    readonly privateChatsOnly: boolean;
    /** Shared secret for /claim <code> pairing; empty disables /claim. */
    readonly claimCode?: string;
}
type QuestionItem = AskUserQuestionItem;
export declare function parseCommand(text: string): ParsedCommand | undefined;
export declare class MessengerBridge {
    private readonly ctx;
    private readonly bindingStore;
    private readonly allowedChatIds;
    private readonly allowedUserIds;
    private readonly privateChatsOnly;
    private readonly bindings;
    private readonly bindingUpdatedAt;
    private readonly bindingRevisions;
    private readonly adapters;
    private readonly outboundQueues;
    private readonly actionQueues;
    private readonly callbacks;
    private readonly progress;
    private readonly questionRequests;
    private readonly pendingQuestions;
    private readonly questionRetries;
    private readonly questionRetryDelays;
    private readonly resolvingQuestions;
    private readonly control;
    private readonly notificationStore;
    private readonly voice;
    private readonly voiceJobs;
    private readonly imageController;
    private activeImageDownloads;
    private readonly mirroredImageMessages;
    private nextThinkingOffset;
    private disposed;
    constructor(ctx: BridgeContext, options: MessengerBridgeOptions, bindingStore?: MessengerBindingStore);
    restoreBindings(): Promise<void>;
    registerAdapter(adapter: MessengerAdapter): void;
    handle(message: InboundMessengerMessage): Promise<void>;
    private handleImage;
    private cancelVoice;
    private voiceTargetCurrent;
    private acceptVoice;
    private runVoice;
    private handleTextMessage;
    /** Content only: transcripts must never pass through the command parser. */
    private handleUserText;
    onSessionEvent(sessionId: string, event: SessionEvent): Promise<void>;
    private notificationRecipients;
    canSendImage(sessionId: string): boolean;
    /** Process-local binding fence for file exports prepared asynchronously. */
    imageBindingVersion(sessionId: string): string;
    /** Explicit export to current session bindings, never notification subscribers. */
    sendImage(sessionId: string, image: MessengerImage, signal?: AbortSignal): Promise<{
        sent: number;
        failed: number;
        skipped: number;
    }>;
    canNotify(sessionId: string): boolean;
    private handleNotificationsCommand;
    private notifySubscribers;
    /** Send to durable subscribers; standalone library bridges without a store retain legacy binding delivery. */
    notify(sessionId: string, text: string, signal?: AbortSignal): Promise<{
        sent: number;
        failed: number;
        skipped: number;
    }>;
    askQuestion(sessionId: string, questions: readonly QuestionItem[], signal?: AbortSignal): Promise<AskUserQuestionAnswer | undefined>;
    onQuestionRequested(rpcId: string, sessionId: string, questions: readonly QuestionItem[], submit?: (answer: AskUserQuestionAnswer) => Promise<boolean>, reject?: (reason: unknown) => void): Promise<void>;
    private promotePendingQuestion;
    onQuestionResolved(questionRpcId: string, outcome?: 'answered' | 'cancelled'): Promise<void>;
    private settleQuestion;
    dispose(): Promise<void>;
    private authorized;
    private handleNotificationCallback;
    private authorizedBinding;
    private authorizationIdentity;
    private handleCallback;
    private runAction;
    private handleCommand;
    private startQuestionForBinding;
    private clearQuestionRetry;
    private scheduleQuestionRetry;
    private clearQuestionRetriesForRpc;
    private renderQuestion;
    private clearQuestionCallbacks;
    private currentQuestion;
    private selectQuestionOption;
    private toggleQuestionOption;
    private submitQuestionSelection;
    private answerQuestionWithText;
    private advanceQuestion;
    private showSessions;
    private bindSession;
    private showWorkspaces;
    private createSession;
    private showDashboard;
    private showModels;
    private showProviderModels;
    private selectModel;
    private showReasoning;
    private selectReasoning;
    private showPermissions;
    private setPermission;
    private showContext;
    private cancel;
    private mainKeyboard;
    private button;
    private pruneCallbacks;
    private binding;
    private bindingRecipients;
    private beginProgress;
    private beginProgressForBindings;
    private progressStates;
    private hasBindings;
    private scheduleProgressEdits;
    private flushProgress;
    private finalizeProgress;
    private failProgress;
    private startAnimation;
    private stopAnimation;
    private startTyping;
    private stopTyping;
    private stopProgressTimers;
    private sendToBindings;
    private enqueueAction;
    private enqueueOutbound;
    private logProgressError;
    private errorMessage;
}
export {};
//# sourceMappingURL=bridge.d.ts.map