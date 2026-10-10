import { describe, expect, it } from 'vitest'
import { limitReply, messageSchema } from '../src/message.ts'

const message = {
  headers: { req_id: 'request' },
  body: { aibotid: 'bot', msgid: 'message', chattype: 'single', from: { userid: 'alice' }, msgtype: 'text', text: { content: 'hello' } },
}

describe('WeCom callback admission', () => {
  it('accepts text and discards unconsumed callback data', () => {
    expect(messageSchema.parse({ ...message, secret: 'not-forwarded' })).toEqual(message)
    expect(messageSchema.safeParse({ ...message, body: { ...message.body, chattype: 'group' } }).success).toBe(false)
    expect(messageSchema.safeParse({ ...message, body: { ...message.body, chattype: 'group', chatid: 'group' } }).success).toBe(true)
    expect(messageSchema.safeParse({ ...message, body: { ...message.body, from: { userid: ' alice ' } } }).success).toBe(false)
  })

  it.each([null, {}, { ...message, headers: {} }, { ...message, body: { ...message.body, text: { content: ' ' } } }, { ...message, body: { ...message.body, msgtype: 'image' } }])('rejects malformed or unsupported input %#', (input) => {
    expect(messageSchema.safeParse(input).success).toBe(false)
  })


  it.each(['https://example.com/image', 'http://127.0.0.1/image', 'http://localhost/image', 'http://[::1]/image'])('accepts attachment URL %s', (url) => {
    expect(messageSchema.safeParse({ ...message, body: { ...message.body, msgtype: 'image', image: { url } } }).success).toBe(true)
  })

  it.each(['http://example.com/image', 'ftp://example.com/image', 'https://user@example.com/image', 'https://:password@example.com/image'])('rejects attachment URL %s', (url) => {
    expect(messageSchema.safeParse({ ...message, body: { ...message.body, msgtype: 'image', image: { url } } }).success).toBe(false)
  })

  it('bounds complete replies by bytes with intact Unicode', () => {
    expect(limitReply('你好', 6)).toBe('你好')
    expect(limitReply('你好', 5)).toBe('…')
    expect(limitReply('a🙂b', 7)).toBe('a🙂b')
    expect(limitReply('a🙂bc', 6)).toBe('a…')
    expect(limitReply('abcdef', 4)).toBe('a…')
    expect(limitReply('', 4)).toBe('')
  })
})
