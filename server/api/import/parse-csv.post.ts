import { Buffer } from 'node:buffer'
import process from 'node:process'
import { z } from 'zod'
import { assertImportOwnerFrom } from '~~/server/utils/import-auth'
import { parseMyLogCsv } from '~~/server/utils/mylog-csv'
import { serverSupabaseUser } from '#supabase/server'

/**
 * `/app/import` 的 CSV 剖析，回 `MyLogItem[]`。★ 是端點而不是讓前端自己 import：
 * 剖析規則只該有一份——它與 CLI 匯入產出的 `import_key` 必須完全一致，否則同一筆
 * 從兩條路徑進來會變成兩筆。★ 這支**不寫任何東西**，寫入由使用者確認後另走。
 */
// ★ `issues` 不是附註是**要顯示出來的東西**：剖析器選擇拒絕可疑的列而不是猜（踩雷
//   #67），不顯示就等於安靜地少匯入了幾筆。

/** 2 MB。實測 174 筆約 20 KB ⇒ 這是「十年份再乘以五十」。設上限是因為 tokenizer 逐字元跑。 */
const MAX_BYTES = 2 * 1024 * 1024

const bodySchema = z.object({
  csv: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  // 未登入 401、登入但不是本人 403。判斷只有一份（見 import-auth.ts：那是功能閘門
  // 不是權限邊界）。supabase 的接線刻意留在這裡，讀的人一眼看得到問身分的是誰。
  await assertImportOwnerFrom({
    user: () => serverSupabaseUser(event),
    allowedEmail: () => process.env.IMPORT_TARGET_EMAIL,
  })

  const parsed = bodySchema.safeParse((await readBody(event)) ?? {})
  if (!parsed.success)
    throw createError({ statusCode: 422, statusMessage: '需要 csv 欄位（檔案內容的純文字）' })

  const bytes = Buffer.byteLength(parsed.data.csv, 'utf8')
  if (bytes > MAX_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `CSV 太大（${Math.round(bytes / 1024)} KB，上限 ${MAX_BYTES / 1024} KB）`,
    })
  }

  const { items, issues, headerSkipped } = parseMyLogCsv(parsed.data.csv)

  // 全部剖析失敗通常是選錯檔。回 200 + 空陣列會讓 UI 顯示「0 筆可匯入」，使用者
  // 不會知道自己選錯了。
  if (!items.length && issues.length) {
    throw createError({
      statusCode: 422,
      statusMessage: `這個檔案的 ${issues.length} 列全部無法解析，可能不是舊 log 匯出的 CSV`,
      data: { issues: issues.slice(0, 5) },
    })
  }

  return {
    headerSkipped,
    count: items.length,
    items,
    // ★ 全部回不截斷：被拒絕的列是使用者唯一會知道「這幾筆沒進來」的管道。
    issues,
  }
})
