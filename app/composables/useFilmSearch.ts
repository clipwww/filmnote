import type { Database } from '~/types/database.types'

export interface FilmOption {
  id: string
  slug: string | null
  title_zh: string | null
  title_original: string | null
  release_year: number | null
  country: string | null
  tmdb_poster_path: string | null
}

/**
 * 片名搜尋。過濾一律交給 Postgres。
 *
 * `USelectMenu` 的內建搜尋是 reka-ui 的 `useFilter`（Intl.Collator,
 * sensitivity:'base'），做的是子字串比對，而且要先把整包資料送進瀏覽器——
 * 2,669 筆片庫兩者都不可接受（踩雷 #50）。呼叫端必須加 `ignore-filter`
 * 並以 `v-model:search-term` 把輸入接到這裡。
 */
export function useFilmSearch() {
  const supabase = useSupabaseClient<Database>()
  const term = ref('')
  const items = ref<FilmOption[]>([])
  const loading = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  async function run(q: string) {
    // 已 lower 過的 search_text 對上 lower 過的 needle；`%` `_` `\` 是 LIKE
    // 的萬用字元與跳脫字元，要中和掉，否則使用者打一個 % 會撈回整個片庫。
    const safe = q.toLowerCase().replace(/[\\%_]/g, ' ').trim()
    if (!safe) {
      items.value = []
      return
    }
    const mine = ++seq
    loading.value = true
    const { data } = await supabase
      .from('film_public')
      .select('id,slug,title_zh,title_original,release_year,country,tmdb_poster_path')
      .like('search_text', `%${safe}%`)
      .limit(20)
    // 慢的請求可能後到，只採用最後一次輸入的結果
    if (mine !== seq)
      return
    items.value = (data ?? []) as FilmOption[]
    loading.value = false
  }

  watch(term, (q) => {
    clearTimeout(timer)
    timer = setTimeout(run, 250, q)
  })
  onBeforeUnmount(() => clearTimeout(timer))

  return { term, items, loading }
}

export function filmLabel(f: FilmOption | null | undefined): string {
  if (!f)
    return ''
  const main = f.title_zh || f.title_original || '未命名'
  return f.release_year ? `${main}（${f.release_year}）` : main
}
