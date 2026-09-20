/**
 * TrueType `cmap` 的最小解析：這個字型畫得出哪些碼位。用途是渲染前先問「這行字
 * 畫得出來嗎」，畫不出來就換一行——OG 圖絕不能出現豆腐格（`SCREENS §16.4`）。
 * ★ 只解析 format 4（BMP）與 format 12（增補平面）；遇到別的格式**回報而不是靜默
 *   略過**，靜默略過會把「字型其實有這個字」誤判成缺字，整站片名退化成降級態。
 */

function u16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
}

export interface CmapResult {
  codepoints: Set<number>
  /** 實際解析成功的子表格式，供除錯與回歸用。 */
  formats: number[]
}

/** 解析字型的 cmap，回傳所有收錄的碼位。 */
export function parseCmap(font: Uint8Array): CmapResult {
  const codepoints = new Set<number>()
  const formats: number[] = []

  // sfnt 檔頭：ttcTag 或 sfntVersion，接著 numTables
  const numTables = u16(font, 4)
  let cmapOffset = -1
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    const tag = String.fromCharCode(font[rec]!, font[rec + 1]!, font[rec + 2]!, font[rec + 3]!)
    if (tag === 'cmap') {
      cmapOffset = u32(font, rec + 8)
      break
    }
  }
  if (cmapOffset < 0)
    throw new Error('字型沒有 cmap 表')

  const numSubtables = u16(font, cmapOffset + 2)
  // 同一個字型會有多張子表（不同平台）。全部掃過並取聯集——只要任何一張說
  // 有這個碼位，字型就畫得出來。
  for (let i = 0; i < numSubtables; i++) {
    const enc = cmapOffset + 4 + i * 8
    const sub = cmapOffset + u32(font, enc + 4)
    const format = u16(font, sub)

    if (format === 4) {
      const segCountX2 = u16(font, sub + 6)
      const segCount = segCountX2 / 2
      const endBase = sub + 14
      const startBase = endBase + segCountX2 + 2
      const deltaBase = startBase + segCountX2
      const rangeBase = deltaBase + segCountX2

      for (let s = 0; s < segCount; s++) {
        const end = u16(font, endBase + s * 2)
        const start = u16(font, startBase + s * 2)
        if (start > end)
          continue
        const delta = u16(font, deltaBase + s * 2)
        const rangeOffset = u16(font, rangeBase + s * 2)
        for (let c = start; c <= end && c !== 0xFFFF; c++) {
          let gid: number
          if (rangeOffset === 0) {
            gid = (c + delta) & 0xFFFF
          }
          else {
            const gi = rangeBase + s * 2 + rangeOffset + (c - start) * 2
            if (gi + 1 >= font.length)
              continue
            const g = u16(font, gi)
            gid = g === 0 ? 0 : (g + delta) & 0xFFFF
          }
          if (gid !== 0)
            codepoints.add(c)
        }
      }
      formats.push(4)
    }
    else if (format === 12) {
      const nGroups = u32(font, sub + 12)
      for (let g = 0; g < nGroups; g++) {
        const rec = sub + 16 + g * 12
        const start = u32(font, rec)
        const end = u32(font, rec + 4)
        const startGid = u32(font, rec + 8)
        if (startGid === 0 && start === 0)
          continue
        // 這裡不展開超大範圍的每一個碼位以免爆記憶體；Noto 的分組都很小。
        for (let c = start; c <= end; c++)
          codepoints.add(c)
      }
      formats.push(12)
    }
    else {
      formats.push(format)
    }
  }

  if (!formats.some(f => f === 4 || f === 12)) {
    throw new Error(
      `cmap 沒有可解析的子表（只看到 format ${formats.join('/')}）——`
      + '不能當成「這個字型沒有任何字」，那會讓每一張 OG 圖都退化成降級態',
    )
  }

  return { codepoints, formats }
}

/**
 * 這串文字有沒有字型畫不出來的字元。空白與控制字元不算（它們不畫東西）。
 * ★ 逐**碼位**走訪而不是 `text.length`：後者把增補平面字元拆成兩個代理碼位，
 *   而代理碼位永遠不在 cmap 裡 ⇒ 每個含 emoji 的字串都會被判成缺字。
 */
export function findMissingChars(text: string, codepoints: Set<number>): string[] {
  const missing: string[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D)
      continue
    if (!codepoints.has(cp))
      missing.push(ch)
  }
  return missing
}
