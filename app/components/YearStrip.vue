<script setup lang="ts">
import type { YearStripRow } from '~/utils/stats'

/**
 * 年表 — 全站簽名（`SCREENS.md §2.1`）。每年一列 53 格，**每格是一週**：實測 169 筆分散在
 * 12 年，日層級填滿率約 6%（7×53 有 96% 是空的，看起來是荒涼不是密度），收成週跳到約 22%。
 * 純 CSS grid 不用圖表庫：每一格都要能被鍵盤走到、被螢幕閱讀器讀到，canvas 給不了。
 */
/*
 * 格子寬度是彈性的，不是 §2.1 算的 5px／8px：那個 371px 假設整條佔滿 375px 視窗，實際上它
 * 在卡片裡還要跟年份與場次數共用一行，375px 下只剩約 230px 給 53 格 ⇒ `flex: 1`、高度固定。
 */
const props = withDefaults(defineProps<{
  rows: YearStripRow[]
  /** `null` = 全期檢視視角（**預設**，見 `SCREENS §9`）。 */
  selected: number | null
  /** false ⇒ 只當門面，不可點也不進 tab 順序。 */
  interactive?: boolean
  /**
     * 是否在最上面放一列「全部年度」。★ 全期是**預設**檢視視角 ⇒ 回到全期必須是**看得見的
     * 一個選項**：做成「再點一次同一年就回全部」那種隱藏切換不行——年表就是這頁的選擇器，
     * 而一個選擇器不能有一個選不到、只能猜出來的狀態，尤其它還是預設值。
     */
  showAll?: boolean
}>(), { interactive: true, showAll: true })

/** ⚠️ 型別必須含 `null`，否則 UI 上永遠到不了全期視角（2026-09-06 之前就是這樣）。 */
const emit = defineEmits<{ 'update:selected': [year: number | null] }>()

/** 「全部年度」那一列右邊的總場次。跟畫面上這些列加總一致，不另外接一個來源。 */
const allRecords = computed(() => props.rows.reduce((n, r) => n + r.records, 0))

/**
 * 三階，取值與年度出席圖同一組（`att` = heat-0/4/6）。⚠️ **圖例與格子必須從同一個陣列取**
 * ——舊 mockup 的 CSS 與 JS 各維護一份，圖例跟圖已經不同色了（§5.4b）。
 */
/*
 * ⚠️ **不可以用 `useColorMode()` 在 JS 裡挑顏色**：這支會出現在 SSR 的 `/u/`，兩邊算出不同
 * 模式 ⇒ `Hydration completed but contains mismatches`，而畫面看起來完全正常（實測抓到的）。
 * 改成亮暗兩組都印成 custom property（兩邊都是常數），由 `.dark` 決定用哪一組。
 */
/** 0 場 / 1 場 / 2 場以上。 */
function level(n: number): 0 | 1 | 2 {
  return n === 0 ? 0 : n === 1 ? 1 : 2
}

/**
 * 每一格同時帶亮暗兩個值，由 Tailwind 的 `dark:` variant 挑。⚠️ 試過在 `<style scoped>` 裡寫
 * `:global(.dark) .year-strip`，**沒有生效**——實測暗色下 `--att-0` 仍解析成亮色的 `#EADDCA`，
 * 而畫面「看起來只是顏色怪」。改用 Nuxt UI 註冊的那條 dark variant（全站都在用、確定會動）。
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

/**
 * 下面那句提示的 id，掛在 listbox 的 `aria-describedby` 上。⚠️ **一定要 `useId()`**（#98）：
 * `/u/` 是 SSR，兩邊各生一次就是 hydration mismatch，而畫面看起來完全正常。
 * 同一條理由也寫在 `DistributionBars.vue` 的 `restId`（⚠️ 引符號名不要引行號，行號會作廢）。
 */
const hintId = useId()
</script>

<template>
  <!--
    ⚠️ 提示那一句**不能放進 `role="listbox"` 裡面**：listbox 的子節點只能是 `option`／`group`，
       塞散文進去螢幕閱讀器要嘛唸成一個選項、要嘛整個跳過。所以外面多包一層純 div，
       提示是 listbox 的**兄弟**，再用 `aria-describedby` 接回去。
  -->
  <div>
    <div
      :role="interactive ? 'listbox' : 'list'"
      aria-label="檢視的年份"
      :aria-describedby="interactive ? hintId : undefined"
      class="space-y-1"
    >
      <!--
        ★ hover／focus-visible／選中的底色一律是 `bg-accented` **不是 `bg-elevated`**，這是量出來的：
          亮色 `bg-elevated` = `#eaddca`，而空白週那格的 `att[0]` 逐字也是 `#EADDCA`（同一個值）
          ⇒ hover 上去那一列 53 格會整條消失（對比 1.00:1），看起來像畫面壞掉。
      -->
      <!--
        暗色 `bg-muted`／`bg-elevated` 都是 `#3d332c`、`att[0]` 是 `#392f24`，對比只有 1.06:1 一樣糊。
        `bg-accented` 對 `att[0]` 是亮 1.18:1／暗 1.29:1，兩個模式下空白格都還讀得出來。
        ⇒ 要改這裡的底色，先去 `app/utils/chart-theme.ts` 對一次 `att[0]` 的值。
      -->
      <!--
        ★ hover 與「選中」用**同一個**底色（hover 的意思就是「按下去會變成這樣」），靠左邊那條
          `border-l-primary` 與粗體年份區分，不發明第三種色階。只在 `interactive` 為真時給 hover。
        ⚠️ **不加 transition**（DS §6，而且 13 列同時在畫面上會看起來在呼吸）；底色與粗體都不改
           列高、也不改邊框寬度——那兩者一動，整條年表會在 hover 時逐列跳版。
      -->

      <!--
        ★「全部年度」——全期檢視視角（預設）。刻意沒有 53 格：那 53 格的座標軸是「一個日曆年裡的
          第幾週」，跨年度沒有這個座標；十三年疊起來會是一條幾乎全滿的黑帶，又會被讀成「某一年」。
          所以這一列只有標籤與總數，用髮絲線跟年份列分開，讀起來是「檢視範圍」不是「某一年」。
      -->
      <!--
        ⚠️ 這一列被選中（＝預設狀態）時**亮色下那條髮絲線看不見**：`border-b-default` 與
           `bg-accented` 在亮色都是 paper-200。這是接受的（分隔改由整塊 tan 色區的下緣去做）。
           **不要改用 `border-accented` 去救**——暗色的它與 `bg-accented` 又是同一個值，
           只是把同一個碰撞搬到另一個模式去。
      -->
      <div
        v-if="showAll"
        :role="interactive ? 'option' : undefined"
        :tabindex="interactive ? 0 : undefined"
        :aria-selected="interactive ? selected === null : undefined"
        :aria-label="`全部年度 ${allRecords} 場`"
        class="flex items-center gap-2 border-b border-l-2 border-b-default py-1 pr-1 pl-2 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        :class="[
          selected === null ? 'border-l-primary bg-accented' : 'border-l-transparent',
          interactive && selected !== null ? 'cursor-pointer hover:bg-accented focus-visible:bg-accented' : '',
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
          row.year === selected ? 'border-primary bg-accented' : 'border-transparent',
          interactive && row.year !== selected ? 'cursor-pointer hover:bg-accented focus-visible:bg-accented' : '',
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

    <!--
      提示（照 `HourHeatmap.vue` 末尾的先例）。2026-09-14：年份能點這件事不明顯——底色回饋只有
      滑鼠移上去才看得到，觸控裝置根本沒有 hover。`interactive: false`（只當門面）時不出現。
    -->
    <p v-if="interactive" :id="hintId" class="mt-2 text-xs text-muted">
      <!-- 後半句只有在真的有那一列時才成立——`showAll: false` 的呼叫端沒有「全部年度」。 -->
      {{ showAll ? '點一列就只看那一年；最上面那列回到全部年度' : '點一列就只看那一年' }}
    </p>
  </div>
</template>
