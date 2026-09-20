<script setup lang="ts">
import type { MyLogItem, NormalizedRecord } from '#pipeline/import/mylog'
import type { FilmOption } from '~/composables/useFilmSearch'
import type { Database } from '~/types/database.types'
import { expandDoubleFeature, resolveDoubleFeature } from '#pipeline/import/double-features'
import { normalizeRecords } from '#pipeline/import/mylog'
import { resolveTmdbOverride } from '#pipeline/import/tmdb-overrides'
import { resolveVenueAlias } from '#pipeline/import/venue-aliases'

/**
 * `/app/import` —— 匯入對帳（`SCREENS §13`、US-56~58）。版面照真實規模設計：
 * 169 筆來源 → 174 筆紀錄、133 部相異作品、134 個相異片名、15 個相異影城名稱。
 */
/*
 * 四個版面決定都來自那批數字：① 影城排在片名前（只有 15 個要對、對完覆蓋全部 169 筆，
 * 片名有 134 個——先做便宜的那段人才有動力做第二段）；② 依筆數由多到少（第一列就是
 * 115 筆，對完少掉 68% 工作量）；③ **下拉一律不預選**（實測模糊比對會把「林口威秀」
 * 綁到「樹林秀泰影城」，而**錯配比不配更糟：不配看得見、錯配看不見**）；
 * ④ 把已對好的摺起來（首次命中 116/134 = 87%，平鋪要捲過 116 列才找得到那 18 列）。
 */
/*
 * 純函式全部複用 `src/import/**`，一行都沒重寫。⚠️ 這個模組**必須維持瀏覽器可載入**——
 * `2a5be22` 之前它 import 了 `node:buffer`，那會讓整條路由在 dev 直接 500、在 build 靜默
 * 編成空物件（踩雷 #130）。往 `src/import/**` 加東西時，`node:` 內建模組一律不行。
 */
/*
 * 三個實測結論長在畫面上：① 時區偏移跑掉的是**午夜場**（台北 00:00 的 UTC 是前一天 16:00），
 * 交叉驗證對不上就進 issues ⇒ 這一頁要顯示 issues 不能吞掉；② 票價一律採用上游的 `cost`
 * 不自行重算（`fee` 是每張不是每筆，19 筆對不上）；③ **雙片連映拆成多筆**、票價全額記在
 * 第一筆 ⇒ 第 3 步的「有記票價」會少於「紀錄」，那不是 bug，畫面要主動解釋。
 */
/*
 * 兩件事走 server 端點都不是繞路：CSV 剖析走端點（前端自己 `split(',')` 會踩 #67——
 * 《劇場版IDOLiSH7》原文片名含逗號且未被引號包住，會**靜默錯位**）；TMDB 查詢走端點
 * （key 只在 server 端）。比對只有兩條**自動**路徑（中文片名完全吻合、人工對照表的 tmdb_id），
 * 沒有第三條：舊 log 沒有片長，而片長交叉驗證是唯一擋得住「片名相近但根本是另一部片」的機制。
 */
definePageMeta({ layout: 'default' })
useSeoMeta({ title: '匯入舊紀錄' })

const supabase = useSupabaseClient<Database>()
const user = useSupabaseUser()
const toast = useToast()

/**
 * 這一頁只有本人能用。選單那側在 `AppNav.vue` 擋，這裡擋的是**直接打網址**進來的人。
 * ⚠️ 這兩處都只是 UI，真正的閘門在 `server/utils/import-auth.ts`（兩支端點各 assert 一次）
 * ——**不要**因為這裡擋掉了就把端點那層拿掉。
 */
/*
 * ⚠️ 而那個閘門自己也只是**功能閘門不是安全邊界**：匯入的實際寫入走瀏覽器端的 RLS。
 * ★ `canImport` 初值是 `false` ⇒ **一定要配 `canImportKnown` 用三態**，只看它的話第一幀會對
 *   本人顯示一次「沒有對外開放」再跳回來——分不出「沒有」與「還沒到」就會說一次謊（#169）。
 */
const { canImport, canImportKnown } = useMyIdentity()

type Step = 'upload' | 'venues' | 'titles' | 'review' | 'done'
const step = ref<Step>('upload')

// ─────────────────────────────────────────────────────────────────────────────
// 第 0 步：讀檔與正規化
// ─────────────────────────────────────────────────────────────────────────────
/** 來源筆數（展開前）。與結果筆數不一樣是常態，第 3 步必須解釋。 */
const sourceCount = ref(0)
const rows = ref<NormalizedRecord[]>([])
const parseError = ref<string | null>(null)
const parsing = ref(false)

/** CSV 略過的標題列數。要說出來，否則使用者會以為少了一筆。 */
const headerSkipped = ref(0)

/**
 * ★ **`issues` 不是附註是產品功能**（US-58 原文就是「看到匯入時哪些片沒比對到」）：
 * 被擋下來的列是使用者**唯一**會知道「這幾筆沒進來」的管道，截斷或摺到看不見等於安靜地
 * 少匯入。兩個來源的形狀不同，這裡收斂成一種——對使用者來說它們是同一件事。
 */
interface ImportIssue {
  /** 給人看的定位：CSV 是第幾列，JSON 是原始那一行的內容。 */
  where: string
  reason: string
  detail: string
  raw: string
}

const issues = ref<ImportIssue[]>([])
/** 一次先給三筆，其餘可展開。全部平鋪會把對帳頁推到看不完。 */
const ISSUE_PAGE = 3
const shownIssues = ref(ISSUE_PAGE)
watch(issues, () => {
  shownIssues.value = ISSUE_PAGE
})

const REASON_LABEL: Record<string, string> = {
  // 正規化階段（src/import/mylog.ts）
  'wall-clock-mismatch': '時間對不上原始列',
  'unknown-format': '沒看過的放映版本',
  'bad-ticket-count': '票數超出範圍',
  'negative-amount': '金額是負的',
  // CSV 剖析階段（server/utils/mylog-csv.ts）
  'too-few-columns': '欄位數不足',
  'ambiguous-columns': '欄位數對不上，無法確定哪一欄是哪一欄',
  'bad-timestamp': '日期時間解析不出來',
  'bad-number': '數字欄位解析不出來',
  'wall-clock-drift': '時間與原始列不一致',
}

const reasonLabel = (r: string) => REASON_LABEL[r] ?? r

/**
 * ⚠️ **UTF-8 BOM**：包裝 JSON 與 CSV 皆為 UTF-8 with BOM（踩雷 #65），
 * 直接 `JSON.parse` 會失敗，而錯誤訊息是毫無線索的
 * `Unexpected token`（那個 token 印出來是看不見的 U+FEFF）。先剝掉再解析。
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

function looksLikeMyLog(v: unknown): v is MyLogItem[] {
  if (!Array.isArray(v) || !v.length)
    return false
  const first = v[0] as Record<string, unknown>
  return typeof first?.id === 'string' && typeof first?.date === 'string' && typeof first?.title === 'string'
}

async function readFile(file: File) {
  parsing.value = true
  parseError.value = null
  try {
    const text = stripBom(await file.text())
    // 副檔名只是提示，真正的判準是內容：JSON 一定以 [ 或 { 開頭。
    // 使用者把 .csv 存成 .txt 是常態，靠副檔名分流會得到一句莫名其妙的錯誤。
    if (/^\s*[[{]/.test(text))
      ingestJson(text)
    else
      await ingestCsv(text)
  }
  catch (e) {
    parseError.value = errText(e)
  }
  finally {
    parsing.value = false
  }
}

/**
 * CSV 走 server 端剖析。⚠️ **不要在前端自己 `split(',')`**（踩雷 #67）：
 * 《劇場版IDOLiSH7》的原文片名含逗號而且沒有被引號包住，用錯的模式解析會**靜默錯位**
 * ——欄位全部往左移一格，而畫面上看起來只是「片名怪怪的」。端點用 RFC 4180 的最小實作。
 */
async function ingestCsv(csv: string) {
  const res = await $fetch<{
    headerSkipped: number
    count: number
    items: MyLogItem[]
    issues: { record: number, raw: string, reason: string, detail: string }[]
  }>('/api/import/parse-csv', { method: 'POST', body: { csv } })

  headerSkipped.value = res.headerSkipped
  ingestItems(res.items, res.issues.map(i => ({
    where: `第 ${i.record} 列`,
    reason: reasonLabel(i.reason),
    detail: i.detail,
    raw: i.raw,
  })))
}

function errText(e: unknown): string {
  const err = e as { statusMessage?: string, data?: { statusMessage?: string }, message?: string }
  return err?.data?.statusMessage ?? err?.statusMessage ?? err?.message ?? '未知錯誤'
}

const pastedText = ref('')

function ingestJson(text: string) {
  const parsed: unknown = JSON.parse(text)
  if (!looksLikeMyLog(parsed)) {
    throw new Error('這不像舊 log 的匯出檔。預期是一個陣列，每一列要有 id、date、title 這幾個欄位。')
  }
  ingestItems(parsed, [])
}

function ingestItems(items: MyLogItem[], priorIssues: ImportIssue[]) {
  const { records, issues: found } = normalizeRecords(items)

  // 雙片連映：一次進場看兩部片，舊 log 記成一筆。拆分順序必須在正規化之後——
  // `expandDoubleFeature` 吃的是 NormalizedRecord。
  const expanded: NormalizedRecord[] = []
  for (const r of records) {
    const feature = resolveDoubleFeature(r.title)
    if (feature)
      expanded.push(...expandDoubleFeature(r, feature))
    else
      expanded.push(r)
  }

  sourceCount.value = items.length
  rows.value = expanded
  issues.value = [
    ...priorIssues,
    ...found.map(i => ({
      where: i.rawLine.split(',')[0] ?? i.importKey.slice(0, 12),
      reason: reasonLabel(i.reason),
      detail: i.detail,
      raw: i.rawLine,
    })),
  ]
  step.value = 'venues'
}

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file)
    readFile(file)
}

async function onPaste() {
  parsing.value = true
  parseError.value = null
  try {
    const text = stripBom(pastedText.value.trim())
    if (/^\s*[[{]/.test(text))
      ingestJson(text)
    else
      await ingestCsv(text)
  }
  catch (e) {
    parseError.value = errText(e)
  }
  finally {
    parsing.value = false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 第 1 步：影城
// ─────────────────────────────────────────────────────────────────────────────
interface VenueRow {
  id: string
  name: string
  city: string | null
  status: string
  selectable: boolean
}

/**
 * ⚠️ 這裡查 `venue` 不是 `venue_option`，**刻意違反**「一律查 venue_option」那條規則：
 * 後者濾掉已歇業／已合併／海外／待審，那對「新增今天的紀錄」是對的，但**匯入的是歷史
 * 紀錄**——2016 年在日新威秀看的那場就是在日新威秀看的，擋掉只會逼人亂綁一個還在營業的。
 * 代價是選單會出現歇業與海外場所，所以標籤上要標出來。
 */
const { data: venueData } = useAsyncData('import-venues', async () => {
  const { data, error } = await supabase
    .from('venue')
    .select('id,name,city,status,selectable')
    .is('merged_into_venue_id', null)
    .order('sort_weight', { ascending: true })
    .order('name', { ascending: true })
  if (error)
    throw error
  return (data ?? []) as VenueRow[]
}, { server: false })

const venues = computed(() => venueData.value ?? [])

interface VenuePick {
  id: string
  label: string
}

/**
 * ★ **名字不可以跟其餘標註一起丟進 `filter(Boolean)`**：`venue.name` 有 3 列是空字串
 * （政府 CSV 的事業名稱欄本來就空），`['', '台北市', null, null]` 過完只剩 `['台北市']`
 * ⇒ 標籤變成一個**裸的城市名**，連分隔符都沒有，看起來像選單裡混進了行政區。
 */
/*
 * 名字是主體：它為空時要**看得出是空的**不是悄悄消失 ⇒ 自己一段、不進 filter，真空了就印
 * 場所 id 讓人查得到。這條路徑直接查 `venue`（見檔頭），所以資料層的保證在這裡不能當理所當然。
 * 分隔用開眼式括號量詞串不用中點（`A · B · C` 是 Letterboxd 的簽名），形狀同 `venueSegment()`。
 */
const venuePicks = computed<VenuePick[]>(() => venues.value.map((v) => {
  const marks = [
    v.city ? `(${v.city})` : null,
    v.status === 'closed' ? '已歇業' : null,
    !v.selectable && v.status !== 'closed' ? '不在現行名冊' : null,
  ].filter(Boolean)
  return {
    id: v.id,
    label: [v.name.trim() || `（未命名場所 ${v.id}）`, ...marks].join(' '),
  }
}))

interface VenueGroup {
  alias: string
  count: number
  /** 人工對照表的建議。**只顯示，不預選。** */
  suggestionId: string | null
  suggestionName: string | null
  suggestionReason: string | null
}

const venueGroups = computed<VenueGroup[]>(() => {
  // ⚠️ 這裡數的是**來源筆數**不是展開後的：雙片連映拆出來的兩列共用同一次進場、同一個影城，
  //    數兩次會讓「林口威秀 115 筆」變成 120 筆，跟標題的「匯入 169 筆紀錄」對不起來。
  const seen = new Map<string, Set<string>>()
  for (const r of rows.value) {
    const sourceKey = r.importKey.replace(/#\d+$/, '')
    let set = seen.get(r.venueAlias)
    if (!set) {
      set = new Set<string>()
      seen.set(r.venueAlias, set)
    }
    set.add(sourceKey)
  }
  const count = new Map<string, number>([...seen].map(([alias, keys]) => [alias, keys.size]))
  return [...count.entries()]
    // ② 依筆數由多到少：第一列就是 115 筆，對完那一個工作量少掉 68%
    .sort((a, b) => b[1] - a[1])
    .map(([alias, n]) => {
      const hit = resolveVenueAlias(alias)
      return {
        alias,
        count: n,
        suggestionId: hit?.venueId ?? null,
        suggestionName: hit?.officialName ?? null,
        suggestionReason: hit?.reason ?? null,
      }
    })
})

/** alias → venue.id；`SKIP` 代表這批紀錄先不匯入。 */
const SKIP = '__skip__'
const venueChoice = reactive<Record<string, string>>({})

const VENUE_MAP_KEY = 'filmnote:import-venue-map'

/**
 * 對好的 15 組對照存起來，否則下次匯入要重對一次。
 * ⚠️ 存在 localStorage 是**過渡作法**：這張表不只匯入時需要（以後手打「林口威秀」也要），
 * 要不要獨立成 `/app/settings/venues` 或進資料庫**需要主 session 決定**。在那之前至少不要白對。
 */
function loadVenueMap() {
  if (import.meta.server)
    return
  try {
    const raw = localStorage.getItem(VENUE_MAP_KEY)
    if (!raw)
      return
    const saved = JSON.parse(raw) as Record<string, string>
    for (const [alias, id] of Object.entries(saved)) {
      // 只回填目前這份檔案真的用到、而且那個場所還在的對照
      if (id === SKIP || venues.value.some(v => v.id === id))
        venueChoice[alias] = id
    }
  }
  catch {
    // 無痕視窗或壞掉的舊值：記不住上次的對照不是錯誤，讓人重對就好
  }
}

function saveVenueMap() {
  if (import.meta.server)
    return
  try {
    localStorage.setItem(VENUE_MAP_KEY, JSON.stringify(venueChoice))
  }
  catch {}
}

watch([venues, venueGroups], () => {
  if (venues.value.length && venueGroups.value.length)
    loadVenueMap()
})

const venuesDone = computed(() => venueGroups.value.filter(g => !!venueChoice[g.alias]).length)
const venuesAllDone = computed(() => venueGroups.value.length > 0 && venuesDone.value === venueGroups.value.length)

// ─────────────────────────────────────────────────────────────────────────────
// 第 2 步：片名
// ─────────────────────────────────────────────────────────────────────────────
type MatchHow = 'library-exact' | 'override' | null

interface TitleGroup {
  title: string
  count: number
  /** 這個片名出現在哪幾天，讓人判斷得出是哪一部。 */
  dates: string[]
  filmId: string | null
  filmLabel: string | null
  how: MatchHow
  /** 使用者主動跳過。跳過的紀錄不匯入，而且**不是懲罰**。 */
  skipped: boolean
}

const titleGroups = ref<TitleGroup[]>([])
const matching = ref(false)

/**
 * 比對的兩條**確定**路徑，都不猜：① 片庫中文片名完全吻合（首次 50 部／72 筆）；
 * ② 人工對照表指定的 tmdb_id（20 個片名／30 筆）。沒有第三條——相近片名只當**建議**，
 * 要人自己按：`runtimeOf` 回 null 時片長交叉驗證會靜默跳過，而舊 log 沒有片長。
 */
async function runMatch() {
  matching.value = true
  try {
    const count = new Map<string, { n: number, dates: Set<string> }>()
    for (const r of rows.value) {
      const cur = count.get(r.title) ?? { n: 0, dates: new Set<string>() }
      cur.n += 1
      cur.dates.add(r.watchedOn)
      count.set(r.title, cur)
    }
    const titles = [...count.keys()]

    // ① 片庫中文片名完全吻合。一次查完，不要 134 次往返。
    const exact = new Map<string, { id: string, label: string }>()
    for (let i = 0; i < titles.length; i += 100) {
      const chunk = titles.slice(i, i + 100)
      const { data } = await supabase
        .from('film')
        .select('id,title_zh,title_original,release_year')
        .is('merged_into_film_id', null)
        .in('title_zh', chunk)
      for (const f of data ?? []) {
        if (!exact.has(f.title_zh))
          exact.set(f.title_zh, { id: f.id, label: labelOf(f) })
      }
    }

    // ② 人工對照表 → tmdb_id → 片庫
    const overrideByTitle = new Map<string, number>()
    for (const t of titles) {
      if (exact.has(t))
        continue
      const o = resolveTmdbOverride(t)
      if (o)
        overrideByTitle.set(t, o.tmdbId)
    }
    const byTmdb = new Map<number, { id: string, label: string }>()
    const tmdbIds = [...new Set(overrideByTitle.values())]
    for (let i = 0; i < tmdbIds.length; i += 100) {
      const { data } = await supabase
        .from('film')
        .select('id,title_zh,title_original,release_year,tmdb_id')
        .is('merged_into_film_id', null)
        .in('tmdb_id', tmdbIds.slice(i, i + 100))
      for (const f of data ?? []) {
        if (f.tmdb_id !== null && !byTmdb.has(f.tmdb_id))
          byTmdb.set(f.tmdb_id, { id: f.id, label: labelOf(f) })
      }
    }

    titleGroups.value = titles.map((title) => {
      const stat = count.get(title)!
      const hitExact = exact.get(title)
      const tmdbId = overrideByTitle.get(title)
      const hitOverride = tmdbId !== undefined ? byTmdb.get(tmdbId) : undefined
      const hit = hitExact ?? hitOverride
      return {
        title,
        count: stat.n,
        dates: [...stat.dates].sort(),
        filmId: hit?.id ?? null,
        filmLabel: hit?.label ?? null,
        how: hitExact ? 'library-exact' : hitOverride ? 'override' : null,
        skipped: false,
      }
    })
  }
  finally {
    matching.value = false
  }
}

// `title_original` 在 0010 之後可為 null（沒有原文片名與空字串是同一件事，見該 migration）
function labelOf(f: { title_zh: string, title_original: string | null, release_year: number | null }): string {
  const main = displayTitle(f.title_zh) || f.title_original || '未命名'
  return f.release_year ? `${main}（${f.release_year}）` : main
}

const HOW_LABEL: Record<'library-exact' | 'override', string> = {
  'library-exact': '片庫完全吻合',
  'override': '人工對照表',
}

const matched = computed(() => titleGroups.value.filter(g => g.filmId))
const undecided = computed(() => titleGroups.value.filter(g => !g.filmId && !g.skipped))
const skipped = computed(() => titleGroups.value.filter(g => !g.filmId && g.skipped))

/**
 * ⚠️ 未決定的卡片要分批：實測 33 張卡就是 4,614px 的頁面，而**首次匯入是 96 張**
 * （96/169 沒對到）——那會攤成一萬多 px。本專案已經有兩次「頁面一萬七千／兩萬兩千 px」
 * 的紀錄，都是同一個錯誤換一頁再犯。
 */
const UNDECIDED_PAGE = 12
const shownUndecided = ref(UNDECIDED_PAGE)
watch(titleGroups, () => {
  shownUndecided.value = UNDECIDED_PAGE
})
const visibleUndecided = computed(() => undecided.value.slice(0, shownUndecided.value))
const moreUndecided = computed(() => Math.max(0, undecided.value.length - shownUndecided.value))

// ── 未命中的三個選擇：選片庫既有的／新增為作品／先跳過 ──────────────────────
const openCard = ref<string | null>(null)
type CardMode = 'pick' | 'create' | 'tmdb'
const cardMode = ref<CardMode>('pick')

const { term: filmTerm, items: filmItems, loading: filmLoading, queried: filmQueried } = useFilmSearch()
const pickedFilm = ref<FilmOption | undefined>()
/** 就地新增作品的表單（不跳頁，見 `createFilm` 的註解）。 */
const newFilm = reactive({ titleZh: '', titleOriginal: '', country: '', releaseYear: null as number | null })

function openPick(g: TitleGroup) {
  openCard.value = g.title
  cardMode.value = 'pick'
  pickedFilm.value = undefined
  // 片名帶進搜尋框，少打一次
  filmTerm.value = g.title
}

/**
 * TMDB 查詢。⚠️ **這是給人看的工具不是自動比對**：舊 log 沒有片長，而片長交叉驗證是唯一
 * 擋得住「片名相近但根本是另一部片」的機制——實測《Fate stay night Heaven's feel》
 * 就是這樣配到系列第二部的。所以這裡只把候選攤開給人看，按下去的是人。
 */
/*
 * 端點回的 `existing` 是「片庫裡有沒有這個 tmdb_id」：有 ⇒ 一鍵選它；沒有 ⇒ 明說片庫還沒有，
 * 讓人改按「新增為作品」——**不要**假裝可以直接用一個 tmdb_id 建作品，那需要 service_role。
 */
interface TmdbHit {
  tmdbId: number
  title: string
  originalTitle: string
  releaseDate: string | null
  existing: { id: string, slug: string | null, title_zh: string } | null
}

const tmdbHits = ref<TmdbHit[] | null>(null)
const tmdbLoading = ref(false)
const tmdbError = ref<string | null>(null)

async function openTmdb(g: TitleGroup) {
  openCard.value = g.title
  cardMode.value = 'tmdb'
  tmdbHits.value = null
  tmdbError.value = null
  tmdbLoading.value = true
  try {
    const res = await $fetch<{ results: TmdbHit[] }>('/api/import/tmdb-search', {
      query: { q: g.title, year: yearOf(g) },
    })
    tmdbHits.value = res.results
  }
  catch (e) {
    tmdbError.value = errText(e)
  }
  finally {
    tmdbLoading.value = false
  }
}

/** 用這個片名最早那一場的年份當排序提示。台灣上映年與 TMDB 常差一年，所以只排序不過濾。 */
function yearOf(g: TitleGroup): number | undefined {
  const y = g.dates[0]?.slice(0, 4)
  return y ? Number(y) : undefined
}

function pickTmdbExisting(g: TitleGroup, hit: TmdbHit) {
  if (!hit.existing)
    return
  g.filmId = hit.existing.id
  g.filmLabel = `${displayTitle(hit.existing.title_zh)}（TMDB ${hit.tmdbId}）`
  g.how = null
  openCard.value = null
}

function openCreate(g: TitleGroup) {
  openCard.value = g.title
  cardMode.value = 'create'
  newFilm.titleZh = g.title
  newFilm.titleOriginal = ''
  newFilm.country = countryOf(g.title)
  newFilm.releaseYear = null
}

function confirmPick(g: TitleGroup) {
  const f = pickedFilm.value
  if (!f)
    return
  g.filmId = f.id
  g.filmLabel = filmLabel(f)
  g.how = null
  openCard.value = null
}

function skip(g: TitleGroup) {
  g.skipped = true
  openCard.value = null
}

function unskip(g: TitleGroup) {
  g.skipped = false
}

/** 來源資料的 `area` 欄就是國別，建作品時直接帶進去，不要讓人再打一次。 */
function countryOf(title: string): string {
  return rows.value.find(r => r.title === title)?.country ?? ''
}

/**
 * 「新增為作品」**不跳頁**（視覺稿明文要求）：就地展開 `/app/films/new` 的欄位，
 * 做完收合、繼續下一部。跳出去再回來會弄丟這一頁的進度——而這一頁的進度
 * 是使用者花了十幾分鐘一列一列點出來的。
 */
const creating = ref(false)

async function createFilm(g: TitleGroup) {
  if (!user.value)
    return
  creating.value = true
  try {
    // ⚠️ 這五個常數是 `film_insert_ugc` policy 的 with check 條件，
    //    少一個或填錯一個會被 RLS 擋掉，而錯誤訊息不會說是哪一欄。
    const { data, error } = await supabase
      .from('film')
      .insert({
        title_zh: newFilm.titleZh.trim(),
        title_original: newFilm.titleOriginal.trim(),
        country: newFilm.country.trim() || null,
        release_year: newFilm.releaseYear,
        title_zh_source: 'ugc',
        title_original_source: 'ugc',
        origin: 'ugc',
        visibility: 'private',
        review_state: 'pending',
        moderation_state: 'visible',
        created_by: user.value.sub,
      })
      .select('id,title_zh,title_original,release_year')
      .single()
    if (error)
      throw error
    g.filmId = data.id
    g.filmLabel = `${labelOf(data)}\u3000審核中`
    g.how = null
    openCard.value = null
    toast.add({ title: '建好了', description: '這部作品現在就能用，但要通過審核才會被別人看到。', color: 'success' })
  }
  catch (e) {
    toast.add({ title: '建不起來', description: (e as Error).message, color: 'error' })
  }
  finally {
    creating.value = false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 第 3 步：匯入前的對帳（不是慶祝畫面）
// ─────────────────────────────────────────────────────────────────────────────
/** 真的會被寫進去的紀錄：片名對到了、而且影城也對到了（沒有被跳過）。 */
const importable = computed(() => {
  const filmByTitle = new Map(titleGroups.value.filter(g => g.filmId).map(g => [g.title, g.filmId!]))
  return rows.value
    .filter(r => filmByTitle.has(r.title))
    .filter(r => venueChoice[r.venueAlias] && venueChoice[r.venueAlias] !== SKIP)
    .map(r => ({ row: r, filmId: filmByTitle.get(r.title)!, venueId: venueChoice[r.venueAlias]! }))
})

/** 已經在資料庫裡的 import_key。**冪等的證據，也是對帳的重點。** */
const existingKeys = ref<Set<string> | null>(null)

async function loadExistingKeys() {
  if (!user.value)
    return
  const { data } = await supabase
    .from('viewing_record')
    .select('import_key')
    .eq('user_id', user.value.sub)
    .not('import_key', 'is', null)
  existingKeys.value = new Set((data ?? []).map(r => r.import_key as string))
}

const toInsert = computed(() =>
  existingKeys.value === null ? [] : importable.value.filter(x => !existingKeys.value!.has(x.row.importKey)))

const alreadyThere = computed(() =>
  existingKeys.value === null ? 0 : importable.value.length - toInsert.value.length)

/**
 * 這一份檔案裡**不會**被寫入的筆數：片名還沒決定／被跳過，或影城選了「先跳過」。
 * 要跟「新增」「既有」擺在一起，否則三個數字加不回總數，使用者只能自己數。
 */
const skippedCount = computed(() => rows.value.length - importable.value.length)

/**
 * ★ **匯入格式漂移的警報**（踩雷 #134）。`import_key` 是原始列的 base64 ⇒ 冪等的前提是
 * **位元組完全相同**：上游改了匯出格式（多一個結尾逗號、欄位數變了）同一份資料的 key 就全變，
 * 而它**不會報錯**，只會安靜地把十二年的紀錄變成兩份。實測補一欄 ⇒ 104/169 個 key 全變。
 */
/*
 * 判準是「這個人**已經匯過東西**，但這份檔案幾乎對不上」。第一次匯入不該示警——
 * 那時全部都是新的才正常。
 */
const DRIFT_MIN_PRIOR = 10
const driftWarning = computed(() => {
  const prior = existingKeys.value?.size ?? 0
  if (prior < DRIFT_MIN_PRIOR || !toInsert.value.length)
    return null
  // 對得上的比例：以「這份檔案可匯入的筆數」與「已經匯過的筆數」取小的那個當分母，
  // 因為使用者可能匯的是一份比較短的檔案。
  const denom = Math.min(prior, importable.value.length)
  if (denom === 0 || alreadyThere.value * 2 >= denom)
    return null
  return {
    prior,
    matched: alreadyThere.value,
    adding: toInsert.value.length,
  }
})

const summary = computed(() => {
  const films = new Set(importable.value.map(x => x.filmId))
  const withCost = importable.value.filter(x => x.row.amount !== null)
  const total = withCost.reduce((s, x) => s + (x.row.amount ?? 0), 0)
  return {
    records: importable.value.length,
    films: films.size,
    withCost: withCost.length,
    total,
  }
})

/** 匯入的紀錄要不要公開。DB 預設是 public，但一次匯入十幾年份的歷史值得問一次。 */
const importPublic = ref(true)

async function goReview() {
  step.value = 'review'
  existingKeys.value = null
  await loadExistingKeys()
}

// ─────────────────────────────────────────────────────────────────────────────
// 寫入
// ─────────────────────────────────────────────────────────────────────────────
const importing = ref(false)
const result = ref<{ inserted: number, costs: number, skipped: number } | null>(null)

/**
 * 冪等靠 `unique (user_id, import_key)`，但**不用 upsert**：那個唯一索引是 partial，
 * PostgREST 的 `on_conflict=` 推不出 partial index 的述詞會直接報錯。
 * 改成「先讀已存在的鍵、只寫沒有的」還多一個好處：**第 3 步就能先說「這次會新增幾筆」**。
 */
async function runImport() {
  if (!user.value || !toInsert.value.length)
    return
  importing.value = true
  try {
    const payload = toInsert.value.map(x => ({
      user_id: user.value!.sub,
      film_id: x.filmId,
      venue_id: x.venueId,
      watched_on: x.row.watchedOn,
      watched_time: x.row.watchedTime,
      tz: 'Asia/Taipei',
      ticket_count: x.row.ticketCount,
      hall_label: x.row.hallLabel,
      format_code: x.row.formatCode,
      format_note: x.row.formatNote,
      memo: x.row.memo,
      import_key: x.row.importKey,
      visibility: importPublic.value ? ('public' as const) : ('private' as const),
    }))

    const inserted: { id: string, import_key: string | null }[] = []
    for (let i = 0; i < payload.length; i += 50) {
      const { data, error } = await supabase
        .from('viewing_record')
        .insert(payload.slice(i, i + 50))
        .select('id,import_key')
      if (error)
        throw error
      inserted.push(...(data ?? []))
    }

    // 票價。**null 代表這一筆不記金額**（雙片連映的第二筆），
    // 那一列連建都不建——記 0 會讓「免費」與「同一次付款的第二部」混為一談。
    const amountByKey = new Map(toInsert.value.map(x => [x.row.importKey, x.row.amount]))
    const costs = inserted
      .map(r => ({ record_id: r.id, amount: amountByKey.get(r.import_key ?? '') ?? null }))
      .filter((c): c is { record_id: string, amount: number } => c.amount !== null)
      .map(c => ({ record_id: c.record_id, amount: c.amount, currency: 'TWD' }))

    for (let i = 0; i < costs.length; i += 50) {
      const { error } = await supabase.from('viewing_record_cost').insert(costs.slice(i, i + 50))
      if (error)
        throw error
    }

    result.value = { inserted: inserted.length, costs: costs.length, skipped: alreadyThere.value }
    step.value = 'done'
  }
  catch (e) {
    toast.add({ title: '匯入中斷', description: (e as Error).message, color: 'error' })
  }
  finally {
    importing.value = false
  }
}

const moneyText = (n: number) => `NT$${Math.round(n).toLocaleString('zh-Hant-TW')}`
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-8">
    <!--
      ── 非本人：整頁不給表單 ──────────────────────────────
      ⚠️ 這是 UI 不是防線（防線在兩支端點的 assertImportOwner）。
      文案刻意不說「你沒有權限」——這不是權限問題，是這個工具只為一個帳號存在。
    -->
    <template v-if="canImportKnown && !canImport">
      <h1 class="text-2xl font-bold tracking-tight">
        匯入舊紀錄
      </h1>
      <p class="mt-2 text-muted">
        這是站主搬遷自己舊資料用的一次性工具，沒有對外開放。
        要一筆一筆記，用<NuxtLink to="/app/records/new" class="text-primary hover:underline">記一場</NuxtLink>；
        要一次補很多筆，
        <NuxtLink to="/legal/dmca" class="text-primary hover:underline">從受理窗口</NuxtLink>跟我說一聲。
      </p>
    </template>

    <!-- ── 第 0 步：讀檔 ──────────────────────────────────── -->
    <!-- ⚠️ `canImport &&` 不可省：沒有它，問到答案之前非本人也會先看到表單。 -->
    <template v-else-if="canImport && step === 'upload'">
      <h1 class="text-2xl font-bold tracking-tight">
        匯入舊紀錄
      </h1>
      <p class="mt-2 text-muted">
        把舊 log 專案匯出的 JSON 丟進來。系統會先幫你把影城與片名對到片庫，
        對不到的再由你決定，最後才寫進去——寫進去之前你都可以反悔。
      </p>

      <div class="mt-6 rounded-sm border border-default px-5 py-5">
        <label class="block text-sm font-semibold text-highlighted" for="import-file">選一個檔案</label>
        <input
          id="import-file"
          type="file"
          accept="application/json,text/csv,.json,.csv,.txt"
          class="mt-2 block w-full text-sm file:mr-3 file:cursor-pointer file:rounded-sm file:border file:border-default file:bg-elevated file:px-3 file:py-1.5 file:text-sm"
          @change="onFileChange"
        >

        <p class="mt-5 text-sm font-semibold text-highlighted">
          或直接貼上內容
        </p>
        <UTextarea
          v-model="pastedText"
          :rows="4"
          class="mt-2 w-full"
          placeholder="[{&quot;id&quot;:&quot;…&quot;,&quot;date&quot;:&quot;…&quot;,&quot;title&quot;:&quot;…&quot;, …}]"
        />
        <UButton class="mt-3" :disabled="!pastedText.trim()" :loading="parsing" @click="onPaste">
          讀進來
        </UButton>

        <UAlert v-if="parseError" class="mt-4" color="error" variant="subtle" :description="parseError" />
      </div>

      <p class="mt-4 text-xs leading-relaxed text-muted">
        JSON 與 CSV 都吃。分流看的是內容不是副檔名——CSV 由伺服器端照 RFC 4180 剖析，
        因為<strong>用錯的模式解析會靜默錯位</strong>（有一部片的原文片名裡就含逗號而且沒有引號包住），
        而錯位在畫面上只看得出「片名怪怪的」。解析不出來的列會全部列給你看，不會安靜地少匯入。
      </p>
    </template>

    <!-- ── 第 1 步：影城 ──────────────────────────────────── -->
    <template v-else-if="step === 'venues'">
      <div class="flex items-baseline justify-between gap-4">
        <h1 class="text-2xl font-bold tracking-tight tabular-nums">
          {{ `匯入 ${sourceCount} 筆紀錄` }}
        </h1>
        <span class="shrink-0 text-sm text-muted">第 1 步／共 2 步</span>
      </div>
      <p class="mt-3">
        先把你的影城名稱對到官方名稱。
      </p>
      <p class="text-sm text-muted">
        {{ `你用了 ${venueGroups.length} 個影城名稱。對好一次，${sourceCount} 筆就都對好了。` }}
      </p>
      <p v-if="headerSkipped" class="text-sm text-muted">
        （檔案第一列是標題列，已略過——所以來源筆數比檔案行數少 {{ headerSkipped }} 行。）
      </p>

      <UProgress class="mt-4" :model-value="venuesDone" :max="Math.max(venueGroups.length, 1)" />
      <p class="mt-1 text-sm text-muted tabular-nums">
        {{ `已對好 ${venuesDone}／${venueGroups.length}` }}
      </p>

      <ul class="mt-4">
        <li
          v-for="g in venueGroups"
          :key="g.alias"
          class="grid grid-cols-1 items-center gap-x-4 gap-y-2 border-b border-default py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_300px]"
        >
          <span class="text-highlighted">{{ g.alias }}</span>
          <span class="whitespace-nowrap text-sm text-muted tabular-nums">{{ `${g.count} 筆` }}</span>
          <div>
            <USelect
              v-model="venueChoice[g.alias]"
              :items="[...venuePicks.map(v => ({ label: v.label, value: v.id })), { label: '先跳過（這批紀錄不匯入）', value: SKIP }]"
              placeholder="選擇…"
              class="w-full"
              @update:model-value="saveVenueMap()"
            />
            <!--
              ③ 建議只以文字顯示，**不預選**。實測模糊比對會把「林口威秀」
                 綁到「樹林秀泰影城」，而錯配比不配更糟。
            -->
            <p v-if="g.suggestionName && !venueChoice[g.alias]" class="mt-1 text-xs text-muted">
              {{ `建議：${g.suggestionName}（${g.suggestionReason}）` }}
            </p>
          </div>
        </li>
      </ul>

      <!--
        ★ US-58：「看到匯入時哪些片沒比對到」。**全部列出來，不截斷。**
          被擋下來的列是使用者唯一會知道「這幾筆沒進來」的管道。
          預設展開前三筆、其餘可展開——摺到看不見等於安靜地少匯入。
      -->
      <div v-if="issues.length" class="mt-5 rounded-sm border border-error/40 px-4 py-3">
        <p class="font-semibold text-highlighted tabular-nums">
          {{ `有 ${issues.length} 列沒有讀進來` }}
        </p>
        <p class="mt-0.5 text-sm text-muted">
          這些不會被匯入。看一下是不是重要的紀錄——如果是，修好原始檔再匯一次，已經匯進去的不會重複。
        </p>
        <ul class="mt-2.5 space-y-2">
          <li v-for="(i, n) in issues.slice(0, shownIssues)" :key="n" class="text-sm">
            <span class="block text-highlighted">{{ metaLine(i.where, i.reason) }}</span>
            <span class="block text-muted">{{ i.detail }}</span>
            <span class="mt-0.5 block break-all text-xs text-dimmed">{{ i.raw.slice(0, 160) }}</span>
          </li>
        </ul>
        <UButton
          v-if="issues.length > shownIssues"
          class="mt-2"
          size="xs"
          variant="ghost"
          color="neutral"
          @click="shownIssues = issues.length"
        >
          {{ `全部展開（還有 ${issues.length - shownIssues} 列）` }}
        </UButton>
      </div>

      <div class="mt-6 flex flex-wrap gap-3">
        <UButton :disabled="!venuesAllDone" @click="step = 'titles'; runMatch()">
          下一步
        </UButton>
        <UButton variant="ghost" color="neutral" @click="step = 'upload'">
          換一個檔案
        </UButton>
      </div>
      <p v-if="!venuesAllDone" class="mt-2 text-sm text-muted">
        每一個影城名稱都要有答案才能繼續——包括「先跳過」。不選比選錯好，但沉默不算答案。
      </p>
    </template>

    <!-- ── 第 2 步：片名 ──────────────────────────────────── -->
    <template v-else-if="step === 'titles'">
      <div class="flex items-baseline justify-between gap-4">
        <h1 class="text-2xl font-bold tracking-tight tabular-nums">
          {{ `匯入 ${sourceCount} 筆紀錄` }}
        </h1>
        <span class="shrink-0 text-sm text-muted">第 2 步／共 2 步</span>
      </div>

      <p v-if="matching" class="mt-4 text-muted">
        正在跟片庫對片名…
      </p>

      <template v-else>
        <p class="mt-3 tabular-nums">
          {{ `${titleGroups.length} 個片名裡，${matched.length} 個我們認得，${undecided.length} 個要你決定。` }}
        </p>

        <!-- ④ 把已經對好的摺起來：87% 不需要人做任何決定 -->
        <details v-if="matched.length" class="mt-4 rounded-sm border border-default bg-elevated/50 px-4 py-3">
          <summary class="cursor-pointer font-semibold text-highlighted">
            {{ `已經對好的 ${matched.length} 部` }}
            <span class="ml-2 text-xs font-normal text-muted">不用看，除非你想檢查</span>
          </summary>
          <div class="mt-3 overflow-x-auto">
            <table class="w-full min-w-[32rem] text-sm">
              <thead>
                <tr class="border-b border-default text-left text-muted">
                  <th class="py-1.5 pr-3 font-semibold">
                    來源片名
                  </th>
                  <th class="py-1.5 pr-3 font-semibold">
                    對到
                  </th>
                  <th class="py-1.5 font-semibold">
                    怎麼對到的
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="g in matched" :key="g.title" class="border-b border-default last:border-b-0">
                  <td class="py-1.5 pr-3 text-highlighted">
                    {{ g.title }}
                  </td>
                  <td class="py-1.5 pr-3 text-highlighted">
                    {{ g.filmLabel }}
                  </td>
                  <td class="py-1.5">
                    <UBadge v-if="g.how" size="sm" variant="outline" :color="g.how === 'library-exact' ? 'primary' : 'neutral'">
                      {{ HOW_LABEL[g.how] }}
                    </UBadge>
                    <UBadge v-else size="sm" variant="outline" color="neutral">
                      你選的
                    </UBadge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>

        <h2 v-if="undecided.length" class="mt-6 text-base font-semibold text-highlighted tabular-nums">
          {{ `要你決定的 ${undecided.length} 部` }}
        </h2>

        <div v-for="g in visibleUndecided" :key="g.title" class="mt-2.5 rounded-sm border border-default px-4 py-3">
          <p class="font-semibold text-highlighted">
            {{ g.title }}
          </p>
          <p class="mt-0.5 text-sm text-muted tabular-nums">
            {{ metaLine(`${g.count} 筆`, g.dates.slice(0, 3).join('、') + (g.dates.length > 3 ? ' 等' : '')) }}
          </p>

          <div class="mt-2.5 flex flex-wrap gap-2">
            <UButton size="xs" variant="outline" color="neutral" @click="openPick(g)">
              選片庫既有的
            </UButton>
            <UButton size="xs" variant="outline" color="neutral" @click="openTmdb(g)">
              上 TMDB 找找看
            </UButton>
            <UButton size="xs" @click="openCreate(g)">
              新增為作品
            </UButton>
            <UButton size="xs" variant="ghost" color="neutral" @click="skip(g)">
              先跳過
            </UButton>
          </div>

          <!-- 選片庫既有的 -->
          <div v-if="openCard === g.title && cardMode === 'pick'" class="mt-3 border-t border-default pt-3">
            <USelectMenu
              v-model="pickedFilm"
              v-model:search-term="filmTerm"
              :items="filmItems"
              :loading="filmLoading"
              ignore-filter
              label-key="title_zh"
              placeholder="輸入片名（中文或原文）"
              class="w-full"
            >
              <template #item-label="{ item }">
                {{ filmLabel(item) }}
              </template>
              <template #empty>
                <div class="px-2 py-3 text-sm">
                  <p v-if="filmLoading">
                    搜尋中…
                  </p>
                  <p v-else-if="!filmQueried">
                    輸入片名開始搜尋
                  </p>
                  <p v-else>
                    找不到「{{ filmQueried }}」。可以改按「新增為作品」。
                  </p>
                </div>
              </template>
            </USelectMenu>
            <div class="mt-2.5 flex gap-2">
              <UButton size="xs" :disabled="!pickedFilm" @click="confirmPick(g)">
                就是這一部
              </UButton>
              <UButton size="xs" variant="ghost" color="neutral" @click="openCard = null">
                算了
              </UButton>
            </div>
          </div>

          <!-- TMDB：只是把候選攤開給人看，不自動比對 -->
          <div v-if="openCard === g.title && cardMode === 'tmdb'" class="mt-3 border-t border-default pt-3">
            <p v-if="tmdbLoading" class="text-sm text-muted">
              查 TMDB 中…
            </p>
            <p v-else-if="tmdbError" class="text-sm text-error">
              {{ tmdbError }}
            </p>
            <p v-else-if="!tmdbHits?.length" class="text-sm text-muted">
              TMDB 上也查不到「{{ g.title }}」。可以改按「新增為作品」。
            </p>
            <ul v-else class="space-y-2">
              <li v-for="h in tmdbHits" :key="h.tmdbId" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span class="text-highlighted">{{ metaLine(h.title, h.originalTitle !== h.title ? h.originalTitle : null, h.releaseDate?.slice(0, 4)) }}</span>
                <UButton v-if="h.existing" size="xs" @click="pickTmdbExisting(g, h)">
                  片庫裡有，就選這一部
                </UButton>
                <span v-else class="text-xs text-muted">片庫還沒有這一部</span>
              </li>
            </ul>
            <UButton size="xs" variant="ghost" color="neutral" class="mt-2.5" @click="openCard = null">
              關掉
            </UButton>
          </div>

          <!-- 新增為作品：就地展開，不跳頁 -->
          <div v-if="openCard === g.title && cardMode === 'create'" class="mt-3 space-y-3 border-t border-default pt-3">
            <UFormField label="中文片名" required>
              <UInput v-model="newFilm.titleZh" class="w-full" />
            </UFormField>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <UFormField label="原文片名" hint="選填">
                <UInput v-model="newFilm.titleOriginal" class="w-full" />
              </UFormField>
              <UFormField label="國別" hint="選填">
                <UInput v-model="newFilm.country" class="w-full" />
              </UFormField>
              <UFormField label="年份" hint="選填">
                <UInput v-model="newFilm.releaseYear" type="number" class="w-full" />
              </UFormField>
            </div>
            <p class="text-xs text-muted">
              建好之後你馬上就能用它記錄，但要通過審核才會被別人看到。
            </p>
            <div class="flex gap-2">
              <UButton size="xs" :loading="creating" :disabled="!newFilm.titleZh.trim()" @click="createFilm(g)">
                建立
              </UButton>
              <UButton size="xs" variant="ghost" color="neutral" @click="openCard = null">
                算了
              </UButton>
            </div>
          </div>
        </div>

        <div v-if="moreUndecided" class="mt-4 flex justify-center">
          <UButton variant="soft" color="neutral" @click="shownUndecided += UNDECIDED_PAGE">
            {{ `再顯示 ${Math.min(UNDECIDED_PAGE, moreUndecided)} 部（還有 ${moreUndecided} 部）` }}
          </UButton>
        </div>

        <!-- 跳過的：必須看得見，而且拿得回來。跳過不是懲罰。 -->
        <details v-if="skipped.length" class="mt-5 rounded-sm border border-default bg-elevated/50 px-4 py-3">
          <summary class="cursor-pointer text-sm font-semibold text-highlighted">
            {{ `先跳過的 ${skipped.length} 部（這些紀錄不會被匯入）` }}
          </summary>
          <ul class="mt-2 space-y-1.5">
            <li v-for="g in skipped" :key="g.title" class="flex flex-wrap items-center gap-x-3 text-sm">
              <span class="text-highlighted">{{ g.title }}</span>
              <span class="text-muted tabular-nums">{{ `${g.count} 筆` }}</span>
              <UButton size="xs" variant="ghost" color="neutral" @click="unskip(g)">
                拿回來決定
              </UButton>
            </li>
          </ul>
        </details>

        <div class="mt-6 flex flex-wrap gap-3">
          <UButton @click="goReview">
            看匯入結果
          </UButton>
          <UButton variant="ghost" color="neutral" @click="step = 'venues'">
            上一步
          </UButton>
        </div>
        <p v-if="undecided.length" class="mt-2 text-sm text-muted tabular-nums">
          {{ `還有 ${undecided.length} 個片名沒決定，它們的紀錄這次不會被匯入。之後再匯一次同一份檔案，已經匯進去的不會重複。` }}
        </p>
      </template>
    </template>

    <!-- ── 第 3 步：對帳 ──────────────────────────────────── -->
    <template v-else-if="step === 'review'">
      <h1 class="text-2xl font-bold tracking-tight">
        匯入前對一下帳
      </h1>

      <div class="mt-5 grid grid-cols-2 overflow-hidden rounded-sm border border-default sm:grid-cols-4">
        <div class="border-b border-r border-default px-4 py-3 sm:border-b-0">
          <p class="text-sm text-muted">
            紀錄
          </p>
          <p class="text-2xl font-semibold text-highlighted tabular-nums">
            {{ summary.records }}
          </p>
        </div>
        <div class="border-b border-default px-4 py-3 sm:border-b-0 sm:border-r">
          <p class="text-sm text-muted">
            相異作品
          </p>
          <p class="text-2xl font-semibold text-highlighted tabular-nums">
            {{ summary.films }}
          </p>
        </div>
        <div class="border-r border-default px-4 py-3">
          <p class="text-sm text-muted">
            有記票價
          </p>
          <p class="text-2xl font-semibold text-highlighted tabular-nums">
            {{ summary.withCost }}
          </p>
        </div>
        <div class="px-4 py-3">
          <p class="text-sm text-muted">
            總金額
          </p>
          <p class="text-2xl font-semibold text-highlighted tabular-nums">
            {{ moneyText(summary.total) }}
          </p>
        </div>
      </div>

      <!-- 來源筆數與結果筆數不一樣是常態，而且必須解釋 -->
      <UAlert
        v-if="rows.length !== sourceCount"
        class="mt-4"
        color="neutral"
        variant="subtle"
        :description="`${sourceCount} 筆來源展開成 ${rows.length} 筆紀錄——多出來的 ${rows.length - sourceCount} 筆是雙片連映，一張票兩部片。票價全額記在第一筆，第二筆不記金額，所以「有記票價」會比「紀錄」少。如果這個數字跟你預期的不一樣，現在還可以回去改。`"
      />

      <!--
        ★ 硬約束：**任何寫入之前**都要先把「既有／新增／略過」三個數字攤在人眼前。
          不是列一份清單讓人自己數——那正是踩雷 #134 唯一會在事前被發現的地方。
      -->
      <div class="mt-4 rounded-sm border border-default px-4 py-3">
        <p v-if="existingKeys === null" class="text-sm text-muted">
          正在比對你已經有的紀錄…
        </p>
        <template v-else>
          <div class="grid grid-cols-3 gap-3 text-center">
            <div>
              <p class="text-sm text-muted">
                已經有了
              </p>
              <p class="text-xl font-semibold text-highlighted tabular-nums">
                {{ alreadyThere }}
              </p>
            </div>
            <div>
              <p class="text-sm text-muted">
                本次新增
              </p>
              <p class="text-xl font-semibold text-highlighted tabular-nums">
                {{ toInsert.length }}
              </p>
            </div>
            <div>
              <p class="text-sm text-muted">
                本次略過
              </p>
              <p class="text-xl font-semibold text-highlighted tabular-nums">
                {{ skippedCount }}
              </p>
            </div>
          </div>
          <p class="mt-2 text-sm text-muted tabular-nums">
            {{ `${alreadyThere} + ${toInsert.length} + ${skippedCount} = ${rows.length} 筆。略過的是片名還沒決定、或影城選了「先跳過」的那些。` }}
          </p>
        </template>
      </div>

      <!--
        ⚠️ 格式漂移警報（踩雷 #134）。這個錯**不會報錯**，只會安靜地把十二年的
           紀錄變成兩份，而且觸發條件（上游改匯出格式）完全在我們控制之外。
      -->
      <UAlert
        v-if="driftWarning"
        class="mt-4"
        color="error"
        variant="subtle"
        title="等一下——這份檔案跟你已經匯過的幾乎對不上"
        :description="`你的紀錄裡已經有 ${driftWarning.prior} 筆是匯入進來的，但這份檔案裡只有 ${driftWarning.matched} 筆對得上，其餘 ${driftWarning.adding} 筆會被當成全新的紀錄寫進去。這通常代表匯出格式變了（例如欄位數、結尾逗號或空白不一樣），而不是你真的多了這麼多場。繼續匯入會得到兩份重複的紀錄。先確認這是你要的再按。`"
      />

      <USwitch v-model="importPublic" class="mt-4" label="匯入的紀錄設為公開" />
      <p class="mt-1 text-sm text-muted">
        {{ importPublic ? '這些紀錄會出現在你的公開個人頁上（票價是否顯示另外由設定決定）。' : '這些紀錄只有你看得到，之後可以逐筆改。' }}
      </p>

      <!--
        ★ US-58：「看到匯入時哪些片沒比對到」。**全部列出來，不截斷。**
          被擋下來的列是使用者唯一會知道「這幾筆沒進來」的管道。
          預設展開前三筆、其餘可展開——摺到看不見等於安靜地少匯入。
      -->
      <div v-if="issues.length" class="mt-5 rounded-sm border border-error/40 px-4 py-3">
        <p class="font-semibold text-highlighted tabular-nums">
          {{ `有 ${issues.length} 列沒有讀進來` }}
        </p>
        <p class="mt-0.5 text-sm text-muted">
          這些不會被匯入。看一下是不是重要的紀錄——如果是，修好原始檔再匯一次，已經匯進去的不會重複。
        </p>
        <ul class="mt-2.5 space-y-2">
          <li v-for="(i, n) in issues.slice(0, shownIssues)" :key="n" class="text-sm">
            <span class="block text-highlighted">{{ metaLine(i.where, i.reason) }}</span>
            <span class="block text-muted">{{ i.detail }}</span>
            <span class="mt-0.5 block break-all text-xs text-dimmed">{{ i.raw.slice(0, 160) }}</span>
          </li>
        </ul>
        <UButton
          v-if="issues.length > shownIssues"
          class="mt-2"
          size="xs"
          variant="ghost"
          color="neutral"
          @click="shownIssues = issues.length"
        >
          {{ `全部展開（還有 ${issues.length - shownIssues} 列）` }}
        </UButton>
      </div>

      <div class="mt-6 flex flex-wrap gap-3">
        <UButton :loading="importing" :disabled="!toInsert.length" @click="runImport">
          {{ `匯入這 ${toInsert.length} 筆` }}
        </UButton>
        <UButton variant="ghost" color="neutral" @click="step = 'titles'">
          上一步
        </UButton>
      </div>
    </template>

    <!-- ── 完成 ──────────────────────────────────────────── -->
    <template v-else-if="step === 'done' && result">
      <h1 class="text-2xl font-bold tracking-tight tabular-nums">
        {{ `寫進去了 ${result.inserted} 筆` }}
      </h1>
      <p class="mt-2 text-muted tabular-nums">
        {{ metaLine(`票價 ${result.costs} 筆`, result.skipped ? `另有 ${result.skipped} 筆本來就在，沒有重複寫入` : null) }}
      </p>
      <div class="mt-6 flex flex-wrap gap-3">
        <UButton to="/app/records">
          去個人紀錄管理
        </UButton>
        <UButton to="/app" variant="ghost" color="neutral">
          回儀表板
        </UButton>
      </div>
    </template>
  </div>
</template>
