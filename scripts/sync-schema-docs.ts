/**
 * 把 `supabase/migrations/**` 同步進 `docs/BUILD_PLAN.md` 的 schema 章節。
 *
 *   pnpm exec tsx scripts/sync-schema-docs.ts           # 檢查漂移（漂移則 exit 1）
 *   pnpm exec tsx scripts/sync-schema-docs.ts --write   # 實際寫回文件
 *
 * （`db:sync-docs` 的 package.json 別名待主 session 核可後補上。）
 *
 * §1.2 開頭寫著「本節與 0001_init.sql 逐字相同」。那句話在人工維護下必然
 * 會變成謊——0002 加進來時它就已經漂移了一次。與其倚賴記得，不如讓「檢查
 * 是否漂移」變成一道可以跑的指令：`--check`（預設）在不一致時直接失敗，
 * 可以掛進 CI 或 commit 前的例行檢查。
 *
 * 章節與檔案的對應寫在 SECTIONS，新增 migration 時只要加一列。
 */

import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

const DOC = 'docs/BUILD_PLAN.md'

interface Section {
  /** 章節標題，必須與 BUILD_PLAN 中的一字不差。 */
  heading: string
  /** 該章節依序收錄的 migration 檔。 */
  files: string[]
  /** 章節不存在時，插入在這個標題之前。 */
  insertBefore?: string
  /** 章節不存在時要生成的前言。 */
  preamble?: string
}

const SECTIONS: Section[] = [
  {
    heading: '## 1.2 完整 migration',
    files: ['supabase/migrations/0001_init.sql'],
  },
  {
    heading: '## 1.2a 後續 migration（`0002`、`0003`）',
    files: [
      'supabase/migrations/0002_venue_selectable.sql',
      'supabase/migrations/0003_user_year_stats.sql',
    ],
    insertBefore: '## 1.2b 權限 migration',
    preamble: [
      '',
      '0001 之後、9999 之前執行。兩支都可重複執行。',
      '',
      '**`0002_venue_selectable.sql`** —— 場所能不能出現在「新增紀錄」的選單。',
      '舊 log 匯入帶進三家不在 2025 年名冊中的影城（兩家已歇業、一家在日本大阪），',
      '這些是真的去過的地方、必須留在歷史紀錄裡，但沒有人能在已拆除的戲院看新片。',
      '刻意不沿用 `status='
      + '\'closed\'` 表達：心斎橋那家還在正常營業，它不該進選單的理由是',
      '「不在台灣、超出 SPEC 範圍」，把兩件事塞進同一個 enum 會逼出一個謊。',
      '**前端一律查 `public.venue_option`，不可直接查 `venue`。**',
      '',
      '**`0003_user_year_stats.sql`** —— 年度統計 RPC（Step 6、US-34～43）。',
      '**SECURITY INVOKER，不可改 DEFINER**：聚合是推論通道（踩雷 #42），',
      'DEFINER 會讓 RLS 整個讓開，此時一個寫錯的 WHERE 不會回 403，',
      '而是安靜地把全站資料算進總計倒給呼叫者。代價是總花費對不同觀看者是不同的',
      '數字，故回傳 `totals.spend_is_partial` 讓前端知道自己拿到的是不是全部。',
      '9999 的自我檢查會在它被改成 DEFINER 時讓 migration 失敗。',
      '',
      '回傳形狀的 TypeScript 契約在 `server/utils/user-year-stats.ts`',
      '（RPC 宣告 `returns jsonb`，型別產生器只能標成 `Json`，故手寫）。',
      '',
    ].join('\n'),
  },
  {
    heading: '## 1.2b 權限 migration',
    files: ['supabase/migrations/9999_grants.sql'],
  },
]

/** 剝掉「由 BUILD_PLAN 產生」這類指回文件的表頭，避免文件裡出現自我指涉。 */
function stripBackReference(sql: string): string {
  const lines = sql.split('\n')
  while (lines.length && /^--\s*(?:由 docs\/BUILD_PLAN|相對於 docs\/research)/.test(lines[0] ?? ''))
    lines.shift()
  return lines.join('\n').replace(/\n+$/, '')
}

/** 找出 `from` 之後、下一個 `##` 標題之前的範圍。 */
function sectionBounds(doc: string, heading: string): { start: number, end: number } {
  const start = doc.indexOf(heading)
  if (start < 0)
    throw new Error(`BUILD_PLAN 找不到章節「${heading}」`)
  const next = doc.indexOf('\n## ', start + heading.length)
  return { start, end: next < 0 ? doc.length : next }
}

/** 取出一段文字裡所有 ```sql 圍籬區塊的位置。 */
function sqlBlocks(body: string): { open: number, close: number }[] {
  const blocks: { open: number, close: number }[] = []
  let from = 0
  for (;;) {
    const open = body.indexOf('```sql', from)
    if (open < 0)
      break
    const close = body.indexOf('\n```', open + 6)
    if (close < 0)
      throw new Error('有未閉合的 ```sql 區塊')
    blocks.push({ open, close })
    from = close + 4
  }
  return blocks
}

async function syncSection(doc: string, section: Section): Promise<string> {
  const bodies = await Promise.all(
    section.files.map(async f => stripBackReference(await readFile(f, 'utf8'))),
  )

  if (!doc.includes(section.heading)) {
    if (!section.insertBefore)
      throw new Error(`章節「${section.heading}」不存在且未指定 insertBefore`)
    const at = doc.indexOf(section.insertBefore)
    if (at < 0)
      throw new Error(`找不到插入點「${section.insertBefore}」`)
    const block = `${section.heading}\n${section.preamble ?? '\n'}\n`
      + `${bodies.map(b => `\`\`\`sql\n${b}\n\`\`\``).join('\n\n')}\n\n\n`
    return doc.slice(0, at) + block + doc.slice(at)
  }

  const { start, end } = sectionBounds(doc, section.heading)
  const body = doc.slice(start, end)
  const blocks = sqlBlocks(body)
  if (blocks.length !== bodies.length) {
    throw new Error(
      `章節「${section.heading}」有 ${blocks.length} 個 sql 區塊，`
      + `但對應 ${bodies.length} 個 migration 檔`,
    )
  }

  // 由後往前替換，前面的位移才不會被影響。
  let next = body
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!
    next = `${next.slice(0, b.open)}\`\`\`sql\n${bodies[i]}\n\`\`\`${next.slice(b.close + 4)}`
  }
  return doc.slice(0, start) + next + doc.slice(end)
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--')
  const write = args.includes('--write')

  const original = await readFile(DOC, 'utf8')
  let doc = original
  for (const section of SECTIONS)
    doc = await syncSection(doc, section)

  if (doc === original) {
    console.log('BUILD_PLAN 與 supabase/migrations/** 一致，沒有漂移。')
    return
  }

  if (!write) {
    console.error('❌ BUILD_PLAN 與 supabase/migrations/** 已漂移。')
    console.error('   以 `pnpm exec tsx scripts/sync-schema-docs.ts --write` 同步。')
    process.exit(1)
  }

  await writeFile(DOC, doc, 'utf8')
  console.log(`已同步 ${SECTIONS.flatMap(s => s.files).length} 支 migration 進 ${DOC}。`)
}

await main()
