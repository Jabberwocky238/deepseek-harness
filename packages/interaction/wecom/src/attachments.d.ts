/** Bounded WeCom downloads, SDK decryption, and durable prompt attachment admission. */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { MessagePart } from './message.ts';
/**
 * Save callback attachments before admitting any model-visible message.
 * @param store - attachment provider shared with the model and file tools.
 * @param parts - validated text and attachment references in message order.
 * @param maxBytes - aggregate decrypted attachment byte limit for this message.
 * @param signal - cancellation and deadline covering downloads and admission.
 * @returns ordered content carrying durable references, with no download URLs or keys.
 * @throws on download, decryption, size, image-validation, storage, or cancellation failure.
 */
export declare function admitMessageContent(store: AttachmentStore, parts: readonly MessagePart[], maxBytes: number, signal: AbortSignal): Promise<ContentBlock[]>;
//# sourceMappingURL=attachments.d.ts.map