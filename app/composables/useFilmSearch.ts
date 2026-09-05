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
 *
 * ── 注音組字中間態 ────────────────────────────────────────────
 * `USelectMenu` 的搜尋框走 reka-ui 的 `ListboxFilter`，那支有 `useComposing()`：
 * 組字中（`shouldDeferInput`）**不更新 `searchTerm`**，所以 `term` 收不到
 * ㄍ／ㄍㄨ／ㄍㄨㄟ 這些中間態，這裡不必再擋一次。實測 reka-ui 2.10.3 確認，
 * 見 BUILD_PLAN §7 #80。
 * **若哪天把片名欄位換成裸的 `UInput`，就必須自己接 `useImeGuard()`**——
 * Nuxt UI 的 `UInput` 沒有這層保護，`/search` 就是踩到這個。
 */
export function useFilmSearch() {
  const supabase = useSupabaseClient<Database>()
  /** 輸入框的字面值。 */
  const term = ref('')
  const items = ref<FilmOption[]>([])
  /**
   * `items` 對應的查詢字串；空字串代表「還沒查過任何東西」。
   *
   * 「找不到『X』」的 X 必須是這個值而不是 `term`——否則在 debounce 與查詢
   * 往返的這幾百毫秒內，畫面會拿新的輸入去配上一次的（空）結果，
   * 使用者在字都還沒查之前就先看到一次「找不到」。
   */
  const queried = ref('')
  const loading = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  async function run(q: string) {
    // 已 lower 過的 search_text 對上 lower 過的 needle；`%` `_` `\` 是 LIKE
    // 的萬用字元與跳脫字元，要中和掉，否則使用者打一個 % 會撈回整個片庫。
    const safe = q.toLowerCase().replace(/[\\%_]/g, ' ').trim()
    if (!safe) {
      items.value = []
      queried.value = ''
      loading.value = false
      return
    }
    const mine = ++seq
    const { data } = await supabase
      .from('film_public')
      .select('id,slug,title_zh,title_original,release_year,country,tmdb_poster_path')
      .like('search_text', `%${safe}%`)
      .limit(20)
    // 慢的請求可能後到，只採用最後一次輸入的結果
    if (mine !== seq)
      return
    items.value = (data ?? []) as FilmOption[]
    queried.value = q
    loading.value = false
  }

  watch(term, (q) => {
    clearTimeout(timer)
    if (!q.trim()) {
      // 清空立即生效，不必等 debounce
      ++seq
      items.value = []
      queried.value = ''
      loading.value = false
      return
    }
    // debounce 期間就進 loading：這段時間畫面上不該還掛著上一次的結果或空狀態
    loading.value = true
    timer = setTimeout(run, 250, q)
  })
  onBeforeUnmount(() => clearTimeout(timer))

  return { term, items, loading, queried }
}

export function filmLabel(f: FilmOption | null | undefined): string {
  if (!f)
    return ''
  const main = f.title_zh || f.title_original || '未命名'
  return f.release_year ? `${main}（${f.release_year}）` : main
}
