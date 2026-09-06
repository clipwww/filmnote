import type { Database } from '~/types/database.types'
import type { ParsedLegalDoc } from '~/utils/legal-markdown'
import { parseLegalMarkdown } from '~/utils/legal-markdown'

export type LegalDocKind = Database['public']['Enums']['legal_doc_kind']
export type LegalDocumentRow = Database['public']['Tables']['legal_document']['Row']

/**
 * `/legal/{terms,privacy,copyright}` 的內容來源（`SCREENS §15.1`）。
 *
 * ── 這四頁是即時 SSR，`cache-control: no-store`（2026-09-06 定案）────────
 * 曾經是 `prerender: true`，但那一條**實測完全沒有生效**（踩雷 #91）。
 * 查出來之後的裁決不是「把預先算繪修好」而是「本來就不該預先算繪」：
 *
 * 條款改版是**插入新的一列**（0007 的 `legal_doc_immutable` 讓已被同意過的文件
 * 根本不能就地改），而 `legal_acceptance` 綁的是 `document_id`。烤死在建置當下的
 * 版本，會讓「使用者同意了某一版」與「畫面上顯示的那一版」分岔——那正是 §15.1
 * 說的「那筆同意紀錄對使用者就是不可查證的」。而且這個失敗**完全無聲**：
 * 沒有錯誤、沒有 404，只有一份過期的條款。條款頁一年改不了幾次，
 * 快取省不到什麼，正確性遠比延遲重要。
 *
 * ⇒ 每一次請求都問一次資料庫，拿到的一定是現行版。
 *
 * 代價寫在這裡，不要當成沒有：資料庫不可達時這一頁會退成「讀不到」的空狀態
 *（`LegalDocumentView` 有處理，並留下 `/legal/dmca` 這條還走得通的路）。
 * 這是拿可用性換正確性的一次明確取捨，不是疏漏。
 *
 * ⚠️ 這裡曾經有一段「掛載後再對一次資料庫」的重新驗證，**已經刪掉**：
 * 它的前提是頁面可能是預先算繪出來的，而現在確定不是，留著只會讓後人
 * 以為有預先算繪。要是哪天真的加回 `nitro.prerender.routes`，那一段要一起回來。
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

  const { data: versions, error } = useAsyncData(
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
   * 「哪一版是現行版」要拿 `effective_at` 跟現在比。即時 SSR 之下伺服器的
   * 「現在」就是請求當下，所以固定成一個值即可——不必再為了預先算繪的
   * 建置時戳做修正。
   */
  const now = Date.now()

  /** 使用者從歷史版本清單選了哪一版。null＝看現行版。 */
  const selectedId = ref<number | null>(null)

  const current = computed(() => pickCurrentVersion(versions.value ?? [], now))
  const shown = computed(() =>
    (selectedId.value === null
      ? current.value
      : versions.value?.find(v => v.id === selectedId.value) ?? current.value),
  )
  const isHistorical = computed(() => !!shown.value && !!current.value && shown.value.id !== current.value.id)

  const parsed = computed<ParsedLegalDoc | null>(() =>
    shown.value ? parseLegalMarkdown(shown.value.body_md) : null,
  )

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
