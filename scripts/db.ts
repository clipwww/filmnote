/**
 * 直連 Postgres 跑 SQL。migration 與 §8.1 的斷言都需要它——
 * PostgREST 看不到 pg_class / pg_proc，那些檢查只能走 SQL。
 *
 *   npm run db:sql -- supabase/migrations/0001_init.sql
 *   npm run db:sql -- --query "select count(*) from public.film"
 *
 * 連線字串取自 DATABASE_URL（.env）。整份檔案以單一 simple-query
 * 送出，因此在隱式交易內執行：任何一句失敗即全部回滾，不會留下半套 schema。
 */

import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { Client } from 'pg'

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
