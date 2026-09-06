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

import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { Client, types as pgTypes } from 'pg'

// 與 scripts/db.ts 同：不要讓 node-postgres 把 date/timestamp 轉成 JS Date，
// 那個顯示層會讓人得出完全相反的結論（交接筆記 2.1）。
for (const oid of [1082, 1114, 1184, 1083])
  pgTypes.setTypeParser(oid, v => v)

const TEST_EMAIL = 'zzverify@example.com'
const TEST_PREFIX = '__verify_http__'

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
       returning id`, [TEST_PREFIX])
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
    record('http/merge-as-user', '§1.1 修正 A、§7 #100（此路徑曾實測回 204）',
      userMerge.status === 403, `期望 403，實得 ${userMerge.status}`)

    const anonMerge = await rpc('merge_films', mergeBody, asAnon)
    record('http/merge-as-anon', 'Step 7 驗收',
      anonMerge.status === 401 || anonMerge.status === 403, `期望 401/403，實得 ${anonMerge.status}`)

    const userApprove = await rpc('approve_film', { p_film: loser, p_approve: true }, asUser)
    record('http/approve-as-user', 'Step 7 驗收、踩雷 #26',
      userApprove.status === 403, `期望 403，實得 ${userApprove.status}`)

    // 對照：真的沒被合併。只看狀態碼的話，端點回 403 但資料被改了也看不出來。
    const stillSeparate = await sql(
      `select count(*)::int as n from public.film where id = $1 and merged_into_film_id is null`, [loser])
    record('http/merge-no-effect', 'Step 7 驗收（狀態碼之外再看一次資料）',
      (stillSeparate[0]!.n as number) === 1, '越權呼叫被擋下了，但敗方竟然已被標記為合併')

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
    record('http/dmca-insert', 'Step 8 驗收、§90-4 第 3 款（未登入者必須提得出通知）',
      minimal.status === 201, `期望 201，實得 ${minimal.status}`)

    // 反向對照：帶 return=representation 必須失敗。沒有 SELECT policy 就拿不到
    // RETURNING —— 這正是「單向」的證據，也證明上一條的 201 不是因為權限全開。
    const representation = await post('return=representation')
    record('http/dmca-one-way', 'Step 8 驗收（單向性的反向對照）',
      representation.status >= 400, `期望 4xx，實得 ${representation.status}`)

    const read = await fetch(`${env.url}/rest/v1/takedown_notice?select=*`, { headers: asAnon })
    record('http/dmca-no-read', 'Step 8 驗收',
      read.status >= 400, `期望 4xx，實得 ${read.status}`)

    // ── ③ 未審核海報：不可取、不可列舉，且有對照組 ─────────────────────
    const ugc = await fetch(`${env.url}/rest/v1/film`, {
      method: 'POST',
      headers: { ...asUser, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({
        title_zh: `${TEST_PREFIX}未審核UGC`, origin: 'ugc', visibility: 'private',
        review_state: 'pending', moderation_state: 'visible', created_by: userId,
      }),
    })
    const ugcRows = await ugc.json() as { id: string }[]
    filmId = Array.isArray(ugcRows) ? ugcRows[0]?.id ?? null : null

    if (!filmId) {
      skip('http/poster-*', 'Step 7 驗收', '建立 UGC 作品失敗，海報段無法進行')
    }
    else {
      const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...Array.from({ length: 64 }, () => 0)])
      const up = await fetch(`${env.url}/storage/v1/object/ugc-poster/${filmId}/poster.png`, {
        method: 'POST',
        headers: { ...asUser, 'Content-Type': 'image/png' },
        body: png,
      })
      record('http/poster-upload', 'Step 7（前置：沒有這一步，下面的斷言全是空轉）',
        up.status === 200, `上傳失敗 HTTP ${up.status}`)

      const pub = await fetch(`${env.url}/storage/v1/object/public/ugc-poster/${filmId}/poster.png`)
      record('http/poster-public', 'Step 7 驗收、踩雷 #26（bucket 必須是 private）',
        pub.status >= 400, `期望 4xx，實得 ${pub.status}`)

      const auth = await fetch(`${env.url}/storage/v1/object/authenticated/ugc-poster/${filmId}/poster.png`, { headers: asAnon })
      record('http/poster-anon-get', 'Step 7 驗收（走 RLS 的那條路）',
        auth.status >= 400, `期望 4xx，實得 ${auth.status}`)

      const list = (headers: Record<string, string>) => fetch(`${env.url}/storage/v1/object/list/ugc-poster`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: `${filmId}/`, limit: 100 }),
      }).then(r => r.json() as Promise<unknown[]>)

      const anonList = await list(asAnon)
      record('http/poster-no-list', '★ Step 7 驗收（只測取檔會漏掉列舉）',
        Array.isArray(anonList) && anonList.length === 0, `期望 []，實得 ${JSON.stringify(anonList).slice(0, 120)}`)

      // ★ 對照組。沒有它，上面兩條在「上傳其實失敗了」時也會綠——
      //   那正是 §7 #102：分不出「RLS 擋住了」與「本來就沒東西」。
      const ownerList = await list(asUser)
      record('http/poster-owner-sees', '★ §7 #102（「看不到」必須配一組「看得到」）',
        Array.isArray(ownerList) && ownerList.length === 1,
        `作者自己應該列得到 1 個檔案，實得 ${JSON.stringify(ownerList).slice(0, 120)}`)
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

/** 清理是否真的乾淨。清理本身也可能失敗，而失敗時最不該做的就是沉默。 */
async function assertNoResidue(): Promise<void> {
  const rows = await sql(`
    select (select count(*) from public.film where title_zh like $1)::int as films,
           (select count(*) from public.profile where username like 'zzverify%')::int as profiles,
           (select count(*) from public.takedown_notice
             where claimant_email = 'zzverify@example.invalid')::int as notices`, [`${TEST_PREFIX}%`])
  const r = rows[0]!
  const total = (r.films as number) + (r.profiles as number) + (r.notices as number)
  record('cleanup/no-residue', '測試資料紀律（不靠執行者記得）',
    total === 0, `殘留：${JSON.stringify(r)}`)
}

// ─────────────────────────────────────────────────────────────────────────────

const sqlOnly = process.argv.includes('--sql-only')

console.log('── SQL 斷言 ──')
await runSqlFile('scripts/verify-core.sql', 'schema 不變量／RLS／TMDB 合規／資料完整性')
await runSqlFile('scripts/verify-dmca.sql', '§90-4 通知／取下／三振／回復')
await runSqlFile('scripts/verify-admin.sql', 'Step 7 審核與合併的資料庫端')

if (!sqlOnly) {
  console.log('\n── HTTP 斷言（真實 PostgREST + 真實使用者 JWT）──')
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_KEY
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !anon || !secret)
    skip('http/*', '需要 SUPABASE_URL / SUPABASE_KEY / SUPABASE_SECRET_KEY', '環境變數不齊')
  else {
    await runHttpChecks({ url, anon, secret })
    await assertNoResidue()
  }
}

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
