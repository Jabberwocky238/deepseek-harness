/** WeCom text and attachment ingress with streaming replies over owned Agent activity intervals. */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import { WSClient } from '@wecom/aibot-node-sdk';
import { assertNever } from '@deepseek-ai/dsh-util-values';
import { createReplyStream } from "./reply-stream.js";
import { admitMessageContent } from "./attachments.js";
import { sendToChat } from "./send.js";
import { limitReply, messageSchema, messageParts } from "./message.js";
/** Cordis function-plugin name. */
export const name = 'wecom';
/** Services required before the bot accepts messages. */
export const inject = ['agents', 'sessions', 'credentials', 'agentDefaultModel', 'permissionPresets', 'attachments', 'sessionProjections', 'tools'];
export const Config = z.object({
    botId: z.string().required(),
    secretEnv: z.string().role('credential-ref').required(),
    allowedUsers: z.array(z.string()).required(),
    workspacePath: z.string().required(),
    permissionPreset: z.string().required(),
    agentPreset: z.string(),
    resumeConversations: z.boolean().default(false),
    wsUrl: z.string().default('wss://openws.work.weixin.qq.com'),
    maxConversations: z.number().step(1).min(1).default(100),
    maxPendingMessages: z.number().step(1).min(1).default(32),
    maxRecentMessages: z.number().step(1).min(1).default(1000),
    maxInputBytes: z.number().step(1).min(1).default(16384),
    maxAttachmentBytes: z.number().step(1).min(1).default(20971520),
    maxAttachmentsPerMessage: z.number().step(1).min(1).default(20),
    attachmentTimeoutMs: z.number().step(1).min(1).max(300000).default(30000),
    maxReplyBytes: z.number().step(1).min(4).max(20480).default(20480),
    replyIntervalMs: z.number().step(1).min(1).default(500),
    runTimeoutMs: z.number().step(1).min(1).max(300000).default(120000),
    reconnectIntervalMs: z.number().step(1).min(1).default(1000),
    maxReconnectAttempts: z.number().step(1).min(0).default(10),
    maxAuthFailureAttempts: z.number().step(1).min(1).default(5),
    heartbeatIntervalMs: z.number().step(1).min(1).default(30000),
    language: z.union(['zh', 'en']).default('zh'),
});
const replies = {
    zh: { attachmentFailed: '附件处理失败，请检查文件大小或重新发送。', processing: '正在处理中…', busy: '当前任务较多，请稍后重试。', failed: '任务未完成，请稍后重试。', timeout: '任务处理超时，已停止。', empty: '本次任务没有文本回复。', large: '消息过长，请缩短后重试。' },
    en: { attachmentFailed: 'The attachment could not be processed. Check its size or send it again.', processing: 'Working…', busy: 'The bot is busy. Please try again later.', failed: 'The task did not complete. Please try again later.', timeout: 'The task timed out and was stopped.', empty: 'This task produced no text reply.', large: 'The message is too long. Please shorten it and try again.' },
};
/**
 * Stable Session id for one WeCom conversation, derived from the bot and the
 * conversation key this plugin already tracks. Used only when
 * `resumeConversations` is on: the same conversation then recomputes the same
 * id on a later start, so a mounted Session persistence resumes its history
 * instead of opening a new conversation.
 */
function conversationSessionId(botId, key) {
    const digest = createHash('sha256').update(JSON.stringify([botId, key])).digest('hex');
    return SessionId(`wecom-${digest}`);
}
/**
 * Connect one bot and own its queued work, Agents, and callback listeners.
 * @param ctx - plugin context carrying Agent and credential services.
 * @param config - validated bot configuration.
 * @returns after local configuration and dependencies are validated and connection starts.
 */
export async function apply(ctx, config) {
    const identifiers = [config.botId, config.permissionPreset, ...config.allowedUsers];
    if (config.agentPreset !== undefined)
        identifiers.push(config.agentPreset);
    for (const value of identifiers) {
        if (value.trim() === '' || value.trim() !== value)
            throw new Error('wecom identifiers must be non-empty and trimmed');
    }
    const url = new URL(config.wsUrl);
    if (url.username !== '' || url.password !== '' || !(url.protocol === 'wss:' || (url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
        throw new Error('wecom wsUrl must use wss, or ws on loopback, without URL credentials');
    }
    // Only the shape is checked here. The directory belongs to whichever
    // filesystem provider is composed -- a remote SSH provider has no local
    // path to stat, and the provider reports a missing directory on first use.
    if (!isAbsolute(config.workspacePath)) {
        throw new Error('wecom workspacePath must be an absolute path');
    }
    ctx.permissionPresets.resolve(config.permissionPreset);
    const presets = ctx.get('agentPresets');
    let mountPreset;
    // The registry hands out a standing scope per preset; this plugin holds it for
    // its own lifetime so every session it creates joins the same mounted tree.
    let presetScope;
    if (config.agentPreset !== undefined) {
        if (presets === undefined)
            throw new Error('wecom agentPreset requires the agent-preset registry plugin');
        const preset = await presets.resolve(config.agentPreset);
        presetScope = await presets.acquireScope(preset.id);
        mountPreset = agentCtx => presets.mount(agentCtx, preset.id);
    }
    const credential = await ctx.credentials.resolve(credentialRef(config.secretEnv));
    if (credential === undefined)
        throw new Error(`wecom credential ${config.secretEnv} is not configured`);
    const lifetime = new AbortController();
    const stopped = () => lifetime.signal.aborted;
    const conversations = new Map();
    const pending = new Set();
    const recent = new Set();
    const jobs = new Set();
    const allowed = new Set(config.allowedUsers);
    const copy = replies[config.language];
    /**
     * The outbound surface a tool package publishes through: one authenticated
     * chat per live Session. A Session the bot does not own finds no target, so a
     * tool cannot address a chat this process is not connected to.
     */
    const sendTargets = new Map();
    ctx.provide('wecom', {
        send: async (sessionId, outbound) => {
            const target = sendTargets.get(sessionId);
            if (target === undefined)
                throw new Error('wecom: this Session is not an authenticated WeCom conversation');
            return sendToChat(target.client, target.chatid, outbound);
        },
    });
    // SDK diagnostics can contain callback bodies; expose only fixed transport notices.
    const client = new WSClient({
        botId: config.botId,
        secret: credential.value,
        wsUrl: config.wsUrl,
        reconnectInterval: config.reconnectIntervalMs,
        maxReconnectAttempts: config.maxReconnectAttempts,
        maxAuthFailureAttempts: config.maxAuthFailureAttempts,
        heartbeatInterval: config.heartbeatIntervalMs,
        maxReplyQueueSize: config.maxPendingMessages,
        logger: { debug() { }, info() { }, warn() { ctx.logger.warn('wecom transport warning'); }, error() { ctx.logger.warn('wecom transport error'); } },
    });
    const track = (job) => {
        jobs.add(job);
        void job.then(() => { jobs.delete(job); });
    };
    const reply = async (message, text, streamId = randomUUID(), finish = true) => {
        if (stopped())
            return;
        try {
            await client.replyStream(message, streamId, limitReply(text, config.maxReplyBytes), finish);
        }
        catch {
            // SDK failures may embed callback frames; never log their payload or resend Agent work.
            ctx.logger.warn('wecom reply delivery failed');
        }
    };
    const run = async (conversation, message, stream) => {
        if (stopped())
            return;
        let content;
        try {
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.attachmentTimeoutMs)]);
            content = await admitMessageContent(ctx.attachments, messageParts(message), config.maxAttachmentBytes, signal);
        }
        catch {
            ctx.logger.warn('wecom attachment admission failed');
            await stream.finish(copy.attachmentFailed);
            return;
        }
        if (conversation.handle === undefined) {
            const selection = ctx.agentDefaultModel.currentSelection();
            const setup = async (agentCtx) => {
                await mountPreset?.(agentCtx);
                installModelSelection(agentCtx, { current: selection, assembled: undefined });
            };
            const agentOptions = { provider: selection.provider, model: selection.model };
            // No persisted conversation takes the random-id path, and a resumed one
            // falls back to creation while its log is still absent.
            const sessionId = conversation.sessionId ?? SessionId(`wecom-${randomUUID()}`);
            const handle = conversation.sessionId === undefined
                ? await ctx.agents.create({
                    sessionId,
                    signal: lifetime.signal,
                    meta: { cwd: config.workspacePath, ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }) },
                    agentOptions,
                    setup,
                })
                : await ctx.agents.resume({ resumeSessionId: sessionId, signal: lifetime.signal, agentOptions, setup })
                    .catch(() => ctx.agents.create({
                    sessionId,
                    signal: lifetime.signal,
                    meta: { cwd: config.workspacePath, ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }) },
                    agentOptions,
                    setup,
                }));
            try {
                lifetime.signal.throwIfAborted();
                ctx.permissionPresets.set(handle.agent.session, config.permissionPreset);
                conversation.handle = handle;
                // The chat this Session answers in: a group's own id, or the user id of
                // a direct chat. Outbound tools address this Session, never a raw chat.
                sendTargets.set(handle.agent.session.id, {
                    client,
                    chatid: message.body.chattype === 'group'
                        ? message.body.chatid ?? message.body.from.userid
                        : message.body.from.userid,
                });
            }
            catch (error) {
                await handle.dispose();
                throw error;
            }
        }
        const { agent } = conversation.handle;
        await agent.whenIdle();
        if (stopped())
            return;
        const outcome = { text: '', timedOut: false };
        let preview = '';
        const stopStream = ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
            if (source !== agent)
                return;
            switch (frame.type) {
                case 'start':
                    preview = '';
                    stream.update(copy.processing);
                    break;
                case 'chunk':
                    if (frame.chunk.type === 'text-delta') {
                        preview = limitReply(preview + frame.chunk.text, config.maxReplyBytes);
                        stream.update(preview);
                    }
                    break;
                case 'end':
                    if (frame.outcome.kind === 'abandoned' || frame.outcome.eventType === 'assistant/attempt') {
                        stream.update(copy.processing);
                    }
                    break;
                /* v8 ignore next -- closed-union exhaustiveness guard */
                default:
                    assertNever(frame);
            }
        });
        const stop = ctx.on('session/event', (session, event) => {
            if (session !== agent.session)
                return;
            if (event.type === 'assistant/message') {
                outcome.text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
                stream.update(outcome.text || copy.processing);
            }
            if (event.type === 'turn/end')
                outcome.reason = event.data.reason;
        });
        const timeout = setTimeout(() => {
            outcome.timedOut = true;
            agent.cancel({ kind: 'user' });
        }, config.runTimeoutMs);
        try {
            agent.followup(createUserMessage({ content, source: { kind: 'user' } }));
            await agent.whenIdle();
        }
        finally {
            clearTimeout(timeout);
            stop();
            stopStream();
        }
        await ctx.sessions.flush(agent.session);
        await stream.finish(outcome.timedOut ? copy.timeout : outcome.reason?.kind === 'completed' ? outcome.text || copy.empty : copy.failed);
    };
    const receive = (frame) => {
        const parsed = messageSchema.safeParse(frame);
        if (!parsed.success)
            return;
        const message = parsed.data;
        const body = message.body;
        if (body.aibotid !== config.botId || !(allowed.has('*') || allowed.has(body.from.userid)))
            return;
        if (pending.has(body.msgid) || recent.has(body.msgid))
            return;
        const parts = messageParts(message);
        const textBytes = parts.reduce((bytes, part) => bytes + (part.msgtype === 'text' ? Buffer.byteLength(part.text.content) : 0), 0);
        const attachments = parts.filter(part => part.msgtype !== 'text').length;
        if (attachments > config.maxAttachmentsPerMessage) {
            if (jobs.size < config.maxPendingMessages)
                track(reply(message, copy.attachmentFailed));
            return;
        }
        if (textBytes > config.maxInputBytes) {
            if (jobs.size < config.maxPendingMessages)
                track(reply(message, copy.large));
            return;
        }
        const key = JSON.stringify([body.chattype, body.chattype === 'group' ? body.chatid : null, body.from.userid]);
        let conversation = conversations.get(key);
        if (pending.size >= config.maxPendingMessages || (conversation === undefined && conversations.size >= config.maxConversations)) {
            if (jobs.size < config.maxPendingMessages)
                track(reply(message, copy.busy));
            return;
        }
        if (conversation === undefined) {
            conversation = {
                tail: Promise.resolve(),
                ...config.resumeConversations ? { sessionId: conversationSessionId(config.botId, key) } : {},
            };
            conversations.set(key, conversation);
        }
        pending.add(body.msgid);
        const owned = conversation;
        const streamId = randomUUID();
        const stream = createReplyStream((text, finish) => reply(message, text, streamId, finish), copy.processing, config.replyIntervalMs);
        const job = owned.tail.then(async () => {
            const env_1 = { stack: [], error: void 0, hasError: false };
            try {
                const ownedStream = __addDisposableResource(env_1, stream, true);
                try {
                    await run(owned, message, ownedStream);
                }
                catch {
                    ctx.logger.warn('wecom Agent task failed');
                    await ownedStream.finish(copy.failed);
                }
            }
            catch (e_1) {
                env_1.error = e_1;
                env_1.hasError = true;
            }
            finally {
                const result_1 = __disposeResources(env_1);
                if (result_1)
                    await result_1;
            }
        }).finally(() => {
            pending.delete(body.msgid);
            recent.add(body.msgid);
            if (recent.size > config.maxRecentMessages) {
                for (const id of recent) {
                    recent.delete(id);
                    break;
                }
            }
        });
        owned.tail = job;
        track(job);
    };
    ctx.effect(() => {
        client.on('message', receive);
        client.on('error', () => { ctx.logger.warn('wecom connection failed; check bot credentials and network'); });
        client.on('authenticated', () => { ctx.logger.info('wecom connected'); });
        client.connect();
        return async () => {
            lifetime.abort();
            client.removeAllListeners();
            const closed = client.isConnected
                ? new Promise((resolve) => { client.once('disconnected', () => { resolve(); }); })
                : Promise.resolve();
            client.disconnect();
            const disposed = await Promise.allSettled([...conversations.values()].map(async (conversation) => {
                await conversation.handle?.dispose();
            }));
            await Promise.all(jobs);
            await closed;
            client.removeAllListeners();
            conversations.clear();
            pending.clear();
            recent.clear();
            sendTargets.clear();
            await presetScope?.[Symbol.asyncDispose]();
            const failures = disposed.filter(result => result.status === 'rejected');
            if (failures.length > 0)
                throw new AggregateError(failures.map(result => result.reason), 'wecom Agent disposal failed');
        };
    }, 'wecom connection and conversations');
}
//# sourceMappingURL=index.js.map