/**
 * OG 分享圖的版面（`SCREENS §16`）。★ 刻意不 import 任何 Nuxt / Nitro、不碰資料庫：
 * 純資料進、satori 元素樹出，測試與離線算圖 harness 才能直接匯入。
 * 顯名列**每一張都有**——顯名未盡者「視為自始未取得授權」，不是只有作品頁要放。
 */
// ⚠️ 三件永遠不畫（`SCREENS §16.3`，是「不做」不是「還沒做」）：票價（爬蟲是 anon）、
//    原文片名（實測 344/2,669 = 12.9% 含字型畫不出來的字）、備註（私人內容，而 OG
//    圖公開、給陌生人看、會被搜尋引擎索引）。

/** 1200×630 是 OG 的標準尺寸；字級照「被縮到 500px 寬看」來設。 */
export const OG_WIDTH = 1200
export const OG_HEIGHT = 630

/** 亮色的紙。**固定不跟隨檢視者的主題**——它是一張 PNG，沒有主題可跟。 */
const PAPER = '#F6F1EB'
const CARD = '#FFFDF9'
const INK = '#1D1610'
const INK_SOFT = '#5F5348'
const INK_FAINT = '#776A5D'
const AMBER = '#B8860B'
const RULE = '#DACCB9'

/** 缺字時換掉的那一行（`SCREENS §16.4`）。絕不渲染豆腐格。 */
export const FALLBACK_HERO = '一張票根'

type El = Record<string, unknown>

function div(style: Record<string, unknown>, children?: unknown): El {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children } }
}

/**
 * 六種版面共用的外殼：細內框 + 左側琥珀撕線帶 + 顯名列。
 * 撕線帶是全站識別（`DS §4.3` 日期帶的放大版），讓分享圖一眼認得出是同一個物件。
 */
function shell(attribution: string, body: unknown): El {
  return div(
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      backgroundColor: PAPER,
      padding: 28,
      fontFamily: 'Noto Sans TC',
    },
    [
      div({ width: 14, backgroundColor: AMBER, borderRadius: '4px 0 0 4px' }),
      div(
        {
          flex: 1,
          flexDirection: 'column',
          backgroundColor: CARD,
          border: `1px solid ${RULE}`,
          borderLeft: 'none',
          borderRadius: '0 4px 4px 0',
          padding: '44px 52px 0 52px',
        },
        [
          div({ flex: 1, flexDirection: 'column', justifyContent: 'center' }, body),
          div(
            {
              borderTop: `1px solid ${RULE}`,
              padding: '18px 0 22px 0',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: 19,
              color: INK_FAINT,
            },
            [
              div({ alignItems: 'center', gap: 10 }, [
                div({ fontSize: 22, fontWeight: 700, color: INK }, '影記'),
              ]),
              div({}, attribution),
            ],
          ),
        ],
      ),
    ],
  )
}

export interface RecordCard {
  /** 已經過缺字檢查、可以安全渲染的英雄行。 */
  hero: string
  /** kicker：日期／年份／國別。 */
  kicker: string
  /** 影城自成一行、不可切開（`DS §4.3` 兩段式）。 */
  venue?: string | null
  /** 其餘量詞串（格式、張數…）。 */
  meta?: string | null
  /** 顯名列文字。 */
  attribution: string
}

/**
 * 版面①：單筆紀錄（US-32）。主力版面。
 * ★ 英雄兩行後截斷，但 satori 的 `WebkitLineClamp` 與瀏覽器行為不完全一致 ⇒
 *   長度的最後一道防線在呼叫端的 `clampHero`，不是 CSS。
 */
export function recordCard(c: RecordCard): El {
  return shell(c.attribution, [
    div({ fontSize: 30, color: INK_SOFT, marginBottom: 26 }, c.kicker),
    div(
      {
        fontSize: 72,
        fontWeight: 700,
        color: INK,
        lineHeight: 1.25,
        marginBottom: 30,
        // 兩行後截斷。satori 的實作與瀏覽器有出入，呼叫端另有硬截斷。
        overflow: 'hidden',
      },
      c.hero,
    ),
    div({ flexDirection: 'column', gap: 8, fontSize: 34, color: INK_SOFT }, [
      c.venue ? div({}, c.venue) : null,
      c.meta ? div({ color: INK_FAINT }, c.meta) : null,
    ].filter(Boolean)),
  ])
}

export interface ProfileCard {
  username: string
  displayName?: string | null
  /** 英雄數字，例如 `169`。 */
  count: number
  /** 年表：由舊到新的 { year, n }。 */
  years: { year: number, n: number }[]
  attribution: string
}

/** YearStrip 的格子色階（`DS §1.3` 的亮色階，拉開取值不取相鄰階）。 */
const HEAT = ['#F2E9DD', '#E3D3BE', '#C9B295', '#A98F6E', '#8A6F4F', '#6B5438', '#4A3A26']

function heatColor(n: number, max: number): string {
  // 零格用最淺一階，且**只有零格用它**：「有去／沒去」要一眼分得出來（DS §1.3，≥3:1）。
  if (n <= 0)
    return HEAT[0]!
  // 有去的年份分佈在 2–6 階。★ 起點是 2 不是 0：從 0 起算「去了 3 場」會跟「完全
  //   沒去」幾乎一樣（第一版就是這樣，13 個年份看起來全是同一個棕色）。
  const t = max <= 1 ? 1 : (n - 1) / (max - 1)
  return HEAT[Math.min(HEAT.length - 1, 2 + Math.round(t * 4))]!
}

/**
 * 版面②：個人頁，以 YearStrip 為英雄——它是全站簽名且**零字型成本**（方塊 + 拉丁數字）。
 * ⚠️ 站上的 `/u/[username]` 還沒有年表（frontend 補到一半）。這裡照規格做，
 *   不要因為站上看不到就以為規格錯了。
 */
export function profileCard(c: ProfileCard): El {
  const max = c.years.reduce((m, y) => Math.max(m, y.n), 0)
  return shell(c.attribution, [
    div({ fontSize: 30, color: INK_SOFT, marginBottom: 18 }, `@${c.username}`),
    div({ alignItems: 'baseline', gap: 14, marginBottom: 34 }, [
      div({ fontSize: 132, fontWeight: 700, color: INK, lineHeight: 1 }, String(c.count)),
      div({ fontSize: 44, color: INK_SOFT }, '場'),
    ]),
    div({ gap: 10, alignItems: 'flex-end' }, c.years.map(y =>
      div({ flexDirection: 'column', alignItems: 'center', gap: 8 }, [
        div({
          width: 56,
          height: 56,
          borderRadius: 3,
          backgroundColor: heatColor(y.n, max),
        }),
        div({ fontSize: 20, color: INK_FAINT }, String(y.year).slice(2)),
      ]),
    )),
  ])
}

/**
 * 英雄行的唯一正確做法：**先驗缺字、再截斷、缺字就整行換掉。**
 *
 * ★ 這支存在的理由是「檢查可以被忘記」。原本缺字檢查在呼叫端、截斷在這裡，
 *   兩件事分開 ⇒ 少做一件就會畫出豆腐格，而**畫出來完全不會報錯**。
 *   實測踩到了：`scripts/og-preview.ts` 第一版只呼叫 `clampHero()`，
 *   於是《劇場版 藍色監獄 -EPISODE凪-》在預覽圖上就是一個方框
 *   ——正是 `SCREENS §16.4` 說絕不能出現的東西。
 *
 * ⇒ 產生英雄行一律用這一支，不要直接用 `clampHero()`。
 *   `clampHero` 仍然匯出是為了單元測試，不是給呼叫端用的。
 */
export function safeHero(title: string | null | undefined, codepoints: Set<number>): string {
  const t = (title ?? '').trim()
  if (!t)
    return FALLBACK_HERO
  // 先驗**完整**片名而不是截斷後的：截斷可能剛好把缺字切掉，於是同一部片
  // 有時降級有時不降級，取決於片名長度——那種不一致比一直降級更難查。
  for (const ch of t) {
    if (!codepoints.has(ch.codePointAt(0)!))
      return FALLBACK_HERO
  }
  return clampHero(t)
}

/**
 * 英雄行的硬截斷。**呼叫端請用 `safeHero()`**，這支沒有缺字檢查。
 *
 * satori 的 line-clamp 與瀏覽器有出入，而 OG 圖沒有第二次機會——超長片名溢出
 * 版面比截斷難看得多。以碼位計數（不是 `length`），避免把增補平面的字元切一半。
 */
export function clampHero(text: string, maxChars = 34): string {
  const chars = [...text]
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join('')}…`
}
