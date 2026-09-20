<script setup lang="ts">
import type { DistItem } from '~/utils/stats'

/**
 * 分布長條（`SCREENS.md §9` band 5/6），影城／版本／國別共用。不是圓餅也不是 ECharts：
 * 實測分布極度傾斜（影城 115/169 = 68%、國別 日本 98／美國 66／其餘 5、版本 2D 126／4DX 20／
 * IMAX 7），而 375px 下每個標籤只分到約 90px，長影城名會被截到無法辨識（§5.2）。
 */
/*
 * ⚠️⚠️ **顏色不可在 JS 裡用 `useColorMode()` 挑再寫 inline style**（踩雷 #88）：在 `ssr: false`
 * 的 `/app` 完全正常，2026-09-06 搬到 SSR 的 `/u/` 立刻炸——server `#685946`（亮）
 * vs client `#A59788`（暗），而畫面看起來正常。
 */
/*
 * ⇒ 亮暗兩組都印成 custom property（兩邊都是常數），由 `dark:` variant 挑。
 *   ⚠️ 不要改用 `<style scoped>` 的 `:global(.dark) X`——**實測沒有生效**。
 */
/*
 * ★ 展開狀態必須由 Vue 擁有：實測 13 個年度裡只有 2016（7 家）與全期（15 家）會長出
 *   「其他」那一列，其餘 11 年 ≤5 家 ⇒ 換年份一定要收回去，而兩頁都沒給 `:key`（不 remount）。
 * ★ 兩種手勢都只落在「名稱＋數字」那一行，**長條一條都不吃點擊**：聚合列的長條是加總、
 *   不對應任何紀錄清單；長條可點的話同一個視覺元素在上下兩列意思不同，比不能點更難學。
 */
/*
 * ⚠️ 這段刻意**不寫**那幾個標籤名與屬性名的字面 token（踩雷 #166：`src.includes(...)` 型的
 *   字串比對會被註解裡的同名字串餵飽，呼叫整個拿掉照樣綠）。要守這個檔請解析 DOM 不要比字串。
 */
const props = defineProps<{
  items: DistItem[]
  /** 場次的量詞，例如「場」。 */
  unit?: string
}>()

/**
 * 點任何一列 → 呼叫端開底部抽屜。★ `key` 是**穩定識別**（venue_id／format code／country）
 * 不是名稱：同名場所會撞，過濾由 `matchesDistPick()` 說了算；一律正規化成 `key ?? null`。
 * ★ `records` 一起帶出去給標題用——那是圖上那個數字，跟抽屜列幾張擺一起才看得出不一致（#169）。
 */
const emit = defineEmits<{
  pick: [item: { key: string | null, name: string, records: number }]
}>()

/**
 * 全部長條共用**同一把尺**（最長那條當 100%）。★★ 展開出來的長尾也用這一把，不可換成長尾
 * 自己的最大值：實測全期「其他 10 家」裡 3 場那條若拿自己當滿版，會被畫得跟 120 場的主場
 * 一樣長——那比不展開更糟，因為它看起來像資料。代價是十根幾乎一樣短的小刺，那是誠實的代價。
 */
const scale = computed(() => Math.max(1, props.items[0]?.records ?? 1))

/** 長條寬度只有這一個算式——收合列與展開列共用，免得日後兩邊漂移。 */
function barWidth(records: number) {
  return `${Math.max(2, (records / scale.value) * 100)}%`
}

/** 「其他」那一列是否展開。一組 items 裡最多只有一列有 `rest`，一個布林就夠。 */
const openRest = ref(false)

/**
 * ★ 換年份要自動收回去。⚠️ **watch 的是 `props.items` 這個陣列參考，不要「化簡」成
 * `items.length`**：實測全期是 6 列（5＋其他 10 家）、2016 也是 6 列（5＋其他 2 家），長度
 * 一模一樣 ⇒ 用長度當 source，全期(展開中)→2016 這一步不會觸發重置，而那正是它唯一要擋的。
 */
watch(() => props.items, () => {
  openRest.value = false
})

/**
 * 展開清單的 id。⚠️ **一定要 `useId()`**，不可 `Math.random()`／`Date.now()`／模組層計數器：
 * `/u/` 是 SSR，兩邊各產一個就是 hydration mismatch，而**屬性的 mismatch Vue 不會幫你修**（#98）。
 * ⚠️ 也不可提到模組範圍：同一頁有三個實例（影城／版本／國別），共用會讓關聯屬性指到別人的清單。
 */
const restId = useId()

/**
 * 這一組資料裡有沒有聚合列。只拿來決定提示文字要不要提「展開」那一半——
 * David 的 13 個年度裡有 11 年根本沒有聚合列，那幾年寫「有箭頭的那一列先展開」
 * 是在指一個畫面上不存在的東西。
 */
const hasRest = computed(() => props.items.some(it => !!it.rest?.length))

/** 提示文字。量詞由呼叫端給，這裡刻意講「紀錄」不講「場」，三種分布共用同一句。 */
const hint = computed(() => (hasRest.value
  ? '點一列看是哪些紀錄；有箭頭的那一列先展開，展開出來的每一列一樣可以點'
  : '點一列看是哪些紀錄'))

/**
 * 條的填色用 `heat[4]`，軌道用 `heat[0]`——不是色階淺端，淺端會讓條分不出長短（§1.3）。
 * 值仍然只有 `CHART` 一個來源，這裡只是把兩組都帶出去。
 */
const BAR_VARS = {
  '--bar-fill-l': CHART.light.heat[4],
  '--bar-fill-d': CHART.dark.heat[4],
  '--bar-track-l': CHART.light.heat[0],
  '--bar-track-d': CHART.dark.heat[0],
}
</script>

<template>
  <div>
    <!--
      ⚠️ `BAR_VARS` 印在**清單的根** `<ul>` 上（不是最外層的這個 `<div>`，
         那只是為了讓提示文字有地方站）。底下所有長條都是它的後代，繼承得到。
    -->
    <ul class="space-y-3" :style="BAR_VARS">
      <!--
        ⚠️ `:key` 用 `it.key ?? it.name`：同名場所（不同 venue_id、同一個店名）
           在 `it.name` 當 key 時會撞，Vue 會重用錯的節點。聚合列自己的 key 是
           null，落回名稱——一組 items 裡最多一列聚合列，不會再撞。
      -->
      <li v-for="(it, i) in items" :key="it.key ?? it.name">
        <!--
          聚合列（「其他 N 家」）：**這一列的手勢是展開／收合，不是開抽屜**。
          它的數字是加總，不對應任何一份可以列出來的紀錄清單。
        -->
        <button
          v-if="it.rest?.length"
          type="button"
          class="group flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-xs text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          :aria-expanded="openRest"
          :aria-controls="restId"
          @click="openRest = !openRest"
        >
          <!--
            ⚠️ hover 的顏色要由**帶顏色的那個 span 自己**接（`group-hover:`）。
               把 `hover:text-highlighted` 寫在按鈕上是死的：子元素自己的
               `text-toned` / `text-muted` 是直接設 color 的 utility，永遠贏過父層。
          -->
          <span class="flex min-w-0 items-baseline gap-1 text-sm text-toned group-hover:text-highlighted">
            <!--
              ★ 這個箭頭兼著區分兩種手勢（有＝展開、無＝開抽屜）。拿掉它，「其他 10 家」會看起來只是
                一行字，而且跟一般列長得一樣、點下去卻做不同的事。
              ⚠️ `motion-reduce:transition-none`：DS §6 要尊重 prefers-reduced-motion，而這個 repo
                 **沒有**全域規則在做，每一處都得自己寫。
            -->
            <UIcon
              name="i-lucide-chevron-right"
              class="size-3.5 shrink-0 self-center transition-transform motion-reduce:transition-none"
              :class="openRest ? 'rotate-90' : ''"
            />
            {{ it.name }}
          </span>
          <span class="shrink-0 text-sm tabular-nums text-muted group-hover:text-highlighted">{{ it.records }}{{ unit ?? '' }}</span>
        </button>

        <!--
          一般列：**整行是一顆開抽屜的按鈕**，觸發區只到這一行（長條不在裡面，理由見檔頭）。
          ★ 第一列本來就是 `text-highlighted`，`group-hover:` 在它身上沒效果 ⇒ hover 的回饋改由
            **底線**承擔，三種列在 hover 時都看得見反應。底線不加 transition（DS §6）。
        -->
        <button
          v-else
          type="button"
          class="group flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-xs text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          aria-haspopup="dialog"
          @click="emit('pick', { key: it.key ?? null, name: it.name, records: it.records })"
        >
          <span
            class="min-w-0 text-sm underline-offset-4 group-hover:text-highlighted group-hover:underline"
            :class="i === 0 ? 'font-medium text-highlighted' : 'text-toned'"
          >
            {{ it.name }}
          </span>
          <span class="shrink-0 text-sm tabular-nums text-muted group-hover:text-highlighted">{{ it.records }}{{ unit ?? '' }}</span>
        </button>

        <!--
          `data-bar` 是給驗收探針認的：軌道與填色長得幾乎一樣，
          歷史上量錯過（量到軌道以為是填色）。別拿掉。
        -->
        <div data-bar="track" class="mt-1 h-2 w-full rounded-[1px] [background-color:var(--bar-track-l)] dark:[background-color:var(--bar-track-d)]">
          <!--
            寬度仍然是 inline style，那沒問題——它是純資料算出來的，
            SSR 與 client 必然相同。會對不起來的只有「依模式挑值」的那一種。
          -->
          <div
            data-bar="fill"
            class="h-full rounded-[1px] [background-color:var(--bar-fill-l)] dark:[background-color:var(--bar-fill-d)]"
            :style="{ width: barWidth(it.records) }"
          />
        </div>

        <!--
          展開後的完整清單。⚠️ 必須留在這個 `<li>` 裡：外層是 `<ul>`，直接子元素只能是 `<li>`
          （不是因為 custom property 解析不到——那幾個印在清單根上，這一層繼承得到）。
          ⚠️ 刻意沒有進場動畫（DS §6）；不重算基準，用同一個 `barWidth()`。
        -->
        <!--
          ★ 用一條上緣髮絲線不用縮排（2026-09-14）：內縮會讓長尾的長條比主列短 12px，而**全部長條
            共用同一把尺** ⇒ 縮排等於讓同一把尺畫出來的條在畫面上量起來不一樣長。那是真的錯不是喜好。
          否決過的：只靠箭頭（捲動後聚合列滑出畫面就零線索）、展開動畫或背景色塊（DS §6／§1.3）。
        -->
        <!--
          ⚠️ 那兩個 utility 的名字刻意不寫在這裡——踩雷 #166 的反面：寫了的話「內縮已經拿掉」
             這種字串比對型的驗收會被這段註解餵飽而永遠綠。
        -->
        <ul v-if="it.rest?.length && openRest" :id="restId" class="mt-3 space-y-3 border-t border-default pt-3">
          <li v-for="sub in it.rest" :key="sub.key ?? sub.name">
            <!-- 展開出來的每一列都是**一般列**：沒有箭頭、點下去開抽屜。 -->
            <button
              type="button"
              class="group flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-xs text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              aria-haspopup="dialog"
              @click="emit('pick', { key: sub.key ?? null, name: sub.name, records: sub.records })"
            >
              <!-- 巢狀這一層第一列**不加粗**：它只是長尾裡最大的一條，不是主場。 -->
              <span class="min-w-0 text-sm text-toned underline-offset-4 group-hover:text-highlighted group-hover:underline">{{ sub.name }}</span>
              <span class="shrink-0 text-sm tabular-nums text-muted group-hover:text-highlighted">{{ sub.records }}{{ unit ?? '' }}</span>
            </button>
            <div data-bar="track" class="mt-1 h-2 w-full rounded-[1px] [background-color:var(--bar-track-l)] dark:[background-color:var(--bar-track-d)]">
              <div
                data-bar="fill"
                class="h-full rounded-[1px] [background-color:var(--bar-fill-l)] dark:[background-color:var(--bar-fill-d)]"
                :style="{ width: barWidth(sub.records) }"
              />
            </div>
          </li>
        </ul>
      </li>
    </ul>

    <!--
      提示文字（照 `HourHeatmap.vue` 的先例）：沒有這一句，「每一列都能點」只剩滑鼠指標的形狀
      在講，觸控裝置上等於沒講。⚠️ `items.length` 的守衛不是多餘的——一列都沒有時這句話會
      孤零零地指著一個不存在的東西。
    -->
    <p v-if="items.length" class="mt-2 text-xs text-muted">
      {{ hint }}
    </p>
  </div>
</template>
