/** Typed homepage copy owned by webwjkj. */
const zh = {
  language: 'zh-CN', switchLanguage: 'English', switchPath: '/en',
  navigation: '主导航', home: '首页', about: '关于',
  eyebrow: '你的下一步，从这里开始', title: '让想法，有一个新的起点。',
  description: '欢迎来到 webwjkj。一个简洁、专注的空间，留给你的想法，也留给接下来要创造的可能。',
  action: '探索这个空间', secondary: '了解 webwjkj',
  sectionLabel: '从简单开始', sectionTitle: '留出空间，创造更多。',
  cards: [
    { title: '清晰的开始', text: '从一张首页出发，让每一次探索都有明确的方向。' },
    { title: '自在地浏览', text: '无论在桌面还是手机，都能轻松阅读，自然切换。' },
    { title: '更多可能', text: '这是第一步。新的页面和功能，将在这里逐步展开。' },
  ],
  aboutTitle: '一个属于 webwjkj 的空间。',
  aboutText: '我们从简洁的首页开始，专注于清晰的内容和舒适的体验。期待在这里，与你一起创造更多。',
  back: '回到顶部', footer: '为新的想法，留一扇门。',
}

/** Supported homepage locales. */
export type Locale = 'zh' | 'en'

/** Both languages provide the same fields and card structure. */
export const locales: Record<Locale, typeof zh> = {
  zh,
  en: {
    language: 'en', switchLanguage: '中文', switchPath: '/',
    navigation: 'Main navigation', home: 'Home', about: 'About',
    eyebrow: 'YOUR NEXT CHAPTER STARTS HERE', title: 'A fresh start for your ideas.',
    description: 'Welcome to webwjkj. A simple, focused space for your ideas and everything you will create next.',
    action: 'Explore this space', secondary: 'Meet webwjkj',
    sectionLabel: 'START SIMPLE', sectionTitle: 'Make room for something new.',
    cards: [
      { title: 'A clear beginning', text: 'Start with one page and find a clear direction for every exploration.' },
      { title: 'Space to explore', text: 'Read comfortably and move naturally, on your desktop or your phone.' },
      { title: 'More possibilities', text: 'This is the first step. New pages and features will grow here.' },
    ],
    aboutTitle: 'A space of our own.',
    aboutText: 'We start with a simple homepage, clear content, and a comfortable experience. We look forward to creating more with you.',
    back: 'Back to top', footer: 'Leave the door open for new ideas.',
  },
}
