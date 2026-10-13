/**
 * Model-facing messages between the Sessions of one deployment.
 *
 * A Session addresses another by its address — in a conversation-scoped WeCom
 * bot, the other conversation's container login, such as `qingang0003`. `talk`
 * hands the message to the `talk` service, which a host such as `dsh-wecom`
 * provides: the host owns the target's Agent, resumes it when it is not live,
 * and delivers the message before that Agent's next step. The target sees who
 * sent it and replies, if at all, with `talk`; its ordinary reply text reaches
 * neither the sender nor any chat. `talk_peers` lists the addresses the caller
 * may reach.
 *
 * Both tools are registered only while a `talk` service is mounted.
 *
 * @module @deepseek-ai/dsh-tool-talk
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'tool-talk'

export const inject = ['tools', 'talk']

/** One Session the caller may talk to. */
export interface TalkPeer {
  /** Address `talk` takes, stable for the Session. */
  address: string
  /** Whether this is the caller's own Session. */
  self: boolean
}

/** How a host received one message. */
export interface TalkDelivery {
  /** Address the message went to. */
  address: string
  /** `queued` when the target was running and reads it before its next step; `woken` when the message started a turn. */
  delivery: 'queued' | 'woken'
}

/**
 * The `talk` service: the Sessions a caller may reach and delivery to them.
 * Hosts provide it with `ctx.provide('talk', directory)`.
 */
export interface TalkDirectory {
  /**
   * List the Sessions the caller may talk to, itself included and marked.
   * @param caller - the calling Session.
   * @returns the reachable Sessions.
   */
  peers(caller: SessionId): Promise<TalkPeer[]>
  /**
   * Deliver one message from the caller to the Session at `address`.
   * @param caller - the sending Session.
   * @param address - the target's address, from {@link peers}.
   * @param text - the message.
   * @returns how the message was received.
   * @throws when the address names no reachable Session, names the caller, or the target refuses more messages.
   */
  send(caller: SessionId, address: string, text: string): Promise<TalkDelivery>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    talk: TalkDirectory
  }
}

/** Source of a message one Session sent another with `talk`. */
export interface TalkMessageSource {
  readonly kind: 'talk-message'
  readonly form: 'relay'
  /** The sending Session. */
  readonly senderSessionId: SessionId
  /** The sender's address, which a reply is sent to. */
  readonly senderAddress: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'talk-message': TalkMessageSource
  }
}

/** Plugin configuration as authored in `cordis.yml`. */
export interface Config {
  /** Longest message one `talk` call may carry, in characters. */
  maxMessageChars: number
}

export const Config: z<Config> = z.object({
  maxMessageChars: z.number().step(1).min(1).default(20_000),
})

/**
 * Build the input a target Session receives for one `talk` message. Hosts
 * deliver exactly this, so every target sees the same wording.
 * @param sender - the sending Session.
 * @param senderAddress - the sender's address, which a reply goes to.
 * @param text - the message.
 * @returns the user-role input, attributed to the sending Session.
 */
export function createTalkMessage(sender: SessionId, senderAddress: string, text: string): UserMessage {
  return createUserMessage({
    content: [
      { type: 'text', text: `Message from Session ${senderAddress} (sent with talk). Your ordinary reply is not delivered to it; answer with talk to ${senderAddress} if a reply is needed.` },
      { type: 'text', text },
    ],
    source: { kind: 'talk-message', form: 'relay', senderSessionId: sender, senderAddress },
  })
}

const talkDescription = 'Send a message to another Session of this deployment, addressed by the address talk_peers lists. The other Session reads it before its next step, or starts a turn for it, and can answer only with talk. Your ordinary reply text never reaches it.'

const peersDescription = 'List the Sessions of this deployment you can send messages to with talk, your own marked self.'

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'talk_peers',
    description: peersDescription,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                address: { type: 'string', required: true },
                self: { type: 'boolean', required: true, description: 'Your own Session.' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('talk_peers must run as an Agent-bound call')
      return { peers: await ctx.talk.peers(agent.session.id) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'talk',
    description: talkDescription,
    parameters: {
      to: { type: 'string', required: true, description: 'Address of the Session to message, from talk_peers.' },
      message: { type: 'string', required: true, description: 'The message.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          address: { type: 'string', required: true },
          delivery: { type: 'string', enum: ['queued', 'woken'], required: true, description: 'queued: it was busy and reads the message before its next step; woken: the message started a turn.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { to: string; message: string }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('talk must run as an Agent-bound call')
      if (args.message.trim() === '') throw new Error('talk needs a non-empty message')
      if (args.message.length > config.maxMessageChars) throw new Error(`talk carries at most ${String(config.maxMessageChars)} characters`)
      const delivered = await ctx.talk.send(agent.session.id, args.to, args.message)
      return { address: delivered.address, delivery: delivered.delivery }
    },
  }))
}
