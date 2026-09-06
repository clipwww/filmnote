<script setup lang="ts">
import type { YearStripRow } from '~/utils/stats'

/**
 * 年表 — 全站簽名（`SCREENS.md §2.1`）。每年一列，一列 53 格，**每格是一週**。
 *
 * ── 為什麼是週不是日 ──────────────────────────────────────────
 * 實測 169 筆分散在 12 年，日層級的填滿率約 6%——一張 7×53 的年格子有 96%
 * 是空的，看起來不是「密度」而是「荒涼」。收成週之後跳到約 22%，密集期與
 * 空窗立刻讀得出來。這是真實資料逼出來的偏離，不是懶。
 *
 * ── 為什麼不用圖表庫 ──────────────────────────────────────────
 * 純 CSS grid。舊專案用 d3 手寫 imperative DOM，在 SSR 下是負擔；而且這裡
 * 每一格都要能被鍵盤走到、被螢幕閱讀器讀到，canvas 給不了。
 *
 * ── 格子寬度是彈性的，不是規格寫的 5px／8px ────────────────────
 * §2.1 算的 371px（53 格 × 節距 7）假設整條佔滿 375px 的視窗寬。實際上它在
 * 卡片裡，還要跟左邊的年份與右邊的場次數共用一行——375px 下扣掉頁面與卡片的
 * padding 只剩約 230px 給 53 格。所以格子改成 `flex: 1` 由容器決定寬度，
 * **高度固定**。年表是密度概覽，格子是不是正方形不影響它要傳達的東西。
 */
const props = withDefaults(defineProps<{
  rows: YearStripRow[]
  /** `null` = 全期檢視視角（**預設**，見 `SCREENS §9`）。 */
  selected: number | null
  /** false ⇒ 只當門面，不可點也不進 tab 順序。 */
  interactive?: boolean
  /**
   * 是否在最上面放一列「全部年度」。
   *
   * ★ 2026-09-06：全期成為預設檢視視角之後，**回到全期必須是看得見的一個選項**。
   *   做成「再點一次同一年就回到全部」那種隱藏切換是不行的：年表本身就是這一頁的
   *   檢視選擇器，而一個選擇器不能有一個選不到、只能猜出來的狀態——尤其它還是預設值，
   *   使用者第一眼看到的就是它，卻找不到它在哪一列被標示著。
   */
  showAll?: boolean
}>(), { interactive: true, showAll: true })

/** ⚠️ 型別必須含 `null`，否則 UI 上永遠到不了全期視角（2026-09-06 之前就是這樣）。 */
const emit = defineEmits<{ 'update:selected': [year: number | null] }>()

/** 「全部年度」那一列右邊的總場次。跟畫面上這些列加總一致，不另外接一個來源。 */
const allRecords = computed(() => props.rows.reduce((n, r) => n + r.records, 0))

/**
 * 三階，取值與年度出席圖同一組（`att` = heat-0/4/6）。
 * ⚠️ **圖例與格子必須從同一個陣列取。** 舊版 mockup 的 CSS 與 JS 各維護一份，
 * 圖例跟圖已經不同色了（§5.4b）。
 *
 * ⚠️ **不可以用 `useColorMode()` 在 JS 裡挑顏色。** 這個元件會出現在 `/u/`，
 * 那是 SSR 頁：伺服器端算出來的是亮色、瀏覽器 hydrate 時可能是暗色，
 * 兩份 inline style 對不起來 ⇒ `Hydration completed but contains mismatches`，
 * 而畫面看起來完全正常（實測就是這樣抓到的）。
 * 改成把**亮暗兩組值都**當成 custom property 印出來（兩邊都是常數，SSR 與
 * client 必然相同），由下方的 `<style>` 依 `.dark` 決定用哪一組。
 * 值仍然只有 CHART 一個來源。
 */
/** 0 場 / 1 場 / 2 場以上。 */
function level(n: number): 0 | 1 | 2 {
  return n === 0 ? 0 : n === 1 ? 1 : 2
}

/**
 * 每一格同時帶亮暗兩個值，由 Tailwind 的 `dark:` variant 挑一個。
 *
 * ⚠️ 試過在 SFC 的 `<style scoped>` 裡寫 `:global(.dark) .year-strip`，**沒有生效**——
 * 實測暗色模式下 `--att-0` 仍然解析成亮色的 `#EADDCA`，而畫面「看起來只是顏色怪」。
 * Nuxt UI 註冊的 `@variant dark (&:where(.dark, .dark *))` 是全站都在用、
 * 確定會動的那一條，所以改用它。
 */
function cellVars(n: number) {
  const i = level(n)
  return { '--att-l': CHART.light.att[i], '--att-d': CHART.dark.att[i] }
}

/**
 * ↑↓ 換選項。**「全部年度」也在這串裡**——它是一個選項，不是一個逃生門，
 * 所以鍵盤走得到它，順序也跟畫面一致（它在最上面）。
 */
const options = computed<(number | null)[]>(() =>
  [...(props.showAll ? [null] : []), ...props.rows.map(r => r.year)])

function move(delta: number) {
  const list = options.value
  const i = list.indexOf(props.selected)
  const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))]
  // `next` 可能正當地是 null（全部年度），所以判斷式是 `!== undefined` 不是真值
  if (next !== undefined)
    emit('update:selected', next)
}
</script>

<template>
  <div :role="interactive ? 'listbox' : 'list'" aria-label="檢視的年份" class="space-y-1">
    <!--
      ★「全部年度」——全期檢視視角（2026-09-06 起是**預設**）。
        它刻意沒有 53 格：那 53 格的座標軸是「一個日曆年裡的第幾週」，
        跨年度沒有這個座標。把十三年疊起來畫成一列會是一條幾乎全滿的黑帶，
        既不傳達東西，又會被讀成「這是某一年」。所以這一列只有標籤與總數，
        並用一條髮絲線跟下面的年份列分開，讀起來是「檢視範圍」而不是「某一年」。
    -->
    <div
      v-if="showAll"
      :role="interactive ? 'option' : undefined"
      :tabindex="interactive ? 0 : undefined"
      :aria-selected="interactive ? selected === null : undefined"
      :aria-label="`全部年度 ${allRecords} 場`"
      class="flex items-center gap-2 border-b border-l-2 border-b-default py-1 pr-1 pl-2 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      :class="[
        selected === null ? 'border-l-primary' : 'border-l-transparent',
        interactive && selected !== null ? 'cursor-pointer' : '',
      ]"
      @click="interactive && emit('update:selected', null)"
      @keydown.enter.prevent="interactive && emit('update:selected', null)"
      @keydown.space.prevent="interactive && emit('update:selected', null)"
      @keydown.down.prevent="interactive && move(1)"
      @keydown.up.prevent="interactive && move(-1)"
    >
      <span
        class="min-w-0 flex-1 text-xs"
        :class="selected === null ? 'font-semibold text-highlighted' : 'text-muted'"
      >全部年度</span>
      <span class="w-8 shrink-0 text-right text-xs tabular-nums text-muted">{{ allRecords }}</span>
    </div>

    <div
      v-for="row in rows"
      :key="row.year"
      :role="interactive ? 'option' : undefined"
      :tabindex="interactive ? 0 : undefined"
      :aria-selected="interactive ? row.year === selected : undefined"
      :aria-label="`${row.year} 年 ${row.records} 場`"
      class="flex items-center gap-2 border-l-2 py-1 pl-2 pr-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      :class="[
        row.year === selected ? 'border-primary' : 'border-transparent',
        interactive && row.year !== selected ? 'cursor-pointer' : '',
      ]"
      @click="interactive && emit('update:selected', row.year)"
      @keydown.enter.prevent="interactive && emit('update:selected', row.year)"
      @keydown.space.prevent="interactive && emit('update:selected', row.year)"
      @keydown.down.prevent="interactive && move(1)"
      @keydown.up.prevent="interactive && move(-1)"
    >
      <span
        class="w-10 shrink-0 text-xs tabular-nums"
        :class="row.year === selected ? 'font-semibold text-highlighted' : 'text-muted'"
      >{{ row.year }}</span>

      <!-- 53 格。格子沒有語意，資料在整列的 aria-label 上。 -->
      <span class="flex min-w-0 flex-1 gap-px" aria-hidden="true">
        <span
          v-for="(n, i) in row.weeks"
          :key="i"
          class="h-2.5 flex-1 rounded-[1px] [background-color:var(--att-l)] sm:h-3 dark:[background-color:var(--att-d)]"
          :style="cellVars(n)"
        />
      </span>

      <span class="w-8 shrink-0 text-right text-xs tabular-nums text-muted">{{ row.records }}</span>
    </div>
  </div>
</template>
