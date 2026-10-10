/**
 * Model-facing `talk` tool: publishes text, images and files into the WeCom
 * chat the calling Session already answers in.
 *
 * The chat is never named by the model — `ctx.wecom` resolves it from the
 * Session, so a tool call cannot address a conversation the bot is not
 * connected to. Attachment bytes come from `ctx.fs`, which in a remote
 * deployment is the container's filesystem rather than the host's.
 *
 * @module @deepseek-ai/dsh-tool-wecom
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-wecom'

export const name = 'tool-wecom'

export const inject = ['tools', 'wecom', 'fs']

/** Attachments one call may publish, and the byte budget across them. */
const MAX_FILES = 20
const MAX_BYTES = 20 * 1024 * 1024

const description = 'Send text, images, or files to the WeCom chat you are talking in. Ordinary assistant text is private; use talk for everything the people in the chat should see. Direct chats need the recipient to have messaged the bot.'

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'talk',
    description,
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'Message text; may be empty when sending attachments only.',
      },
      files: {
        type: 'array',
        description: 'Workspace files to publish without interpreting their contents.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Path in your filesystem.' },
            kind: { type: 'string', enum: ['file', 'image'], required: true },
            media_type: {
              type: 'string',
              enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
              description: 'Required for images.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'boolean', required: true, description: 'Whether a text message was sent.' },
          files: { type: 'number', required: true, description: 'How many attachments were published.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { message: string; files?: { path: string; kind: 'file' | 'image'; media_type?: string }[] }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('talk must run as an Agent-bound call')
      const session = agent.session
      const requested = args.files ?? []
      if (requested.length > MAX_FILES) throw new Error(`talk accepts at most ${MAX_FILES} attachments`)
      const files: { data: Uint8Array; name: string; kind: 'file' | 'image' }[] = []
      let remaining = MAX_BYTES
      for (const file of requested) {
        if (file.kind === 'image' && file.media_type === undefined) throw new Error('talk images require media_type')
        const cwd = session.header.cwd
        const target = await ctx.fs.resolve(file.path, {
          ...cwd === undefined ? {} : { cwd },
          signal: exec.signal,
        })
        const data = await ctx.fs.readBytes(target, exec.signal, remaining)
        remaining -= data.byteLength
        files.push({ data, name: basename(file.path), kind: file.kind })
      }
      return await ctx.wecom.send(session.id, { text: args.message, files })
    },
  }))
}
