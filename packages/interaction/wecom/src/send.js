/** Outbound text, image and file delivery over the authenticated bot transport. */
/**
 * Publish one proactive message into a chat the bot is authenticated for.
 *
 * Each attachment uploads through the SDK's own init/chunk/finish exchange, so
 * no caller needs to know that protocol. `chatid` is the WeCom chat the
 * conversation already belongs to: a group's id, or the user id of a direct
 * chat.
 *
 * @param client - the authenticated bot transport that owns this chat.
 * @param chatid - destination chat id.
 * @param outbound - text and attachments to publish.
 * @returns what was delivered.
 */
export async function sendToChat(client, chatid, outbound) {
    const text = outbound.text?.trim() ?? '';
    if (text)
        await client.sendMessage(chatid, { msgtype: 'markdown', markdown: { content: text } });
    let files = 0;
    for (const file of outbound.files ?? []) {
        const uploaded = await client.uploadMedia(Buffer.from(file.data), {
            type: file.kind,
            filename: file.name,
        });
        await client.sendMessage(chatid, file.kind === 'image'
            ? { msgtype: 'image', image: { media_id: uploaded.media_id } }
            : { msgtype: 'file', file: { media_id: uploaded.media_id } });
        files += 1;
    }
    return { text: Boolean(text), files };
}
//# sourceMappingURL=send.js.map