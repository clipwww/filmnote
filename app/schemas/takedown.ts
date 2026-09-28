import { z } from 'zod'

/**
 * 侵權通知（`SCREENS §15.3`、著作權法 §90-6）。**前端表單與 `server/api/legal/notice.post.ts`
 * 共用這一個模組**：界限（100／200／50／2000／500、`min(10)`、善意聲明必為 true）、網址補全、
 * 空電話→null、送出形狀、`/film/{slug}` 解析都只在這裡寫一次。
 */
/*
 * 這個窗口的使用者是法務或權利人，操作失敗率比一般使用者高，而窗口沒開就不符 §90-4 第 3 款
 * ⇒ **擋掉他們的代價是法遵要件失效**，每一條訊息都要說「怎麼修」不是「你錯了」。
 * ⚠️ 以前是兩份鏡像，分岔的症狀最難查：前端過了、伺服器回 422，而 422 的訊息長在另一個檔案裡。
 */
/*
 * ⚠️ 這個檔要維持**自給自足**（只 import zod）：伺服器以 `~~/app/schemas/takedown` 在執行期
 * 載入它、vitest 也直接載入它——加一個 Nuxt 專屬 alias 或 auto-import，兩邊會一起壞。
 */

/**
 * 沒有 scheme 的網址補上 `https://`。不是為了寬鬆而寬鬆：`example.tw/film/abc` 是一個
 * **看得懂的答案**，因為少打四個字就把一份侵權通知擋在門外，是拿法遵要件去換一條驗證規則。
 * 補完會寫回輸入框（使用者看得到我們改了什麼，也改得回來），這跟「悄悄替他決定」不同。
 */
/*
 * 判斷不出是網址的字串**原樣回傳**讓 `z.url()` 去報錯，而不是硬補一個 scheme
 * 把「這根本不是網址」變成「這是一個怪網址」。
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

/** 空白或沒填的電話一律存 null，不存空字串——admin 那邊「有沒有留電話」才只有一種判斷。 */
export function phoneOrNull(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  return value || null
}

const GOOD_FAITH_ERROR = '請勾選善意聲明，這是法定要件'

/** 兩個變體共用的欄位。只有電話與善意聲明因為型別需求而分開寫（見下面兩個 schema）。 */
const sharedFields = {
  claimantName: z.string().trim().min(1, '請填寫你的姓名或單位名稱').max(100, '最多 100 字'),

  // 這是唯一的回覆管道，所以格式錯誤要在送出前就攔下來——
  // 送出之後我們沒有第二個方法找到他。
  claimantEmail: z.email('這個電子郵件看起來不完整，請再確認一次').max(200, '最多 200 字'),

  workDescription: z
    .string()
    .trim()
    .min(10, '請再多寫一點，要能辨識出是哪一個著作')
    .max(2000, '最多 2000 字'),

  // ⚠️ 用 `.transform().pipe()` 而不是 `z.preprocess()`：後者在 zod 4 推不出
  // 輸出型別（`z.output` 是 `unknown`），而 `UForm` 的 `:state` 型別是
  // `Partial<z.output<schema>>` ⇒ 整個表單狀態會退化成 unknown，typecheck 紅（#95）。
  targetUrl: z
    .string()
    .transform(normalizeTargetUrl)
    // ⚠️ 訊息裡**刻意不寫任何網域**：這是純模組（伺服器也 import 它）讀不到 `siteUrl`，而本站
    //    網域會變。寫死的代價不是不精確，是**在受理窗口上叫權利人去貼一個不是本站的位址**。
    //    真正的來源示範由輸入框的 placeholder 提供，那裡讀得到 siteUrl。
    .pipe(z.url('請貼上完整的網址，要包含開頭的 https://').max(500, '最多 500 字')),
}

const phoneField = z.string().trim().max(50, '最多 50 字')

/**
 * 表單變體（`UForm` 用）。§90-6 的善意聲明：沒有勾就不是一份完整的通知。
 * ⚠️ 這裡是 `boolean` + `refine`、伺服器變體是 `z.literal(true)`——驗證行為一樣，差別在型別：
 *    `literal(true)` 會讓「還沒勾」這個合法中間狀態在型別上不存在，`:state` 吃不下它（#95）。
 */
export const takedownSchema = z.object({
  ...sharedFields,
  claimantPhone: phoneField.optional(),
  statementGoodFaith: z.boolean().refine(v => v === true, { error: GOOD_FAITH_ERROR }),
})

/**
 * 伺服器變體（`/api/legal/notice` 用），真正把關的那一份。輸出已經是要寫進
 * `takedown_notice` 的值：網址已補全、空電話已是 null。
 * ⚠️ 電話要吃 `null`：`toTakedownPayload()` 送的就是 null，拿掉 `.nullish()` 每一份沒留電話的通知都 422。
 */
export const takedownNoticeSchema = z.object({
  ...sharedFields,
  claimantPhone: phoneField.nullish().transform(phoneOrNull),
  statementGoodFaith: z.literal(true, { error: GOOD_FAITH_ERROR }),
})

export type TakedownForm = z.output<typeof takedownSchema>
/** 送到 `/api/legal/notice` 的形狀。型別綁在伺服器變體的輸入上，兩邊漂移會先紅在 typecheck。 */
export type TakedownPayload = z.input<typeof takedownNoticeSchema>

export function toTakedownPayload(form: TakedownForm): TakedownPayload {
  return {
    claimantName: form.claimantName,
    claimantEmail: form.claimantEmail,
    claimantPhone: phoneOrNull(form.claimantPhone),
    workDescription: form.workDescription,
    targetUrl: form.targetUrl,
    statementGoodFaith: true,
  }
}

/**
 * 本站網址 → 作品 slug，解析不出來回 null。⚠️ **刻意只認 `/film/{slug}` 而且刻意不看網域**。
 * 畫面回顯與伺服器填 `target_film_id` 都呼叫這一支：回顯認得出、伺服器認不出，使用者會以為
 * 我們已經定位到那一筆，而 admin 打開來看到的是空的。
 */
/*
 * ⚠️ `decodeURIComponent` 必須留在 try 裡：`/film/%E0%A4` 這種壞掉的跳脫會丟 URIError，
 * 以前伺服器那份在 try 外面解碼 ⇒ 500，一份法定通知就這樣沒寫進去。
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
