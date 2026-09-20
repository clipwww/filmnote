/**
 * `/u/` 上的金額，**三種觀看者各驗一組**（`SCREENS §12`）：本人看到全部票價；路人 +
 * `show_cost = true` 看到公開紀錄的票價；路人 + `show_cost = false` **一列都讀不到**。
 * 一定要真的打一次而不是相信 RLS：金額要經過 RLS → RPC 聚合 → `useUserSpend()` →
 * 元件的 `v-if`，任何一層算錯 RLS 都還是綠的，而失敗方向是**把某人的消費金額公開出去**。
 */
// ★ 「看不到」必須配一組「看得到」（§7 #102）：第二種就是那組對照——同一個匿名 key、
//   同一支查詢，只有 `show_cost` 不同 ⇒ 兩者的差異只可能來自那個旗標本身。
// ⚠️ 這支會**暫時**把受測帳號的 `show_cost` 打開，在 finally 裡關回去並再查一次確認。
//    原值不是硬寫的 false 而是**先讀出來再還原**——受測帳號本來就開著的話，關掉才是破壞。

import process from 'node:process'
import { Client } from 'pg'

const url = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_KEY
const email = process.env.IMPORT_TARGET_EMAIL

let pass = 0
let fail = 0
function check(id: string, ok: boolean, detail: string) {
  console.log(`${ok ? '✅' : '❌'} ${id.padEnd(38)}${ok ? ` ${detail}` : `\n     ↳ ${detail}`}`)
  if (ok)
    pass++
  else
    fail++
}

async function sql<T = Record<string, unknown>>(q: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  try {
    return (await c.query(q, params)).rows as T[]
  }
  finally {
    await c.end()
  }
}

/**
 * **完全匿名**地打 PostgREST 的 RPC。只帶 apikey（那是公開的 anon key），
 * 沒有 Authorization、沒有 cookie ⇒ RLS 以 `anon` 求值。
 */
async function anonRpc(username: string) {
  const res = await fetch(`${url}/rest/v1/rpc/user_year_stats`, {
    method: 'POST',
    headers: { 'apikey': anonKey!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_username: username, p_year: null }),
  })
  return await res.json() as {
    totals?: { spend: number, spend_known_records: number, spend_unknown_records: number, records: number, spend_is_partial: boolean }
    by_year?: { year: number, spend: number, spend_is_partial: boolean }[]
    is_own?: boolean
  } | null
}

if (!url || !anonKey || !process.env.DATABASE_URL || !email) {
  console.log('⏭️  略過：缺 SUPABASE_URL / SUPABASE_KEY / DATABASE_URL / IMPORT_TARGET_EMAIL')
  console.log('     ↳ 這一組守的是「/u/ 上的票價只有該看到的人看得到」——被略過的斷言等於不存在。')
  process.exit(0)
}

// 以 email 精確指定，不用 `limit 1`／「DB 裡唯一一筆 profile」這種假設。
// email 從環境變數來，**不進版控**（這個 repo 是 public 的）。
const [me] = await sql<{ username: string, show_cost: boolean, id: string }>(
  `select p.username, p.show_cost, p.id
     from public.profile p join auth.users u on u.id = p.id
    where u.email = $1`,
  [email],
)

if (!me) {
  console.log('⏭️  略過：IMPORT_TARGET_EMAIL 找不到對應的 profile')
  process.exit(0)
}

const originalShowCost = me.show_cost
console.log(`受測帳號 @${me.username}，show_cost 原值 = ${originalShowCost}（結束會還原）\n`)

try {
  // ── ① 本人視角（service role 直接查，代表「全部票價確實存在」）──────────
  //    這是整組斷言的**母數**：沒有它，「路人看不到」可能只是因為根本沒資料。
  const [truth] = await sql<{ rows: string, total: string }>(
    `select count(*)::text as rows, coalesce(sum(c.amount), 0)::text as total
       from public.viewing_record_cost c
       join public.viewing_record r on r.id = c.record_id
      where r.user_id = $1`,
    [me.id],
  )
  const truthRows = Number(truth?.rows ?? 0)
  check('owner/has-cost-rows', truthRows > 0, `★ 母數：這個帳號真的有 ${truthRows} 列票價（沒有的話下面全部是空轉）`)

  // ── ② 路人 ＋ show_cost = false ⇒ 一列都讀不到 ─────────────────────────
  await sql(`update public.profile set show_cost = false where id = $1`, [me.id])
  const closed = await anonRpc(me.username)
  check('stranger/closed/no-cost-rows', (closed?.totals?.spend_known_records ?? -1) === 0, `匿名讀到 ${closed?.totals?.spend_known_records} 列票價（應為 0）`)
  check('stranger/closed/zero-total', (closed?.totals?.spend ?? -1) === 0, `匿名讀到的總額是 ${closed?.totals?.spend}（應為 0）`)
  check('stranger/closed/every-year-zero', (closed?.by_year ?? []).every(y => y.spend === 0), `逐年金額：${(closed?.by_year ?? []).filter(y => y.spend !== 0).map(y => `${y.year}=${y.spend}`).join('、') || '全部為 0'}`)
  check('stranger/closed/not-own', closed?.is_own === false, `is_own = ${closed?.is_own}（匿名絕不可能是本人）`)
  // ★ 對照組：關著的時候**筆數仍然讀得到**——證明不是「整支 RPC 被擋光了」
  check('stranger/closed/still-sees-records', (closed?.totals?.records ?? 0) > 0, `★ 對照組：匿名仍讀得到 ${closed?.totals?.records} 筆紀錄（只有票價被擋）`)

  // ── ③ 路人 ＋ show_cost = true ⇒ 看得到（這就是②的對照組）──────────────
  await sql(`update public.profile set show_cost = true where id = $1`, [me.id])
  const open = await anonRpc(me.username)
  check('stranger/open/sees-cost-rows', (open?.totals?.spend_known_records ?? 0) > 0, `★ 對照組：打開後匿名讀到 ${open?.totals?.spend_known_records} 列票價、總額 ${open?.totals?.spend}`)
  check('stranger/open/differs-from-closed', (open?.totals?.spend ?? 0) !== (closed?.totals?.spend ?? 0), `開 ${open?.totals?.spend} vs 關 ${closed?.totals?.spend} —— 一樣的話②在空轉`)
  check('stranger/open/has-year-with-money', (open?.by_year ?? []).some(y => y.spend > 0), `逐年至少有一年 > 0（否則「每年花費」那條 band 會是空的）`)

  // ── ④ `spend_is_partial` 是逐年的，而且真的會逐年不同 ───────────────────
  const flags = new Set((open?.by_year ?? []).map(y => y.spend_is_partial))
  check('spend/partial-is-per-year', (open?.by_year ?? []).length > 0, `逐年旗標：${(open?.by_year ?? []).map(y => `${y.year}:${y.spend_is_partial ? '部分' : '完整'}`).join(' ')}`)
  check('spend/partial-flag-discriminates', flags.size > 1 || truthRows === (open?.totals?.records ?? -1), flags.size > 1
    ? '★ 逐年旗標有真有假 ⇒ 標記真的分辨得出哪幾年不完整'
    : `⚠️ 每一年的旗標都是 ${[...flags][0]}——若是因為每筆都有票價，那是對的；否則標記在空轉`)

  // ── ⑤ 頁面層：show_cost 開著時，匿名拿到的 HTML **仍然**不含金額 ─────────
  //    金額是 client-only 的（server: false），所以即使開著，SSR 也不該吐出來。
  //    這條守的是「金額不進 __NUXT_DATA__」，跟②是兩件不同的事。
  const site = process.env.SITE ?? 'http://localhost:3000'
  const alive = await fetch(site).then(() => true).catch(() => false)
  if (alive) {
    const html = await (await fetch(`${site}/u/${me.username}`, {
      headers: { 'user-agent': 'filmnote-anon-check' },
    })).text()
    const hits = html.match(/NT\$[\d,]+/g)
    check('ssr/no-money-even-when-open', !hits, hits ? `show_cost 開著時 SSR 的 HTML 仍然吐出金額：${hits.slice(0, 3).join('、')}` : 'show_cost 開著時 SSR 仍然不吐金額（金額是 client-only）')
    check('ssr/has-content', html.includes(me.username), `★ 對照組：那份 HTML 確實有內容（${html.length} 字元）`)
  }
  else {
    console.log(`⏭️  ssr/no-money-even-when-open\n     ↳ 略過：${site} 沒有回應。這一條守的是「金額不得進 SSR 的輸出」。`)
  }
}
finally {
  // ★ 還原成**原值**，不是硬寫 false——本來就開著的帳號被關掉才是破壞。
  await sql(`update public.profile set show_cost = $2 where id = $1`, [me.id, originalShowCost])
  const [after] = await sql<{ show_cost: boolean }>(
    `select show_cost from public.profile where id = $1`,
    [me.id],
  )
  const restored = after?.show_cost === originalShowCost
  console.log(`\n${restored ? '✅' : '❌'} 還原 show_cost = ${after?.show_cost}（原值 ${originalShowCost}）`)
  if (!restored) {
    console.log('   ⚠️ **還原失敗，請立刻手動改回去。**')
    fail++
  }
}

console.log(`\n── 合計 ── 通過 ${pass}／失敗 ${fail}`)
process.exit(fail ? 1 : 0)
