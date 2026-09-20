import { z } from 'zod'

/**
 * 觀影紀錄表單的驗證規則，`/app/records/new` 與 `/edit` 共用。**必填只有三個**（片名、日期、
 * 場所）：這是 SPEC 的核心設計（US-4 散場走出影廳三十秒內記完），其餘一律選填
 * ——加必填等於破壞這個產品的主張，改動前請先看 SPEC。
 */
/*
 * 票價的空值語意：`cost` 是 `number | null`，**null 與 0 是兩件事**——null 是「沒有票價資料」
 * （編輯時代表刪掉那筆 cost 列）、0 是「真的沒花錢」（招待票、影展贈票）。匯入管線在這件事
 * 上踩過坑：把「沒資料」寫成 0 會稀釋平均票價 ⇒ 不用 `.default(0)`，也不要把空字串 coerce 成 0。
 */

/** 空字串／undefined → null，其餘交給後面的規則。UInputNumber 清空時給的是 null。 */
function emptyToNull<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(v => (v === '' || v === undefined || Number.isNaN(v) ? null : v), schema)
}

export const recordSchema = z.object({
  // 綁的是整個 film 物件（USelectMenu 未設 value-key），所以驗 id 存在即可
  film: z.object({ id: z.uuid('片名資料異常') }, { error: '請選擇作品' }),

  watchedOn: z
    .string({ error: '請選擇日期' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式應為 YYYY-MM-DD')
    .refine(v => !Number.isNaN(Date.parse(v)), '不是有效的日期')
    // schema 的 sane check 是 1895-12-28（電影誕生日），未來日期由資料庫的
    // guard_record_date trigger 擋（它按使用者時區判斷，前端算不準）
    .refine(v => v >= '1895-12-28', '這比電影本身還早'),

  watchedTime: emptyToNull(
    z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, '時間格式應為 HH:MM').nullable(),
  ),

  venueId: z.string({ error: '請選擇場所' }).min(1, '請選擇場所'),

  ticketCount: emptyToNull(
    z.number().int('票數要是整數').min(1, '至少一張').max(99, '最多 99 張').nullable(),
  ),

  // ★ 不要給 default(0)：見檔頭的空值語意
  cost: emptyToNull(
    z.number().min(0, '票價不能是負數').max(999999, '這個金額看起來不對').nullable(),
  ),

  hallLabel: emptyToNull(z.string().max(40, '影廳名稱最多 40 字').nullable()),
  formatCode: emptyToNull(z.string().nullable()),
  memo: emptyToNull(z.string().max(2000, '備註最多 2000 字').nullable()),
  isPublic: z.boolean(),
})

export type RecordForm = z.output<typeof recordSchema>

/** 編輯頁沒有換片的 UI，片名不參與驗證。 */
export const recordEditSchema = recordSchema.omit({ film: true })
export type RecordEditForm = z.output<typeof recordEditSchema>

/** 表單狀態 → viewing_record 的欄位。兩個頁面共用，避免欄位對應漂移。 */
export function toRecordRow(form: RecordEditForm) {
  return {
    watched_on: form.watchedOn,
    watched_time: form.watchedTime,
    ticket_count: form.ticketCount,
    hall_label: form.hallLabel,
    format_code: form.formatCode,
    memo: form.memo,
    visibility: form.isPublic ? ('public' as const) : ('private' as const),
    venue_id: form.venueId,
  }
}
