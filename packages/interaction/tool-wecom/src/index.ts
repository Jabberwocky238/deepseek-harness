/**
 * Model-facing WeCom file tools for the chat the calling Session already
 * answers in.
 *
 * `sendfile` delivers attachments. Attachments only — the tool has no text
 * parameter, because the ordinary assistant reply is what the people read, and
 * a second text channel would duplicate it. The chat is never named by the
 * model: `ctx.wecom` resolves it from the Session, so a call cannot address a
 * conversation the bot is not connected to. Attachment bytes come from
 * `ctx.fs`, which in a remote deployment is the container's filesystem rather
 * than the host's. When the bot stores files, every sent attachment also lands
 * in the Session's outbox.
 *
 * `syncbox` reads the Session's stored inbox and outbox: it lists them and
 * checks names from metadata alone, and pulls only the named files, or only
 * the files the working directory lacks. It is registered only when the bot
 * stores files.
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

const description = 'Send files (documents, spreadsheets, presentations, PDFs, images) to the WeCom chat you are talking in. Your ordinary reply text is what the people read; this tool carries attachments only and never text.'

const syncboxDescription = 'Inspect and fetch the files of this chat. The inbox holds files people sent you; the outbox holds files you sent with sendfile. `list` names every stored file with its size; `exists` checks the given names; `pull` copies stored files into your working directory under inbox/ or outbox/ — the files you name, or every file not already there — so nothing is fetched that you do not need.'

const nameList = { type: 'array', items: { type: 'string' } } as const

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'sendfile',
    description,
    parameters: {
      files: {
        type: 'array',
        required: true,
        description: 'Files to deliver to the chat, in the order they should arrive.',
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
          files: { type: 'number', required: true, description: 'How many attachments were published.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { files: { path: string; kind: 'file' | 'image'; media_type?: string }[] }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('sendfile must run as an Agent-bound call')
      const session = agent.session
      const requested = args.files
      if (requested.length === 0) throw new Error('sendfile needs at least one file')
      if (requested.length > MAX_FILES) throw new Error(`sendfile accepts at most ${MAX_FILES} attachments`)
      const files: { data: Uint8Array; name: string; kind: 'file' | 'image' }[] = []
      let remaining = MAX_BYTES
      for (const file of requested) {
        if (file.kind === 'image' && file.media_type === undefined) throw new Error('sendfile images require media_type')
        const cwd = session.header.cwd
        const target = await ctx.fs.resolve(file.path, {
          ...cwd === undefined ? {} : { cwd },
          signal: exec.signal,
        })
        const data = await ctx.fs.readBytes(target, exec.signal, remaining)
        remaining -= data.byteLength
        files.push({ data, name: basename(file.path), kind: file.kind })
      }
      // Return exactly the declared output shape. The delivery seam reports
      // more than the model needs (`{ text, files }`), and handing that object
      // back fails the `additionalProperties: false` output schema *after* the
      // attachments are already in the chat — the call then reads as failed and
      // the model retries, delivering the same file again for every attempt.
      const delivered = await ctx.wecom.send(session.id, { files })
      return { files: delivered.files }
    },
  }))

  const store = ctx.wecom.files
  if (store === undefined) return
  ctx.tools.register(defineTool({
    name: 'syncbox',
    description: syncboxDescription,
    parameters: {
      action: { type: 'string', enum: ['list', 'exists', 'pull'], required: true, description: 'list, exists, or pull.' },
      box: { type: 'string', enum: ['inbox', 'outbox'], required: true, description: 'inbox for files sent to you, outbox for files you sent.' },
      names: { ...nameList, description: 'File names. Required for exists; for pull, omit to fetch every file not already in your working directory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          box: { type: 'string', required: true },
          files: {
            type: 'array',
            description: 'list: every stored file.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                size: { type: 'number', required: true, description: 'Bytes.' },
              },
            },
          },
          found: { ...nameList, description: 'exists: names the box holds.' },
          missing: { ...nameList, description: 'exists: names the box does not hold.' },
          directory: { type: 'string', description: 'pull: where the files were written.' },
          pulled: { ...nameList, description: 'pull: files copied in this call.' },
          skipped: { ...nameList, description: 'pull: files already present, not copied again.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { action: 'list' | 'exists' | 'pull'; box: 'inbox' | 'outbox'; names?: string[] }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('syncbox must run as an Agent-bound call')
      const session = agent.session.id
      switch (args.action) {
        case 'list':
          return { box: args.box, files: await store.list(session, args.box) }
        case 'exists': {
          if (args.names === undefined || args.names.length === 0) throw new Error('syncbox exists needs at least one name')
          const { found, missing } = await store.exists(session, args.box, args.names)
          return { box: args.box, found, missing }
        }
        case 'pull': {
          const { directory, pulled, skipped } = await store.pull(session, args.box, args.names, MAX_BYTES)
          return { box: args.box, directory, pulled, skipped }
        }
        default: {
          const unreachable: never = args.action
          throw new Error(`syncbox: unknown action ${String(unreachable)}`)
        }
      }
    },
  }))
}
