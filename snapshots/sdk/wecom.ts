/** Loopback WeCom peer for recorded Sessions driven through the shipped SDK profile. */

import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * Bind an isolated WeCom peer that acknowledges SDK frames and collects final replies.
 * @param media - optional fixture attachment served to the bot over HTTP.
 * @returns an owned peer; dispose it after the child runtime exits.
 */
export async function createWecomPeer(media?: { kind: 'image' | 'file'; data: Uint8Array }) {
  const http = createServer((_request, response) => {
    response.setHeader('Content-Disposition', `attachment; filename="${media?.kind === 'image' ? 'image.png' : 'attachment.txt'}"`)
    response.end(media?.data)
  })
  const server = new WebSocketServer({ server: http })
  const ready = Promise.withResolvers<WebSocket>()
  const updates: { id: string; content: string; finish: boolean }[] = []
  const replies = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>()
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')) as {
        cmd: string
        headers: { req_id: string }
        body?: { stream?: { id: string; content: string; finish: boolean } }
      }
      socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
      if (frame.cmd === 'aibot_subscribe') ready.resolve(socket)
      if (frame.body?.stream !== undefined) updates.push(frame.body.stream)
      if (frame.body?.stream?.finish === true) replies.get(frame.headers.req_id)?.resolve(frame.body.stream.content)
    })
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (typeof address !== 'object' || address === null) throw new Error('WeCom peer has no bound address')
  const mediaUrl = `http://127.0.0.1:${String(address.port)}/attachment`
  return {
    updates,
    url: `ws://127.0.0.1:${String(address.port)}`,
    async send(text: string): Promise<string> {
      const id = `wecom-${String(replies.size + 1)}`
      const response = Promise.withResolvers<string>()
      replies.set(id, response)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          (async () => {
            const socket = await ready.promise
            socket.send(JSON.stringify({
              cmd: 'aibot_msg_callback', headers: { req_id: id },
              body: {
                aibotid: 'snapshot-bot', msgid: id, chattype: 'single', from: { userid: 'alice' },
                ...(media?.kind === 'image'
                  ? { msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: text } }, { msgtype: 'image', image: { url: mediaUrl } }] } }
                  : media?.kind === 'file'
                    ? { msgtype: 'file', file: { url: mediaUrl } }
                    : { msgtype: 'text', text: { content: text } }),
              },
            }))
            return response.promise
          })(),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('WeCom reply timed out')) }, 30000) }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
    async [Symbol.asyncDispose](): Promise<void> {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
      http.closeAllConnections()
      await new Promise<void>((resolve, reject) => { http.close(error => { if (error) reject(error); else resolve() }) })
    },
  }
}
