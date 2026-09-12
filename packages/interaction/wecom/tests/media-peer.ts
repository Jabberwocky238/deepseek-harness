import { createCipheriv } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

/** Own a loopback peer serving encrypted or plain callback attachments. */
export async function mediaPeer() {
  const responses = new Map<string, { bytes: Buffer; disposition?: string; status?: number; hang?: boolean }>()
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    const entry = responses.get(request.url!)!
    if (entry.hang) return
    response.statusCode = entry.status ?? 200
    if (entry.disposition !== undefined) response.setHeader('Content-Disposition', entry.disposition)
    response.end(entry.bytes)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('Missing media peer address')
  return {
    get requests() { return requests },
    add(bytes: Buffer, options: { encrypted?: boolean; disposition?: string; status?: number; hang?: boolean } = {}) {
      const path = `/media-${String(responses.size)}`
      const key = Buffer.alloc(32, 7)
      let payload = bytes
      if (options.encrypted) {
        const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
        cipher.setAutoPadding(false)
        const padding = 32 - bytes.length % 32
        payload = Buffer.concat([cipher.update(Buffer.concat([bytes, Buffer.alloc(padding, padding)])), cipher.final()])
      }
      responses.set(path, { bytes: payload, ...options })
      return { url: `http://127.0.0.1:${String(address.port)}${path}`, ...options.encrypted ? { aeskey: key.toString('base64') } : {} }
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    },
  }
}
