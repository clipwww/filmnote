import type { MyLogItem } from '#pipeline/import/mylog'
import { Buffer } from 'node:buffer'
import { parseRawWallClock, toTaipeiWallClock } from '#pipeline/import/mylog'

/**
 * 舊 log 專案匯出的 CSV → `MyLogItem[]`。CLI 匯入吃的是上游 JSON，這裡吃 CSV，
 * 兩條路徑必須產出**同樣的 `id`**——它是 `viewing_record.import_key`（唯一鍵），
 * 決定重跑會不會重複匯入。
 */
// 欄位：date, title, area, version, theater, price, fee, tickets, discount, cost[, memo]
// 實測 174 筆的欄數分布：10 欄 107 筆、11 欄 66 筆、**13 欄 1 筆**。
//
// ★ 那 1 筆 13 欄是踩雷 #67 的形狀且更糟（備註裡同時有逗號**和換行**）⇒ 絕不用
//   `columns: true` 之類的具名模式，一律陣列模式 + 欄數檢查，多的欄位只在確定是
//   備註溢位時才收攏。
//
// ★ 分辨「備註裡有逗號」與「片名裡有逗號」：memo 是最後一欄、片名是第 2 欄，
//   若第 6–10 欄全是數字，多出來的逗號只可能在它後面 ⇒ 安全收攏成 memo；
//   任何一欄不是數字代表整列位移了 ⇒ **不猜，列進 issues**（猜錯是把票價寫進片名）。

/** 欄位順序（實測 174 筆）。index 即欄位位置。 */
const COLUMNS = [
  'date',
  'title',
  'area',
  'version',
  'theater',
  'price',
  'fee',
  'tickets',
  'discount',
  'cost',
] as const
/** 第 6–10 欄必須是數字。這組索引是判斷「有沒有位移」的唯一依據。 */
const NUMERIC_FROM = 5
const MEMO_INDEX = COLUMNS.length

export interface MyLogCsvIssue {
  /** 1-based，指的是 CSV 的**記錄**序號（含引號換行的多行算一筆）。 */
  record: number
  raw: string
  reason: 'too-few-columns' | 'ambiguous-columns' | 'bad-timestamp' | 'bad-number' | 'wall-clock-drift'
  detail: string
}

export interface MyLogCsvResult {
  items: MyLogItem[]
  issues: MyLogCsvIssue[]
  /** 略過的標題列數（0 或 1）。回給 UI 顯示，免得使用者以為少了一筆。 */
  headerSkipped: number
}

/**
 * RFC 4180 的最小可用實作。不用現成套件是因為這裡需要**原樣的欄位陣列**（含備註裡
 * 的換行），而多數套件的預設值會替我們做決定（trim、具名欄位、跳過空列）——#67 的來源。
 */
function tokenize(text: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false

  // 去掉 BOM。Excel 另存的 CSV 幾乎一定有，而它會讓第一欄的日期正則對不上，
  // 症狀是「第一筆永遠被當成標題列」。
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text

  const endField = (): void => {
    record.push(field)
    field = ''
  }
  const endRecord = (): void => {
    endField()
    records.push(record)
    record = []
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (inQuotes) {
      if (ch !== '"') {
        field += ch
      }
      else if (src[i + 1] === '"') {
        // RFC 4180 的轉義：欄位內的一個 `"` 寫成 `""`
        field += '"'
        i++
      }
      else {
        inQuotes = false
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    }
    else if (ch === ',') {
      endField()
    }
    else if (ch === '\n') {
      endRecord()
    }
    else if (ch !== '\r') {
      field += ch
    }
  }
  // 檔尾沒有換行時，最後一筆還在暫存區裡。漏掉它的樣子是「最後一筆神秘消失」。
  if (field !== '' || record.length)
    endRecord()
  return records
}

/** 台北牆上時間 → UTC 瞬間的 ISO 字串。 */
const TAIPEI_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 某個瞬間，台北時間比 UTC 快多少毫秒。 */
function taipeiOffsetMs(instant: number): number {
  const p: Record<string, string> = {}
  for (const part of TAIPEI_FMT.formatToParts(new Date(instant)))
    p[part.type] = part.value
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
  )
  return asUtc - Math.floor(instant / 60_000) * 60_000
}

/**
 * `YYYY-MM-DD` + `HH:MM`（台北牆上時間）→ ISO UTC。
 * ★ 用 Intl 量偏移不硬寫 +8：台灣 1979 年以前實施過日光節約時間，硬寫會靜默錯一小時。
 * ★ 收斂後再丟回 `toTaipeiWallClock()` 驗一次，拿不回原值就回 null——DST 換日那一小時
 *   可能不存在或出現兩次，安靜地回一個差一小時的瞬間比回 null 危險。
 */
export function taipeiWallClockToIso(watchedOn: string, watchedTime: string): string | null {
  let instant = Date.parse(`${watchedOn}T${watchedTime}:00Z`)
  if (Number.isNaN(instant))
    return null
  for (let i = 0; i < 3; i++)
    instant = Date.parse(`${watchedOn}T${watchedTime}:00Z`) - taipeiOffsetMs(instant)

  const iso = new Date(instant).toISOString()
  const back = toTaipeiWallClock(iso)
  if (back.watchedOn !== watchedOn || back.watchedTime !== watchedTime)
    return null
  return iso
}

function toNumber(raw: string): number | null {
  // 千分位與全形逗號都出現過（備註裡的 `JPY 1,600` 是全形逗號後綴），
  // 但**金額欄位**實測全是純數字。仍然容忍空字串＝0：舊資料的手續費常常留空。
  const t = raw.trim().replace(/,/g, '')
  if (t === '')
    return 0
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * `id`（＝ `import_key`）＝ 原始列以逗號 join 後的 base64。★ 必須與上游一致，否則
 * 同一筆從 JSON 與從 CSV 匯入會產生兩個不同的 import_key ⇒ 重跑不再冪等而是多一份。
 * 實測 DB 裡的 import_key 解碼回來就是「欄位以逗號 join」（備註的逗號原樣、沒有引號）。
 */
function encodeImportKey(fields: string[]): string {
  return Buffer.from(fields.join(','), 'utf8').toString('base64')
}

/**
 * ★★ 完全相同的原始列會重複出現，上游會加 `#1` / `#2` 後綴。這條規則推不出來，
 * 只能從真資料量：實測 175 個 import_key，165 個唯一（無後綴）、5 組各兩次
 * （兩筆分別 `#1`/`#2`，第一筆**也有**後綴），五組全部一致。
 */
// 非做不可的理由：`unique (user_id, import_key)` 之下不補後綴會讓那五組各撞成一筆，
// 而 `on conflict do update` **不會報錯**，只是總場次安靜地少 5。
// ⚠️ `#N` 是位置相關的：使用者手動調換那兩列的順序，兩筆後綴會對調（內容相同，無實害）。
function applyDuplicateSuffixes(items: MyLogItem[]): void {
  const count = new Map<string, number>()
  for (const it of items)
    count.set(it.id, (count.get(it.id) ?? 0) + 1)

  const nth = new Map<string, number>()
  for (const it of items) {
    if ((count.get(it.id) ?? 0) < 2)
      continue
    const base = it.id
    const n = (nth.get(base) ?? 0) + 1
    nth.set(base, n)
    it.id = `${base}#${n}`
  }
}

export function parseMyLogCsv(text: string): MyLogCsvResult {
  const items: MyLogItem[] = []
  const issues: MyLogCsvIssue[] = []
  let headerSkipped = 0

  const records = tokenize(text).filter(r => !(r.length === 1 && r[0]!.trim() === ''))

  for (const [index, fieldsRaw] of records.entries()) {
    const recordNo = index + 1
    const raw = fieldsRaw.join(',')

    // 標題列：第一筆而且第一欄不是時間戳。只認第一筆，避免把備註開頭剛好
    // 不像日期的資料列當成標題丟掉。
    if (index === 0 && !parseRawWallClock(raw)) {
      headerSkipped = 1
      continue
    }

    if (fieldsRaw.length < COLUMNS.length) {
      issues.push({ record: recordNo, raw, reason: 'too-few-columns', detail: `只有 ${fieldsRaw.length} 欄，至少要 ${COLUMNS.length} 欄` })
      continue
    }

    // ★ #67 的核心判斷。多出來的欄位只有在「金額欄全是數字」時才確定是備註溢位。
    const numerics = COLUMNS.slice(NUMERIC_FROM).map((_, i) => toNumber(fieldsRaw[NUMERIC_FROM + i]!))
    if (numerics.includes(null)) {
      // 剛好 10 欄時不可能有位移（沒有多餘的逗號），所以那是單純的壞值；
      // 超過 10 欄就分不出「備註裡有逗號 + 金額真的壞了」與「片名裡有逗號 ⇒
      // 整列右移」——分不出來就**不要猜**。
      const shiftPossible = fieldsRaw.length > COLUMNS.length
      issues.push({ record: recordNo, raw, reason: shiftPossible ? 'ambiguous-columns' : 'bad-number', detail: shiftPossible
        ? `有 ${fieldsRaw.length} 欄且金額欄位不是數字 ⇒ 逗號可能出現在片名等前段欄位，整列位移。這一列不做推測，請人工確認。`
        : `金額欄位不是數字：${fieldsRaw.slice(NUMERIC_FROM, COLUMNS.length).join(' | ')}` })
      continue
    }

    // 備註是最後一欄，多出來的一律收攏回去（原樣還原成含逗號的字串）
    const memo = fieldsRaw.length > MEMO_INDEX ? fieldsRaw.slice(MEMO_INDEX).join(',') : ''

    const clock = parseRawWallClock(raw)
    if (!clock) {
      issues.push({ record: recordNo, raw, reason: 'bad-timestamp', detail: `第一欄不是可解析的時間：${fieldsRaw[0]}` })
      continue
    }

    const iso = taipeiWallClockToIso(clock.watchedOn, clock.watchedTime)
    if (!iso) {
      issues.push({ record: recordNo, raw, reason: 'wall-clock-drift', detail: `${clock.watchedOn} ${clock.watchedTime} 換算成 UTC 後再換回來對不上（時區換日？）` })
      continue
    }

    const [price, fee, tickets, discount, cost] = numerics as number[]
    items.push({
      id: encodeImportKey(fieldsRaw),
      date: iso,
      title: fieldsRaw[1]!.trim(),
      area: fieldsRaw[2]!.trim(),
      version: fieldsRaw[3]!.trim(),
      theater: fieldsRaw[4]!.trim(),
      price: price!,
      fee: fee!,
      tickets: tickets!,
      discount: discount!,
      cost: cost!,
      memo,
    })
  }

  applyDuplicateSuffixes(items)
  return { items, issues, headerSkipped }
}
