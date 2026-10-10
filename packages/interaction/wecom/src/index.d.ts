/** WeCom text and attachment ingress with streaming replies over owned Agent activity intervals. */
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import { type WecomDelivered, type WecomOutbound } from './send.ts';
/** Cordis function-plugin name. */
export declare const name = "wecom";
/** Services required before the bot accepts messages. */
export declare const inject: string[];
declare module '@deepseek-ai/cordis' {
    interface Context {
        /**
         * Proactive outbound delivery, addressed by the Session that owns the chat.
         * A tool package publishes through this seam instead of holding the bot's
         * transport, and a Session the bot does not own has no target.
         */
        wecom: {
            send(sessionId: SessionId, outbound: WecomOutbound): Promise<WecomDelivered>;
        };
    }
}
/** Connection, admission, and Agent settings for one WeCom bot. */
export interface Config {
    /** Bot identifier issued by WeCom. */
    botId: string;
    /** Credential reference containing the bot secret. */
    secretEnv: string;
    /** Exact WeCom user ids allowed to invoke the Agent; "*" allows everyone and an empty list denies everyone. */
    allowedUsers: string[];
    /** Existing absolute working directory shared by this bot's Agents. */
    workspacePath: string;
    /** Permission preset applied before the first input is admitted. */
    permissionPreset: string;
    /** Optional Agent preset; omission uses globally mounted capabilities. */
    agentPreset?: string;
    /**
     * Resume each conversation's persisted Session across restarts instead of
     * starting a fresh one. Off by default: the ids a conversation maps to are
     * then random and process-local, so a reload begins a new conversation.
     * Turning this on derives the Session id from the WeCom conversation itself,
     * so a mounted Session persistence restores the earlier history on the next
     * start.
     */
    resumeConversations?: boolean;
    /** WeCom endpoint; unencrypted connections are permitted only on loopback. */
    wsUrl: string;
    /** Maximum retained conversations until plugin reload. */
    maxConversations: number;
    /** Maximum accepted messages across active and queued work. */
    maxPendingMessages: number;
    /** Number of completed message ids retained for process-local deduplication. */
    maxRecentMessages: number;
    /** Maximum UTF-8 input bytes admitted to the Agent. */
    maxInputBytes: number;
    /** Maximum total decrypted attachment bytes admitted from one message. */
    maxAttachmentBytes: number;
    /** Maximum image or file parts admitted from one message. */
    maxAttachmentsPerMessage: number;
    /** Total attachment download and admission deadline in milliseconds. */
    attachmentTimeoutMs: number;
    /** Maximum complete reply bytes, including a truncation marker. */
    maxReplyBytes: number;
    /** Interval in milliseconds for coalescing changed streaming reply text. */
    replyIntervalMs: number;
    /** Maximum active Agent interval in milliseconds; expiry cancels and drains it. */
    runTimeoutMs: number;
    /** SDK reconnection base delay in milliseconds. */
    reconnectIntervalMs: number;
    /** Maximum SDK reconnection attempts. */
    maxReconnectAttempts: number;
    /** Maximum SDK authentication attempts. */
    maxAuthFailureAttempts: number;
    /** SDK heartbeat interval in milliseconds. */
    heartbeatIntervalMs: number;
    /** Language of transport status replies. */
    language: 'zh' | 'en';
}
export declare const Config: z<Config>;
/**
 * Connect one bot and own its queued work, Agents, and callback listeners.
 * @param ctx - plugin context carrying Agent and credential services.
 * @param config - validated bot configuration.
 * @returns after local configuration and dependencies are validated and connection starts.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map