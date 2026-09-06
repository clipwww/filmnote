/**
 * OG 圖的純邏輯。算圖本身（satori → PNG）需要相依套件與 6.76MB 字型，
 * 不適合放進單元測試；那部分以 `scripts/og-preview.ts` 產出真圖用眼睛看。
 * 這裡釘的是「會讓 OG 圖出錯但不會有任何錯誤訊息」的那幾條。
 */
import { describe, expect, it } from 'vitest'
import { clampHero, FALLBACK_HERO } from '../server/utils/og-card'
import { findMissingChars } from '../server/utils/og-cmap'

describe('findMissingChars', () => {
  // 模擬一個只收錄「一張票根」與 ASCII 的字型
  const cps = new Set([...'一張票根abc0123'].map(c => c.codePointAt(0)!))

  it('缺字時列出缺的那幾個字', () => {
    expect(findMissingChars('一張票根', cps)).toEqual([])
    expect(findMissingChars('凪', cps)).toEqual(['凪'])
  })

  it('★ 以碼位走訪，增補平面的字元不會被拆成兩個代理碼位', () => {
    // emoji 是單一碼位。用 text.length 逐 index 走會拆成兩半，
    // 而代理碼位永遠不在 cmap 裡——結論碰巧對，但理由是錯的。
    const missing = findMissingChars('🎉', cps)
    expect(missing).toHaveLength(1)
    expect(missing[0]).toBe('🎉')
  })

  it('空白與控制字元不算缺字（它們不畫任何東西）', () => {
    expect(findMissingChars('一張 票根\n', cps)).toEqual([])
  })
})

describe('clampHero', () => {
  it('短片名原樣保留', () => {
    expect(clampHero('鬥陣俱樂部')).toBe('鬥陣俱樂部')
  })

  it('超長片名截斷並補省略號', () => {
    const long = '劇'.repeat(60)
    const out = clampHero(long)
    expect([...out]).toHaveLength(34)
    expect(out.endsWith('…')).toBe(true)
  })

  it('★ 以碼位計數，不把增補平面的字元切一半', () => {
    const out = clampHero('🎉'.repeat(60), 10)
    // 切一半的話會出現落單的代理碼位（U+D800–U+DFFF）
    for (const ch of out)
      expect(ch.codePointAt(0)! < 0xD800 || ch.codePointAt(0)! > 0xDFFF).toBe(true)
  })
})

describe('降級態', () => {
  it('絕不渲染豆腐格：缺字就整行換掉，而不是只拿掉缺的那個字', () => {
    // 拿掉缺字會得到「青大學體育會航空部劇場版」——一個看起來正常但**錯的**片名，
    // 比豆腐格更糟，因為讀者不會發現。
    expect(FALLBACK_HERO).toBe('一張票根')
  })
})
