import type { Context } from '@deepseek-ai/cordis';
import type { MessengerBridge } from './bridge.js';
/** Registered once; resolve the live runtime on every call after reconfiguration. */
export declare function installNotificationTool(ctx: Context, getActiveBridges: () => readonly MessengerBridge[]): () => void;
//# sourceMappingURL=notifications.d.ts.map