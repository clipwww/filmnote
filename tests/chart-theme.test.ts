import { describe, expect, it } from 'vitest'
import { attendancePieces, attMatchesHeat, CHART, chartPalette, heatPieces } from '../app/utils/chart-theme'

describe('色階本身', () => {
  it('att 恆等於 heat[0] / heat[4] / heat[6]（§5.4b）', () => {
    // 圖例的色塊與圖上的格子若由兩份常數維護遲早會分岔
    expect(attMatchesHeat(CHART.light)).toBe(true)
    expect(attMatchesHeat(CHART.dark)).toBe(true)
  })

  it('亮色墨階的相對亮度單調遞減、暗色單調遞增（§1.3）', () => {
    const lum = (hex: string) => {
      const n = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(n[0]!) + 0.7152 * f(n[1]!) + 0.0722 * f(n[2]!)
    }
    const light = CHART.light.heat.map(lum)
    const dark = CHART.dark.heat.map(lum)
    for (let i = 1; i < 7; i++) {
      expect(light[i]!).toBeLessThan(light[i - 1]!)
      expect(dark[i]!).toBeGreaterThan(dark[i - 1]!)
    }
  })

  it('全部是 hex——zrender 不解析 oklch / var() / 空白分隔的 rgb', () => {
    for (const mode of [CHART.light, CHART.dark]) {
      for (const c of [...mode.heat, ...mode.att, mode.sheet, mode.accent, mode.text0])
        expect(c).toMatch(/^#[0-9A-F]{6}$/i)
    }
  })
})

describe('visualMap 的 pieces 不能留縫（§5.3-9）', () => {
  /** 把 pieces 套到一個值上，回傳命中的顏色；沒有 piece 認領就是 undefined＝破洞。 */
  function paint(pieces: ReturnType<typeof heatPieces>, v: number) {
    for (const p of pieces) {
      if (p.value !== undefined) {
        if (v === p.value)
          return p.color
        continue
      }
      const okLo = p.gt === undefined || v > p.gt
      const okHi = p.lte === undefined || v <= p.lte
      if (okLo && okHi)
        return p.color
    }
    return undefined
  }

  it('出席圖：0 / 1 / 2 / 3 全部畫得出來（2 是雙片連映，最容易掉的那格）', () => {
    const pieces = attendancePieces(false)
    for (const v of [0, 1, 2, 3, 9])
      expect(paint(pieces, v), `值 ${v} 沒有 piece 認領`).toBeDefined()
    expect(paint(pieces, 2)).toBe(CHART.light.att[2])
  })

  it('熱點圖：0..max 每一個整數都有 piece 認領', () => {
    for (const max of [1, 2, 3, 5, 8, 12, 40]) {
      const pieces = heatPieces(false, max)
      for (let v = 0; v <= max; v++)
        expect(paint(pieces, v), `max=${max} 時值 ${v} 沒有 piece 認領`).toBeDefined()
    }
  })

  it('熱點圖：超過 max 的值也畫得出來（最後一段是開放上界）', () => {
    expect(paint(heatPieces(false, 8), 99)).toBe(CHART.light.heat[6])
  })

  it('熱點圖：0 是最淺、最深的一段是 heat[6]', () => {
    const pieces = heatPieces(true, 8)
    expect(paint(pieces, 0)).toBe(CHART.dark.heat[0])
    expect(paint(pieces, 8)).toBe(CHART.dark.heat[6])
  })

  it('值域小的時候不產生空 piece', () => {
    for (const max of [1, 2, 3]) {
      const pieces = heatPieces(false, max)
      const covered = new Set<string>()
      for (let v = 0; v <= max; v++)
        covered.add(paint(pieces, v)!)
      // 每一段都要真的有整數落進去
      expect(covered.size).toBe(pieces.length)
    }
  })
})

describe('chartPalette', () => {
  it('依 dark 旗標切換', () => {
    expect(chartPalette(false).sheet).toBe('#FDF9F1')
    expect(chartPalette(true).sheet).toBe('#29211A')
  })
})
