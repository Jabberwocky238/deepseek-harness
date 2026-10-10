import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import sharp from 'sharp'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { admitMessageContent } from '../src/attachments.ts'
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

it('rejects unsupported raster formats before publishing image references', async () => {
  await using peer = await mediaPeer()
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0088ff' } }).tiff().toBuffer()
  await expect(admitMessageContent(ctx.attachments, [{ msgtype: 'image', image: peer.add(bytes) }], 10000, new AbortController().signal)).rejects.toThrow('unsupported image format')
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
