/** Homepage rendering for the standalone webwjkj application. */
import { locales, type Locale } from './locales.ts'
import { styles } from './styles.ts'

/**
 * Render a complete page from package-owned locale dictionaries.
 * @param locale - language selected by the registered route.
 * @returns HTML with local styles and no browser scripts.
 */
export function renderHomepage(locale: Locale): string {
  const t = locales[locale]
  return `<!doctype html>
<html lang="${t.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${t.description}"><meta name="theme-color" content="#f7f8f4"><title>webwjkj</title><style>${styles}</style></head>
<body id="top"><div class="wrap">
<header><a class="brand" href="${locale === 'zh' ? '/' : '/en'}"><span class="mark" aria-hidden="true">w</span>webwjkj</a><nav aria-label="${t.navigation}"><a class="home-link" href="#top">${t.home}</a><a href="#about">${t.about}</a><a class="language" href="${t.switchPath}" hreflang="${locale === 'zh' ? 'en' : 'zh-CN'}">${t.switchLanguage}</a></nav></header>
<main><section class="hero"><div class="eyebrow"><span class="dot" aria-hidden="true"></span>${t.eyebrow}</div><h1>${t.title}</h1><p class="description">${t.description}</p><div class="actions"><a class="primary" href="#explore">${t.action}<span aria-hidden="true">↗</span></a><a class="secondary" href="#about">${t.secondary}</a></div></section>
<section class="section" id="explore"><span class="label">${t.sectionLabel}</span><h2>${t.sectionTitle}</h2><div class="cards">${t.cards.map((card, index) => `<article class="card"><span class="number" aria-hidden="true">0${index + 1} /</span><h3>${card.title}</h3><p>${card.text}</p></article>`).join('')}</div></section>
<section class="section about" id="about"><h2>${t.aboutTitle}</h2><p>${t.aboutText}</p></section></main>
<footer><span>webwjkj · ${t.footer}</span><a href="#top">${t.back} ↑</a></footer>
</div></body></html>
`
}
