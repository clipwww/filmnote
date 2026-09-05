import type { Database } from '~/types/database.types'

export interface VenueOption {
  id: string
  name: string
  kind: string
  city: string | null
  sort_weight: number | null
}

const LAST_VENUE_KEY = 'filmnote:last-venue'

/**
 * 新增／編輯紀錄用的選項來源。
 *
 * ★ 場所一律查 `venue_option` view，不要直接查 `venue`。
 *   view 已濾掉已歇業、已合併、海外與待審 UGC 場所；直接查 venue 會讓
 *   2020 年就歇業的日新威秀出現在「新增紀錄」的選單裡（見 0002 migration）。
 */
export function useVenueOptions() {
  const supabase = useSupabaseClient<Database>()

  const { data, status } = useAsyncData('venue-options', async () => {
    const { data, error } = await supabase
      .from('venue_option')
      .select('id,name,kind,city,sort_weight')
      .order('sort_weight', { ascending: true })
      .order('name', { ascending: true })
    if (error)
      throw error
    return (data ?? []) as VenueOption[]
  }, { server: false })

  return { venues: computed(() => data.value ?? []), status }
}

/** US-6：影城下拉選單記住上次選的。只是便利性，存 localStorage 即可。 */
export function useLastVenue() {
  function read(): string | null {
    if (import.meta.server)
      return null
    try {
      return localStorage.getItem(LAST_VENUE_KEY)
    }
    catch {
      return null
    }
  }
  function write(id: string | null) {
    if (import.meta.server || !id)
      return
    try {
      localStorage.setItem(LAST_VENUE_KEY, id)
    }
    catch {
      // 無痕視窗或封鎖 storage：記不住上次選擇不是錯誤，不要因此中斷流程
    }
  }
  return { read, write }
}
