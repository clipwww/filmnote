import { describe, expect, it } from 'vitest'
import {
  filmSlugFromUrl,
  phoneOrNull,
  takedownNoticeSchema,
  takedownSchema,
  toTakedownPayload,
} from '../app/schemas/takedown'

// 侵權通知模組的介面測試：表單（dmca.vue）與伺服器（notice.post.ts）都只經過這些出口。

const valid = {
  claimantName: '某某影業股份有限公司',
  claimantEmail: 'legal@example.com',
  claimantPhone: '',
  workDescription: '電影《某某》之海報與劇照，著作財產權人為本公司。',
  targetUrl: 'https://filmnote.example/film/some-film',
  statementGoodFaith: true,
}

function issues(result: { success: boolean, error?: { issues: { path: PropertyKey[], message: string }[] } }) {
  return result.success ? [] : result.error!.issues.map(i => `${i.path.join('.')}: ${i.message}`).sort()
}

describe('filmSlugFromUrl —— 回顯與 target_film_id 共用的判斷', () => {
  it.each([
    ['https://filmnote.example/film/abc', 'abc'],
    ['https://filmnote.example/film/abc/', 'abc'],
    ['filmnote.example/film/abc', 'abc'], // 沒有 scheme 也認得（先補全）
    ['https://other.example/film/abc', 'abc'], // 刻意不看網域
    ['https://filmnote.example/film/%E9%AC%BC%E5%AA%BD%E5%AA%BD', '鬼媽媽'],
    ['https://filmnote.example/film/abc?x=1#y', 'abc'],
  ])('%s → %s', (url, slug) => {
    expect(filmSlugFromUrl(url)).toBe(slug)
  })

  it.each([
    'https://filmnote.example/film/',
    'https://filmnote.example/film/abc/edit',
    'https://filmnote.example/u/abc',
    'https://filmnote.example/films/abc',
    'not a url',
    '',
  ])('%s → null', (url) => {
    expect(filmSlugFromUrl(url)).toBeNull()
  })

  it('壞掉的百分比跳脫回 null，不丟 URIError（以前伺服器會 500、通知沒寫進去）', () => {
    expect(() => filmSlugFromUrl('https://x/film/%E0%A4')).not.toThrow()
    expect(filmSlugFromUrl('https://x/film/%E0%A4')).toBeNull()
    expect(filmSlugFromUrl('https://x/film/%')).toBeNull()
  })

  it('壞掉的跳脫網址本身仍是一份合法通知（slug 解不出來不是退件理由）', () => {
    expect(takedownNoticeSchema.safeParse({ ...valid, claimantPhone: null, targetUrl: 'https://x/film/%E0%A4' }).success).toBe(true)
  })
})

describe('空電話 → null', () => {
  it.each([[''], ['   '], [undefined], [null]])('phoneOrNull(%j) → null', (v) => {
    expect(phoneOrNull(v)).toBeNull()
  })

  it('有值時 trim 後保留', () => {
    expect(phoneOrNull(' 02-1234-5678 ')).toBe('02-1234-5678')
  })

  it('送出形狀：空電話送 null', () => {
    const form = takedownSchema.parse({ ...valid, claimantPhone: '  ' })
    expect(toTakedownPayload(form).claimantPhone).toBeNull()
  })

  it('伺服器變體輸出：空字串／null／沒填都寫成 null', () => {
    for (const claimantPhone of ['', '  ', null, undefined])
      expect(takedownNoticeSchema.parse({ ...valid, claimantPhone }).claimantPhone).toBeNull()
  })
})

describe('表單變體與伺服器變體的判斷一致', () => {
  const cases: Record<string, Partial<typeof valid> & Record<string, unknown>> = {
    '合法': {},
    '姓名空白': { claimantName: '   ' },
    '姓名 101 字': { claimantName: 'a'.repeat(101) },
    '信箱不完整': { claimantEmail: 'legal@' },
    '電話 51 字': { claimantPhone: '1'.repeat(51) },
    '描述不足 10 字': { workDescription: '太短了' },
    '描述 2001 字': { workDescription: 'a'.repeat(2001) },
    '網址不是網址': { targetUrl: 'not a url' },
    '網址少了 scheme': { targetUrl: 'filmnote.example/film/abc' },
    '網址 501 字': { targetUrl: `https://x.example/${'a'.repeat(490)}` },
    '沒勾善意聲明': { statementGoodFaith: false },
  }

  it.each(Object.entries(cases))('%s', (_label, patch) => {
    const input = { ...valid, ...patch }
    const form = takedownSchema.safeParse(input)
    const server = takedownNoticeSchema.safeParse(input)
    expect(server.success).toBe(form.success)
    // 422 的訊息會被貼回表單欄位（dmca.vue 的 setErrors），所以連路徑與字句都要一樣。
    expect(issues(server)).toEqual(issues(form))
  })

  it('表單通過的資料，經 toTakedownPayload 送到伺服器也通過，且網址已補全', () => {
    const form = takedownSchema.parse({ ...valid, targetUrl: 'filmnote.example/film/abc' })
    const server = takedownNoticeSchema.parse(toTakedownPayload(form))
    expect(server.targetUrl).toBe('https://filmnote.example/film/abc')
    expect(server.statementGoodFaith).toBe(true)
  })

  it('伺服器變體只收 literal true：字串 "true"、1 都退件', () => {
    expect(takedownNoticeSchema.safeParse({ ...valid, statementGoodFaith: 'true' }).success).toBe(false)
    expect(takedownNoticeSchema.safeParse({ ...valid, statementGoodFaith: 1 }).success).toBe(false)
  })
})
