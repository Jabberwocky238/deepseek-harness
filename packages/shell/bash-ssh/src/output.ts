/** Bounded byte tails with consuming callers holding their own offsets. @module */
import { StringDecoder } from 'node:string_decoder'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { CollectedOutput } from '@deepseek-ai/dsh-shell'

/** Retains the last configured bytes without collecting an unbounded SSH stream. */
export class TailOutput {
  private readonly retained: TextRetainer
  private readonly decoder = new StringDecoder('utf8')
  private total = 0
  constructor(maxBytes: number) {
    this.retained = new TextRetainer({ kind: 'tail', maxBytes })
  }

  /**
   * Retain an SSH data chunk within the byte budget.
   * @param chunk - bytes in stream delivery order.
   */
  push(chunk: Buffer): void {
    this.retain(Buffer.from(this.decoder.write(chunk)))
  }

  /** Flush an incomplete final UTF-8 sequence when the SSH stream closes. */
  seal(): void {
    this.retain(Buffer.from(this.decoder.end()))
  }

  private retain(chunk: Buffer): void {
    this.total += chunk.length
    this.retained.push(chunk)
  }

  /**
   * Read retained bytes at an absolute stream offset, omitting a clipped UTF-8 prefix.
   * @param offset - byte offset returned by an earlier read, or zero.
   * @returns text, loss fact, and the next absolute offset.
   */
  read(offset: number): { text: string; lossy: boolean; offset: number } {
    const tail = Buffer.from(this.retained.finish().text)
    const start = this.total - tail.length
    const index = Math.max(0, offset - start)
    return { text: tail.subarray(index).toString('utf8'), lossy: offset < start, offset: this.total }
  }

  /**
   * Materialize the final retained output.
   * @returns the retained tail and whether earlier bytes were discarded.
   */
  final(): CollectedOutput {
    const result = this.read(0)
    return { text: result.text, truncated: result.lossy }
  }
}
