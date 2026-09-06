/**
 * 只有**真的跑起來**才驗得到的東西。需要一個跑著的 Nuxt server。
 *
 *   pnpm dev                                    # 另一個終端機
 *   pnpm tsx --env-file=.env scripts/verify-http.ts
 *
 * 目前涵蓋兩組：
 *   ① SSR payload 不得夾帶來訪者身分（見下）
 *   ② `/api/og/**` 真的畫得出 PNG —— 那兩支端點曾經**對每一個請求都回 400**，
 *      而 `scripts/og-preview.ts` 是直接呼叫 render 函式的，完全繞過 HTTP 路由，
 *      所以那個 400 從來沒有被任何檢查碰到過（見 server/utils/og-route.ts）。
 *
 * ── 這支存在的理由 ────────────────────────────────────────────────────────
 * `server/middleware/strip-auth-on-cacheable.ts` 守的是這個專案最貴的一個外洩：
 * @nuxtjs/supabase 的 server plugin 無條件把 session 寫進 useState，而 Nuxt 把
 * useState 序列化進 `__NUXT_DATA__` ⇒ **任何** SSR 頁面的 HTML 都夾帶該次來訪者的
 * email、sub 與一枚約 59 分鐘效期的合法 access_token。走 ISR 的路由以「路徑」為
 * 單位快取 ⇒ 第一位登入者的 token 被寫進 CDN，發給之後所有訪客。
 *
 * 那支 middleware 原本自己維護一份「哪些路由會被快取」的正則，而 `/legal/**`
 * 改成不快取之後沒有跟著改——這一次漂移的方向是安全的（多拔一次 cookie），
 * **下一次未必**。少寫一條的症狀是 token 進 CDN，而畫面完全正常。
 *
 * 所以：
 *   ① middleware 改成向 Nitro 問 `getRouteRules(event)`，不再有第二份清單；
 *   ② 這支腳本測的**不是那個機制，是我們真正在乎的性質**——
 *      「會被快取的路由，HTML 裡不得出現 access_token」。
 *      機制哪天換掉（例如改用別的方式關掉 SSR session），這條斷言仍然有效。
 *
 * ★ 路由清單直接讀 `nuxt.config.ts` 的 routeRules，不在這裡重打一份。
 *   重打就又是兩份，而兩份一定會漂移——那正是這支要修的東西。
 *
 * ── 為什麼不併進 verify:all ───────────────────────────────────────────────
 * 需要跑著的 Nuxt server。verify:all 必須在沒有 server 的環境也全綠。
 */

import { Buffer } from 'node:buffer'
import process from 'node:process'
import { Client } from 'pg'

const SITE = process.env.SITE ?? 'http://localhost:3000'
const EMAIL = 'zzssrprobe@example.com'

interface Result { ok: boolean }
const results: Result[] = []

function record(label: string, ok: boolean, detail = ''): void {
  results.push({ ok })
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n     ↳ ${detail}`}`)
}

/**
 * 從 nuxt.config.ts 取出 routeRules。
 *
 * `defineNuxtConfig` 在 Nuxt 之外是不存在的全域函式，所以先塞一個原樣回傳的
 * 替身再 import。這比自己剖析檔案可靠——它拿到的就是那份物件本身。
 */
async function loadRouteRules(): Promise<Record<string, Record<string, unknown>>> {
  ;(globalThis as Record<string, unknown>).defineNuxtConfig = (c: unknown) => c
  // ★ 路徑放在變數裡是刻意的。寫成字面值的話 TypeScript 會把 nuxt.config.ts
  //   拉進 tsconfig.pipeline 的程式集，而那裡沒有 `defineNuxtConfig` 的宣告
  //   ⇒ `pnpm typecheck` 紅在一個與這支無關的檔案上。
  const configPath = '../nuxt.config'
  const mod = await import(configPath) as { default: { routeRules?: Record<string, Record<string, unknown>> } }
  return mod.default.routeRules ?? {}
}

/** 與 middleware 同一組判準。swr 在建置期會被正規化成 cache，所以不查它。 */
function willBeCached(rule: Record<string, unknown>): boolean {
  return Boolean(rule.isr || rule.prerender || rule.cache || rule.swr)
}

/** routeRules 的萬用字元 pattern → 一條真的走得到的路徑。 */
function sampleFor(pattern: string, samples: Record<string, string>): string | null {
  if (samples[pattern])
    return samples[pattern]
  if (!pattern.includes('*'))
    return pattern
  return null
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_KEY
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !anon || !secret || !process.env.DATABASE_URL) {
    console.log('⏭️  略過：環境變數不齊')
    return
  }
  const alive = await fetch(SITE).then(() => true).catch(() => false)
  if (!alive) {
    console.log(`⏭️  略過：${SITE} 沒有回應。先在另一個終端機跑 \`pnpm dev\`。`)
    return
  }

  // 取真的 slug / venue id / username，否則抓到的是 404 頁——那上面本來就
  // 沒有 payload，斷言會「通過」而什麼都沒驗到（§7 #102）。
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const { rows } = await db.query<{ film_slug: string, venue_id: string, username: string }>(
    `select (select slug from public.film
              where slug is not null and visibility = 'public'
                and merged_into_film_id is null limit 1) as film_slug,
            (select id from public.venue limit 1) as venue_id,
            (select username from public.profile limit 1) as username`,
  )
  await db.end()
  const { film_slug: filmSlug, venue_id: venueId, username } = rows[0]!

  const samples: Record<string, string> = {
    '/film/**': `/film/${filmSlug}`,
    '/venue/**': `/venue/${venueId}`,
    '/u/**': `/u/${username}`,
    '/legal/**': '/legal/privacy',
  }

  const admin = { apikey: secret, Authorization: `Bearer ${secret}` }
  const password = `zzSsr-${Date.now()}-Aa!`
  let userId: string | null = null

  try {
    const created = await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { ...admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password, email_confirm: true }),
    })
    if (!created.ok) {
      record('建立測試帳號', false, `HTTP ${created.status}`)
      return
    }
    userId = (await created.json() as { id: string }).id

    const session = await (await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password }),
    })).json() as { access_token?: string }
    const token = session.access_token
    if (!token) {
      record('登入取得 access_token', false, '拿不到 token')
      return
    }

    const ref = new URL(url).hostname.split('.')[0]!
    const raw = `base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`
    const chunks: string[] = []
    for (let i = 0; i < raw.length; i += 3180)
      chunks.push(raw.slice(i, i + 3180))
    const cookie = chunks.length === 1
      ? `sb-${ref}-auth-token=${chunks[0]}`
      : chunks.map((c, i) => `sb-${ref}-auth-token.${i}=${c}`).join('; ')

    /** HTML 裡有沒有這次來訪者的身分。token 會被 JSON 逸出，所以也比對切片。 */
    const leaks = (html: string): string[] => {
      const found: string[] = []
      if (html.includes(token.slice(0, 40)))
        found.push('access_token')
      if (html.includes(EMAIL))
        found.push('email')
      return found
    }

    const rules = await loadRouteRules()
    const cacheablePaths: string[] = []

    for (const [pattern, rule] of Object.entries(rules)) {
      // /api/** 不 render HTML，沒有 payload 可外洩。
      // 不可快取的路由不在這支的範圍內（它們的 HTML 只有請求者自己看得到）。
      if (pattern.startsWith('/api') || !willBeCached(rule))
        continue

      const path = sampleFor(pattern, samples)
      if (!path) {
        record(`routeRules ${pattern} 會被快取，但沒有樣本路徑`, false, '請在 samples 補一條真的走得到的路徑，否則這條規則從來沒有被驗過')
        continue
      }

      cacheablePaths.push(path)
      const res = await fetch(`${SITE}${path}`, { headers: { cookie } })
      const html = await res.text()
      const found = leaks(html)

      // ⚠️ 404 也是 Nuxt render 出來的 SSR 頁，一樣吃這條 route rule、一樣會被
      //    快取，所以它的 payload 同樣不得夾帶身分——**但它證不了那個路由本身
      //    是乾淨的**（真正的頁面可能還沒寫，或寫了之後才開始塞東西進 useState）。
      //    所以照驗，但在標籤上講清楚它只是弱證據。
      const weak = res.status === 404 ? '（⚠️ 這條路由目前是 404，只驗到錯誤頁）' : ''
      record(`★ ${pattern} 會被快取 ⇒ payload 不得夾帶身分（${path}）${weak}`, found.length === 0, `HTTP ${res.status}，HTML 裡出現了 ${found.join(' / ')}`)
    }

    record('至少有一條可快取路由被驗到（否則整段是空轉）', cacheablePaths.length > 0, '沒有任何 routeRules 標成 isr/prerender/cache')

    // ★ 對照組。沒有它，上面每一條「沒有 token」都可能只是因為比對方式錯了，
    //   或者根本沒帶到 cookie（§7 #102 就是這樣被騙過去的）。
    //   /u/** 是 no-store 的私人頁，middleware 刻意**不**拔 cookie ⇒ 這裡必須看得到。
    const control = await fetch(`${SITE}/u/${username}`, { headers: { cookie } })
    const controlHtml = await control.text()
    record('★ 對照組：不快取的 /u/** 上**看得到**身分（證明偵測方式是對的）', control.ok && leaks(controlHtml).length > 0, control.ok
      ? '連不快取的頁面都找不到 token ⇒ cookie 沒帶到，或比對方式錯了，上面全是假綠燈'
      : `HTTP ${control.status}`)

    // 未登入時本來就不該有任何身分——順手釘住，免得將來有人在 SSR 期間
    // 從別的來源（例如 service role）撈到別人的資料塞進 payload。
    const anonRes = await fetch(`${SITE}/film/${filmSlug}`)
    record('未登入造訪可快取路由：payload 乾淨', anonRes.ok && leaks(await anonRes.text()).length === 0, `HTTP ${anonRes.status}`)

    // ── ② OG 圖 ──────────────────────────────────────────────────────────
    // ★ 只驗狀態碼會被騙：端點回 200 但畫出一張 0 byte 或一張 JSON 的情況都存在過。
    //   這裡驗到「真的是 1200×630 的 PNG」為止——PNG 的 IHDR 就在檔頭，
    //   不需要影像函式庫。
    const recRows = await (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
      await c.connect()
      const r = await c.query<{ id: string }>(
        `select id::text from public.viewing_record where visibility = 'public' limit 1`,
      )
      await c.end()
      return r.rows
    })()

    const ogTargets: [string, string][] = [
      ['/api/og/u/{username}.png（版面②）', `/api/og/u/${username}.png`],
      ['/api/og/u/{username}（不帶 .png 也該通）', `/api/og/u/${username}`],
    ]
    if (recRows[0])
      ogTargets.push(['/api/og/record/{id}.png（版面①）', `/api/og/record/${recRows[0].id}.png`])

    for (const [label, path] of ogTargets) {
      const res = await fetch(`${SITE}${path}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const isPng = buf.length > 24
        && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
      const width = isPng ? buf.readUInt32BE(16) : 0
      const height = isPng ? buf.readUInt32BE(20) : 0
      record(`★ ${label}`, res.ok && isPng && width === 1200 && height === 630, `HTTP ${res.status}、${buf.length} bytes、isPng=${isPng}、${width}x${height}`
      + `${res.ok && !isPng ? `、開頭：${buf.subarray(0, 60).toString('utf8')}` : ''}`)
    }

    // 對照組：不存在的使用者必須 404，而不是畫一張空圖出來。
    const ogMissing = await fetch(`${SITE}/api/og/u/zznosuchuser.png`)
    record('★ 對照組：不存在的使用者 → 404（不是一張空圖）', ogMissing.status === 404, `實得 HTTP ${ogMissing.status}`)
  }
  finally {
    if (userId) {
      await fetch(`${url}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: admin })
    }
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    await c.connect()
    const { rows: r } = await c.query<{ n: string }>(
      `select count(*)::text as n from public.profile where username like 'zzssrprobe%'`,
    )
    await c.end()
    record('cleanup/no-residue', r[0]!.n === '0', `殘留 ${r[0]!.n} 個 profile`)
  }
}

await main()

const failed = results.filter(r => !r.ok).length
console.log(`\n── 合計 ── 通過 ${results.length - failed}／失敗 ${failed}`)
if (failed)
  process.exit(1)
