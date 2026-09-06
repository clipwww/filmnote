import type { Database } from '~/types/database.types'
import type { ParsedLegalDoc } from '~/utils/legal-markdown'
import { parseLegalMarkdown } from '~/utils/legal-markdown'

export type LegalDocKind = Database['public']['Enums']['legal_doc_kind']
export type LegalDocumentRow = Database['public']['Tables']['legal_document']['Row']

/**
 * `/legal/{terms,privacy,copyright}` 的內容來源（`SCREENS §15.1`）。
 *
 * ── ⚠️ `/legal/** → prerender: true` 目前**不生效**（2026-09-06 實測，踩雷 #91）
 * `nuxt.config.ts` 有那一條規則，但 `pnpm build` 之後 `.output/public/` 裡
 * **一個 HTML 都沒有**，建置日誌也沒有 `Initializing prerenderer`。兩個原因疊在一起：
 *   ① nitro 只把**不含萬用字元**的 routeRules 路徑放進預先算繪佇列
 *      （`filter(([path, o]) => o.prerender && !path.includes("*"))`），`/legal/**` 被濾掉；
 *   ② Nuxt 4.5.2 的 `nuxt build`（沒有 `--prerender`）根本不會呼叫 nitro 的
 *      `prerender()`——`nitropack` 的 `build()` 也沒有呼叫它。
 * ⇒ 這四頁**實際上是每次請求即時 SSR**。真要靜態化得在 nuxt.config 明列
 *   `nitro.prerender.routes`，那是共用檔，要先問主 session。
 *
 * ── 即時 SSR 其實是這一頁想要的行為，不是將就 ─────────────────────────
 * 條款改版是**插入新的一列**（0007 的 `legal_doc_immutable` 讓已被同意過的文件
 * 根本不能就地改），而 `legal_acceptance` 綁的是 `document_id`。如果資料庫已經
 * 有 v1.0、畫面卻停在建置當下的 v0.1，使用者按下同意的是新版、看到的是舊版
 * ——那正是 §15.1 說的「那筆同意紀錄對使用者就是不可查證的」，而且**完全無聲**：
 * 沒有錯誤、沒有 404，只有一份過期的條款。即時 SSR 沒有這個失敗模式。
 *
 * 代價是條款頁在資料庫不可達時會退成「讀不到」的空狀態（`LegalDocumentView`
 * 有處理，並留下 `/legal/dmca` 這條還走得通的路）。這是已知取捨，寫在回報裡。
 *
 * ── 但程式仍然要在 prerender 打開的那一天是對的 ───────────────────────
 * 所以掛載後保留一次重新驗證，**只在這一頁真的是預先算繪出來的時候才跑**
 * （`payload.prerenderedAt` 只有預先算繪的頁面才有）。即時 SSR 時它不會發出任何請求。
 * 順帶修掉另一個只有 prerender 會踩到的細節：「哪一版是現行版」要拿 `effective_at`
 * 跟**現在**比，而建置期的「現在」是建置時間 ⇒ 排程在未來生效的版本，
 * 靜態檔會永遠選不到它。
 */

const COLUMNS = 'id,kind,version,effective_at,body_md,content_sha256'

/**
 * 現行版＝`effective_at` 已到、且最新的那一列。
 *
 * 全部都還沒生效時回**最早**的那一列而不是 null：這一頁沒有「空狀態」這個選項，
 * 法遵頁少一頁就是少一頁。生效日照樣顯示在標題下方，讀的人看得出來它還沒到。
 */
export function pickCurrentVersion(
  rows: LegalDocumentRow[],
  now: number = Date.now(),
): LegalDocumentRow | null {
  if (!rows.length)
    return null
  const byEffective = [...rows].sort(
    (a, b) => Date.parse(b.effective_at) - Date.parse(a.effective_at) || b.id - a.id,
  )
  return byEffective.find(r => Date.parse(r.effective_at) <= now) ?? byEffective.at(-1)!
}

export function useLegalDocument(kind: LegalDocKind) {
  const supabase = useSupabaseClient<Database>()

  const { data: versions, refresh, error } = useAsyncData(
    `legal-${kind}`,
    async () => {
      const { data, error: queryError } = await supabase
        .from('legal_document')
        .select(COLUMNS)
        .eq('kind', kind)
        .order('effective_at', { ascending: false })
      if (queryError)
        throw queryError
      return (data ?? []) as LegalDocumentRow[]
    },
    { default: () => [] as LegalDocumentRow[] },
  )

  /**
   * 建置期烤進去的是建置當下的時間；掛載後換成瀏覽器的現在。
   * 兩者不同時，`current` 會自己重算——這就是上面說的「未來生效的版本」那一條。
   */
  const now = ref(Date.now())

  /** 使用者從歷史版本清單選了哪一版。null＝看現行版。 */
  const selectedId = ref<number | null>(null)

  const current = computed(() => pickCurrentVersion(versions.value ?? [], now.value))
  const shown = computed(() =>
    (selectedId.value === null
      ? current.value
      : versions.value?.find(v => v.id === selectedId.value) ?? current.value),
  )
  const isHistorical = computed(() => !!shown.value && !!current.value && shown.value.id !== current.value.id)

  const parsed = computed<ParsedLegalDoc | null>(() =>
    shown.value ? parseLegalMarkdown(shown.value.body_md) : null,
  )

  const nuxtApp = useNuxtApp()

  onMounted(async () => {
    now.value = Date.now()
    // 即時 SSR 的頁面剛剛才查過資料庫，再查一次只是多一個往返。
    if (!nuxtApp.payload.prerenderedAt)
      return
    // 失敗就維持烤好的那一份。條款頁的可用性優先於新鮮度——反過來會讓
    // 資料庫的一次抖動變成一頁空白的法遵頁。
    await refresh().catch(() => {})
  })

  return { versions, current, shown, isHistorical, parsed, selectedId, error }
}

/**
 * `2026-09-06T02:36:36.795Z` → `2026-09-06 生效`（台北）。
 *
 * ⚠️ 一律指定 `timeZone`。`effective_at` 是 timestamptz，不指定的話伺服器算出來的
 * 是 UTC 日期、瀏覽器算出來的是當地日期——同一列資料在 SSR 與 hydration 會顯示成
 * 不同的日期，而且**只有跨日的那幾個小時會不一樣**，平常測不出來。
 */
export function effectiveDateText(effectiveAt: string): string {
  return new Intl.DateTimeFormat('zh-Hant-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(effectiveAt)).replace(/\//g, '-')
}
