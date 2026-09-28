import type { UgcPosterSigner } from '../shared/ugc-poster'
import { describe, expect, it } from 'vitest'
import { signUgcPosters, UGC_POSTER_BUCKET, UGC_POSTER_TTL_SECONDS } from '../shared/ugc-poster'

/** 假的 storage：記下每一次呼叫，回傳 `signed` 裡有的那幾條。 */
function fakeClient(signed: Record<string, string | null>, fail = false) {
  const calls: { bucket: string, paths: string[], ttl: number }[] = []
  const client: UgcPosterSigner = {
    storage: {
      from: bucket => ({
        createSignedUrls: async (paths, ttl) => {
          calls.push({ bucket, paths, ttl })
          if (fail)
            return { data: null }
          return { data: paths.filter(p => p in signed).map(p => ({ path: p, signedUrl: signed[p] ?? null })) }
        },
      }),
    },
  }
  return { client, calls }
}

describe('使用者上傳海報（UGC）的簽名規則（/api/u 與 useMyRecords 共用）', () => {
  it('★ 批次簽一次：去掉空值、去重，bucket 與 TTL 固定', async () => {
    const { client, calls } = fakeClient({ 'a.webp': 'https://s/a', 'b.webp': 'https://s/b' })
    await signUgcPosters(client, ['a.webp', null, 'b.webp', undefined, 'a.webp', ''])
    expect(calls).toEqual([{ bucket: UGC_POSTER_BUCKET, paths: ['a.webp', 'b.webp'], ttl: UGC_POSTER_TTL_SECONDS }])
    expect(UGC_POSTER_BUCKET).toBe('ugc-poster')
    expect(UGC_POSTER_TTL_SECONDS).toBe(3600)
  })

  it('★ 路徑換成 signed URL；沒有路徑就是沒有海報', async () => {
    const { client } = fakeClient({ 'a.webp': 'https://s/a' })
    const url = await signUgcPosters(client, ['a.webp'])
    expect(url('a.webp')).toBe('https://s/a')
    expect(url(null)).toBeNull()
    expect(url(undefined)).toBeNull()
  })

  it('★ 簽不出來的（匿名 client 對未審核海報）當作沒有海報，不是回傳路徑', async () => {
    // 路徑直接塞 `<img src>` 會 400；退回路徑比退回 null 更糟。
    const { client } = fakeClient({ 'ok.webp': 'https://s/ok', 'pending.webp': null })
    const url = await signUgcPosters(client, ['ok.webp', 'pending.webp', 'gone.webp'])
    expect(url('pending.webp')).toBeNull()
    expect(url('gone.webp')).toBeNull()
  })

  it('storage 整批失敗時一律沒有海報，不 throw', async () => {
    const { client } = fakeClient({}, true)
    const url = await signUgcPosters(client, ['a.webp'])
    expect(url('a.webp')).toBeNull()
  })

  it('沒有任何 UGC 海報就不打 storage', async () => {
    const { client, calls } = fakeClient({})
    await signUgcPosters(client, [null, undefined])
    expect(calls).toHaveLength(0)
  })
})
