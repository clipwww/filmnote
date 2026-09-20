/**
 * `/u/**` 公開頁的匿名驗收。**用完全不帶 cookie 的請求真的打一次**：RLS 是對的不代表
 * 這一頁是對的——資料經過 RLS → 端點的欄位挑選 → 頁面的 render 三層，任何一層多帶一個
 * 欄位出來，RLS 都還是綠的。
 */
// ★ 「看不到」必須配一組「看得到」：只驗「匿名看不到票價」會被「中介層把所有東西都拔光」
//   矇混過去（§7 #102 就是這樣被騙的）⇒ 每一條「不該有」旁邊都有一條對照組，而且對照組
//   要真的會因為資料變空而變紅。
// 實測抓得到什麼（2026-09-06 逐條弄壞驗證過）：端點的金額白名單漏一個欄位 → `u/stats-no-money`
//   紅；頁面把票價 render 進 SSR HTML → `u/html-no-money` 紅而對照組保持綠。
// ⚠️ 需要跑著的 dev server，沒有就**略過**（不是失敗）；但略過的理由要寫明它守的是什麼
//    ——**被略過的斷言等於不存在**。

import process from 'node:process'

const SITE = process.env.SITE ?? 'http://localhost:3000'

interface Reporter {
  record: (id: string, ok: boolean, detail?: string, guards?: string) => void
  skip: (id: string, why: string, guards?: string) => void
}

const GUARDS = '★ 踩雷 #1／硬約束三：/u/** 不得快取，且匿名視角看不到票價——但看得到內容'

/** 完全不帶 cookie／Authorization 的請求。 */
async function anon(path: string): Promise<{ status: number, headers: Headers, text: string }> {
  const res = await fetch(`${SITE}${path}`, {
    headers: { 'accept': 'application/json,text/html', 'user-agent': 'filmnote-anon-check' },
    redirect: 'manual',
  })
  return { status: res.status, headers: res.headers, text: await res.text() }
}

/** `YYYY-MM-DD` → isodow（1=週一…7=週日）。全程 UTC，理由見 `utils/stats.ts`。 */
function isoDow(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date))
  if (!m)
    return null
  return ((new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() + 6) % 7) + 1
}

export async function runPublicProfileChecks(r: Reporter, username: string | null): Promise<void> {
  const alive = await fetch(SITE).then(() => true).catch(() => false)
  if (!alive)
    return r.skip('u/public', `${SITE} 沒有回應 —— 這一組守的是「匿名在 /u/ 上看不到票價、但看得到內容」。先跑 \`pnpm dev\` 再跑一次。`, GUARDS)

  if (!username)
    return r.skip('u/public', '找不到任何公開的 username 可以拿來驗', GUARDS)

  const rec = (id: string, ok: boolean, detail?: string) => r.record(id, ok, detail, GUARDS)

  // ── 圖表端點 ──────────────────────────────────────────────────────────
  const statsRes = await anon(`/api/u/${username}/stats`)
  if (statsRes.status !== 200)
    return rec('u/stats-reachable', false, `GET /api/u/${username}/stats → ${statsRes.status}`)

  const s = JSON.parse(statsRes.text)

  // ★ 對照組先來：證明匿名真的拿得到東西，後面的「沒有金額」才有意義
  rec('u/stats-visible', s.totals?.records > 0 && s.daily?.length > 0 && s.weekdayHour?.length > 0, `★ 對照組：匿名拿得到圖表資料（records=${s.totals?.records} daily=${s.daily?.length}）`)

  // ⚠️ 比對加了引號的鍵名，不是裸字串——`records` 裡含 "cost" 之類的誤判很煩人
  const money = ['spend', 'cost', 'amount', 'avg_spend', 'currency', 'spend_is_partial']
  const leaked = money.filter(k => statsRes.text.includes(`"${k}"`))
  rec('u/stats-no-money', leaked.length === 0, `圖表端點洩漏金額欄位：${leaked.join('、')}`)

  // ── 圖與列表必須是同一個母體 ──────────────────────────────────────────
  const listRes = await anon(`/api/u/${username}?limit=200`)
  const l = JSON.parse(listRes.text)
  rec('u/stats-same-population', s.totals.records === l.counts?.records && s.totals.records === l.page?.total, `圖 ${s.totals.records}／counts ${l.counts?.records}／page.total ${l.page?.total} 對不起來`)

  // ── 年表不是從那 200 筆就地算的 ───────────────────────────────────────
  const dailySum = s.daily.reduce((n: number, d: { records: number }) => n + d.records, 0)
  rec('u/strip-is-full-aggregate', dailySum === s.totals.records, `daily 加總 ${dailySum} ≠ totals ${s.totals.records}（年表可能是從分頁的列表算的）`)

  // ── `monthly_baseline` 不受 year 影響（`verify-core` H4 的前端側對照）──
  const y = s.availableYears?.[Math.min(1, (s.availableYears?.length ?? 1) - 1)]
  if (y) {
    const scoped = JSON.parse((await anon(`/api/u/${username}/stats?year=${y}`)).text)
    rec('u/baseline-year-invariant', JSON.stringify(scoped.monthlyBaseline) === JSON.stringify(s.monthlyBaseline), `指定年份(${y})的 monthly_baseline 與全期不同 ⇒ 基準線被 p_year 過濾了`)
    // ★ 對照組：其他欄位確實有跟著 year 變，否則上面那條是在比兩份一樣的東西
    rec('u/baseline-invariant-discriminates', scoped.totals.records !== s.totals.records && scoped.totals.records > 0, `★ 對照組：${y} 年 ${scoped.totals?.records} 場 vs 全期 ${s.totals?.records} 場——一樣的話上面那條在空轉`)
  }

  // ── 抽屜的母體：匿名翻得完，而且圖上那一格的數字對得起來 ────────────────
  // `film` 放寬到含 id：多刷排行以 `film_id` 分組，抽屜要靠它把排行的一列對回紀錄。
  const acc: { id: string, watchedOn: string, watchedTime: string | null, film?: { id?: string | null } | null }[] = []
  const total = l.page?.total ?? 0
  for (let off = 0; off < total; off += 200) {
    const page = JSON.parse((await anon(`/api/u/${username}?limit=200&offset=${off}`)).text)
    if (!page.items?.length)
      break
    acc.push(...page.items)
  }
  const uniq = new Set(acc.map(x => x.id)).size
  rec('u/drawer-population-complete', acc.length === total && uniq === total, `翻到 ${acc.length} 筆、相異 ${uniq} 筆，應為 ${total}（抽屜會少列或重複）`)

  const withMoney = acc.filter(x => 'cost' in x || 'costAmount' in x || 'cost_amount' in x)
  rec('u/drawer-cards-no-money', withMoney.length === 0, `${withMoney.length} 筆帶金額 ⇒ 抽屜的票根卡會印出票價`)

  // ★ 「圖說 N 場、抽屜就有 N 張」——用列表自己重算，不是相信端點
  const peak = [...(s.weekdayHour ?? [])].sort((a, b) => b.records - a.records)[0]
  if (peak) {
    const fromList = acc.filter(x =>
      isoDow(x.watchedOn) === peak.weekday
      && Number(String(x.watchedTime).slice(0, 2)) === peak.hour).length
    rec('u/heatmap-matches-drawer', fromList === peak.records, `熱點圖 週${peak.weekday} ${peak.hour}時 說 ${peak.records} 場，匿名列表重算得 ${fromList} 筆`)
  }

  /*
   * ── 多刷排行（band 7）與抽屜的母體 ──
   * ⚠️ **這兩條不檢查抽屜，它們檢查的是資料層**（名字刻意不叫 `matches-drawer`）：這裡做的
   *    是把 `/stats` 的 repeats 跟列表在腳本裡重算一次，所以四種弄壞法它們**全都會綠**——
   *    `@pick` 跳過 `await ensureAllRecords()`、`inRepeatScope` 少了年份條件、過濾 `visible`
   *    而不是 `cards`、TicketCard 忘了傳 `show-year`。那四件事這個 repo 沒有東西自動守得住
   *    （沒有 @vue/test-utils、沒有 happy-dom），只能靠瀏覽器手動點。
   *    **被略過的斷言等於不存在，冒充的斷言比略過更糟。**
   */
  const repeats: { film_id: string, title_zh: string | null, records: number }[] = s.repeats ?? []
  const topRepeat = [...repeats].sort((a, b) => b.records - a.records)[0]
  if (!topRepeat) {
    r.skip('u/repeat-film-id-joins', `${username} 沒有任何多刷作品 —— 這一條守的是「repeats 的 film_id 與列表的 film.id 是同一個識別空間」，沒有多刷就沒得比。`, GUARDS)
    r.skip('u/repeat-scope-follows-year', '同上：沒有多刷作品可以拿來驗年份 scope。', GUARDS)
  }
  else {
    // ① 識別空間：`film.id` 真的有送到 client，而且對得起 repeats 的 film_id。
    //    端點是逐欄挑白名單的（`venues[].venue_id` 就已經被挑掉了），
    //    哪天 `id` 從 select 掉出去，這裡的 fromList 會變 0。
    const fromList = acc.filter(x => x.film?.id === topRepeat.film_id).length
    rec('u/repeat-film-id-joins', fromList === topRepeat.records, `多刷排行「${topRepeat.title_zh}」說 ${topRepeat.records} 次，匿名列表用 film.id 重算得 ${fromList} 筆`)
    // ★ 對照組：兩邊都是 0 的話上面那條是空轉（film.id 整個沒送出來就是這樣）
    rec('u/repeat-film-id-discriminates', topRepeat.records > 1 && fromList > 0, `★ 對照組：最高多刷 ${topRepeat.records} 次、列表重算 ${fromList} 筆——列表這邊是 0 的話上面那條是假綠燈`)

    // ② 年份 scope：指定年份時 repeats 的數字只算那一年。
    //    挑「那部片最常看的那一年」，因為只有 >1 次才進得了 repeats。
    const byYear = new Map<string, number>()
    for (const x of acc) {
      if (x.film?.id !== topRepeat.film_id)
        continue
      const yy = String(x.watchedOn).slice(0, 4)
      byYear.set(yy, (byYear.get(yy) ?? 0) + 1)
    }
    const best = [...byYear.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!best || best[1] < 2) {
      r.skip('u/repeat-scope-follows-year', `「${topRepeat.title_zh}」在任何單一年份都只看過 1 次（全期 ${topRepeat.records} 次分散在 ${byYear.size} 個年份），單年不會進 repeats ⇒ 沒得比。這一條守的是「指定年份時 repeats 只算那一年」。`, GUARDS)
    }
    else {
      const [yTop, yCount] = best
      const scopedStats = JSON.parse((await anon(`/api/u/${username}/stats?year=${yTop}`)).text)
      const hit = (scopedStats.repeats ?? []).find((x: { film_id: string }) => x.film_id === topRepeat.film_id)
      rec('u/repeat-scope-follows-year', hit?.records === yCount, `${yTop} 年的 repeats 對「${topRepeat.title_zh}」說 ${hit?.records ?? '（不在清單裡）'} 次，匿名列表過濾 ${yTop} 重算得 ${yCount} 筆`)
      // ★ 對照組：單年一定要真的比全期少，否則上面那條在比兩份一樣的東西
      //   （`?year=` 被忽略時就是這個形狀，而每個數字看起來都合理）
      rec('u/repeat-scope-discriminates', yCount < topRepeat.records, `★ 對照組：${yTop} 年 ${yCount} 次 vs 全期 ${topRepeat.records} 次——一樣的話 year 參數可能整個被忽略了`)
    }
  }

  // ── HTTP 快取標頭（踩雷 #1）───────────────────────────────────────────
  const html = await anon(`/u/${username}`)
  const cc = html.headers.get('cache-control') ?? ''
  rec('u/no-store', cc.includes('no-store') && cc.includes('private'), `cache-control: "${cc}" —— /u/** 絕不可被快取`)

  // ── SSR 的 HTML 裡沒有金額，但確實有內容 ───────────────────────────────
  const hits = html.text.match(/NT\$[\d,]+|"cost"|cost_amount/g)
  rec('u/html-no-money', !hits, `匿名拿到的 HTML 裡有金額：${hits?.slice(0, 5).join('、')}`)
  rec('u/html-has-content', html.status === 200 && html.text.includes(username) && html.text.includes('觀影紀錄'), `★ 對照組：那份 HTML 確實有內容（status=${html.status} len=${html.text.length}）——空的話上面那條是假綠燈`)
}

/** 單獨跑：`pnpm tsx --env-file=.env scripts/verify-u-public.ts [username]` */
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let pass = 0
  let fail = 0
  await runPublicProfileChecks({
    record: (id, ok, detail) => {
      console.log(`${ok ? '✅' : '❌'} ${id.padEnd(34)}${ok ? '' : `\n     ↳ ${detail}`}`)
      if (ok)
        pass++
      else
        fail++
    },
    skip: (id, why) => console.log(`⏭️  ${id.padEnd(34)}\n     ↳ 略過：${why}`),
  }, process.argv[2] ?? null)
  console.log(`\n── 合計 ── 通過 ${pass}／失敗 ${fail}`)
  process.exit(fail ? 1 : 0)
}
