import { describe, expect, it } from 'vitest'
// ⚠️ 相對路徑：vitest 的 `~` 指向 ./src，不是 ./app（見 vitest.config.ts）。
import { pickAvatarUrl } from '../app/utils/avatar'

/**
 * `pickAvatarUrl()` 是導覽列頭像唯一有邏輯的那一段——`useMyAvatar()` 的其餘部分
 * 全是 Nuxt auto-import（`useSupabaseUser` / `useAsyncData`），在 vitest 裡不存在。
 *
 * 這裡守的是三件會靜靜壞掉的事：挑錯 key、把非 https 的東西放進 `<img src>`、
 * metadata 形狀變了之後回傳一個不是字串的東西。
 */
describe('pickAvatarUrl', () => {
  // 用兩個不同的值才驗得到順序。Google 實際上兩個 key 給的是同一個字串
  // （實測 `avatar_url = picture` 為 true），所以只有刻意造出差異才看得出誰贏。
  it('avatar_url 優先於 picture', () => {
    expect(pickAvatarUrl({
      avatar_url: 'https://lh3.googleusercontent.com/a/AAAA=s96-c',
      picture: 'https://lh3.googleusercontent.com/a/BBBB=s96-c',
    })).toBe('https://lh3.googleusercontent.com/a/AAAA=s96-c')
  })

  it('沒有 avatar_url 時退而取 picture', () => {
    expect(pickAvatarUrl({ picture: 'https://lh3.googleusercontent.com/a/BBBB=s96-c' }))
      .toBe('https://lh3.googleusercontent.com/a/BBBB=s96-c')
  })

  it('avatar_url 不合格時跳過它，改用合格的 picture', () => {
    expect(pickAvatarUrl({
      avatar_url: 'http://lh3.googleusercontent.com/a/AAAA=s96-c',
      picture: 'https://lh3.googleusercontent.com/a/BBBB=s96-c',
    })).toBe('https://lh3.googleusercontent.com/a/BBBB=s96-c')
  })

  it.each([
    ['http（混合內容）', 'http://lh3.googleusercontent.com/a/AAAA'],
    ['通訊協定相對網址', '//lh3.googleusercontent.com/a/AAAA'],
    ['data URI', 'data:image/png;base64,iVBORw0KGgo='],
    ['空字串', ''],
    ['一坨不是網址的東西', 'AAAA=s96-c'],
  ])('%s 一律回 null，不會進 <img src>', (_label, value) => {
    expect(pickAvatarUrl({ avatar_url: value })).toBeNull()
  })

  it.each([
    ['數字', 42],
    ['null', null],
    ['物件', { url: 'https://example.com/a.png' }],
    ['陣列', ['https://example.com/a.png']],
  ])('avatar_url 是%s時回 null', (_label, value) => {
    expect(pickAvatarUrl({ avatar_url: value })).toBeNull()
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字串', 'https://lh3.googleusercontent.com/a/AAAA'],
    ['空物件', {}],
  ])('metadata 本身是%s時回 null', (_label, value) => {
    expect(pickAvatarUrl(value)).toBeNull()
  })
})
