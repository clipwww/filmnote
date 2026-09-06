import { z } from 'zod'

/**
 * 手動新增作品的表單（US-13~18）。
 *
 * ── 只有中文片名必填 ─────────────────────────────────────────
 * US-14 寫的是「只需填片名與年份」，但**連年份都不該擋**：缺的欄位之後比對到
 * TMDB 會自己補（US-18）。**擋住人比資料不完整更糟**——這一頁是「找不到片」
 * 流程的終點，是硬約束 (1) 最重要的落點，它必須讀起來像流程的下一步，
 * 不像錯誤畫面也不像後台表單。
 *
 * ── 空值一律 null 不是空字串 ─────────────────────────────────
 * `film` 的 `title_original` / `country` 是 `not null default ''`，
 * 所以寫入時空值要轉成 `''` 而不是 null；但**表單層面**維持 null，
 * 因為票根卡上「沒有原文片名」與「原文片名是空字串」要走同一條路：
 * 不渲染那一行，而不是渲染一個空行。
 */

function emptyToNull<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(v => (v === '' || v === undefined || Number.isNaN(v) ? null : v), schema)
}

export const filmSchema = z.object({
  titleZh: z
    .string({ error: '請填中文片名' })
    .trim()
    .min(1, '請填中文片名')
    .max(200, '片名最多 200 字'),

  titleOriginal: emptyToNull(z.string().trim().max(200, '原文片名最多 200 字').nullable()),
  country: emptyToNull(z.string().trim().max(40, '國別最多 40 字').nullable()),

  releaseYear: emptyToNull(
    // schema 的上下界跟資料庫的 check 對齊（1880–2200）
    z.number().int('年份要是整數').min(1880, '這比電影本身還早').max(2200, '這個年份看起來不對').nullable(),
  ),

  runtimeMinutes: emptyToNull(
    z.number().int('片長要是整數').min(1, '至少 1 分鐘').max(1200, '這個片長看起來不對').nullable(),
  ),
})

export type FilmForm = z.output<typeof filmSchema>

/**
 * 表單 → `film` 的欄位。
 *
 * ⚠️ 這五個常數不是「順便填的預設值」，是 `film_insert_ugc` policy 的
 * `with check` 條件——少一個或填錯一個，insert 會被 RLS 擋掉並回
 * 「new row violates row-level security policy」，而錯誤訊息不會告訴你是哪一欄。
 * `created_by` 由呼叫端補上目前使用者。
 */
export function toFilmRow(form: FilmForm) {
  return {
    title_zh: form.titleZh,
    // not null default ''：資料庫不吃 null，但表單層面維持 null（見檔頭）
    title_original: form.titleOriginal ?? '',
    country: form.country ?? '',
    release_year: form.releaseYear,
    runtime_minutes: form.runtimeMinutes,
    title_zh_source: 'ugc' as const,
    title_original_source: 'ugc' as const,
    origin: 'ugc' as const,
    visibility: 'private' as const,
    review_state: 'pending' as const,
    moderation_state: 'visible' as const,
  }
}
