/** Coalesced full-text updates with one outstanding transport acknowledgement. */
/**
 * Start a reply and retain only the latest unsent text while a send is pending.
 * @param send - owned transport sender; resolves after acknowledgement or a handled failure.
 * @param initial - first visible status text.
 * @param intervalMs - minimum polling interval for changed text.
 * @returns a reply whose owner must dispose it after finishing or cancellation.
 */
export declare function createReplyStream(send: (text: string, finish: boolean) => Promise<void>, initial: string, intervalMs: number): {
    /** Replace the pending full-text preview; unchanged text needs no transmission. */
    update(text: string): void;
    /** End the stream after its outstanding update settles. */
    finish(text: string): Promise<void>;
    /** Stop updates and drain the outstanding acknowledgement. */
    [Symbol.asyncDispose](): Promise<void>;
};
//# sourceMappingURL=reply-stream.d.ts.map