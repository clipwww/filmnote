/**
 * 法律文件的 Markdown → 區塊樹（`SCREENS §15.1`）。自己寫不裝套件：三份條款用到的語法是
 * **封閉集合**（h1~h3、段落、引言、清單、表格、粗體、行內碼），為這七種裝一個通用剖析器
 * 換到的是一份要跟著升級的相依，以及一段**產生 HTML 字串**的路徑。
 */
/*
 * 回傳結構化區塊、由 Vue 以文字節點算繪 ⇒「資料庫沒有被寫入 HTML」這條保證由框架供應，
 * 不是靠自律。⚠️ 另一個理由更硬：`SCREENS §15.1` 明文禁止套 prose 預設樣式（字級行高跟本站
 * 的紙不同調，且會把 `<code>` 渲染成等寬字）⇒ 樣式一定要自己寫，剖析也自己寫並不多一件事。
 */
/*
 * ⚠️ 換行接合：原始檔在 80 欄手動斷行而 Markdown 的語意是同一段，一般實作以**空格**接合
 * ——那對中文是錯的（「本服務不提供 電影片分級查詢」會多出看得見的空隙）。規則是接縫兩側
 * 只要有一邊是 CJK 或全形標點就直接相接，兩邊都是拉丁才補空格。中英間距靠 `text-autospace`。
 */

export interface Inline {
  type: 'text' | 'strong' | 'code'
  value: string
}

export interface TableCell {
  inlines: Inline[]
}

export type Block
  = | { type: 'heading', level: 2 | 3, id: string, label: string | null, text: string, display: string }
    | { type: 'paragraph', inlines: Inline[] }
    | { type: 'quote', paragraphs: Inline[][] }
    | { type: 'list', ordered: boolean, items: Inline[][] }
    | { type: 'table', head: TableCell[], rows: TableCell[][] }

export interface TocEntry {
  id: string
  /** 條號（`3`、`3.1`）。原文沒有編號時是 null。 */
  label: string | null
  text: string
}

export interface ParsedLegalDoc {
  /** 正文第一個 `# ` 標題。`legal_document` 沒有標題欄位，標題就在正文裡。 */
  title: string
  blocks: Block[]
  /** 只收 h2。法律文件的目錄要能一眼掃完，h3 進去就變成第二份內文。 */
  toc: TocEntry[]
}

/**
 * 中日韓字元與全形標點。接合軟換行時，這一側出現就不補空格。
 * 涵蓋部首補充到統一表意文字（含假名、注音、諺文，也含 U+3000 一段的全形標點）、
 * 相容表意文字、相容形式，以及全形／半形變體區（全形逗號與句號在這一段）。
 */
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

function joinSoftWrap(lines: string[]): string {
  let out = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line)
      continue
    if (!out) {
      out = line
      continue
    }
    const left = out.at(-1)!
    const right = line[0]!
    out += CJK_RE.test(left) || CJK_RE.test(right) ? line : ` ${line}`
  }
  return out
}

/**
 * 行內語法。`**粗體**` 與 `` `行內碼` ``，其餘一律文字。
 *
 * 兩者不巢狀（三份文件裡沒有），所以一次掃描就夠，不必做成 tokenizer。
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let last = 0
  let m: RegExpExecArray | null = re.exec(text)
  while (m) {
    if (m.index > last)
      out.push({ type: 'text', value: text.slice(last, m.index) })
    out.push(m[1] !== undefined
      ? { type: 'strong', value: m[1] }
      : { type: 'code', value: m[2]! })
    last = m.index + m[0].length
    m = re.exec(text)
  }
  if (last < text.length)
    out.push({ type: 'text', value: text.slice(last) })
  return out.length ? out : [{ type: 'text', value: text }]
}

/**
 * 條號 → 錨點 id（`## 3. 侵權通知` → `s3`）。⚠️ **這個 id 是對外承諾的一部分**（侵權通知、
 * 客服回覆、admin 備註都會指向特定一條）。從**條號**長出來不是從標題文字：標題改一個字，
 * 用文字做的錨點就死了，而寄出去的信裡那個 `#s4` 不會跟著改。
 */
function headingId(label: string | null, fallbackIndex: number): string {
  return label ? `s${label.replace(/\./g, '-')}` : `s-${fallbackIndex}`
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(c => c.trim())
}

const DELIMITER_ROW_RE = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/
const ITEM_RE = /^\s*(?:[-*]|\d+\.)\s+/
/** 段落到此為止：下一行是標題、引言、清單或表格。 */
const BLOCK_START_RE = /^(?:#{1,3}\s|>|\||\s*(?:[-*]|\d+\.)\s)/

export function parseLegalMarkdown(md: string): ParsedLegalDoc {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  const toc: TocEntry[] = []
  let title = ''
  let headingSeq = 0

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (!trimmed) {
      i++
      continue
    }

    // ── 標題 ──────────────────────────────────────────────
    const heading = /^(#{1,3})\s(.*)$/.exec(trimmed)
    if (heading) {
      const level = heading[1]!.length
      const body = heading[2]!.trim()
      if (level === 1) {
        // `legal_document` 沒有 title 欄位，正文的 h1 就是文件標題。
        // 它由頁面的 `<h1>` 承擔，不重複進正文。
        title ||= body
        i++
        continue
      }
      headingSeq++
      // 「3. 標題」與「3.1 標題」兩種寫法都要吃：前者有句點後空格，後者沒有。
      const numbered = /^(\d+(?:\.\d+)*)\.?\s(.*)$/.exec(body)
      const label = numbered ? numbered[1]! : null
      const text = (numbered ? numbered[2]! : body).trim()
      const id = headingId(label, headingSeq)
      // ⚠️ `display` 是**原文那一行**不是拿 label 跟 text 重組的。重組會憑空長出標點：
      //    原文的 h2 是「3. 侵權通知」（有句點）、h3 是「3.1 聯繫窗口」（沒有），一律接 `. `
      //    會 render 成「1.1. 政府開放資料」。條號要怎麼寫是條款自己的事。
      blocks.push({ type: 'heading', level: level as 2 | 3, id, label, text, display: body })
      if (level === 2)
        toc.push({ id, label, text })
      i++
      continue
    }

    // ── 表格 ──────────────────────────────────────────────
    if (trimmed.startsWith('|') && DELIMITER_ROW_RE.test(lines[i + 1] ?? '')) {
      const head = splitTableRow(trimmed).map(c => ({ inlines: parseInline(c) }))
      i += 2
      const rows: TableCell[][] = []
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i]!.trim()).map(c => ({ inlines: parseInline(c) })))
        i++
      }
      blocks.push({ type: 'table', head, rows })
      continue
    }

    // ── 引言 ──────────────────────────────────────────────
    if (trimmed.startsWith('>')) {
      const paragraphs: Inline[][] = []
      let buffer: string[] = []
      const flush = () => {
        const text = joinSoftWrap(buffer)
        if (text)
          paragraphs.push(parseInline(text))
        buffer = []
      }
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        const content = lines[i]!.trim().replace(/^>\s?/, '')
        if (content.trim())
          buffer.push(content)
        else
          flush()
        i++
      }
      flush()
      blocks.push({ type: 'quote', paragraphs })
      continue
    }

    // ── 清單 ──────────────────────────────────────────────
    if (ITEM_RE.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: string[][] = []
      while (i < lines.length) {
        const cur = lines[i]!
        if (!cur.trim())
          break
        if (ITEM_RE.test(cur)) {
          items.push([cur.replace(ITEM_RE, '')])
        }
        else if (/^\s+\S/.test(cur) && items.length) {
          // 縮排續行＝同一項的軟換行，不是新的一項。
          items.at(-1)!.push(cur)
        }
        else {
          break
        }
        i++
      }
      blocks.push({ type: 'list', ordered, items: items.map(l => parseInline(joinSoftWrap(l))) })
      continue
    }

    // ── 段落 ──
    // ⚠️ 第一行**無條件**吃掉：上面每個分支都有「看起來像但不是」的漏網情形，若這裡照樣用
    //    BLOCK_START_RE 擋，那一行會既不被消化、`i` 也不前進 ⇒ 整個剖析器停在無窮迴圈裡。
    const buffer: string[] = [line]
    i++
    while (i < lines.length) {
      const cur = lines[i]!
      if (!cur.trim() || BLOCK_START_RE.test(cur.trim()))
        break
      buffer.push(cur)
      i++
    }
    const text = joinSoftWrap(buffer)
    if (text)
      blocks.push({ type: 'paragraph', inlines: parseInline(text) })
  }

  return { title, blocks, toc }
}
