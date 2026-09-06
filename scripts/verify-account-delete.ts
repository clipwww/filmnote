/**
 * US-47 端點層驗收 —— 把 `POST /api/account/delete` 走一次**真的 HTTP**。
 *
 *   pnpm dev                                              # 另一個終端機
 *   pnpm tsx --env-file=.env scripts/verify-account-delete.ts
 *
 * ── 為什麼不併進 verify-all.ts ────────────────────────────────────────────
 * 它需要一個跑著的 Nuxt dev server。verify:all 必須在沒有 dev server 的環境
 * （CI、剛 clone 下來的機器）也能全綠，把這一段塞進去只會讓它變成「常常被略過
 * 的那一條」——而常常被略過的斷言等於不存在。所以獨立成一支，並在交接筆記裡
 * 寫明什麼時候要跑它。
 *
 * ── 它補的是 verify-all 補不到的那一段 ────────────────────────────────────
 * `verify-all.ts` 的 http/account-* 已經證明了 **RPC 層**：真 PostgREST、真 JWT、
 * grant 對不對、別人的紀錄有沒有少。它證不到的是**端點自己的膠水**：
 *   ① 二次確認字串比對
 *   ② 「先清 bucket、再刪資料庫」的順序
 *   ③ 刪完有沒有清掉登入 cookie
 * 其中②最關鍵：順序反過來的話，海報會永遠留在 bucket 裡（film 一刪，
 * `ugc_poster_delete` policy 就再也不會對任何人放行），而使用者被告知
 * 「所有資料都刪掉了」。那個失敗**不會有任何錯誤訊息**。
 *
 * ── 前一棒卡在哪 ──────────────────────────────────────────────────────────
 * 交接筆記第 5 節：「/api/legal/counter-notice 的登入後 happy path 沒走過 HTTP，
 * 拿不到真的 OAuth session」。解法在下面的 `sessionCookie()`：password grant
 * 拿到的 session 用 @supabase/ssr 的格式手動組成 cookie 就行，不需要 OAuth。
 * 同樣的手法可以用來補上 counter-notice 那一條。
 */

import { Buffer } from 'node:buffer'
import process from 'node:process'
import { Client, types as pgTypes } from 'pg'

// 與 scripts/db.ts 同：不要讓 node-postgres 把 date/timestamp 轉成 JS Date。
for (const oid of [1082, 1114, 1184, 1083])
  pgTypes.setTypeParser(oid, v => v)

const SITE = process.env.SITE ?? 'http://localhost:3000'
const EMAIL = 'zze2edel@example.com'
const FILM_PREFIX = '__e2e_del__'

interface Result { ok: boolean }
const results: Result[] = []

function record(label: string, ok: boolean, detail = ''): void {
  results.push({ ok })
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n     ↳ ${detail}`}`)
}

async function sql(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  try {
    return (await c.query(query, params)).rows as Record<string, unknown>[]
  }
  finally {
    await c.end()
  }
}

/**
 * 把 password grant 拿到的 session 組成 @nuxtjs/supabase（＝@supabase/ssr）
 * 認得的 cookie：`sb-<projectRef>-auth-token = base64-<base64(JSON)>`，
 * 超過 3180 字元要切成 `.0` / `.1` 分塊。
 */
function sessionCookie(supabaseUrl: string, session: unknown): string {
  const ref = new URL(supabaseUrl).hostname.split('.')[0]!
  const name = `sb-${ref}-auth-token`
  const raw = `base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`
  const chunks: string[] = []
  for (let i = 0; i < raw.length; i += 3180)
    chunks.push(raw.slice(i, i + 3180))
  return chunks.length === 1
    ? `${name}=${chunks[0]}`
    : chunks.map((c, i) => `${name}.${i}=${c}`).join('; ')
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_KEY
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !anon || !secret || !process.env.DATABASE_URL) {
    console.log('⏭️  略過：環境變數不齊（SUPABASE_URL / SUPABASE_KEY / SUPABASE_SECRET_KEY / DATABASE_URL）')
    return
  }

  const alive = await fetch(`${SITE}/api/u/__probe__`).then(() => true).catch(() => false)
  if (!alive) {
    console.log(`⏭️  略過：${SITE} 沒有回應。先在另一個終端機跑 \`pnpm dev\`。`)
    return
  }

  const admin = { apikey: secret, Authorization: `Bearer ${secret}` }
  const password = `zzE2E-${Date.now()}-Aa!`
  let userId: string | null = null
  let filmId: string | null = null

  try {
    // ── ① 未登入必須擋下來 ────────────────────────────────────────────────
    const noAuth = await fetch(`${SITE}/api/account/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'whatever' }),
    })
    record('未登入 → 401', noAuth.status === 401, `實得 ${noAuth.status}`)

    // ── 前置：一個真的帳號、一部未核准的自建作品、一張真的海報 ────────────
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

    const signIn = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password }),
    })
    const session = await signIn.json() as { access_token?: string }
    if (!session.access_token) {
      record('登入取得 session', false, JSON.stringify(session).slice(0, 200))
      return
    }

    const rows = await sql(`select username from public.profile where id = $1`, [userId])
    const username = rows[0]?.username as string | undefined
    if (!username) {
      record('前置：profile 已建立', false, 'handle_new_user 沒有建立 profile')
      return
    }

    const films = await sql(
      `insert into public.film (title_zh, origin, visibility, review_state, created_by)
       values ($1 || '孤兒','ugc','private','pending',$2) returning id`,
      [FILM_PREFIX, userId],
    )
    filmId = films[0]!.id as string

    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...Array.from({ length: 64 }).fill(0)])
    const up = await fetch(`${url}/storage/v1/object/ugc-poster/${filmId}/poster.png`, {
      method: 'POST',
      headers: { 'apikey': anon, 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'image/png' },
      body: png,
    })
    record('前置：海報上傳成功', up.status === 200, `HTTP ${up.status}`)

    // ★ 對照組。沒有它，最後那條「海報不見了」在「海報從來沒上傳成功」時
    //   也會綠（§7 #102）。
    const before = await sql(
      `select count(*)::int as n from storage.objects where bucket_id = 'ugc-poster' and name like $1`,
      [`${filmId}/%`],
    )
    record('★ 對照組：bucket 裡真的有這張海報', before[0]!.n === 1, JSON.stringify(before[0]))

    const cookie = sessionCookie(url, session)

    // ── ② 確認字串不符 → 422。同時證明 cookie 真的被認得 ──────────────────
    //    這一條若回 401，代表 cookie 沒生效，下面所有斷言都是空轉。
    const wrong = await fetch(`${SITE}/api/account/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ confirm: 'definitely-not-my-username' }),
    })
    record('★ cookie 有效且確認字串不符 → 422（不是 401）', wrong.status === 422, `實得 ${wrong.status}：${(await wrong.text()).slice(0, 200)}`)

    const stillThere = await sql(`select count(*)::int as n from auth.users where id = $1`, [userId])
    record('確認字串不符時什麼都沒發生', stillThere[0]!.n === 1, JSON.stringify(stillThere[0]))

    // ── ③ 真的刪。confirm 故意用大寫，驗大小寫不敏感 ─────────────────────
    const res = await fetch(`${SITE}/api/account/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ confirm: username.toUpperCase() }),
    })
    const body = await res.json() as { deleted?: Record<string, number>, retained?: Record<string, number> }
    record('刪除 → 200', res.ok, `${res.status} ${JSON.stringify(body).slice(0, 300)}`)
    record('回報 1 部作品、1 張海報', body.deleted?.films === 1 && body.deleted?.posters === 1, JSON.stringify(body.deleted))

    const setCookies = res.headers.getSetCookie?.() ?? []
    record('刪完有清掉登入 cookie', setCookies.some(c => c.startsWith('sb-')), JSON.stringify(setCookies).slice(0, 200))

    // ── ④ ★ 海報真的離開 bucket 了（「先清 bucket 再刪 DB」那個順序的證據）──
    const after = await sql(
      `select (select count(*) from storage.objects
                where bucket_id = 'ugc-poster' and name like $1)::int as objects,
              (select count(*) from public.film where id = $2)::int as film,
              (select count(*) from auth.users where id = $3)::int as auth_user,
              (select count(*) from public.profile where id = $3)::int as profile`,
      [`${filmId}/%`, filmId, userId],
    )
    const a = after[0]! as Record<string, number>
    record('★ 海報真的離開 bucket（順序反了的話它會永遠留在那裡）', a.objects === 0, JSON.stringify(a))
    record('作品 / profile / auth.users 都不見了', a.film === 0 && a.profile === 0 && a.auth_user === 0, JSON.stringify(a))
  }
  finally {
    try {
      await sql(`delete from public.viewing_record where film_id in
                   (select id from public.film where title_zh like $1)`, [`${FILM_PREFIX}%`])
      await sql(`delete from public.film where title_zh like $1`, [`${FILM_PREFIX}%`])
      // 隔離中的舊名沒有 profile_id ⇒ 不會被 cascade 帶走，必須顯式清掉。
      await sql(`delete from public.username
                  where profile_id is null and kind = 'reserved' and name like 'zze2edel%'`)
      if (userId) {
        await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
          method: 'DELETE',
          headers: { apikey: process.env.SUPABASE_SECRET_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY!}` },
        })
      }
      const residue = await sql(
        `select (select count(*) from public.profile where username like 'zze2edel%')::int as profiles,
                (select count(*) from public.film where title_zh like $1)::int as films,
                (select count(*) from public.username where name like 'zze2edel%')::int as names`,
        [`${FILM_PREFIX}%`],
      )
      const r = residue[0]! as Record<string, number>
      record('cleanup/no-residue（清理本身也可能失敗，失敗時最不該做的就是沉默）', r.profiles + r.films + r.names === 0, JSON.stringify(r))
    }
    catch (cause) {
      console.error('⚠️  清理時出錯，請手動確認：', cause)
    }
  }
}

await main()

const failed = results.filter(r => !r.ok).length
console.log(`\n── 合計 ── 通過 ${results.length - failed}／失敗 ${failed}`)
if (failed)
  process.exit(1)
