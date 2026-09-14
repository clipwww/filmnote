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

/**
 * 下面那句提示的 id，掛在 listbox 的 `aria-describedby` 上。
 *
 * ⚠️ **一定要 `useId()`，不可以 `Math.random()` / `Date.now()` / 模組層計數器**
 * （踩雷 #98）：`/u/` 是 SSR，伺服器與瀏覽器各生一次就是兩個不同的字串 ⇒
 * hydration mismatch，而畫面看起來完全正常。
 * 同一條理由寫在 `DistributionBars.vue` 的 `restId`（「展開清單的 id」，約 :126-132）——
 * ⚠️ **引符號名不要只引行號**：同一輪在那個 `useId()` 上方插了三十行，行號就作廢了。
 */
const hintId = useId()
</script>

<template>
  <!--
    ⚠️ 提示那一句**不能放進 `role="listbox"` 裡面**：listbox 的子節點只能是
       `option`／`group`，塞一段散文進去，螢幕閱讀器要嘛把它唸成一個選項、
       要嘛整個跳過。所以外面多包一層純 div，提示是 listbox 的**兄弟**，
       再用 `aria-describedby` 接回去。
  -->
  <div>
    <div
      :role="interactive ? 'listbox' : 'list'"
      aria-label="檢視的年份"
      :aria-describedby="interactive ? hintId : undefined"
      class="space-y-1"
    >
      <!--
        ★ hover／focus-visible／選中的底色一律是 `bg-accented`，**不是 `bg-elevated`**。
          這是量出來的，不是品味：
          · 亮色的 `bg-elevated` = neutral-100 = `--color-paper-100` = `#eaddca`，
            而空白週那一格的顏色 `CHART.light.att[0]` 逐字也是 `#EADDCA`——**同一個值**。
            hover 上去，那一列的 53 格會整條消失（對比 1.00:1），看起來像畫面壞掉。
          · 暗色更省事：`bg-muted` 與 `bg-elevated` 都是 neutral-800（`#3d332c`），
            而 `att[0]` 是 `#392f24`，對比只有 1.06:1，一樣糊掉。
          · `bg-accented`（亮 paper-200／暗 paper-700）對 `att[0]` 是 1.18:1／1.29:1，
            兩個模式下空白格都還讀得出來（暗色甚至比原本坐在 `bg-default` 上的 1.21:1
            更清楚）。`ChartBand.vue` 那條「1.16:1 會跟底糊在一起」記的是同一筆帳。
          ⇒ 要改這裡的底色，先去 `app/utils/chart-theme.ts` 對一次 `att[0]` 的值。

        ★ hover 與「選中」用**同一個**底色：hover 的意思就是「按下去會變成這樣」。
          兩者靠左邊那條 `border-l-primary` 與粗體年份區分，不再發明第三種色階。
          只在 `interactive` 為真時才給 hover——`interactive: false` 是「只當門面」。

        ⚠️ **不加 transition。** DS §6 逐字寫著「沒有每張卡片的 hover transition」，
           而且 13 列同時在畫面上，逐列淡入淡出會讓整張年表看起來在呼吸。
           沒有動畫也就不需要 `motion-reduce:`（這個 repo 沒有全域規則）。
        ⚠️ 底色與粗體都不改變**列高**，也不改 `border-l-2` 的寬度——那兩者一動，
           整條年表會在 hover 時逐列跳版。
      -->

      <!--
        ★「全部年度」——全期檢視視角（2026-09-06 起是**預設**）。
          它刻意沒有 53 格：那 53 格的座標軸是「一個日曆年裡的第幾週」，
          跨年度沒有這個座標。把十三年疊起來畫成一列會是一條幾乎全滿的黑帶，
          既不傳達東西，又會被讀成「這是某一年」。所以這一列只有標籤與總數，
          並用一條髮絲線跟下面的年份列分開，讀起來是「檢視範圍」而不是「某一年」。

          ⚠️ 2026-09-14 補：這一列被選中（＝預設狀態）時，**亮色下那條髮絲線看不見**
             ——`border-b-default` 是 `--ui-border` = neutral-200 = paper-200，而
             `bg-accented` 亮色也正好是 paper-200，底色就蓋在自己的邊框上。
             這是接受的：選中時分隔的工作改由「整塊 tan 色區的下緣」對下面 paper-25 的
             年份列去做，分隔沒有消失，只是換了一個東西在做。
             **不要改用 `border-accented` 去救**——暗色的 `--ui-border-accented` 是
             neutral-700，跟暗色的 `bg-accented` 又是同一個值，只是把同一個碰撞搬到
             另一個模式去而已。
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
      提示。照 `HourHeatmap.vue` 末尾的先例（`mt-2 text-xs text-muted`）。
      2026-09-14 David：「年表的年份能點擊這件事不太明顯」——底色回饋只有滑鼠移上去
      才看得到，觸控裝置根本沒有 hover，所以還要有一句話直接說它會發生什麼事。
      `interactive: false`（只當門面）時不出現：那時點了不會有任何事。
    -->
    <p v-if="interactive" :id="hintId" class="mt-2 text-xs text-muted">
      <!-- 後半句只有在真的有那一列時才成立——`showAll: false` 的呼叫端沒有「全部年度」。 -->
      {{ showAll ? '點一列就只看那一年；最上面那列回到全部年度' : '點一列就只看那一年' }}
    </p>
  </div>
</template>
