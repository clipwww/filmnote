<script setup lang="ts">
/**
 * `/admin/**` 三個佇列的外框（`SCREENS §14`、視覺稿 `docs/design/mockups/admin.html`）。
 *
 * ── 為什麼三個佇列共用一套版面 ────────────────────────────────
 * 視覺稿的前提寫得很直白：**David 是唯一的 staff，而且他不是每天做這件事。**
 * 所以刻意不做批次操作、統計儀表板、多人指派——那些是給團隊營運台用的，
 * 在一人偶爾使用的情境下只是額外的學習成本。三個佇列長得一樣，是為了
 * 「隔兩個月再打開」時不必重新學一次。**每個畫面只回答一個問題：這一筆怎麼處理。**
 *
 * ── 版面 ──────────────────────────────────────────────────────
 * 左列表、右詳情。760px 以下疊成一欄（列表在上）。
 *
 * ⚠️ 左列表自己捲，不讓它把頁面拉長。本專案已經有兩次「頁面攤開一萬七千 px /
 *    兩萬兩千 px」的紀錄，都是同一個錯誤換一頁再犯——列表元件把所有列一次
 *    攤平在 document 流裡。這裡直接用 `max-h` + `overflow-y-auto` 釘住。
 *
 * ⚠️ 沒有用 `UTable`。BUILD_PLAN §5 Step 7 建議用它，但它的 `virtualize`
 *    需要容器有確定高度（踩雷 #54），而這裡本來就是「一列一筆、點了看右邊」
 *    的清單不是表格——用 `<ul>` 少一個相依也少一個坑。表格語彙留給
 *    `/admin/films` 合併介面的並排比對，那個才真的是表格。
 */

const props = defineProps<{
  /** 目前這個佇列的標題，例如「作品審核」。 */
  title: string
  /** 左欄表頭那一行，例如「待審核 7」。 */
  listHeading: string
  /** 有沒有選中的項目——沒有的話右欄畫 `#blank` 而不是 `#detail`。 */
  hasSelection?: boolean
}>()

defineSlots<{
  /** 左欄的列表內容（呼叫端自己畫 `<li>`）。 */
  list?: () => unknown
  /** 右欄：選中一筆時的詳情。 */
  detail?: () => unknown
  /** 右欄：沒有選中任何一筆時。 */
  blank?: () => unknown
}>()

const QUEUES = [
  { to: '/admin/films', label: '作品審核' },
  { to: '/admin/takedowns', label: 'DMCA 承辦' },
  { to: '/admin/reports', label: '資料回報' },
] as const

const route = useRoute()
const hasSelection = computed(() => props.hasSelection === true)
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-8">
    <h1 class="text-2xl font-bold tracking-tight">
      {{ title }}
    </h1>

    <!-- 三個佇列之間切換。橫向捲的是這一條，不是頁面（§10 品質底線）。 -->
    <nav class="mt-4 -mx-4 overflow-x-auto px-4">
      <div class="flex w-max gap-1.5">
        <UButton
          v-for="q in QUEUES"
          :key="q.to"
          :to="q.to"
          size="sm"
          :variant="route.path === q.to ? 'solid' : 'ghost'"
          :color="route.path === q.to ? 'primary' : 'neutral'"
        >
          {{ q.label }}
        </UButton>
      </div>
    </nav>

    <div class="mt-6 grid grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)] overflow-hidden rounded-sm border border-default bg-default">
      <div class="border-b md:border-b-0 md:border-r border-default bg-elevated/50">
        <p class="border-b border-default px-4 py-2.5 text-sm text-muted">
          {{ listHeading }}
        </p>
        <!-- 列表自己捲。md 以下不限高（手機上外層本來就是唯一的捲軸）。 -->
        <ul class="md:max-h-[32rem] md:overflow-y-auto">
          <slot name="list" />
        </ul>
      </div>

      <div class="min-w-0 px-5 py-5">
        <slot v-if="hasSelection" name="detail" />
        <slot v-else name="blank" />
      </div>
    </div>
  </div>
</template>
