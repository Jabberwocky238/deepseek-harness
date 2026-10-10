/** Coalesced full-text updates with one outstanding transport acknowledgement. */

/**
 * Start a reply and retain only the latest unsent text while a send is pending.
 * @param send - owned transport sender; resolves after acknowledgement or a handled failure.
 * @param initial - first visible status text.
 * @param intervalMs - minimum polling interval for changed text.
 * @returns a reply whose owner must dispose it after finishing or cancellation.
 */
export function createReplyStream(send: (text: string, finish: boolean) => Promise<void>, initial: string, intervalMs: number) {
  let latest = initial
  let dirty = false
  let sending: Promise<void> | undefined
  const publish = (): void => {
    dirty = false
    sending = send(latest, false).then(() => { sending = undefined })
  }
  publish()
  const timer = setInterval(() => {
    if (dirty && sending === undefined) publish()
  }, intervalMs)
  return {
    /** Replace the pending full-text preview; unchanged text needs no transmission. */
    update(text: string): void {
      if (text === latest) return
      latest = text
      dirty = true
    },
    /** End the stream after its outstanding update settles. */
    async finish(text: string): Promise<void> {
      clearInterval(timer)
      await sending
      await send(text, true)
    },
    /** Stop updates and drain the outstanding acknowledgement. */
    async [Symbol.asyncDispose](): Promise<void> {
      clearInterval(timer)
      await sending
    },
  }
}
