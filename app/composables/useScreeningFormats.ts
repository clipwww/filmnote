import type { Database } from '~/types/database.types'

/**
 * 播放版本的代碼 → 中文顯示名。`screening_format` 是查表不是 enum（會持續長出成員的開放
 * 詞彙）⇒ 顯示名必須從資料庫來，不能在前端寫死一份對照表——寫死的那份會在有人新增
 * `imax_laser` 之類的成員時默默過期，畫面直接印出原始代碼。
 */
/*
 * 這張表對 anon 全開（RLS `using (true)`），內容與觀看者無關 ⇒ SSR 期間取它不會讓輸出因人而異。
 */
export function useScreeningFormats() {
  const supabase = useSupabaseClient<Database>()

  const { data } = useAsyncData('screening-formats', async () => {
    const { data, error } = await supabase
      .from('screening_format')
      .select('code,label')
      .order('sort_order')
    if (error)
      throw error
    return data ?? []
  })

  const labelByCode = computed(() =>
    new Map((data.value ?? []).map(f => [f.code, f.label])))

  /** 查不到就回原始代碼——寧可顯示 `imax_laser` 也不要顯示空白。 */
  function formatLabel(code: string | null | undefined): string | null {
    if (!code)
      return null
    return labelByCode.value.get(code) ?? code
  }

  return { formats: computed(() => data.value ?? []), formatLabel }
}
