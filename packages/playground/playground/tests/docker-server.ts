/** Isolated Docker HTTP fixture; no container runtime or shared ports required. */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

/** Start a Docker API fixture over an exclusively allocated local socket. */
export async function dockerServer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pg-'))
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-pg-${randomUUID()}` : join(root, 'api.sock')
  const calls: { method: string; path: string; body: unknown }[] = []
  let handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void = (_req, res) => {
    res.writeHead(500).end(JSON.stringify({ message: 'fixture has no handler' }))
  }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      const body: unknown = raw.length === 0 ? undefined : JSON.parse(raw)
      calls.push({ method: request.method ?? '', path: request.url ?? '', body })
      response.setHeader('Content-Type', 'application/json')
      handler(request, response, body)
    })
  })
  try {
    server.listen(socketPath)
    await once(server, 'listening')
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return {
    root, socketPath, calls,
    handle(next: typeof handler) { handler = next },
    disconnect() { server.closeAllConnections() },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
      await rm(root, { recursive: true, force: true })
    },
  }
}
