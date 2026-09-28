import type { SupabaseClient } from '@supabase/supabase-js'
import type { RecordForm } from '../schemas/record'
import type { Database } from '../types/database.types'
// ⚠️ 相對路徑不用 `~/`：tests/ 走 tsconfig.pipeline.json，那裡的 `~` 指向 ./src（#212 同一類）。
import { toRecordRow } from '../schemas/record'

/**
 * 新增（`records/new`）與更新（`RecordEditForm`）的寫入順序、票價三態、部分失敗都在這裡定；⚠️ 不含 `import.vue`（批次＋import_key）與刪除（FK cascade）。
 * 票價在獨立的 `viewing_record_cost`：RLS 只能遮「列」不能遮「欄」，`show_cost` 要靠結構強制
 * ⇒ 永遠兩次寫入、先紀錄後票價（票價列靠 `record_id` 掛著，先寫票價會撞 FK）。
 */

type Client = SupabaseClient<Database>

/**
 * 三種結果**必須分得開**：`cost-failed` 時紀錄已經落地，呼叫端若當成整筆失敗，
 * 使用者會再按一次「記下來」⇒ 重複一筆（新增）或以為沒改到（更新）。
 */
export type RecordWriteResult
  = | { status: 'saved', id: string, hasCost: boolean }
    | { status: 'cost-failed', id: string, hasCost: boolean, error: { message: string } }
    | { status: 'failed', error: { message: string } }

/**
 * 新增。`form.cost` 是 null ⇒ **不寫票價列**；0 ⇒ 寫一列 amount 0（招待票）。
 * null 與 0 是兩件事，理由見 `schemas/record.ts` 檔頭。
 */
export async function createRecord(
  supabase: Client,
  { form, userId }: { form: RecordForm, userId: string },
): Promise<RecordWriteResult> {
  const { data: inserted, error } = await supabase
    .from('viewing_record')
    .insert({ ...toRecordRow(form), user_id: userId, film_id: form.film.id })
    .select('id')
    .single()
  if (error || !inserted)
    return { status: 'failed', error: error ?? { message: '沒有拿到新紀錄的 id' } }

  if (form.cost === null)
    return { status: 'saved', id: inserted.id, hasCost: false }

  const { error: costError } = await supabase
    .from('viewing_record_cost')
    .insert({ record_id: inserted.id, amount: form.cost })
  return costError
    ? { status: 'cost-failed', id: inserted.id, hasCost: false, error: costError }
    : { status: 'saved', id: inserted.id, hasCost: true }
}

/**
 * 更新。`hadCost` 是「載入時原本就有票價列」：只有那時清空票價才需要去刪（沒有列就不發 delete）。
 * 回傳的 `hasCost` 是寫完之後的真相，呼叫端拿它蓋回自己的 `hadCost`，不要自己猜。
 */
export async function updateRecord(
  supabase: Client,
  { id, form, hadCost }: { id: string, form: RecordForm, hadCost: boolean },
): Promise<RecordWriteResult> {
  /*
   * ★ **單一 UPDATE，永遠不是「刪掉再新增」**（David 第 2 條）：`id`／`created_at` 要原封不動，
   * 而票價列的 FK 是 ON DELETE CASCADE ⇒ 刪掉重建會把票價靜靜連帶刪掉（#334）。
   * `film_id` 跟著送：RLS `record_update` 的 with check 沒把它釘成常數（活體查過）⇒ 換片是被允許的。
   */
  const { error } = await supabase
    .from('viewing_record')
    .update({ ...toRecordRow(form), film_id: form.film.id })
    .eq('id', id)
  if (error)
    return { status: 'failed', error }

  if (form.cost === null) {
    if (!hadCost)
      return { status: 'saved', id, hasCost: false }
    const { error: de } = await supabase
      .from('viewing_record_cost')
      .delete()
      .eq('record_id', id)
    // 刪失敗 ⇒ 那一列還在，hasCost 維持 true
    return de
      ? { status: 'cost-failed', id, hasCost: true, error: de }
      : { status: 'saved', id, hasCost: false }
  }

  const { error: ce } = await supabase
    .from('viewing_record_cost')
    .upsert({ record_id: id, amount: form.cost }, { onConflict: 'record_id' })
  return ce
    ? { status: 'cost-failed', id, hasCost: hadCost, error: ce }
    : { status: 'saved', id, hasCost: true }
}

/**
 * 結果 → toast。兩個呼叫端共用這一支，部分失敗的講法才不會一邊說「存好了但票價沒存」、
 * 一邊說「更新失敗」（改之前 RecordEditForm 就是這樣：UPDATE 已落地卻報整筆失敗）。
 * ★ 不用 color: 'warning'——Nuxt UI 的 warning 預設是 amber，跟 primary 同色會撞（DESIGN_SYSTEM §1.5）。
 */
export function recordWriteToast(
  result: RecordWriteResult,
  titles: { saved: string, failed: string },
): { title: string, description?: string, color: 'success' | 'error' } {
  if (result.status === 'saved')
    return { title: titles.saved, color: 'success' }
  if (result.status === 'cost-failed')
    return { title: `${titles.saved}，但票價沒存成功`, description: result.error.message, color: 'error' }
  return { title: titles.failed, description: result.error.message, color: 'error' }
}
