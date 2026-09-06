import type { MyLogItem } from '#pipeline/import/mylog'
import { Buffer } from 'node:buffer'
import { parseRawWallClock, toTaipeiWallClock } from '#pipeline/import/mylog'

/**
 * 舊 log 專案匯出的 CSV → `MyLogItem[]`。
 *
 * 既有的 CLI 匯入（`scripts/import-mylog.ts`）吃的是上游 API 的 **JSON**。
 * `/app/import` 需要的是使用者上傳 CSV，而這兩條路徑必須產出**同樣的東西**——
 * 尤其是 `id`，它是 `viewing_record.import_key`（唯一鍵），決定重跑會不會重複匯入。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 欄位順序不是猜的。從 DB 裡 174 筆真的 `import_key` base64 解碼回來實測：
 *
 *   2016/05/17 (週二) 19:20,少女與戰車劇場版,日本,4DX,信義威秀,500,20,1,0,520
 *   2014/03/01 (週六) 14:00,KANO,台灣,2D,信義威秀,300,20,1,0,320,<備註>
 *
 *   date, title, area, version, theater, price, fee, tickets, discount, cost[, memo]
 *
 *   欄數分布：10 欄 107 筆、11 欄 66 筆、**13 欄 1 筆**。
 *   （範例中的備註內容已代換——那是 David 的私人筆記，不進版控；形狀保留。）
 *
 * ★ 那 1 筆 13 欄的正是踩雷 #67 的形狀，而且比 #67 描述的更糟——備註裡同時有
 *   逗號**和換行**：
 *
 *   …,350,<備註第一段> | ⏎<第二段裡有「JPY 1,600」這種逗號> | <第三段>
 *
 *   所以這裡**絕不用 `columns: true` 之類的具名模式**，一律陣列模式 + 欄數檢查
 *   （#67 的正解），而且多出來的欄位只在**確定是備註溢位**時才收攏。
 *
 * ★ 怎麼分辨「備註裡有逗號」與「片名裡有逗號」：memo 是最後一欄，片名是第 2 欄。
 *   若第 6–10 欄（price/fee/tickets/discount/cost）全部是數字，多出來的逗號就
 *   只可能在它後面 ⇒ 安全地收攏成 memo。任何一欄不是數字，代表逗號出現在前面、
 *   整列位移了 ⇒ **不猜，列進 issues 交給人看**。
 *   猜錯的樣子是「把票價 240 寫成片名的一部分」，而且不會有任何錯誤訊息。
 */

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
 * RFC 4180 的最小可用實作：雙引號包住的欄位可含逗號、換行與 `""` 轉義。
 *
 * 不用現成套件是因為這裡需要**原樣的欄位陣列**（含備註裡的換行），而多數
 * 套件的預設值會替我們做決定（trim、具名欄位、跳過空列），那些決定正是 #67 的來源。
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
 *
 * ★ 用 Intl 量出偏移再修正，不硬寫 +8：台灣在 1979 年以前實施過日光節約時間，
 *   硬寫偏移量在資料回溯到更早年份時會**靜默地**錯一小時
 *   （`toTaipeiWallClock` 的註解已經為了同一個理由用 Intl）。
 *
 * ★ 收斂後**再驗一次**：把算出來的瞬間丟回 `toTaipeiWallClock()`，拿不回原本的
 *   牆上時間就回 null。DST 換日那一小時本來就可能不存在或出現兩次，那時候
 *   安靜地回一個差一小時的瞬間，比回 null 危險得多。
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
 * `id`（＝ `viewing_record.import_key`）＝ 原始列以逗號 join 後的 base64。
 *
 * ★ 必須與上游一致，否則同一筆紀錄從 JSON 匯入與從 CSV 匯入會產生**兩個不同的
 *   import_key**，於是重跑匯入不再冪等，而是憑空多出一份。實測：DB 裡的
 *   import_key 解碼回來就是「欄位以逗號 join」的樣子（備註裡的逗號原樣保留，
 *   沒有引號），所以 join 是還原它的正確方式。
 */
function encodeImportKey(fields: string[]): string {
  return Buffer.from(fields.join(','), 'utf8').toString('base64')
}

/**
 * ★★ 完全相同的原始列會出現不只一次，那時上游會加 `#1` / `#2` 後綴。
 *
 * 這條規則**推不出來，只能從真資料量**。實測 DB 裡 175 個 import_key：
 *   · 165 個是唯一的原始列 ⇒ **沒有後綴**
 *   · 5 組各出現兩次 ⇒ 兩筆分別是 `#1` 與 `#2`（第一筆**也有**後綴）
 * 五組全部一致，沒有例外。
 *
 * 為什麼非做不可：`viewing_record` 有 `unique (user_id, import_key)`。不補後綴的話
 * 那五組會各自撞成一筆——`on conflict do update` 之下**不會報錯**，只是同一天同一場
 * 的兩筆紀錄變成一筆，總場次少 5。少掉的東西不會有任何訊息。
 *
 * ⚠️ 這也表示 `#N` 是**位置相關**的：同一份 CSV 重跑會得到同樣的結果（順序固定），
 *   但若使用者手動調換了那兩列的順序，兩筆的後綴會對調。內容相同，所以沒有實害。
 */
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
