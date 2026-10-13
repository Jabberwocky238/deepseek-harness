import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import sharp from 'sharp'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { admitMessageContent, hostInbox } from '../src/attachments.ts'
import { mediaPeer } from './media-peer.ts'

let ctx: Context
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wecom-media-'))
  ctx = new Context()
  await ctx.plugin(LocalAttachments, { dshHome: root })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

it.each(['png', 'jpeg', 'webp', 'gif'] as const)('decrypts and admits %s images with ordered text', async (format) => {
  await using peer = await mediaPeer()
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0088ff' } }).toFormat(format).toBuffer()
  const image = peer.add(bytes, { encrypted: true, disposition: 'attachment; filename="picture"' })
  const content = await admitMessageContent(ctx.attachments, [
    { msgtype: 'text', text: { content: 'describe' } }, { msgtype: 'image', image },
  ], 10000, new AbortController().signal)
  expect(content[0]).toEqual({ type: 'text', text: 'describe' })
  const block = content[1]!
  expect(block.type).toBe('image')
  if (block.type !== 'image') throw new Error('Missing image')
  expect((await ctx.attachments.readImage(block.attachment)).data.byteLength).toBeGreaterThan(0)
  expect(JSON.stringify(content)).not.toContain(image.url)
  expect(JSON.stringify(content)).not.toContain(image.aeskey)
})

it('stores decrypted files verbatim with a decoded, sanitized filename', async () => {
  await using peer = await mediaPeer()
  const bytes = Buffer.from('file content')
  const file = peer.add(bytes, { encrypted: true, disposition: "attachment; filename*=UTF-8''..%2Freport.txt" })
  const [block] = await admitMessageContent(ctx.attachments, [{ msgtype: 'file', file }], 100, new AbortController().signal)
  if (block?.type !== 'file') throw new Error('Missing file')
  expect(block.attachment.name).not.toContain('/')
  expect(await readFile(ctx.attachments.fileHostPath(block.attachment)!)).toEqual(bytes)
})

it('accepts empty files without content or filename headers', async () => {
  await using peer = await mediaPeer()
  const file = peer.add(Buffer.alloc(0), { status: 204 })
  const [block] = await admitMessageContent(ctx.attachments, [{ msgtype: 'file', file }], 100, new AbortController().signal)
  expect(block).toMatchObject({ type: 'file', attachment: { bytes: 0 } })
})

it.each([2, 40])('rejects plain bodies of %i bytes beyond the admission or transfer limit', async (size) => {
  await using peer = await mediaPeer()
  const file = peer.add(Buffer.alloc(size))
  await expect(admitMessageContent(ctx.attachments, [{ msgtype: 'file', file }], 1, new AbortController().signal)).rejects.toThrow('byte limit')
})

it('rejects failed downloads and corrupt encrypted content', async () => {
  await using peer = await mediaPeer()
  const missing = peer.add(Buffer.from('missing'), { status: 404 })
  await expect(admitMessageContent(ctx.attachments, [{ msgtype: 'file', file: missing }], 100, new AbortController().signal)).rejects.toThrow('download failed')
  const corrupt = peer.add(Buffer.from('corrupt'))
  await expect(admitMessageContent(ctx.attachments, [{ msgtype: 'file', file: { ...corrupt, aeskey: Buffer.alloc(32).toString('base64') } }], 100, new AbortController().signal)).rejects.toThrow('Decryption failed')
})

it('delivers an unsupported raster as a file rather than a vision image', async () => {
  await using peer = await mediaPeer()
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0088ff' } }).tiff().toBuffer()
  const content = await admitMessageContent(ctx.attachments, [{ msgtype: 'image', image: peer.add(bytes) }], 10000, new AbortController().signal)
  // WeCom sends image callbacks for formats the model cannot be shown; without an
  // inbox the attachment store is the only delivery left, so the bytes still reach
  // the Agent as a readable file.
  expect(content).toHaveLength(1)
  expect(content[0]?.type).toBe('file')
  expect(content.some(part => part.type === 'image')).toBe(false)
})

it('cancels an outstanding download', async () => {
  await using peer = await mediaPeer()
  const file = peer.add(Buffer.alloc(0), { hang: true })
  const controller = new AbortController()
  const result = admitMessageContent(ctx.attachments, [{ msgtype: 'file', file }], 100, controller.signal)
  const rejected = expect(result).rejects.toThrow('cancelled')
  await vi.waitFor(() => { expect(peer.requests).toBe(1) })
  controller.abort(new Error('cancelled'))
  await rejected
})

it.each([
  ['Jingyu%2BShen.pdf', 'Jingyu+Shen.pdf'],
  ['%E6%8A%A5%E5%91%8A.pdf', '报告.pdf'],
  ['50%off.pdf', '50%off.pdf'],
  ['..%2Fescape.txt', 'escape.txt'],
])('decodes the percent-encoded filename %s before publishing it to the inbox', async (sent, saved) => {
  await using peer = await mediaPeer()
  const file = peer.add(Buffer.from('x'), { disposition: `attachment; filename="${sent}"` })
  const inbox = hostInbox('/home/agent/inbox', join(root, 'inbox'))
  const [note] = await admitMessageContent(ctx.attachments, [{ msgtype: 'file', file }], 100, new AbortController().signal, inbox)
  if (note?.type !== 'text') throw new Error('Missing inbox note')
  expect(note.text).toContain(`/home/agent/inbox/${saved}（`)
  expect(await readFile(join(root, 'inbox', saved), 'utf8')).toBe('x')
})
