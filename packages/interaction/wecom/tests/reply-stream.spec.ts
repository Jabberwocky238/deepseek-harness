import { afterEach, expect, it, vi } from 'vitest'
import { createReplyStream } from '../src/reply-stream.ts'

afterEach(() => { vi.useRealTimers() })

it('coalesces changed text behind one acknowledgement and finishes after it', async () => {
  vi.useFakeTimers()
  const ack = Promise.withResolvers<undefined>()
  const send = vi.fn<(text: string, finish: boolean) => Promise<void>>().mockResolvedValue(undefined)
  send.mockImplementationOnce(() => ack.promise)
  await using stream = createReplyStream(send, 'Working…', 500)
  stream.update('Working…')
  stream.update('first')
  stream.update('latest')
  await vi.advanceTimersByTimeAsync(1000)
  expect(send.mock.calls).toEqual([['Working…', false]])
  ack.resolve(undefined)
  await vi.advanceTimersByTimeAsync(500)
  expect(send.mock.calls).toEqual([['Working…', false], ['latest', false]])
  await vi.advanceTimersByTimeAsync(1000)
  expect(send).toHaveBeenCalledTimes(2)
  stream.update('unsent')
  await stream.finish('complete')
  await vi.advanceTimersByTimeAsync(1000)
  expect(send.mock.calls.at(-1)).toEqual(['complete', true])
  expect(send).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
})

it('stops its timer and drains a pending send on disposal', async () => {
  vi.useFakeTimers()
  const ack = Promise.withResolvers<undefined>()
  const send = vi.fn(() => ack.promise)
  const stream = createReplyStream(send, 'Working…', 500)
  stream.update('late')
  const disposing = stream[Symbol.asyncDispose]()
  await vi.advanceTimersByTimeAsync(1000)
  expect(send).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  ack.resolve(undefined)
  await disposing
})
