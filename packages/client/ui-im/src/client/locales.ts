/** Native IM panel dictionaries. */
export const zh = {
  title: '即时通讯', contacts: '联系人', groups: '群聊', direct: '单聊', inbox: '收件箱',
  add: '添加联系人', name: '名称', human: '人', ai: 'AI', create: '创建聊天',
  choose: '选择联系人或群聊', empty: '暂无消息', message: '消息', send: '发送',
  queue: '排队：下个工具前处理', interrupt: '立即打断', attach: '添加图片或文件',
  download: '下载', loading: '加载中…', error: '操作失败，请重试', members: '参与者',
  recipients: '通知接收方', pending: '待投递', accepted: '已接收', queued: '等待 AI 处理', failed: '投递失败',
} satisfies Record<string, string>
/** Dictionary keys owned by the IM panel. */
export type ImKey = keyof typeof zh
/** English counterpart of every IM label. */
export const en = {
  title: 'Instant messaging', contacts: 'Contacts', groups: 'Groups', direct: 'Direct', inbox: 'Inbox',
  add: 'Add contact', name: 'Name', human: 'Human', ai: 'AI', create: 'Create chat',
  choose: 'Choose a contact or group', empty: 'No messages yet', message: 'Message', send: 'Send',
  queue: 'Queue before next tool', interrupt: 'Interrupt now', attach: 'Add images or files',
  download: 'Download', loading: 'Loading…', error: 'The operation failed. Please retry.', members: 'Participants',
  recipients: 'Notify recipients', pending: 'Pending delivery', accepted: 'Accepted', queued: 'Waiting for AI', failed: 'Delivery failed',
} satisfies Record<ImKey, string>
