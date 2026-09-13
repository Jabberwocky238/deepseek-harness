/** Locale-owned UI text for the independent workbench. */
const zh = {
  contacts: '联系人', groups: '群聊', add: '添加好友', notifications: '通知', createGroup: '发起群聊',
  search: '搜索联系人或群聊', refresh: '刷新', profile: '个人资料', settings: '设置',
  close: '关闭', cancel: '取消', save: '保存', send: '发送', logout: '退出登录',
  name: '用户名', avatar: '头像链接（HTTPS）', uuid: '用户 ID', phone: '手机号', email: '邮箱', wechat: '微信', bound: '已绑定', unbound: '未绑定',
  edit: '编辑资料', security: '账号与安全', theme: '颜色主题', system: '跟随系统', light: '亮色', dark: '暗色',
  find: '按 UUID、手机号或邮箱查找好友', missing: '没有找到对应用户', greeting: '打招呼消息', request: '发送好友申请', requested: '好友申请已发送',
  accept: '接受', reject: '拒绝', pending: '等待验证', accepted: '已添加', rejected: '已拒绝', emptyNotifications: '暂无好友申请',
  groupName: '群名称', selectMembers: '选择加入群聊的联系人', noMessages: '暂无消息', message: '输入消息', failed: '操作失败，请重试',
  empty: '选择联系人开始聊天', splitDown: '向下拆分工作区', splitRight: '向右拆分工作区', right: '右侧工作区', bottom: '下方工作区',
  loading: '正在加载…', emptyContacts: '没有匹配的联系人或群聊',
}
const en: typeof zh = {
  contacts: 'Contacts', groups: 'Groups', add: 'Add friend', notifications: 'Notifications', createGroup: 'Create group',
  search: 'Search contacts or groups', refresh: 'Refresh', profile: 'Profile', settings: 'Settings',
  close: 'Close', cancel: 'Cancel', save: 'Save', send: 'Send', logout: 'Sign out',
  name: 'Username', avatar: 'Avatar URL (HTTPS)', uuid: 'User ID', phone: 'Phone', email: 'Email', wechat: 'WeChat', bound: 'Linked', unbound: 'Not linked',
  edit: 'Edit profile', security: 'Account and security', theme: 'Color theme', system: 'Follow system', light: 'Light', dark: 'Dark',
  find: 'Find a friend by UUID, phone, or email', missing: 'No matching user', greeting: 'Greeting', request: 'Send friend request', requested: 'Friend request sent',
  accept: 'Accept', reject: 'Reject', pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected', emptyNotifications: 'No friend requests',
  groupName: 'Group name', selectMembers: 'Select contacts for this group', noMessages: 'No messages yet', message: 'Type a message', failed: 'Operation failed. Please retry.',
  empty: 'Select a contact to start chatting', splitDown: 'Split workspace down', splitRight: 'Split workspace right', right: 'Right workspace', bottom: 'Bottom workspace',
  loading: 'Loading…', emptyContacts: 'No matching contacts or groups',
}
/** Browser locale and its complete UI dictionary. */
export const locale = document.documentElement.lang === 'en' ? 'en' : 'zh'
/** Selected product text. */
export const t = locale === 'en' ? en : zh
