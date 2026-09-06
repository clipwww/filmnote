/**
 * 舊 log 專案（mechakucha-api `/my-log/movie`）的觀影紀錄正規化。
 *
 * 這個模組刻意只放純函式：時區換算與版本對照是整個匯入裡最容易錯、
 * 也最值得回歸測試的兩件事，把它們和 I/O 分開才測得動
 * （見 tests/import.test.ts）。
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
 * 台北牆上時間。
 *
 * 上游的 `date` 是 UTC 瞬間，但它代表的是**台北的牆上時間**：
 * `2026-07-26T08:00:00.000Z` 這筆，原始 CSV 列寫的是 `2026/07/26 (週日) 16:00`。
 * 169 筆實測全部吻合（見 parseRawWallClock 的交叉驗證）。
 *
 * schema 存 `watched_on date` + `watched_time time` 而非 timestamptz，
 * 就是為了讓貢獻圖與時段熱力圖零換算。所以**必須先換到台北時區再取日期**。
 *
 * 直接取 UTC 的日期部分會錯，但方向和直覺相反：台北 = UTC+8，所以台北時間
 * 08:00 以後的場次（含全部晚場）UTC 日期仍相同，真正會跑掉的是**午夜場**——
 * 台北 00:00 的 UTC 是**前一天** 16:00。169 筆裡有 5 筆 00:00 的午夜場
 * （《正義聯盟》《雷神索爾3》《氣象戰》《少女與戰車 最終章 第1話》
 * 《美國隊長3》），不換算會全部退到前一天。
 *
 * 用 Intl 而非硬寫 +8：台灣在 1979 年以前實施過日光節約時間，
 * 硬寫偏移量在資料回溯到更早年份時會靜默地錯。
 */
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
 *
 * ⚠️ 刻意不用 `Buffer`。這個模組同時被 CLI（`scripts/import-mylog.ts`）與
 * 瀏覽器（`/app/import`）載入，而 `node:buffer` 會讓**整個模組**在瀏覽器裡
 * 載不起來——dev 是整條路由 500，**build 卻是 exit 0 並把它編成空物件**。
 * 也就是說靜態檢查全綠、建置成功，功能靜默消失。
 *
 * `atob` 回的是 latin1 字串（每個 char code 是一個位元組），中文必須再經
 * `TextDecoder` 才會對。等價性已對 169 個真實 import key 逐一比對（169/169 相同）。
 */
export function decodeImportKey(id: string): string {
  const binary = atob(id)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * 自解碼後的原始 CSV 列取出牆上時間，用來交叉驗證 `date` 欄。
 *
 * 實測有兩種寫法（166 / 3 筆）：
 *   `2026/07/26 (週日) 16:00`
 *   `2025/7/4 下午 22:10:00`
 * 「下午」在第二種寫法裡是**裝飾**——三筆的時針分別是 21、22、20，
 * 已經是 24 小時制，再加 12 會溢位。因此一律忽略上午／下午標記。
 *
 * 解析不出來時回傳 null，由呼叫端決定要不要當成錯誤。
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
  /** viewing_record.hall_label。只有廳型品牌（非放映格式）才填。 */
  hall: string | null
}

/**
 * 放映版本 → screening_format.code。
 *
 * 逐字對照而非樣式比對：實測只有 10 種相異寫法，全部列出來比正規表示式
 * 更好讀，也讓日後冒出的新寫法在匯入時**明確報錯**而非被靜默歸到「其他」。
 *
 * TITAN 與 MAPPA 是威秀的**廳型品牌**而非放映格式（其中一筆的備註寫
 * 「TITAN廳初體驗」），所以進 hall_label，format_code 記為 other。
 */
const FORMAT_TABLE: Record<string, FormatMapping> = {
  '2D': { code: 'digital', note: null, hall: null },
  '2D (ATMOS)': { code: 'digital', note: 'ATMOS', hall: null },
  'IMAX': { code: 'imax', note: null, hall: null },
  'IMAX 3D': { code: 'imax', note: '3D', hall: null },
  '4DX': { code: '4dx', note: null, hall: null },
  '4DX 3D': { code: '4dx', note: '3D', hall: null },
  '4DX 極爆': { code: '4dx', note: '極爆', hall: null },
  'Dolby Cinema': { code: 'dolby', note: null, hall: null },
  'TITAN': { code: 'other', note: null, hall: 'TITAN' },
  'MAPPA': { code: 'other', note: null, hall: 'MAPPA' },
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
   * viewing_record_cost.amount。
   *
   * 直接採用上游的 `cost`，不自行由 price/fee/tickets/discount 重算：
   * 實測 19 筆對不上「price×tickets+fee−discount」，因為 `fee` 是**每張**
   * 手續費而非每筆（`240,20,2,0,520` → 240×2+20×2=520）。上游的 `cost`
   * 才是實付金額，也是唯一能同時解釋兌換票（`0,0,1,200,0`）與
   * 折扣票（`357,0,1,113,357`）的欄位。
   *
   * **null 代表「這一筆不記金額」**，不是 0 元：雙片連映拆出來的第二筆
   * 屬於同一次付款，票價全額記在第一筆，這一筆連 viewing_record_cost
   * 那一列都不建（見 src/import/double-features.ts）。
   */
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
 * 逐筆正規化，並以解碼後的原始 CSV 列交叉驗證時區換算。
 *
 * 交叉驗證不是多餘的：`date` 欄的語意（UTC 存的是台北牆上時間）是逆推來的，
 * 而原始列裡就寫著答案。上游哪天改了 `date` 的產生方式，這裡會立刻炸出來，
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
