import type { Context } from '@deepseek-ai/cordis';
import type { MessengerBridge } from './bridge.js';
/** Explicit file export only; never infer image uploads from assistant Markdown. */
export declare function installImageTool(ctx: Context, getActiveBridges: () => readonly MessengerBridge[]): () => void;
//# sourceMappingURL=image-tool.d.ts.map