import { z } from 'zod'

/**
 * 侵權通知表單（`SCREENS §15.3`、著作權法 §90-6）。
 *
 * ⚠️ 這份 schema 是 `server/api/legal/notice.post.ts` 那一份的**鏡像**，
 * 界限（100／200／50／2000／500、`min(10)`、善意聲明必為 true）逐項對齊。
 * 前端這一份的作用不是把關——把關在伺服器——而是**讓人在送出之前就知道哪裡不對**。
 * 這個窗口的使用者是法務或權利人，操作失敗率比一般使用者高，
 * 而窗口沒開就不符 §90-4 第 3 款：**擋掉他們的代價是法遵要件失效**，
 * 所以每一條訊息都要說「怎麼修」，不是「你錯了」。
 *
 * ⚠️ 兩份 schema 分岔的話會出現最難查的那種症狀：前端過了、伺服器回 422，
 * 而 422 的訊息長在另一個檔案裡。改任何一條界限時兩邊一起改。
 */

/**
 * 沒有 scheme 的網址補上 `https://`。
 *
 * 不是為了寬鬆而寬鬆：`filmnote.tw/film/abc` 是一個**看得懂的答案**，
 * 因為少打四個字就把一份侵權通知擋在門外，是拿法遵要件去換一條驗證規則。
 * 補完之後會寫回輸入框，所以使用者看得到我們改了什麼，也改得回來——
 * 這跟「悄悄替他決定」不是同一件事。
 *
 * 判斷不出是網址的字串**原樣回傳**，讓 `z.url()` 去報錯，
 * 而不是硬補一個 scheme 把「這根本不是網址」變成「這是一個怪網址」。
 */
export function normalizeTargetUrl(raw: string): string {
  const value = raw.trim()
  if (!value)
    return value
  if (/^[a-z][\w+.-]*:\/\//i.test(value))
    return value
  // `example.com`、`example.com/a`、`example.com:8080` → 補 scheme
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value))
    return `https://${value}`
  return value
}

export const takedownSchema = z.object({
  claimantName: z.string().trim().min(1, '請填寫你的姓名或單位名稱').max(100, '最多 100 字'),

  // 這是唯一的回覆管道，所以格式錯誤要在送出前就攔下來——
  // 送出之後我們沒有第二個方法找到他。
  claimantEmail: z.email('這個電子郵件看起來不完整，請再確認一次').max(200, '最多 200 字'),

  claimantPhone: z.string().trim().max(50, '最多 50 字').optional(),

  workDescription: z
    .string()
    .trim()
    .min(10, '請再多寫一點，要能辨識出是哪一個著作')
    .max(2000, '最多 2000 字'),

  // ⚠️ 用 `.transform().pipe()` 而不是 `z.preprocess()`：後者在 zod 4 推不出
  // 輸出型別（`z.output` 是 `unknown`），而 `UForm` 的 `:state` 型別是
  // `Partial<z.output<schema>>` ⇒ 整個表單狀態會退化成 unknown，typecheck 紅。
  targetUrl: z
    .string()
    .transform(normalizeTargetUrl)
    .pipe(z.url('請貼上完整的網址，例如 https://filmnote.tw/film/…').max(500, '最多 500 字')),

  // §90-6 的要件：沒有勾就不是一份完整的通知。
  // ⚠️ 伺服器那一份是 `z.literal(true)`，這裡是 `boolean` + `refine`——
  // 驗證行為一模一樣，差別純粹在型別：`literal(true)` 會讓「還沒勾」這個
  // 合法的中間狀態在型別上不存在，而 `UForm` 的 `:state` 要吃得下它。
  // 真正的把關在伺服器，送出時 `toTakedownPayload` 一律送 `true as const`。
  statementGoodFaith: z.boolean().refine(v => v === true, { error: '請勾選善意聲明，這是法定要件' }),
})

export type TakedownForm = z.output<typeof takedownSchema>

/** 送到 `/api/legal/notice` 的形狀。空電話送 null 而不是空字串。 */
export function toTakedownPayload(form: TakedownForm) {
  return {
    claimantName: form.claimantName,
    claimantEmail: form.claimantEmail,
    claimantPhone: form.claimantPhone?.trim() ? form.claimantPhone.trim() : null,
    workDescription: form.workDescription,
    targetUrl: form.targetUrl,
    statementGoodFaith: true as const,
  }
}

/**
 * 本站網址 → 作品 slug。解析不出來回 null。
 *
 * ⚠️ **刻意只認 `/film/{slug}`，而且刻意不看網域**——`server/api/legal/notice.post.ts`
 * 的 `resolveTargetFilm()` 就是這樣做的。畫面上回顯的東西必須跟資料庫裡
 * `target_film_id` 真正會填進去的東西**是同一個判斷**：回顯認得出、伺服器認不出，
 * 使用者會以為我們已經定位到那一筆，而 admin 打開來看到的是空的。
 */
export function filmSlugFromUrl(targetUrl: string): string | null {
  try {
    const path = new URL(normalizeTargetUrl(targetUrl)).pathname
    const slug = /^\/film\/([^/]+)\/?$/.exec(path)?.[1]
    return slug ? decodeURIComponent(slug) : null
  }
  catch {
    return null
  }
}
