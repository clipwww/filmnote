/**
 * UGC 海報的簽名規則，`/api/u/[username]`（匿名 client）與 `useMyRecords()`（使用者 client）共用。
 * **規則在這裡、權限在呼叫端**：傳哪一個 client 進來就是用誰的身分簽，兩邊的差別是刻意的。
 */
/*
 * ⚠️ 放 `shared/` 根目錄不放 `shared/utils/`：後者會被 app 與 server 同時 auto-import，
 *   多一個撞名的地方。呼叫端一律顯式 `import … from '#shared/ugc-poster'`。
 * ⚠️ 不 import supabase 的型別與 `#supabase/*`：要能被 vitest 直接載入（§7 #212），client 用結構型別。
 */

/** private bucket。`ugc_poster_path` 是這裡面的**路徑不是 URL**，直接塞 `<img src>` 會 400。 */
export const UGC_POSTER_BUCKET = 'ugc-poster'

/** 一小時。`/u/**` 不快取，簽出來的 URL 只活在這一次回應／這一次 client 取資料裡。 */
export const UGC_POSTER_TTL_SECONDS = 60 * 60

/** 只描述用得到的那一小段：`client.storage.from(bucket).createSignedUrls(paths, ttl)`。 */
export interface UgcPosterSigner {
  storage: {
    from: (bucket: string) => {
      createSignedUrls: (paths: string[], expiresIn: number) => PromiseLike<{
        data: { path: string | null, signedUrl: string | null }[] | null
      }>
    }
  }
}

/**
 * 批次簽一次（不要一部片一個往返），回傳「路徑 → signed URL」的查表函式。簽不出來（未審核的
 * 海報對匿名 client、或 storage 出錯）一律當作**沒有海報**：回 null，不 throw。
 */
export async function signUgcPosters(
  client: UgcPosterSigner,
  paths: readonly (string | null | undefined)[],
): Promise<(path: string | null | undefined) => string | null> {
  const unique = [...new Set(paths.filter((p): p is string => !!p))]
  const byPath = new Map<string, string>()
  if (unique.length) {
    const { data } = await client.storage
      .from(UGC_POSTER_BUCKET)
      .createSignedUrls(unique, UGC_POSTER_TTL_SECONDS)
    for (const s of data ?? []) {
      if (s.path && s.signedUrl)
        byPath.set(s.path, s.signedUrl)
    }
  }
  return path => (path ? byPath.get(path) ?? null : null)
}
