/**
 * 舊 log 專案（mechakucha-api `/my-log/movie`）的觀影紀錄正規化。
 * 刻意只放純函式：時區換算與版本對照是整個匯入裡最容易錯的兩件事，
 * 和 I/O 分開才測得動（tests/import.test.ts）。
 */

import { normalizeCountry } from '#pipeline/normalize/country'

/** 上游一列的原始欄位。169 筆實測全部具備這些欄位且皆非 null。 */
export interface MyLogItem {
  /** 原始 CSV 列的 base64。天生就是確定性鍵，直接當 import_key。 */
  id: string
  memo: string
  /** ISO 字串。**存的是 UTC，但代表的是台北牆上時間**，見 toTaipeiWallClock。 */
  date: string
  title: string
  /** 國別，如「日本」「美國」。 */
  area: string
  /** 放映版本，如「2D」「IMAX 3D」「4DX 極爆」。 */
  version: string
  /** 影廳的口語簡稱，需經 venue-aliases 對照。 */
  theater: string
  price: number
  fee: number
  tickets: number
  discount: number
  cost: number
}

export interface TaipeiWallClock {
  /** `YYYY-MM-DD`，對應 viewing_record.watched_on。 */
  watchedOn: string
  /** `HH:MM`，對應 viewing_record.watched_time。 */
  watchedTime: string
}

/**
 * 台北牆上時間。上游的 `date` 是 UTC 瞬間但代表**台北牆上時間**（169 筆實測全部吻合，
 * 見 `parseRawWallClock` 的交叉驗證）。schema 存 date + time 就是為了讓貢獻圖與時段
 * 熱力圖零換算 ⇒ **必須先換到台北時區再取日期**。
 */
// 方向與直覺相反：台北 08:00 之後的場次 UTC 日期相同，真正會跑掉的是**午夜場**
// （台北 00:00 的 UTC 是前一天 16:00）——169 筆裡有 5 筆，不換算會全部退到前一天。
// 用 Intl 而非硬寫 +8：台灣 1979 年以前實施過日光節約時間，硬寫會靜默地錯。
const TAIPEI_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function toTaipeiWallClock(iso: string): TaipeiWallClock {
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime()))
    throw new Error(`無法解析的時間字串：${iso}`)

  const parts: Record<string, string> = {}
  for (const p of TAIPEI_PARTS.formatToParts(instant))
    parts[p.type] = p.value

  return {
    watchedOn: `${parts.year}-${parts.month}-${parts.day}`,
    watchedTime: `${parts.hour}:${parts.minute}`,
  }
}

/**
 * base64 的 id 解回原始 CSV 列，供交叉驗證與人工核對。
 * ⚠️ 刻意不用 `Buffer`：本模組同時被 CLI 與瀏覽器載入，而 `node:buffer` 會讓整個模組
 * 在瀏覽器裡載不起來——dev 是整條路由 500，**build 卻是 exit 0 並把它編成空物件**
 * （靜態檢查全綠、建置成功、功能靜默消失）。
 */
// `atob` 回 latin1 字串，中文必須再經 TextDecoder；等價性已對 169 個真實 import key
// 逐一比對（169/169 相同）。
export function decodeImportKey(id: string): string {
  const binary = atob(id)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * 自解碼後的原始 CSV 列取出牆上時間，用來交叉驗證 `date` 欄。解析不出來回 null。
 * 實測兩種寫法（166 / 3 筆）：`2026/07/26 (週日) 16:00`、`2025/7/4 下午 22:10:00`。
 * ⚠️ 「下午」在第二種裡是**裝飾**——三筆的時針是 21、22、20，已是 24 小時制，
 * 再加 12 會溢位 ⇒ 一律忽略上午／下午標記。
 */
const RAW_WALL_CLOCK_RE
  = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(?:\([^)]*\)\s*)?(?:(?:上午|下午)\s*)?(\d{1,2}):(\d{2})/

export function parseRawWallClock(rawLine: string): TaipeiWallClock | null {
  const head = rawLine.split(',')[0] ?? ''
  const m = RAW_WALL_CLOCK_RE.exec(head)
  if (!m)
    return null

  const [, year, month, day, hour, minute] = m as unknown as string[]
  return {
    watchedOn: `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`,
    watchedTime: `${hour!.padStart(2, '0')}:${minute}`,
  }
}

export interface FormatMapping {
  /** viewing_record.format_code，值域為 screening_format.code。 */
  code: string
  /** viewing_record.format_note，沒有額外資訊時為 null。 */
  note: string | null
  /**
   * viewing_record.hall_label。⚠️ 2026-09-20 起對照表**沒有任何一列會填這裡**
   * （TITAN/MAPPA 已升格成獨立版本，見下方）。欄位留著是因為下游仍然寫這一欄，
   * 但**不要**再把它當成「歸不進既有版本就塞這裡」的出口——那正是被推翻的推理。
   */
  hall: string | null
}

/**
 * 放映版本 → screening_format.code。逐字對照而非樣式比對：實測只有 10 種相異寫法，
 * 全部列出來比正規表示式好讀，也讓日後冒出的新寫法**明確報錯**而非靜默歸到「其他」。
 */
// ── TITAN / MAPPA：前一輪的決定已於 2026-09-20 被推翻 ──
// 舊結論（**不刪，留著是為了擋住重新推導**）：「它們是威秀的廳型品牌而非放映格式，
// 所以進 hall_label、format_code 記 other。」
// 新理由：判準是**使用者買票時選的是哪一種版本**，不是它技術上算不算一套規格——照後者
// 4DX 與 Dolby Cinema 同樣只是品牌名。歸進 other 的代價實測過：那 5 筆在分布圖上會併成
// 「其他」一桶（RPC 是 `group by coalesce(r.format_code,'other')`），兩個版本看不出來。
// ⇒ 各自成為 screening_format 的成員，且 **hall_label 留空**（既有慣例：版本已指明是哪個
//   廳時廳別欄留空，實測 imax 9 + 4dx 30 + dolby 1 共 39 筆全是 null；不留空會印成
//   「林口…威秀影城 (MAPPA) MAPPA」）。
// ⚠️ 這件事有兩半：既有 5 筆由 `0016_screening_format_mappa_titan.sql` 就地改寫，這張表
//    管的是之後匯入的資料。改任一邊的人請連同另一邊一起看，只做一半下次一定漂回去。
const FORMAT_TABLE: Record<string, FormatMapping> = {
  '2D': { code: 'digital', note: null, hall: null },
  '2D (ATMOS)': { code: 'digital', note: 'ATMOS', hall: null },
  'IMAX': { code: 'imax', note: null, hall: null },
  'IMAX 3D': { code: 'imax', note: '3D', hall: null },
  '4DX': { code: '4dx', note: null, hall: null },
  '4DX 3D': { code: '4dx', note: '3D', hall: null },
  '4DX 極爆': { code: '4dx', note: '極爆', hall: null },
  'Dolby Cinema': { code: 'dolby', note: null, hall: null },
  'TITAN': { code: 'titan', note: null, hall: null },
  'MAPPA': { code: 'mappa', note: null, hall: null },
}

/** 未知的版本寫法回傳 null，由呼叫端列進報告，不要自行猜測。 */
export function mapScreeningFormat(version: string): FormatMapping | null {
  return FORMAT_TABLE[version.trim()] ?? null
}

/** 已知的版本寫法清單，供測試斷言涵蓋率。 */
export function knownFormats(): string[] {
  return Object.keys(FORMAT_TABLE)
}

/** 正規化後的一筆紀錄，欄位已對齊 viewing_record 與 viewing_record_cost。 */
export interface NormalizedRecord {
  /** = 上游的 id 原字串。unique (user_id, import_key) 保證重跑冪等。 */
  importKey: string
  /** 解碼後的原始 CSV 列，出問題時供人工核對。 */
  rawLine: string
  watchedOn: string
  watchedTime: string
  title: string
  country: string
  /** 影廳的口語簡稱，尚未對照。 */
  venueAlias: string
  formatCode: string
  formatNote: string | null
  hallLabel: string | null
  ticketCount: number
  /**
   * viewing_record_cost.amount。直接採用上游的 `cost` 不自行重算：實測 19 筆對不上
   * 「price×tickets+fee−discount」，因為 `fee` 是**每張**手續費（`240,20,2,0,520`
   * → 240×2+20×2）。`cost` 也是唯一能同時解釋兌換票與折扣票的欄位。
   */
  // **null 代表「這一筆不記金額」不是 0 元**：雙片連映拆出的第二筆屬於同一次付款，
  // 票價全額記在第一筆，連 viewing_record_cost 那一列都不建（見 double-features.ts）。
  amount: number | null
  memo: string | null
}

export interface NormalizeIssue {
  importKey: string
  rawLine: string
  reason: 'unknown-format' | 'wall-clock-mismatch' | 'bad-ticket-count' | 'negative-amount'
  detail: string
}

export interface NormalizeResult {
  records: NormalizedRecord[]
  issues: NormalizeIssue[]
}

/**
 * 逐筆正規化，並以解碼後的原始 CSV 列交叉驗證時區換算。交叉驗證不是多餘的：`date` 欄的
 * 語意是逆推來的，而原始列裡就寫著答案 ⇒ 上游哪天改了產生方式這裡會立刻炸，
 * 而不是靜默地把 169 筆全部偏移八小時。
 */
export function normalizeRecords(items: MyLogItem[]): NormalizeResult {
  const records: NormalizedRecord[] = []
  const issues: NormalizeIssue[] = []

  for (const item of items) {
    const rawLine = decodeImportKey(item.id)
    const clock = toTaipeiWallClock(item.date)
    const raw = parseRawWallClock(rawLine)

    if (raw && (raw.watchedOn !== clock.watchedOn || raw.watchedTime !== clock.watchedTime)) {
      issues.push({
        importKey: item.id,
        rawLine,
        reason: 'wall-clock-mismatch',
        detail: `date 欄換算得 ${clock.watchedOn} ${clock.watchedTime}，原始列寫 ${raw.watchedOn} ${raw.watchedTime}`,
      })
      continue
    }

    const format = mapScreeningFormat(item.version)
    if (!format) {
      issues.push({
        importKey: item.id,
        rawLine,
        reason: 'unknown-format',
        detail: `未知的放映版本「${item.version}」`,
      })
      continue
    }

    if (!Number.isInteger(item.tickets) || item.tickets < 1 || item.tickets > 99) {
      issues.push({
        importKey: item.id,
        rawLine,
        reason: 'bad-ticket-count',
        detail: `票數 ${item.tickets} 超出 schema 允許的 1–99`,
      })
      continue
    }

    if (!(item.cost >= 0)) {
      issues.push({
        importKey: item.id,
        rawLine,
        reason: 'negative-amount',
        detail: `金額 ${item.cost} 為負，viewing_record_cost 要求 amount >= 0`,
      })
      continue
    }

    records.push({
      importKey: item.id,
      rawLine,
      watchedOn: clock.watchedOn,
      watchedTime: clock.watchedTime,
      title: item.title.trim(),
      // ⚠️ 這條路徑**不經過政府資料**：`/app/import` 會拿它直接 insert
      //    `film.country`（`import.vue` 的 `countryOf(title)`）。只修政府那一支的話，
      //    再匯入一次舊 log 就能造出新的「中華民國」，而且是使用者自己的路徑、
      //    沒有任何檢查會擋。同一個欄位、同一個失敗模式，兩邊一起收。
      country: normalizeCountry(item.area) ?? '',
      venueAlias: item.theater.trim(),
      formatCode: format.code,
      formatNote: format.note,
      hallLabel: format.hall,
      ticketCount: item.tickets,
      amount: item.cost,
      memo: item.memo.trim() || null,
    })
  }

  return { records, issues }
}
