<script setup lang="ts">
import { apiErrorText, stampText } from '~/utils/admin-format'

/**
 * TMDB 快取維護（`/admin`）。
 *
 * ── ⚠️ 檔名前綴的 `-` 不可省 ────────────────────────────────────────────────
 * `pages/` 掃的是 `.vue` **和** `.ts`，共用元件直接放進去會冒出一條
 * `/admin/-tmdb-maintenance` 路由（踩雷 #131）。加了前綴掃描器就跳過它，而顯式
 * 相對 import 照樣可用——那走 Vite 的解析，不看 nuxt 的 ignore 清單。
 *
 * ── 這一頁在解決什麼 ───────────────────────────────────────────────────────
 * David 說「免費的 Vercel 好像不能使用 cron job」。**那個前提不成立**：Vercel 官方
 * 文件寫 "Cron jobs are included in all plans."，Hobby 每專案 100 條、最短一天
 * 一次、精度是該小時內 ±59 分。`vercel.json` 的兩條排程照舊有效，**沒有被取代**。
 *
 * 但這一頁仍然要做，理由跟 cron 能不能用無關：
 *   1. cron 目前唯一的觀測面是 `console.log` ⇒ **站上完全看不出它昨天有沒有跑**
 *   2. 失敗了沒有重試入口——要重跑只能拿 CRON_SECRET 去 curl
 *   3. 剛匯入一批作品時要等到隔天 03:00（而且會浮動到 03:59）
 *   4. 六個月條款的到期清除若要立刻執行，一天一次不夠即時
 *
 * ⇒ 所以這一頁的第一等公民是**上面那三個數字**，不是兩顆按鈕。進來就看得到
 *   「到期待刷新幾列」，不是按了才知道。
 *
 * ── ★ 按不完再按，是設計不是缺陷 ───────────────────────────────────────────
 * `runTmdbRefresh()` **以時間預算收尾，不是以筆數收尾**（`server/utils/tmdb-refresh.ts`
 * 檔頭寫了理由：跑到一半被砍會留下一批 attempts 沒加、next_refresh_at 沒推的列）。
 * 超過預算就停止取新工作，剩下的列 `next_refresh_at` 仍 ≤ now()，下次會再被
 * view 給出來。所以 `abortedBy === 'budget'` **是正常且預期的收尾**，畫面上一定
 * 不能畫成錯誤——畫成錯誤的話管理者會以為壞了而不敢再按，那正好把用法弄反。
 */

interface TmdbStatus {
  due: number
  tracked: number
  purgeable: number | null
  purgeableError: string | null
  lastFetchedAt: string | null
  /** 查不到「最後更新時間」時的原因。⚠️ 不能吞：null 跟「從沒 fetch 過」在畫面上一模一樣。 */
  lastFetchedError: string | null
  checkedAt: string
}

interface RefreshReport {
  due: number
  claimed: number
  fresh: number
  gone: number
  failed: number
  untouched: number
  applied: number
  tmdb: { requests: number, retries: number, throttled: number }
  elapsedMs: number
  abortedBy: 'budget' | 'throttle' | 'fatal' | null
  errors: string[]
  options: { limit: number, budgetMs: number, concurrency: number }
}

const toast = useToast()

const {
  data: status,
  status: statusState,
  error: statusError,
  refresh: refreshStatus,
} = useAsyncData(
  'admin-tmdb-status',
  () => $fetch<TmdbStatus>('/api/admin/tmdb/status'),
  // 同 `useStaffGate()`：這幾頁是 SPA 語意（`SCREENS §14`），伺服器端不預先算。
  { server: false },
)

// ─────────────────────────────────────────────────────────────────────────────
// 旋鈕
// ─────────────────────────────────────────────────────────────────────────────
/**
 * ★ 最大的那一格（60 秒）就是**伺服器端的上限**
 * （`server/api/admin/tmdb/refresh.post.ts` 的 `MANUAL_MAX_BUDGET_MS`）。
 * 選單只給到上限，所以這裡送不出超過上限的值；伺服器仍然會再夾一次，而且會把
 * **實際生效的預算**放在回應的 `options` 裡（下方「這一輪實際用了」那一行）——
 * 兩邊哪天分岔了，畫面上看得出來，不會靜默地跑了另一個數字。
 *
 * 為什麼上限不是 300 秒（Vercel Hobby 的函式執行上限）：預算只決定「要不要再取
 * 新工作」，不會砍掉已經在飛的請求，最壞情況還要等 TMDB 的整套退避跑完（約 62 秒）。
 * 而且真正的限制是**有個人在瀏覽器前面等**。理由完整寫在那個端點的檔頭。
 */
const BUDGET_OPTIONS = [
  { label: '5 秒（試一下）', value: 5_000 },
  { label: '15 秒（預設）', value: 15_000 },
  { label: '30 秒', value: 30_000 },
  { label: '60 秒（上限）', value: 60_000 },
]

/**
 * ⚠️ limit 開大**不會**讓一輪做得更多——做多少是預算決定的。多出來的只會變成
 * `untouched`（取出來但沒動到），讓報告看起來像「大部分沒做」。所以預設維持 100，
 * 只有在剛匯入一大批、而且預算也調大時才有必要往上調。
 */
const LIMIT_OPTIONS = [
  { label: '100 列（預設）', value: 100 },
  { label: '300 列', value: 300 },
  { label: '1000 列（上限）', value: 1000 },
]

const budgetMs = ref(15_000)
const limit = ref(100)

// ─────────────────────────────────────────────────────────────────────────────
// 執行
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 同時只跑一件事。工作本身是可重入的（沒做完的列下一輪還在），所以按兩次不會
 * 壞掉——但會白白吃掉 TMDB 的配額，而且兩份報告誰先回來是不確定的。
 */
const running = ref<'refresh' | 'purge' | null>(null)
const report = ref<RefreshReport | null>(null)
const purged = ref<number | null>(null)

async function runRefresh() {
  running.value = 'refresh'
  purged.value = null
  try {
    report.value = await $fetch<RefreshReport>('/api/admin/tmdb/refresh', {
      method: 'POST',
      body: { limit: limit.value, budgetMs: budgetMs.value },
    })
    // ★ 跑完一定要重新查現況。「還剩幾列」的權威值是重新查過的 `due`，
    //   不是拿報告裡的數字自己減——報告的 due 是**這一輪開始前**的快照。
    await refreshStatus()
  }
  catch (e) {
    report.value = null
    toast.add({ title: '刷新失敗', description: apiErrorText(e), color: 'error' })
  }
  finally {
    running.value = null
  }
}

async function runPurge() {
  running.value = 'purge'
  report.value = null
  try {
    const result = await $fetch<{ purged: number }>('/api/admin/tmdb/purge', { method: 'POST' })
    purged.value = result.purged
    await refreshStatus()
  }
  catch (e) {
    purged.value = null
    toast.add({ title: '清除失敗', description: apiErrorText(e), color: 'error' })
  }
  finally {
    running.value = null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 報告怎麼講
// ─────────────────────────────────────────────────────────────────────────────
/**
 * ★ 這一段是整個元件最需要小心的地方。四種收尾方式裡**只有一種是失敗**：
 *   · `null` ........ 取出來的列都處理完了（或根本沒有到期的列）
 *   · `'budget'` .... 推進到預算上限。**正常**，再按一次就好
 *   · `'throttle'` .. 被 TMDB 節流。要等，不要馬上再按
 *   · `'fatal'` ..... 設定層的錯（例如金鑰不對）。這個才是壞了
 */
const outcome = computed(() => {
  const r = report.value
  if (!r)
    return null

  if (r.abortedBy === 'fatal') {
    // ⚠️ 「這一輪沒有寫任何狀態」是**有條件的**，原本寫成無條件斷言是錯的
    //   （對抗式覆核 2026-09-08 抓到）。runTmdbRefresh 只跳過**撞到 fatal 的那一列**；
    //   在它之前完成的、以及其餘併發 worker 手上的列，早就寫進 film_tmdb_snapshot
    //   並跑過 apply_tmdb_snapshot 了。
    //   失效形狀：跑到一半金鑰被撤銷 ⇒ 紅色警示寫「沒有寫任何狀態」，正下方的數字
    //   卻寫「刷新成功 12 / 套用回作品 12」。兩句話互相矛盾，管理者不知道該信哪一個。
    const touched = r.fresh + r.gone + r.failed > 0
    return {
      color: 'error' as const,
      title: '設定有誤，整批中止',
      body: touched
        ? '已經處理完的列都算數（見下方數字），撞到設定錯誤之後就停止取新工作了。多半是 TMDB 金鑰的問題，看下面的錯誤訊息。'
        : '這一輪沒有寫任何狀態回資料庫，佇列保持原樣。多半是 TMDB 金鑰的問題，看下面的錯誤訊息。',
    }
  }
  if (r.abortedBy === 'throttle') {
    return {
      color: 'warning' as const,
      title: '被 TMDB 節流了，等一下再試',
      body: '已經處理的列都算數。★ 被節流時繼續灌請求只會延長懲罰，也會把整批列的重試次數一起推高，所以現在不要再按。',
    }
  }
  if (r.abortedBy === 'budget') {
    return {
      color: 'info' as const,
      title: `這一輪推進到時間預算上限（${Math.round(r.options.budgetMs / 1000)} 秒）`,
      body: '這不是失敗，是預期中的收尾方式。沒做完的列還在佇列裡，可以直接再按一次；上面的「到期待刷新」已經重新查過了。',
    }
  }
  if (r.claimed === 0) {
    return {
      color: 'neutral' as const,
      title: '沒有到期的列，這一輪不用做事',
      body: '每一列都還在有效期內。這是正常狀態，不是沒跑成功。',
    }
  }
  return {
    color: 'success' as const,
    title: '這一輪把取出來的列都處理完了',
    body: '沒有碰到預算上限也沒有被節流。',
  }
})

/** 報告上的數字，附一句話說明——沒有說明的話 `due` / `untouched` 一定會被誤讀。 */
const reportRows = computed(() => {
  const r = report.value
  if (!r)
    return []
  return [
    { label: '到期待刷新（這一輪開始前）', value: r.due, note: '不受一次取幾列影響，是佇列的總數' },
    { label: '這一輪取出來', value: r.claimed, note: '受「一次最多取幾列」限制' },
    { label: '刷新成功', value: r.fresh, note: '' },
    { label: '套用回作品', value: r.applied, note: '政府核准的中文片名不會被覆寫' },
    { label: 'TMDB 說已不存在', value: r.gone, note: '標成 gone，之後不再刷' },
    { label: '失敗', value: r.failed, note: '已寫回重試次數，會退避後再試' },
    { label: '取出來但沒動到', value: r.untouched, note: '收工時還沒輪到，下一輪會再取' },
  ]
})
</script>

<template>
  <section class="overflow-hidden rounded-sm border border-default bg-default">
    <header class="border-b border-default px-5 py-3">
      <h2 class="font-semibold">
        TMDB 快取維護
      </h2>
      <p class="mt-1 text-sm text-muted">
        排程（每天 03:00 與 03:30 台北時間）照常跑，這裡是<strong>額外</strong>的手動入口：
        看得到目前的積欠量，需要時可以立刻推進一批。
      </p>
    </header>

    <!-- ── 現況。這一區是這一頁存在的主要理由，所以放最上面 ────────────── -->
    <div class="border-b border-default bg-elevated/50 px-5 py-4">
      <!-- ★ 骨架只在**第一次**載入時出現（`!status`）。少了那個條件，按「重新查詢」
           會讓三個數字整組消失再長回來——看起來像壞掉，而且正好在你想比對前後
           數字的那一刻把舊值拿走。有舊值時就留著舊值，讓按鈕上的 spinner 說話。 -->
      <div v-if="!status && (statusState === 'pending' || statusState === 'idle')" class="flex gap-6">
        <USkeleton class="h-12 w-28" />
        <USkeleton class="h-12 w-28" />
        <USkeleton class="h-12 w-40" />
      </div>

      <UAlert
        v-else-if="statusError"
        color="error"
        variant="soft"
        title="讀不到目前的狀態"
        :description="apiErrorText(statusError)"
      />

      <div v-else-if="status" class="flex flex-wrap items-start gap-x-10 gap-y-4">
        <div>
          <p class="text-sm text-muted">
            到期待刷新
          </p>
          <p class="mt-0.5 text-2xl font-bold tabular-nums">
            {{ status.due.toLocaleString('en-US') }}
            <span class="text-base font-normal text-muted">/ {{ status.tracked.toLocaleString('en-US') }} 列</span>
          </p>
        </div>

        <div>
          <p class="text-sm text-muted">
            到期待清除
          </p>
          <p v-if="status.purgeable !== null" class="mt-0.5 text-2xl font-bold tabular-nums">
            {{ status.purgeable.toLocaleString('en-US') }}
            <span class="text-base font-normal text-muted">列</span>
          </p>
          <p v-else class="mt-0.5 text-sm text-muted">
            查不到（{{ status.purgeableError }}）
          </p>
        </div>

        <div class="min-w-0">
          <p class="text-sm text-muted">
            最後一次有快照被更新
          </p>
          <p class="mt-0.5 text-lg font-medium tabular-nums">
            <template v-if="status.lastFetchedError">
              查不到
            </template>
            <template v-else>
              {{ status.lastFetchedAt ? stampText(status.lastFetchedAt) : '—' }}
            </template>
          </p>
          <!-- ⚠️ 這句不能省。這個時間**不等於**「排程上次執行的時間」。 -->
          <p v-if="status.lastFetchedError" class="mt-1 max-w-md text-xs text-error">
            查詢失敗：{{ status.lastFetchedError }}
          </p>
          <p class="mt-1 max-w-md text-xs text-muted">
            這不是「排程上次執行的時間」。若某一輪跑到沒有列到期，它什麼都不會寫，
            這個時間就不會動。
          </p>
        </div>

        <UButton
          size="sm"
          variant="ghost"
          color="neutral"
          icon="i-lucide-refresh-cw"
          :loading="statusState === 'pending'"
          :disabled="running !== null"
          class="ml-auto"
          @click="refreshStatus()"
        >
          重新查詢
        </UButton>
      </div>
    </div>

    <!-- ── 刷新 ───────────────────────────────────────────────────────────── -->
    <div class="border-b border-default px-5 py-5">
      <h3 class="font-medium">
        刷新快照
      </h3>
      <p class="mt-1 max-w-2xl text-sm text-muted">
        把到期的列重新向 TMDB 取一次，成功的套用回作品。
        <strong>一次推進一批，按不完再按</strong>——它以時間收尾而不是以筆數收尾，
        沒做完的列會留在佇列裡等下一次。
      </p>

      <div class="mt-4 flex flex-wrap items-end gap-3">
        <UFormField label="時間預算" class="w-48">
          <USelect v-model="budgetMs" :items="BUDGET_OPTIONS" :disabled="running !== null" class="w-full" />
        </UFormField>
        <UFormField label="一次最多取幾列" class="w-48">
          <USelect v-model="limit" :items="LIMIT_OPTIONS" :disabled="running !== null" class="w-full" />
        </UFormField>
        <UButton
          icon="i-lucide-play"
          :loading="running === 'refresh'"
          :disabled="running !== null"
          @click="runRefresh"
        >
          執行刷新
        </UButton>
      </div>

      <!-- 結果。aria-live 讓螢幕閱讀器在非同步結束時聽得到。 -->
      <!-- ⚠️ 容器**常駐**，只有內容用 v-if。多數螢幕閱讀器只監看「已存在的 live
           region 的子樹變動」，對「region 本身連容器一起新出現」不播報——那樣的話
           讀屏使用者按下按鈕之後聽不到任何結果，只能自己 tab 去找。 -->
      <div aria-live="polite" class="mt-5">
        <template v-if="outcome && report">
          <UAlert :color="outcome.color" variant="soft" :title="outcome.title" :description="outcome.body" />

          <dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <div v-for="row in reportRows" :key="row.label">
              <dt class="text-xs text-muted">
                {{ row.label }}
              </dt>
              <dd class="text-lg font-semibold tabular-nums">
                {{ row.value.toLocaleString('en-US') }}
              </dd>
              <dd v-if="row.note" class="text-xs text-dimmed">
                {{ row.note }}
              </dd>
            </div>
          </dl>

          <p class="mt-4 text-sm text-muted tabular-nums">
            耗時 {{ (report.elapsedMs / 1000).toFixed(1) }} 秒 ·
            TMDB 請求 {{ report.tmdb.requests }}（重試 {{ report.tmdb.retries }}、被節流 {{ report.tmdb.throttled }}）·
            這一輪實際用了預算 {{ Math.round(report.options.budgetMs / 1000) }} 秒 / 上限 {{ report.options.limit }} 列 / 併發 {{ report.options.concurrency }}
          </p>

          <div v-if="report.errors.length" class="mt-4">
            <p class="text-sm font-medium">
              錯誤訊息（<strong>取樣</strong>，最多 5 筆）
            </p>
            <!-- ⚠️ 一定要寫「取樣」。失敗 200 列而這裡只列 5 條時，不講的話
               會被讀成「只有這 5 筆有問題」。完整清單在 Vercel 的函式日誌。 -->
            <p class="mt-0.5 text-xs text-muted">
              這不是全部——上面「失敗」那個數字才是。完整內容在 Vercel 的函式日誌。
            </p>
            <ul class="mt-2 space-y-1">
              <li
                v-for="(msg, i) in report.errors"
                :key="i"
                class="rounded-sm bg-elevated px-3 py-1.5 font-mono text-xs break-all"
              >
                {{ msg }}
              </li>
            </ul>
          </div>
        </template>
      </div>
    </div>

    <!-- ── 清除 ───────────────────────────────────────────────────────────── -->
    <div class="px-5 py-5">
      <h3 class="font-medium">
        清除已到期的快取內容
      </h3>

      <!-- ⚠️ 這一段的措辭是刻意的，不要簡化成「合規清除」。 -->
      <p class="mt-1 max-w-2xl text-sm text-muted">
        把已經超過保存期限的 TMDB 內容（簡介、海報、片長⋯）從資料庫裡清空，退回待刷新。
        清的是<strong>已無權保存的內容</strong>。
      </p>
      <UAlert
        color="neutral"
        variant="soft"
        class="mt-3 max-w-2xl"
        title="沒按這顆按鈕不會違規"
        description="合規不靠這一步。公開頁是逐列以「還在有效期內」把關的，過期欄位會直接變成空值、退回文字卡片——即使這裡從來沒被按過，也不會有逾期內容被送出去。這顆按鈕做的是另一件事：不要在資料庫裡留著已經沒有權利保存的內容。"
      />

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <UButton
          color="neutral"
          variant="subtle"
          icon="i-lucide-eraser"
          :loading="running === 'purge'"
          :disabled="running !== null"
          @click="runPurge"
        >
          執行清除
        </UButton>
        <p aria-live="polite" class="text-sm tabular-nums">
          <template v-if="purged !== null">
            <template v-if="purged > 0">
              清掉了 <strong>{{ purged.toLocaleString('en-US') }}</strong> 列。
              <!-- ⚠️ 不講這句的話：剛按完「清除」，上面的「到期待刷新」卻從 0 跳到 300，
                 第一反應會是「我按壞了什麼」。兩個數字動得對不上而沒有解釋，
                 是這個 repo 反覆記載的失效形狀。 -->
              清掉的列會退回待刷新，所以上面的「到期待刷新」會同步增加同樣的數量。
            </template>
            <template v-else>
              沒有到期的內容需要清除（清掉 0 列）。
            </template>
          </template>
        </p>
      </div>
    </div>
  </section>
</template>
