// 把 docs/legal/*.md 載進 legal_document。
//
// version 用 v0.1 而不是 v1.0：這三份是草案，還沒有經過法律意見。
// effective_at 設成現在，因為欄位是 NOT NULL 而頁面需要有東西可以 render——
// 但正文第一行就寫著「草案、尚未生效」，畫面上不會假裝它已經生效。
// 上線前由 David 與律師定稿後，以 v1.0 + 真正的生效日插入新的一列
// （legal_document 是 unique(kind, version)，舊版留著就是為了舉證）。
//
// content_sha256 由 DB 的 trigger 算，這裡不給——寫入端給的雜湊只證明
// 「寫入的人算了一個雜湊」，而會去改條款正文的人正是最有動機一起改雜湊的人。

import { readFile } from 'node:fs/promises'
import process from 'node:process'

const pg = (await import('pg')).default
const { Client } = pg

const ROOT = new URL('../docs/legal', import.meta.url).pathname
const DOCS = [
  { kind: 'terms', file: 'terms.md' },
  { kind: 'privacy', file: 'privacy.md' },
  { kind: 'copyright_policy', file: 'copyright-policy.md' },
]

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
await client.connect()

/**
 * 剝掉 <!--INTERNAL … INTERNAL--> 區塊。
 *
 * 那些區塊放的是「技術落點」——每一條條文對應到哪張表、哪支函式、哪條 policy。
 * 它們的用途是**日後改實作時能反查有沒有把條文變成謊話**，所以必須留在原始檔、
 * 貼著它們所描述的那一條；但它們是給團隊看的，印在公開條款頁上既洩漏 schema
 * 細節、也讓文件讀起來像沒寫完。
 *
 * 刻意用「單一來源 + 載入時機械性剝除」而不是「維護兩份」：
 * 兩份一定會漂移，而漂移的方向必然是內部那份越來越舊——因為改條文的人
 * 看的是公開那份。
 */
function stripInternal(md) {
  return `${md
    .replace(/<!--INTERNAL[\s\S]*?INTERNAL-->\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`
}

for (const { kind, file } of DOCS) {
  const body = stripInternal(await readFile(`${ROOT}/${file}`, 'utf8'))
  await client.query(
    `insert into public.legal_document (kind, version, effective_at, body_md)
     values ($1, 'v0.1', now(), $2)
     on conflict (kind, version) do update set body_md = excluded.body_md`,
    [kind, body],
  )
  console.log(`載入 ${kind.padEnd(18)} ${body.length} 字元`)
}

const { rows } = await client.query(
  `select kind::text, version, effective_at::text,
          length(body_md)::text as len,
          coalesce(left(content_sha256, 12), '(null)') as sha
     from public.legal_document order by kind`,
)
console.table(rows)
await client.end()
