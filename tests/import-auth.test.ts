/**
 * 「匯入舊紀錄」限定本人的斷言（`server/utils/import-auth.ts`）。
 *
 * ⚠️ 這守的是一道**功能閘門**，不是權限邊界：`/app/import` 的寫入是瀏覽器端帶
 * 使用者自己的 JWT 走 RLS 做的，任何登入者本來就能從 `/app/records/new` 寫自己的
 * 紀錄。這些斷言證明的是「這個工具只給本人用」，**不是**「別人寫不進資料」。
 * 把它讀成後者，就會有人在這道閘門後面放真正需要保護的東西。
 *
 * ── 這裡不需要造測試帳號 ───────────────────────────────────────────────────
 * 決策抽成注入 probe 的純函式（同 `admin-auth.ts`），所以三種呼叫者都是一個物件
 * 字面值，不必起伺服器、不必真的建一個 `zz` 前綴的第二帳號、也就沒有要清掉的殘留。
 *
 * ── 反向斷言 ───────────────────────────────────────────────────────────────
 * 「本人 → 放行」那一條就是反向組：少了它，把整支函式改成「永遠 throw 403」
 * 也會全綠，於是分不出「擋住了」與「整個工具壞掉了」。
 */

import { describe, expect, it } from 'vitest'
import { assertImportOwnerFrom, decideImportOwnerFrom, normalizeEmail } from '../server/utils/import-auth'

/** h3 的 createError 把狀態碼放在 `statusCode`。 */
function statusOf(e: unknown): number | undefined {
  return (e as { statusCode?: number })?.statusCode
}

const OWNER = 'owner@example.test'

function probeFor(options: {
  user?: { sub: string, email?: unknown } | null
  allowedEmail?: string | undefined
}) {
  return {
    user: async () => (options.user === undefined ? { sub: 'u-1', email: OWNER } : options.user),
    allowedEmail: () => ('allowedEmail' in options ? options.allowedEmail : OWNER),
  }
}

/** 取 throw 出來的狀態碼；沒 throw 是測試失敗（而不是回傳 undefined）。 */
async function statusOfThrown(run: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await run()
  }
  catch (e) {
    return statusOf(e)
  }
  throw new Error('預期要 throw，但它回傳了——閘門沒有擋住')
}

describe('匯入閘門：三種呼叫者', () => {
  it('未登入 → 401（還沒有身分，不是「不是本人」）', async () => {
    expect(await statusOfThrown(() => assertImportOwnerFrom(probeFor({ user: null })))).toBe(401)
  })

  it('已登入但 email 不符 → 403（他登入了，只是不准用；回 401 會叫他去重新登入）', async () => {
    const probe = probeFor({ user: { sub: 'u-2', email: 'someone@example.test' } })
    expect(await statusOfThrown(() => assertImportOwnerFrom(probe))).toBe(403)
  })

  it('★ 反向組：本人 → 放行，並且只回 id（不把 JWT claims 往外傳）', async () => {
    await expect(assertImportOwnerFrom(probeFor({ user: { sub: 'u-1', email: OWNER } })))
      .resolves
      .toEqual({ id: 'u-1' })
  })
})

describe('失敗方向必須是關閉的', () => {
  it('沒設 IMPORT_TARGET_EMAIL → 連本人也不能用', async () => {
    const probe = probeFor({ user: { sub: 'u-1', email: OWNER }, allowedEmail: undefined })
    expect(await statusOfThrown(() => assertImportOwnerFrom(probe))).toBe(403)
  })

  it('空白字串的 IMPORT_TARGET_EMAIL → 同樣全部擋下（trim 後等於沒設）', async () => {
    const probe = probeFor({ user: { sub: 'u-1', email: OWNER }, allowedEmail: '   ' })
    expect(await statusOfThrown(() => assertImportOwnerFrom(probe))).toBe(403)
  })

  it('jWT 沒有 email claim → 擋下（不要把「取不到」當成「相符」）', async () => {
    const probe = probeFor({ user: { sub: 'u-3' } })
    expect(await statusOfThrown(() => assertImportOwnerFrom(probe))).toBe(403)
  })
})

describe('email 正規化：只做 trim 與 toLowerCase', () => {
  it('大小寫與前後空白的差異不影響判定', async () => {
    const probe = probeFor({ user: { sub: 'u-1', email: `  ${OWNER.toUpperCase()} ` } })
    await expect(assertImportOwnerFrom(probe)).resolves.toEqual({ id: 'u-1' })
  })

  it('★ 不做 Gmail 的 + 別名正規化——「誰能用」不該是一個要推理的問題', async () => {
    const probe = {
      user: async () => ({ sub: 'u-4', email: 'owner+import@example.test' }),
      allowedEmail: () => OWNER,
    }
    expect(await statusOfThrown(() => assertImportOwnerFrom(probe))).toBe(403)
  })

  it('normalizeEmail 對非字串一律回空字串（undefined / null / 物件都不算相符）', () => {
    expect([normalizeEmail(undefined), normalizeEmail(null), normalizeEmail({})]).toEqual(['', '', ''])
  })
})

describe('/api/import/allowed 的裁決不可以變成 email 探測器', () => {
  it('非本人時 decide 回 allowed:false 而不 throw（端點才能一律回 200）', async () => {
    const v = await decideImportOwnerFrom(probeFor({ user: { sub: 'u-2', email: 'x@example.test' } }))
    expect(v).toEqual({ allowed: false, reason: 'not-owner' })
  })

  it('未登入時 decide 仍然 throw 401（那是身分問題，不是裁決問題）', async () => {
    expect(await statusOfThrown(() => decideImportOwnerFrom(probeFor({ user: null })))).toBe(401)
  })

  it('★ 兩條路徑共用同一個判斷：assert 放行的人，decide 一定回 allowed:true', async () => {
    const probe = probeFor({ user: { sub: 'u-1', email: OWNER } })
    await expect(assertImportOwnerFrom(probe)).resolves.toEqual({ id: 'u-1' })
    await expect(decideImportOwnerFrom(probe)).resolves.toEqual({ allowed: true, caller: { id: 'u-1' } })
  })
})
