/**
 * 直連 Postgres 跑 SQL。migration 與 §8.1 的斷言都需要它——PostgREST 看不到
 * pg_class / pg_proc。連線字串取自 DATABASE_URL。
 *   npm run db:sql -- supabase/migrations/0001_init.sql
 *   npm run db:sql -- --query "select count(*) from public.film"
 * ⚠️ 整份檔案以單一 simple-query 送出 ⇒ 在隱式交易內執行：任何一句失敗即全部回滾。
 */

import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { Client, types as pgTypes } from 'pg'

// ⚠️ node-postgres 預設把 date/timestamp 解析成 JS Date，console.table 再以 UTC 印出來
// ——存著 2026-09-05 的 date 欄位會顯示成 2026-09-04T16:00:00.000Z，看起來像被時區轉換過。
// 斷言時被這個顯示層誤導會得出完全相反的結論 ⇒ 一律保留資料庫給的字串（踩雷 #253）。
for (const oid of [1082 /* date */, 1114 /* timestamp */, 1184 /* timestamptz */, 1083])
  pgTypes.setTypeParser(oid, v => v)

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('缺少 DATABASE_URL。取自 Supabase Dashboard → Settings → Database → Connection string → URI。')
    process.exit(1)
  }

  // pnpm 會把分隔用的 `--` 原樣傳進來（npm 會吃掉），濾掉才能兩邊都跑
  const args = process.argv.slice(2).filter(a => a !== '--')
  const qIndex = args.indexOf('--query')
  const sql = qIndex >= 0
    ? args[qIndex + 1]!
    : await readFile(args[0]!, 'utf8')

  const client = new Client({
    connectionString: url,
    // Supabase 的憑證鏈在 Node 預設 CA 下驗不過；連線本身仍是 TLS 加密的。
    ssl: { rejectUnauthorized: false },
    statement_timeout: 300_000,
  })
  // ★ 沒有這一段，`raise notice` 全部靜默消失（PostgreSQL 的 notice 走獨立通道）。代價
  //   比看起來大：migration 的冒煙測試印「通過」沒人看得到；9999_grants.sql 的「xxx 尚不
  //   存在，略過其 grant」會**無聲跳過授權**，前端拿到沒有上下文的 401。
  client.on('notice', (msg) => {
    if (msg.message)
      console.log(`[${(msg.severity ?? 'NOTICE').toLowerCase()}] ${msg.message}`)
  })

  await client.connect()
  try {
    const res = await client.query(sql)
    const results = Array.isArray(res) ? res : [res]
    for (const r of results) {
      if (r.rows?.length)
        console.table(r.rows)
      else if (r.command)
        console.log(`${r.command} ${r.rowCount ?? ''}`.trim())
    }
    console.log('OK')
  }
  finally {
    await client.end()
  }
}

await main()
