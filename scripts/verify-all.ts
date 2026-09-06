/**
 * 一次跑完全部驗收。
 *
 *   pnpm tsx --env-file=.env scripts/verify-all.ts
 *   pnpm tsx --env-file=.env scripts/verify-all.ts --sql-only   # 跳過需要臨時帳號的 HTTP 段
 *
 * ── 這支存在的理由 ────────────────────────────────────────────────────────
 * 這個專案最有價值的資產是那些斷言——**每一條都對應一個真的踩過的坑**。但它們
 * 原本散在三支 SQL、一支 parser 檢查、以及 BUILD_PLAN §5 各 Step 的 curl 裡，
 * 只有讀過那些文件的人知道怎麼跑。session 一換就等於沒有。
 *
 * ── 三條規矩 ──────────────────────────────────────────────────────────────
 * ① 每條斷言都標出它守的是哪個坑（§7 編號或 Step 編號）。沒有那句話的斷言，
 *    日後有人看到它紅了會傾向刪掉它，而不是修程式。
 * ② 不留痕跡。SQL 段全部 begin/rollback；HTTP 段建立的臨時帳號與資料在
 *    finally 裡刪除，**不靠執行者記得**。
 * ③ 假綠燈比紅燈危險。凡是「應該看不到」的斷言，都必須有一組「應該看得到」的
 *    對照——否則分不出「擋住了」與「本來就沒東西」（§7 #102 就是這樣被騙過去的）。
 *
 * ── 為什麼 HTTP 段不能改用 SQL 模擬 ───────────────────────────────────────
 * §7 #100：`set local role` 只改 current_user，**session_user 直連時永遠是
 * postgres** ⇒ `is_service_context()` 為真，`merge_films` 這類判準在 db:sql
 * 腳本裡一律放行。拿它當授權測試會得到假的「破口重現」，反過來寫則是永遠通過
 * 的假綠燈。**這類授權只能用真的 PostgREST + 真的使用者 JWT 測。**
 */

import type { YearStats } from '../app/utils/stats'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { Client, types as pgTypes } from 'pg'
import { monthlyBaselineSeries } from '../app/utils/stats'
import { runSsrAndOgChecks } from './verify-http'
import { runPublicProfileChecks } from './verify-u-public'

// 與 scripts/db.ts 同：不要讓 node-postgres 把 date/timestamp 轉成 JS Date，
// 那個顯示層會讓人得出完全相反的結論（交接筆記 2.1）。
for (const oid of [1082, 1114, 1184, 1083])
  pgTypes.setTypeParser(oid, v => v)

const TEST_EMAIL = 'zzverify@example.com'
const TEST_PREFIX = '__verify_http__'
// US-47 那一段自己的兩個帳號。刪除測試會把 A 真的刪掉，不能跟上面共用。
const DELETE_EMAIL = 'zzdelete@example.com'
const BYSTANDER_EMAIL = 'zzbystander@example.com'

interface Result { id: string, guards: string, ok: boolean, detail?: string, skipped?: boolean }
const results: Result[] = []

function record(id: string, guards: string, ok: boolean, detail?: string) {
  results.push({ id, guards, ok, detail })
  const mark = ok ? '✅' : '❌'
  console.log(`${mark} ${id.padEnd(28)} ${guards}${ok ? '' : `\n     ↳ ${detail}`}`)
}

function skip(id: string, guards: string, why: string) {
  results.push({ id, guards, ok: true, skipped: true, detail: why })
  console.log(`⏭️  ${id.padEnd(28)} ${guards}\n     ↳ 略過：${why}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL 段
// ─────────────────────────────────────────────────────────────────────────────

async function runSqlFile(path: string, guards: string): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url)
    return skip(path, guards, '缺少 DATABASE_URL')

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 300_000,
  })
  const warnings: string[] = []
  client.on('notice', (m) => {
    // 斷言的細節走 notice/warning 通道，不會出現在查詢結果裡。
    if (m.severity === 'WARNING' && m.message)
      warnings.push(m.message)
  })

  await client.connect()
  try {
    await client.query(await readFile(path, 'utf8'))
    record(path, guards, true)
  }
  catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    record(path, guards, false, [msg, ...warnings].join('\n     ↳ '))
  }
  finally {
    await client.end()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 段 —— 需要真的 PostgREST、真的 JWT、真的 storage
// ─────────────────────────────────────────────────────────────────────────────

interface HttpEnv { url: string, anon: string, secret: string }

async function sql(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  try {
    return (await client.query(query, params)).rows as Record<string, unknown>[]
  }
  finally {
    await client.end()
  }
}

/**
 * 把 `.vue` 原始碼裡的註解拿掉，只留下真的會執行的部分。
 *
 * ⚠️ 存在的理由見下方③的註解：**註解會餵飽字串比對的斷言**。
 * 這支不追求剖析正確（不處理字串字面裡的 `//`），它只需要讓
 * 「檔案裡提到某個名字」與「檔案裡真的呼叫某個名字」分得開。
 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ') // template 註解
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 區塊註解（含 JSDoc）
    .replace(/^\s*\/\/.*$/gm, ' ') // 整行的行註解
}

/**
 * ── 前端有沒有真的接上 `monthly_baseline` ───────────────────────────────────
 *
 * ★★ 這一段守的是一個 **DB 那側守不到** 的破法。
 *
 * `verify-core` 的 H4／H6 把 `monthly_baseline` 這個欄位釘得很牢（不受 p_year
 * 影響、分母是曝光數而不是年份數）。但它們只證明**資料庫給的是對的**——
 * 完全沒有東西證明**前端有在用它**。實測 2026-09-06：那個欄位在整個前端
 * `grep` 是空的，`app/utils/stats.ts` 自己用「該月份總場次 ÷ 年份數」另算了一套，
 * 12 個月裡有 5 個偏掉（十月畫 1.85，DB 說 2.00），而 H1–H6 全綠。
 *
 * 這正是 `backend.md §6e` 預言過的形狀：一致性斷言只驗到內部一致。
 *
 * 所以這裡拿**真實資料**跑**真正的前端函式**（直接 import `app/utils/stats.ts`，
 * 不是抄一份公式——抄一份就變成實作的複本，實作改錯它會跟著改錯），
 * 再跟 DB 的答案逐格對帳。三條：
 *
 *   ① 前端算出來的 12 個值 === DB 的 `monthly_baseline[].avg_records`
 *   ② ★ **對照組**：同一組資料用「年份數」當分母會得到**不同**的答案。
 *      沒有這一條的話，哪天資料剛好變成兩種分母同解（例如每個月曝光數都相同），
 *      ①就會靜默失去分辨力而照樣全綠——那是「看不到必須配一組看得到」的同一個道理。
 *   ③ 呼叫端真的有接線：畫這條線的頁面必須引用得到這個值。
 *      ①②只證明函式對，不證明有人呼叫它——而 2026-09-06 的病灶正是「沒人呼叫」。
 */
async function runMonthlyBaselineChecks(): Promise<void> {
  const guards = '★ §6e／§7 #123：平均線的分母是曝光數，而且前端要真的用 DB 給的那個欄位'

  const rows = await sql(
    `select p.username, public.user_year_stats(p.username, null) as stats
       from public.profile p
       join auth.users u on u.id = p.id
      where u.email = $1`,
    // ⚠️ 以 email 精確指定，不用 `limit 1`／「DB 裡唯一一筆 profile」這種假設。
    //    email 從環境變數來，**不進版控**（這個 repo 是 public 的）。
    [process.env.IMPORT_TARGET_EMAIL ?? ''],
  )

  const stats = rows[0]?.stats as YearStats | undefined
  const baseline = stats?.monthly_baseline
  if (!baseline?.length) {
    skip('frontend/monthly-baseline', guards, 'IMPORT_TARGET_EMAIL 沒設或該帳號沒有紀錄 ⇒ 拿不到真實資料可對帳')
    return
  }

  // ① 前端的函式 vs DB 的答案
  const fromFrontend = monthlyBaselineSeries(baseline)
  const fromDb = [...baseline].sort((a, b) => a.month - b.month).map(b => b.avg_records)
  record('frontend/monthly-baseline', guards, JSON.stringify(fromFrontend) === JSON.stringify(fromDb), `前端 ${JSON.stringify(fromFrontend)} vs DB ${JSON.stringify(fromDb)}`)

  // ② ★ 對照組：這組資料真的分辨得出兩種分母嗎？
  const yearCount = stats?.by_year?.length ?? 0
  const byYearCount = [...baseline]
    .sort((a, b) => a.month - b.month)
    .map(b => (yearCount ? Math.round((b.records / yearCount) * 100) / 100 : 0))
  const differs = byYearCount.some((v, i) => v !== fromDb[i])
  record('frontend/monthly-baseline-discriminates', guards, differs, differs
    ? `年份數分母(${yearCount}) 會得到 ${JSON.stringify(byYearCount)}，與曝光數分母不同 ⇒ ①有分辨力`
    : `⚠️ 這組資料下兩種分母同解 ⇒ 上面那條**分辨不出**錯的分母，等於沒在守`)

  // ③ 呼叫端真的有接線。
  //
  // ⚠️ 這裡**不寫死頁面清單**。寫死的話，這條會在「某一頁還沒做圖表」時紅
  //    （那不是缺陷，是還沒做），而真正該紅的「新增了一頁畫月度趨勢卻自己算平均」
  //    反而漏掉——清單不會自己長出新頁面。
  //    改成從實作推導：**凡是 render `<MonthlyTrend` 的檔案，都必須引用得到
  //    `monthlyBaselineSeries`。** 條件與結論都跟著程式碼走。
  const files = execFileSync('git', ['ls-files', 'app'], { encoding: 'utf8' })
    .split('\n')
    .filter(f => f.endsWith('.vue'))
  const drawers: string[] = []
  const missing: string[] = []
  for (const f of files) {
    // ⚠️ **一定要先把註解拿掉。** 第一版用 `src.includes('monthlyBaselineSeries')`
    //    直接掃原始碼，實測把呼叫拿掉之後**照樣綠**——因為那一頁的註解裡就寫著
    //    「見 stats.ts 的 monthlyBaselineSeries()」，註解餵飽了斷言。
    //    這個專案最貴的錯就是這種「檢查機制本身失效」，而且這一條是我自己剛寫的。
    const src = stripComments(await readFile(f, 'utf8').catch(() => ''))
    // 元件自己不算（它收 prop，不負責取數）
    if (!src.includes('<MonthlyTrend') || f.endsWith('MonthlyTrend.vue'))
      continue
    drawers.push(f)
    // 要的是**呼叫**，所以左括號是條件的一部分
    if (!/monthlyBaselineSeries\s*\(/.test(src))
      missing.push(f)
  }
  record('frontend/monthly-baseline-wired', guards, drawers.length > 0 && missing.length === 0, !drawers.length
    ? '⚠️ 找不到任何 render <MonthlyTrend 的頁面 ⇒ 這條在空轉'
    : missing.length
      ? `這些頁面畫了月度趨勢卻沒有引用 monthlyBaselineSeries（＝自己算了一套）：${missing.join('、')}`
      : `${drawers.length} 個呼叫端都接上了：${drawers.join('、')}`)
}

async function runHttpChecks(env: HttpEnv): Promise<void> {
  const password = `zzVerify-${Date.now()}-Aa!`
  let userId: string | null = null
  let filmId: string | null = null

  try {
    // ── 建立臨時帳號並取得真實 JWT ───────────────────────────────────────
    const created = await fetch(`${env.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { 'apikey': env.secret, 'Authorization': `Bearer ${env.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password, email_confirm: true }),
    })
    if (!created.ok)
      return skip('http/*', '需要臨時帳號', `建立測試帳號失敗 HTTP ${created.status}`)
    userId = (await created.json() as { id: string }).id

    const signedIn = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': env.anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password }),
    })
    const token = (await signedIn.json() as { access_token?: string }).access_token
    if (!token)
      return skip('http/*', '需要臨時帳號', '登入取不到 access_token')

    const asUser = { apikey: env.anon, Authorization: `Bearer ${token}` }
    const asAnon = { apikey: env.anon, Authorization: `Bearer ${env.anon}` }

    // ── ① 破壞性寫入：三種身分 ──────────────────────────────────────────
    // 先建兩部拋棄式作品當標的。就算攻擊成功，毀掉的也只是測試資料。
    const films = await sql(
      `insert into public.film (title_zh, origin, visibility, review_state)
       values ($1 || '敗方','gov','public','approved'), ($1 || '勝方','gov','public','approved')
       returning id`,
      [TEST_PREFIX],
    )
    const loser = films[0]!.id as string
    const winner = films[1]!.id as string

    const rpc = async (name: string, body: unknown, headers: Record<string, string>) =>
      fetch(`${env.url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    const mergeBody = { p_loser: loser, p_winner: winner, p_reason: 'verify' }

    const userMerge = await rpc('merge_films', mergeBody, asUser)
    record('http/merge-as-user', '§1.1 修正 A、§7 #100（此路徑曾實測回 204）', userMerge.status === 403, `期望 403，實得 ${userMerge.status}`)

    const anonMerge = await rpc('merge_films', mergeBody, asAnon)
    record('http/merge-as-anon', 'Step 7 驗收', anonMerge.status === 401 || anonMerge.status === 403, `期望 401/403，實得 ${anonMerge.status}`)

    const userApprove = await rpc('approve_film', { p_film: loser, p_approve: true }, asUser)
    record('http/approve-as-user', 'Step 7 驗收、踩雷 #26', userApprove.status === 403, `期望 403，實得 ${userApprove.status}`)

    // 對照：真的沒被合併。只看狀態碼的話，端點回 403 但資料被改了也看不出來。
    const stillSeparate = await sql(
      `select count(*)::int as n from public.film where id = $1 and merged_into_film_id is null`,
      [loser],
    )
    record('http/merge-no-effect', 'Step 7 驗收（狀態碼之外再看一次資料）', (stillSeparate[0]!.n as number) === 1, '越權呼叫被擋下了，但敗方竟然已被標記為合併')

    // ── ② 侵權通知在 API 層單向 ─────────────────────────────────────────
    const noticeBody = {
      claimant_name: `${TEST_PREFIX}原告`,
      claimant_email: 'zzverify@example.invalid',
      work_description: '驗收用的通知內容，長度需超過門檻。',
      target_url: 'https://example.invalid/verify',
      statement_good_faith: true,
    }
    const post = (prefer: string) => fetch(`${env.url}/rest/v1/takedown_notice`, {
      method: 'POST',
      headers: { ...asAnon, 'Content-Type': 'application/json', 'Prefer': prefer },
      body: JSON.stringify(noticeBody),
    })

    const minimal = await post('return=minimal')
    record('http/dmca-insert', 'Step 8 驗收、§90-4 第 3 款（未登入者必須提得出通知）', minimal.status === 201, `期望 201，實得 ${minimal.status}`)

    // 反向對照：帶 return=representation 必須失敗。沒有 SELECT policy 就拿不到
    // RETURNING —— 這正是「單向」的證據，也證明上一條的 201 不是因為權限全開。
    const representation = await post('return=representation')
    record('http/dmca-one-way', 'Step 8 驗收（單向性的反向對照）', representation.status >= 400, `期望 4xx，實得 ${representation.status}`)

    const read = await fetch(`${env.url}/rest/v1/takedown_notice?select=*`, { headers: asAnon })
    record('http/dmca-no-read', 'Step 8 驗收', read.status >= 400, `期望 4xx，實得 ${read.status}`)

    // ── ③ 未審核海報：不可取、不可列舉，且有對照組 ─────────────────────
    const ugc = await fetch(`${env.url}/rest/v1/film`, {
      method: 'POST',
      headers: { ...asUser, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({
        title_zh: `${TEST_PREFIX}未審核UGC`,
        origin: 'ugc',
        visibility: 'private',
        review_state: 'pending',
        moderation_state: 'visible',
        created_by: userId,
      }),
    })
    const ugcRows = await ugc.json() as { id: string }[]
    filmId = Array.isArray(ugcRows) ? ugcRows[0]?.id ?? null : null

    if (!filmId) {
      skip('http/poster-*', 'Step 7 驗收', '建立 UGC 作品失敗，海報段無法進行')
    }
    else {
      // PNG magic number + 64 個 0。用 new Uint8Array(72) 而不是展開一個
      // Array.from(...).fill(0)：後者的型別是 unknown[]，而 tsx 不做型別檢查
      // ⇒ verify:all 全綠但 pnpm typecheck 紅。
      const png = new Uint8Array(72)
      png.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
      const up = await fetch(`${env.url}/storage/v1/object/ugc-poster/${filmId}/poster.png`, {
        method: 'POST',
        headers: { ...asUser, 'Content-Type': 'image/png' },
        body: png,
      })
      record('http/poster-upload', 'Step 7（前置：沒有這一步，下面的斷言全是空轉）', up.status === 200, `上傳失敗 HTTP ${up.status}`)

      const pub = await fetch(`${env.url}/storage/v1/object/public/ugc-poster/${filmId}/poster.png`)
      record('http/poster-public', 'Step 7 驗收、踩雷 #26（bucket 必須是 private）', pub.status >= 400, `期望 4xx，實得 ${pub.status}`)

      const auth = await fetch(`${env.url}/storage/v1/object/authenticated/ugc-poster/${filmId}/poster.png`, { headers: asAnon })
      record('http/poster-anon-get', 'Step 7 驗收（走 RLS 的那條路）', auth.status >= 400, `期望 4xx，實得 ${auth.status}`)

      const list = (headers: Record<string, string>) => fetch(`${env.url}/storage/v1/object/list/ugc-poster`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: `${filmId}/`, limit: 100 }),
      }).then(r => r.json() as Promise<unknown[]>)

      const anonList = await list(asAnon)
      record('http/poster-no-list', '★ Step 7 驗收（只測取檔會漏掉列舉）', Array.isArray(anonList) && anonList.length === 0, `期望 []，實得 ${JSON.stringify(anonList).slice(0, 120)}`)

      // ★ 對照組。沒有它，上面兩條在「上傳其實失敗了」時也會綠——
      //   那正是 §7 #102：分不出「RLS 擋住了」與「本來就沒東西」。
      const ownerList = await list(asUser)
      record('http/poster-owner-sees', '★ §7 #102（「看不到」必須配一組「看得到」）', Array.isArray(ownerList) && ownerList.length === 1, `作者自己應該列得到 1 個檔案，實得 ${JSON.stringify(ownerList).slice(0, 120)}`)
    }
  }
  finally {
    // ── 清理。放在 finally：中途任何一條 throw 都不會留下帳號或資料。 ──
    try {
      if (filmId) {
        await fetch(`${env.url}/storage/v1/object/ugc-poster/${filmId}/poster.png`, {
          method: 'DELETE',
          headers: { apikey: env.secret, Authorization: `Bearer ${env.secret}` },
        })
      }
      await sql(`delete from public.viewing_record where film_id in
                   (select id from public.film where title_zh like $1)`, [`${TEST_PREFIX}%`])
      await sql(`delete from public.film_merge_log where loser_id in
                   (select id from public.film where title_zh like $1)`, [`${TEST_PREFIX}%`])
      await sql(`delete from public.film_identity where film_id in
                   (select id from public.film where title_zh like $1)`, [`${TEST_PREFIX}%`])
      await sql(`delete from public.film where title_zh like $1`, [`${TEST_PREFIX}%`])
      await sql(`delete from public.takedown_notice where claimant_email = $1`, ['zzverify@example.invalid'])
      if (userId) {
        await fetch(`${env.url}/auth/v1/admin/users/${userId}`, {
          method: 'DELETE',
          headers: { apikey: env.secret, Authorization: `Bearer ${env.secret}` },
        })
      }
    }
    catch (cause) {
      console.error('⚠️  清理時出錯，請手動確認：', cause)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// US-47 帳號刪除 —— 真的刪一個帳號
//
// ★ 為什麼一定要走 HTTP：§7 #100。db.ts 直連時 session_user 永遠是 postgres，
//   而 postgres 對 auth.users 有 DELETE 又有 bypassrls ⇒ 在那裡「刪得掉」是
//   一句沒有內容的話。要證明的是**登入使用者拿自己的 JWT 呼叫 PostgREST**
//   時真的刪得掉（grant 對不對），以及**匿名呼叫時刪不掉**。
//
// ★ 為什麼要第二個帳號：整個 US-47 最貴的那條保證是「別人的紀錄一筆都沒少」。
//   0009 的冒煙測試在 SQL 層驗過一次，這裡在真實資料路徑上再驗一次——
//   因為那條保證壞掉的樣子是別人的資料消失，而且沒有人會立刻發現。
// ─────────────────────────────────────────────────────────────────────────────
async function runAccountDeletionChecks(env: HttpEnv): Promise<void> {
  const password = `zzDelete-${Date.now()}-Aa!`
  let userA: string | null = null
  let userB: string | null = null

  const admin = { apikey: env.secret, Authorization: `Bearer ${env.secret}` }
  const createUser = async (email: string): Promise<{ id: string | null, status: number }> => {
    const r = await fetch(`${env.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { ...admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true }),
    })
    return { id: r.ok ? (await r.json() as { id: string }).id : null, status: r.status }
  }
  const tokenFor = async (email: string): Promise<string | null> => {
    const r = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': env.anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    return (await r.json() as { access_token?: string }).access_token ?? null
  }

  try {
    const [resA, resB] = [await createUser(DELETE_EMAIL), await createUser(BYSTANDER_EMAIL)]
    userA = resA.id
    userB = resB.id
    if (!userA || !userB) {
      // ⚠️ 429 是 Supabase Auth 對建立帳號的節流。這支與 verify-account-delete
      //    每跑一次就建 1–2 個帳號，短時間連跑好幾次就會撞到——那是**假紅燈**，
      //    不是程式壞了。等一分鐘再跑就過。把狀態碼寫出來才分得出來。
      return skip('http/account-*', 'US-47 驗收', `建立測試帳號失敗（HTTP ${resA.status}／${resB.status}）`
        + `${resA.status === 429 || resB.status === 429 ? ' —— 這是 Supabase Auth 的節流，等一分鐘再跑' : ''}`)
    }

    const tokenA = await tokenFor(DELETE_EMAIL)
    if (!tokenA)
      return skip('http/account-*', 'US-47 驗收', '登入取不到 access_token')

    const asA = { apikey: env.anon, Authorization: `Bearer ${tokenA}` }
    const asAnon = { apikey: env.anon, Authorization: `Bearer ${env.anon}` }

    const nameRows = await sql(
      `select username from public.profile where id = $1`,
      [userA],
    ) as { username: string }[]
    const nameA = nameRows[0]?.username
    if (!nameA)
      return skip('http/account-*', 'US-47 驗收', 'handle_new_user 沒有替 A 建立 profile')

    // 前置資料。用直連建，因為要測的是刪除本身，不是建立流程。
    const venueRows = await sql(`select id from public.venue order by id limit 1`)
    const venue = venueRows[0]?.id as string | undefined
    if (!venue)
      return skip('http/account-*', 'US-47 驗收', '沒有任何 venue')

    const films = await sql(
      `insert into public.film (title_zh, origin, visibility, review_state, created_by)
       values ($1 || '共用','ugc','public','approved',$2),
              ($1 || '孤兒','ugc','private','pending',$2)
       returning id`,
      [TEST_PREFIX, userA],
    ) as { id: string }[]
    const shared = films[0]!.id
    const orphan = films[1]!.id

    await sql(`insert into public.viewing_record (user_id, film_id, venue_id, watched_on)
               values ($1,$2,$4,current_date - 2), ($3,$5,$4,current_date - 1)`, [userA, orphan, userB, venue, shared])
    // A 的舊名，用來驗 301 會不會指向一個不存在的人
    await sql(`insert into public.username (name, profile_id, kind, released_at)
               values ('zzdeleteold', $1, 'historical', now())`, [userA])

    const rpc = (name: string, headers: Record<string, string>) =>
      fetch(`${env.url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
      })

    // ── 前置對照：現在這個人是存在的 ────────────────────────────────────
    // ★ 沒有這一組，下面所有「找不到了」的斷言都分不出「刪掉了」與
    //   「本來就沒建起來」（§7 #102 就是這樣被騙過去的）。
    const beforeProfile = await fetch(
      `${env.url}/rest/v1/profile?username=eq.${nameA}&select=username`,
      { headers: asAnon },
    )
      .then(r => r.json() as Promise<unknown[]>)
    record('http/account-before', '★ §7 #102（「不見了」必須配一組「本來看得到」）', Array.isArray(beforeProfile) && beforeProfile.length === 1, `刪除前匿名應查得到這個 profile，實得 ${JSON.stringify(beforeProfile).slice(0, 120)}`)

    // ── 匿名不得呼叫 ────────────────────────────────────────────────────
    const anonDelete = await rpc('delete_my_account', asAnon)
    record('http/account-anon-denied', 'US-47（9999 的 grant 清單）', anonDelete.status === 401 || anonDelete.status === 403, `匿名呼叫 delete_my_account 期望 401/403，實得 ${anonDelete.status}`)

    // ── 預覽 ────────────────────────────────────────────────────────────
    const previewRes = await rpc('account_deletion_preview', asA)
    const preview = await previewRes.json() as {
      username?: string
      records?: number
      films_to_delete?: { id: string }[]
      films_to_keep?: number
    }
    record('http/account-preview', 'US-47（端點靠它決定要清哪些海報）', previewRes.ok && preview.username === nameA && preview.records === 1
    && preview.films_to_delete?.length === 1 && preview.films_to_delete[0]?.id === orphan
    && preview.films_to_keep === 1, `預覽不符：HTTP ${previewRes.status} ${JSON.stringify(preview).slice(0, 200)}`)

    // ── 真的刪 ──────────────────────────────────────────────────────────
    const deleteRes = await rpc('delete_my_account', asA)
    const summary = await deleteRes.json() as Record<string, unknown>
    record('http/account-delete', '★ US-47、§7 #100（只有真 PostgREST + 真 JWT 證得了 grant 對不對）', deleteRes.ok && summary.records_deleted === 1 && summary.films_deleted === 1
    && summary.usernames_reserved === 2, `HTTP ${deleteRes.status} ${JSON.stringify(summary).slice(0, 200)}`)

    // ── 該不見的都不見了 ────────────────────────────────────────────────
    const afterProfile = await fetch(
      `${env.url}/rest/v1/profile?username=eq.${nameA}&select=username`,
      { headers: asAnon },
    )
      .then(r => r.json() as Promise<unknown[]>)
    record('http/account-profile-gone', 'US-47 驗收（個人頁 404）', Array.isArray(afterProfile) && afterProfile.length === 0, `個人頁應該消失，實得 ${JSON.stringify(afterProfile).slice(0, 120)}`)

    const authUser = await fetch(`${env.url}/auth/v1/admin/users/${userA}`, { headers: admin })
    record('http/account-auth-gone', '★ US-47（public 清乾淨但 auth.users 還在＝殭屍帳號）', authUser.status === 404, `auth.users 那一列應該消失，實得 HTTP ${authUser.status}`)

    // ★ 這條用的是**刪除之前發的那個 JWT**。它還沒過期（JWT 是無狀態的），
    //   所以這裡問的是：拿著一個指向已刪除使用者的合法 token，還能不能倒出資料。
    const exportRes = await rpc('export_my_data', asA)
    const exported = await exportRes.json() as { records?: unknown[], profile?: unknown } | null
    record('http/account-export-empty', 'US-47 驗收（export_my_data 拿不到東西）', !exported || (exported.profile == null && (exported.records?.length ?? 0) === 0), `舊 token 仍倒得出資料：${JSON.stringify(exported).slice(0, 200)}`)

    const resolved = await fetch(`${env.url}/rest/v1/rpc/resolve_username`, {
      method: 'POST',
      headers: { ...asAnon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_name: 'zzdeleteold' }),
    }).then(r => r.json() as Promise<string | null>)
    record('http/account-no-redirect', 'US-47（舊網址不得 301 到一個不存在的人）', resolved === null, `舊名應解析不到任何人，實得 ${JSON.stringify(resolved)}`)

    // ── ★ 別人的東西一樣都沒少 ──────────────────────────────────────────
    const intact = await sql(
      `select (select count(*) from public.viewing_record where user_id = $1)::int as records,
              (select count(*) from public.film where id = $2)::int as shared_film,
              (select count(*) from public.film where id = $2 and created_by is null)::int as anonymised,
              (select count(*) from public.film where id = $3)::int as orphan_film,
              (select count(*) from public.username
                where profile_id is null and kind = 'reserved'
                  and name in ($4,'zzdeleteold'))::int as reserved`,
      [userB, shared, orphan, nameA],
    ) as Record<string, number>[]
    const i = intact[0]!
    record('http/account-others-intact', '★ US-47 驗收最貴的一條（別人的紀錄一筆都沒少）', i.records === 1 && i.shared_film === 1 && i.anonymised === 1
    && i.orphan_film === 0 && i.reserved === 2, `實得 ${JSON.stringify(i)}`)
  }
  finally {
    try {
      await sql(`delete from public.viewing_record where film_id in
                   (select id from public.film where title_zh like $1)`, [`${TEST_PREFIX}%`])
      await sql(`delete from public.film_identity where film_id in
                   (select id from public.film where title_zh like $1)`, [`${TEST_PREFIX}%`])
      await sql(`delete from public.film where title_zh like $1`, [`${TEST_PREFIX}%`])
      // 隔離中的舊名沒有 profile_id，不會被 cascade 帶走——必須顯式清掉，
      // 否則下一次跑會撞上 username 的主鍵。
      await sql(`delete from public.username where name in ('zzdeleteold')
                   or (profile_id is null and kind = 'reserved' and name like 'zzdelete%')`)
      for (const id of [userA, userB]) {
        if (id) {
          await fetch(`${env.url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: admin })
        }
      }
    }
    catch (cause) {
      console.error('⚠️  帳號刪除段清理時出錯，請手動確認：', cause)
    }
  }
}

/** 清理是否真的乾淨。清理本身也可能失敗，而失敗時最不該做的就是沉默。 */
async function assertNoResidue(): Promise<void> {
  const rows = await sql(`
    select (select count(*) from public.film where title_zh like $1)::int as films,
           -- 'zz%' 而不是 'zzverify%'：US-47 那一段另外建了 zzdelete / zzbystander，
           -- 只認一個前綴的殘留檢查會漏掉它們，而漏掉的樣子是 DB 裡多了一個
           -- 沒有人記得的 profile（測試資料紀律）。
           (select count(*) from public.profile where username like 'zz%')::int as profiles,
           (select count(*) from public.takedown_notice
             where claimant_email = 'zzverify@example.invalid')::int as notices`, [`${TEST_PREFIX}%`])
  const r = rows[0]!
  const total = (r.films as number) + (r.profiles as number) + (r.notices as number)
  record('cleanup/no-residue', '測試資料紀律（不靠執行者記得）', total === 0, `殘留：${JSON.stringify(r)}`)
}

// ─────────────────────────────────────────────────────────────────────────────

const sqlOnly = process.argv.includes('--sql-only')

/**
 * ⚠️ 四個 session 共用一個工作樹。別人的 migration 或腳本改到一半時，
 *   這支會變紅，而**紅的樣子跟自己造成的迴歸一模一樣**。
 *   實測 2026-09-06：adminui 看到三條 US-47 斷言失敗、整批只跑 14 條就中止，
 *   它正確地判斷是別人改到一半——但那個判斷花掉的時間本來可以省下來。
 *
 *   所以在最前面吵一聲。這裡刻意**不**阻止執行：那些變更多半是無害的，
 *   而擋下驗收的成本比誤報高。
 */
function warnAboutDirtyTree(): void {
  let dirty: string[] = []
  try {
    dirty = execFileSync('git', ['status', '--porcelain', '--', 'supabase/migrations', 'scripts'], { encoding: 'utf8' })
      .split('\n')
      .map(l => l.slice(3))
      .filter(Boolean)
  }
  catch {
    return // 不在 git 工作樹裡（例如 CI 用 tarball），那就沒有這個問題
  }
  if (!dirty.length)
    return
  console.log('⚠️  supabase/migrations 或 scripts 有未提交的變更：')
  for (const f of dirty.slice(0, 8))
    console.log(`     ${f}`)
  if (dirty.length > 8)
    console.log(`     …還有 ${dirty.length - 8} 個`)
  console.log('   四個 session 共用一個工作樹 —— 下面的紅燈**可能不是你造成的**。')
  console.log('   先 `git status` 看是誰在改，再決定要不要追。\n')
}

warnAboutDirtyTree()

console.log('── SQL 斷言 ──')
await runSqlFile('scripts/verify-core.sql', 'schema 不變量／RLS／TMDB 合規／資料完整性')
await runSqlFile('scripts/verify-dmca.sql', '§90-4 通知／取下／三振／回復')
await runSqlFile('scripts/verify-admin.sql', 'Step 7 審核與合併的資料庫端')

console.log('\n── 前端對帳（真實資料 × 真正的前端函式）──')
await runMonthlyBaselineChecks()

if (!sqlOnly) {
  console.log('\n── HTTP 斷言（真實 PostgREST + 真實使用者 JWT）──')
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_KEY
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !anon || !secret) {
    skip('http/*', '需要 SUPABASE_URL / SUPABASE_KEY / SUPABASE_SECRET_KEY', '環境變數不齊')
  }
  else {
    await runHttpChecks({ url, anon, secret })
    await runAccountDeletionChecks({ url, anon, secret })
    await assertNoResidue()
  }
}

/**
 * ── SSR payload 與 OG 圖 ──────────────────────────────────────────────────
 * 需要一個跑著的 Nuxt server，沒有就**略過**（不是失敗）：verify:all 必須在
 * 沒有 server 的環境也能全綠。但被略過的斷言等於不存在，所以合計會把略過數
 * 單獨列出來，而略過的理由裡寫明它守的是什麼。
 *
 * ★ 斷言本身住在 `scripts/verify-http.ts`，這裡**共用同一份**而不是抄一份。
 *   它原本只能單獨跑，於是 `strip-auth-on-cacheable.ts` 的註解宣稱有一張安全網、
 *   而 verify:all 從來沒跑過它（§7 #124）。
 */
/**
 * ── `/u/**` 的匿名驗收（需要 pnpm dev）──────────────────────────────────────
 * 硬約束三：**抽屜的清單必須用不帶 cookie 的請求實際驗一次，不要只相信 RLS。**
 * RLS 對，不代表這一頁對——資料還要經過端點的欄位挑選與頁面的 render，
 * 任何一層多帶一個欄位出來 RLS 都還是綠的。
 */
console.log('\n── /u/** 匿名驗收（需要 pnpm dev）──')
{
  // 拿一個真的 username。寫死或用「DB 裡唯一一筆 profile」都會在資料一變就靜默空轉。
  const who = await sql(`select username from public.profile
                          where username is not null
                          order by created_at limit 1`)
  await runPublicProfileChecks({
    record: (id, ok, detail, guards) => record(id, guards ?? '/u/** 的匿名視角', ok, detail),
    skip: (id, why, guards) => skip(id, guards ?? '/u/** 的匿名視角', why),
  }, (who[0]?.username as string | undefined) ?? null)
}

console.log('\n── SSR payload 與 OG（需要 pnpm dev）──')
await runSsrAndOgChecks({
  record: (id, ok, detail, guards) =>
    record(id, guards ?? '踩雷 #79：訪客的 access_token 不得被寫進 CDN', ok, detail),
  skip: (id, why, guards) =>
    skip(id, guards ?? '踩雷 #79：訪客的 access_token 不得被寫進 CDN', why),
})

const failed = results.filter(r => !r.ok)
const skipped = results.filter(r => r.skipped)
console.log(`\n── 合計 ── 通過 ${results.length - failed.length - skipped.length}`
  + `／略過 ${skipped.length}／失敗 ${failed.length}`)

if (failed.length) {
  console.log('\n失敗的斷言：')
  for (const f of failed)
    console.log(`  ❌ ${f.id}  守的是：${f.guards}`)
  process.exit(1)
}
