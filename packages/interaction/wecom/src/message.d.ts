/** Validation of WeCom callback frames and UTF-8 reply limits. */
import { z } from 'zod';
import { type Branded } from '@deepseek-ai/dsh-brand';
type WecomUserId = Branded<'WecomUserId'>;
type WecomMessageId = Branded<'WecomMessageId'>;
type WecomChatId = Branded<'WecomChatId'>;
type WecomBotId = Branded<'WecomBotId'>;
type WecomRequestId = Branded<'WecomRequestId'>;
declare const part: z.ZodDiscriminatedUnion<[z.ZodObject<{
    msgtype: z.ZodLiteral<"text">;
    text: z.ZodObject<{
        content: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    msgtype: z.ZodLiteral<"image">;
    image: z.ZodObject<{
        url: z.ZodURL;
        aeskey: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    msgtype: z.ZodLiteral<"file">;
    file: z.ZodObject<{
        url: z.ZodURL;
        aeskey: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>], "msgtype">;
/** Callback identities and supported message content; unused fields are stripped. */
export declare const messageSchema: z.ZodObject<{
    headers: z.ZodObject<{
        req_id: z.ZodPipe<z.ZodString, z.ZodTransform<WecomRequestId, string>>;
    }, z.core.$strip>;
    body: z.ZodIntersection<z.ZodDiscriminatedUnion<[z.ZodObject<{
        msgid: z.ZodPipe<z.ZodString, z.ZodTransform<WecomMessageId, string>>;
        aibotid: z.ZodPipe<z.ZodString, z.ZodTransform<WecomBotId, string>>;
        from: z.ZodObject<{
            userid: z.ZodPipe<z.ZodString, z.ZodTransform<WecomUserId, string>>;
        }, z.core.$strip>;
        chattype: z.ZodLiteral<"single">;
    }, z.core.$strip>, z.ZodObject<{
        msgid: z.ZodPipe<z.ZodString, z.ZodTransform<WecomMessageId, string>>;
        aibotid: z.ZodPipe<z.ZodString, z.ZodTransform<WecomBotId, string>>;
        from: z.ZodObject<{
            userid: z.ZodPipe<z.ZodString, z.ZodTransform<WecomUserId, string>>;
        }, z.core.$strip>;
        chattype: z.ZodLiteral<"group">;
        chatid: z.ZodPipe<z.ZodString, z.ZodTransform<WecomChatId, string>>;
    }, z.core.$strip>], "chattype">, z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        msgtype: z.ZodLiteral<"text">;
        text: z.ZodObject<{
            content: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        msgtype: z.ZodLiteral<"image">;
        image: z.ZodObject<{
            url: z.ZodURL;
            aeskey: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        msgtype: z.ZodLiteral<"file">;
        file: z.ZodObject<{
            url: z.ZodURL;
            aeskey: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>], "msgtype">, z.ZodObject<{
        msgtype: z.ZodLiteral<"mixed">;
        mixed: z.ZodObject<{
            msg_item: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                msgtype: z.ZodLiteral<"text">;
                text: z.ZodObject<{
                    content: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                msgtype: z.ZodLiteral<"image">;
                image: z.ZodObject<{
                    url: z.ZodURL;
                    aeskey: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>], "msgtype">>;
        }, z.core.$strip>;
    }, z.core.$strip>]>>;
}, z.core.$strip>;
/** Parsed callback; download URLs and keys are consumed only by attachment admission. */
export type InboundMessage = z.infer<typeof messageSchema>;
/** One ordered text, image, or file input from a callback. */
export type MessagePart = z.infer<typeof part>;
/**
 * Preserve the order of text and attachments in an admitted callback.
 * @param message - validated callback.
 * @returns individual input parts in their original order.
 */
export declare function messageParts(message: InboundMessage): readonly MessagePart[];
/**
 * Bound a complete reply to WeCom's UTF-8 limit without splitting a code point.
 * @param text - complete model or status text.
 * @param maxBytes - positive configured limit of at least four bytes.
 * @returns text, or a truncated prefix with an ellipsis included in the limit.
 */
export declare function limitReply(text: string, maxBytes: number): string;
export {};
//# sourceMappingURL=message.d.ts.map