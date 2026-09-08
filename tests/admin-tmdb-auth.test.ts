/**
 * `/api/admin/tmdb/**` 守門的斷言。
 *
 * ── 為什麼這支測試值得存在 ─────────────────────────────────────────────────
 * 這幾支端點是這個 repo 裡少見的形狀：**先自己判斷授權，通過之後才用
 * service_role 幹活**。approve / merge 那種「整段丟給 RPC，讓資料庫決定」
 * 的寫法在這裡用不上，因為 `tmdb_refresh_due` 只 grant 給 service_role、
 * `purge_expired_tmdb_cache()` 只認 `is_service_context()`——沒有任何一支
 * RPC 會替我們問「呼叫者是不是 staff」。
 *
 * ⚠️ BUILD_PLAN §1.1：這個 repo 的授權被攻破過一次，攻破它的是**已登入但
 *   不是 staff** 的一般使用者。所以下面那條 `已登入但不是 staff` 的斷言不是
 *   湊數，它就是那次事故的迴歸測試。只擋匿名等於沒擋。
 *
 * ── 這些斷言被我親手弄壞驗證過 ─────────────────────────────────────────────
 * 每一條斷言都做過「故意把它守的東西弄壞一次，確認它會紅」，過程與輸出寫在
 * 回報的 measurements 裡。這個 repo 的交接筆記反覆記載「四個檢查全綠而東西是
 * 壞的」，所以綠燈本身不是證據，紅過才是。
 */

import { describe, expect, it, vi } from 'vitest'
import { apiErrorText, stampText } from '../app/utils/admin-format'
import { assertStaffFrom } from '../server/utils/admin-auth'
import { clampManualOptions, MANUAL_DEFAULT_BUDGET_MS, MANUAL_MAX_BUDGET_MS } from '../server/utils/admin-tmdb-options'
import { parseRefreshOptions } from '../server/utils/tmdb-refresh-options'

/** h3 的 createError 把狀態碼放在 `statusCode`。 */
function statusOf(e: unknown): number | undefined {
  return (e as { statusCode?: number })?.statusCode
}

/**
 * 造一個 probe，並記錄「誰被呼叫了、以什麼順序」。
 *
 * 順序本身是這一項唯一真正危險的地方，所以它必須是可斷言的，不能只靠讀程式碼。
 */
function probeFor(options: {
  user?: { sub: string } | null
  isStaff?: { data: boolean | null, error: { code?: string, message?: string } | null }
}) {
  const calls: string[] = []
  const probe = {
    user: vi.fn(async () => {
      calls.push('user')
      return options.user ?? null
    }),
    isStaff: vi.fn(async () => {
      calls.push('isStaff')
      return options.isStaff ?? { data: null, error: null }
    }),
  }
  return { probe, calls }
}

/**
 * ⚠️ **`sub` 不是 `id`**（踩雷 #13）。`serverSupabaseUser()` 回的是 JWT claims，
 * `sub` 是 `RequiredClaims` 的必填欄位、`id` 根本不存在。`StaffProbe.user` 的型別
 * 刻意寫成 `{ sub }` 就是為了讓端點能直接把 `serverSupabaseUser(event)` 接上去、
 * 一行轉換都不用寫——沒有轉換就沒有寫錯的機會。
 */
const STAFF = { sub: '00000000-0000-4000-8000-000000000001' }
const PLAIN_USER = { sub: '00000000-0000-4000-8000-000000000002' }

describe('assertStaffFrom —— 授權順序', () => {
  it('未登入 → 401，而且**根本不去問 is_staff()**', async () => {
    const { probe, calls } = probeFor({ user: null })

    await expect(assertStaffFrom(probe)).rejects.toSatisfy(e => statusOf(e) === 401)

    // 順序斷言：① 沒過就不會走到 ②。把兩步對調的話這裡會多一個 'isStaff'。
    expect(calls).toEqual(['user'])
    expect(probe.isStaff).not.toHaveBeenCalled()
  })

  it('★ 已登入但不是 staff（is_staff() 回 false）→ 403', async () => {
    // ★ 這就是 §1.1 真正攻破過這個 repo 的那一種呼叫者。
    //   拿掉 assertStaffFrom 的 ② 之後，這一條會從 403 變成「順利通過」。
    const { probe } = probeFor({
      user: PLAIN_USER,
      isStaff: { data: false, error: null },
    })

    await expect(assertStaffFrom(probe)).rejects.toSatisfy(e => statusOf(e) === 403)
  })

  it('is_staff() 回 null（RPC 給了空答案）也要擋，不可以當成通過', async () => {
    const { probe } = probeFor({
      user: PLAIN_USER,
      isStaff: { data: null, error: null },
    })

    await expect(assertStaffFrom(probe)).rejects.toSatisfy(e => statusOf(e) === 403)
  })

  it('is_staff() 被權限擋下（42501）→ 403，不是 500', async () => {
    const { probe } = probeFor({
      user: PLAIN_USER,
      isStaff: { data: null, error: { code: '42501', message: 'permission denied' } },
    })

    await expect(assertStaffFrom(probe)).rejects.toSatisfy(e => statusOf(e) === 403)
  })

  it('is_staff() 查不出答案（連線錯誤）→ 擋下並回 500，不可以放行', async () => {
    // 「問不到答案就當作有權限」是這一類守門最常見的死法。
    const { probe } = probeFor({
      user: PLAIN_USER,
      isStaff: { data: null, error: { message: 'connection reset' } },
    })

    await expect(assertStaffFrom(probe)).rejects.toSatisfy(e => statusOf(e) === 500)
  })

  it('是 staff → 通過，並回傳呼叫者（稽核日誌要記 id）', async () => {
    const { probe, calls } = probeFor({
      user: STAFF,
      isStaff: { data: true, error: null },
    })

    // ★ 兩件事一起釘：① 回的 `id` 取自 claims 的 `sub`（接錯就是 undefined）；
    //   ② 回傳值**只有 `id`**——不是把整包 JWT claims（email、app_metadata、
    //   session_id）原樣透傳出去，那會被呼叫端寫進稽核日誌。
    await expect(assertStaffFrom(probe)).resolves.toEqual({ id: STAFF.sub })
    // ① 一定在 ② 之前。
    expect(calls).toEqual(['user', 'isStaff'])
  })
})

describe('手動觸發的時間預算為什麼需要自己的上限', () => {
  /**
   * `parseRefreshOptions()` 是 cron 那條路徑用的，它的上限是 **30 分鐘**。
   *
   * 這一條斷言的用途是把「為什麼手動端點要再夾一次」釘住：不是多此一舉，
   * 而是共用的那一支根本擋不住瀏覽器送進來的大數字。Vercel 的函式執行時間
   * 上限（Hobby 300 秒）之下，30 分鐘的預算等於保證 504。
   *
   * ⚠️ 若哪天有人把 MAX_BUDGET_MS 調小到手動上限以下，這一條會紅——那正是
   *   我要的：屆時手動端點的那一夾就可以拿掉，而不是留著兩份會漂移的規則。
   */
  it('共用的 parseRefreshOptions 會放行遠超過函式執行時間的預算', () => {
    const parsed = parseRefreshOptions({ budget: '1800000' })
    expect(parsed.budgetMs).toBe(1_800_000)
    expect(parsed.budgetMs).toBeGreaterThan(300_000)
  })

  it('它也不會把亂填的值變成 0（誤打不該變成「立刻收工」）', () => {
    expect(parseRefreshOptions({ budget: 'abc' }).budgetMs).toBe(8_000)
    expect(parseRefreshOptions({ budget: '0' }).budgetMs).toBe(500)
  })

  /**
   * ★ 上面兩條守的是**共用的那一支**，一條都沒有守到手動端點自己那一夾。
   *   對抗式覆核（2026-09-08）實測：把 `Math.min(..., MANUAL_MAX_BUDGET_MS)`
   *   刪掉，這個檔仍然全綠。斷言存在、名字也對，但它守的不是它宣稱要守的東西
   *   ——這正是這個 repo 反覆記載的「檢查機制本身失效」。
   *
   *   夾子因此被搬到 `server/utils/admin-tmdb-options.ts`（純函式、沒有
   *   `#supabase/server` 的相依，vitest 載得進來），下面兩條才真的守得到它。
   */
  it('手動端點把超大的預算夾到自己的上限', () => {
    expect(clampManualOptions({ budgetMs: 1_800_000 }).budgetMs).toBe(MANUAL_MAX_BUDGET_MS)
    expect(clampManualOptions({ budgetMs: 90_000 }).budgetMs).toBe(MANUAL_MAX_BUDGET_MS)
  })

  it('沒填就用手動的預設值，而且那個預設值本身在上限之內', () => {
    expect(clampManualOptions({}).budgetMs).toBe(MANUAL_DEFAULT_BUDGET_MS)
    expect(MANUAL_DEFAULT_BUDGET_MS).toBeLessThanOrEqual(MANUAL_MAX_BUDGET_MS)
  })

  /**
   * limit 與 budget 是兩條獨立的線。夾預算的時候把 limit 一起夾壞過一次的話，
   * 症狀是「報告說大部分沒做」而不是錯誤訊息，所以這一條要分開釘。
   */
  it('夾預算不會動到 limit', () => {
    expect(clampManualOptions({ limit: 250, budgetMs: 1_800_000 }).limit).toBe(250)
    expect(clampManualOptions({}).limit).toBe(100)
  })
})

describe('stampText —— 維護畫面上的時間戳', () => {
  /**
   * ★ 這一條才是重點：`fetched_at` 是 `timestamptz`，而全站的日期語意是**台北
   *   牆上時間**。用瀏覽器本地時區去 format 的話，在非台灣的機器上（包括
   *   Vercel 的函式與 CI）會顯示成偏一個時區的時間，而那種錯不會有人注意到
   *   ——它看起來就只是「早了 8 小時」。
   *
   *   下面這個值是資料庫裡真實的一列（2026-09-07 以 db:sql 讀出來的
   *   `max(fetched_at)`）：`2026-09-05 18:29:18.9+00` ⇒ 台北時間隔天 02:29。
   *   跨日這件事本身就是斷言的一部分。
   */
  it('uTC 的 18:29 在台北是隔天 02:29（跨日）', () => {
    expect(stampText('2026-09-05T18:29:18.9+00:00')).toBe('2026/09/06 02:29')
  })

  it('用 24 小時制，時與分都補零（tabular-nums 要對得齊）', () => {
    expect(stampText('2026-01-05T20:05:00Z')).toBe('2026/01/06 04:05')
    expect(stampText('2026-01-05T16:00:00Z')).toBe('2026/01/06 00:00')
  })

  it('空值與不合法的輸入回空字串，不做盡量拼湊', () => {
    expect(stampText(null)).toBe('')
    expect(stampText(undefined)).toBe('')
    expect(stampText('')).toBe('')
    expect(stampText('不是時間')).toBe('')
  })
})

describe('apiErrorText —— $fetch 包過的錯誤', () => {
  /**
   * ⚠️ 這一條守的是一個很容易寫錯的細節：`createError({ statusMessage })` 經過
   *   `$fetch` 之後會落在 **`data.statusMessage`**，而頂層的 `message` 是
   *   `[POST] "/api/…": 403 Forbidden` 這種對管理者沒有意義的字串。
   *   取錯欄位的話，「需要審核權限」會變成一串 HTTP 雜訊。
   */
  it('優先取 data.statusMessage，而不是 $fetch 自己組的 message', () => {
    const fetchError = {
      message: '[POST] "/api/admin/tmdb/refresh": 403 Forbidden',
      statusMessage: 'Forbidden',
      data: { statusMessage: '需要審核權限' },
    }
    expect(apiErrorText(fetchError)).toBe('需要審核權限')
  })

  it('沒有 data 時退回頂層 statusMessage，再退回 message', () => {
    expect(apiErrorText({ statusMessage: '請先登入' })).toBe('請先登入')
    expect(apiErrorText({ message: 'Failed to fetch' })).toBe('Failed to fetch')
  })

  it('什麼都沒有時給一句話，不是 undefined', () => {
    expect(apiErrorText(null)).toBe('未知錯誤')
    expect(apiErrorText({})).toBe('未知錯誤')
  })
})
