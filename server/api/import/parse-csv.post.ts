import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { parseMyLogCsv } from '~~/server/utils/mylog-csv'
import { serverSupabaseUser } from '#supabase/server'

/**
 * `/app/import` 的 CSV 剖析。前端把檔案內容當字串送上來，這裡回 `MyLogItem[]`。
 *
 * ★ 為什麼是端點而不是讓前端自己 import：剖析器住在 `server/utils/**`，
 *   那是 server-only。而且**剖析規則只該有一份**——它與 CLI 匯入
 *   （`scripts/import-mylog.ts`）產出的 `import_key` 必須完全一致，
 *   否則同一筆紀錄從兩條路徑進來會變成兩筆。前端另寫一份一定會漂移。
 *
 * ★ 這支**不寫任何東西**。它只把 CSV 變成結構化資料回給 UI，讓使用者確認
 *   比對結果之後再走既有的建立流程。剖析與寫入分開，是因為使用者需要在
 *   中間插手（未比對到的片名要選 TMDB 候選或自建 UGC）。
 *
 * ★ `issues` 不是附註，是**要顯示出來的東西**。踩雷 #67 的整個教訓就是
 *   「CSV 用錯模式會靜默錯位」——剖析器選擇拒絕可疑的列而不是猜，
 *   那些列如果不顯示給使用者看，就等於安靜地少匯入了幾筆。
 */

/**
 * 2 MB。實測 174 筆約 20 KB，所以這個上限是「十年份的資料再乘以五十」。
 * 設上限是因為這支要跑一個字元一個字元的 tokenizer，而 Vercel 的函式有執行時間限制。
 */
const MAX_BYTES = 2 * 1024 * 1024

const bodySchema = z.object({
  csv: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const user = await serverSupabaseUser(event)
  if (!user)
    throw createError({ statusCode: 401, statusMessage: '請先登入' })

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

  // 全部都剖析失敗時通常不是資料壞了，是檔案根本不是這個格式（例如選錯檔）。
  // 回 200 加一個空陣列會讓 UI 顯示「0 筆可匯入」，而使用者不知道自己選錯檔。
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
    // ★ 全部回，不截斷。被拒絕的列是使用者唯一會知道「這幾筆沒進來」的管道，
    //   截斷等於安靜地少匯入。
    issues,
  }
})
