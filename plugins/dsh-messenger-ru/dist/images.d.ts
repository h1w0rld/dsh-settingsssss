import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { MessengerImage } from './types.js';
export declare const IMAGE_BYTE_LIMIT: number;
export declare const MAX_REPLY_IMAGES = 10;
export type AssistantImage = Extract<ContentBlock, {
    type: 'image';
}>;
/** Cheap signature gate; DSH performs full decoding/normalization on intake. */
export declare function messengerImage(bytes: Uint8Array): MessengerImage;
export declare function decodeImage(data: string): MessengerImage;
/** Mirror explicit assistant attachments only, never tool results or Markdown paths. */
export declare function visibleAssistantImages(event: SessionEvent): AssistantImage[];
//# sourceMappingURL=images.d.ts.map