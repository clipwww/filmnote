<script setup lang="ts">
import type { DistItem } from '~/utils/stats'

/**
 * 分布長條（`SCREENS.md §9` band 5/6）。影城、版本、國別共用。
 *
 * ── 為什麼不是圓餅圖 ──────────────────────────────────────────
 * 實測 David 的分布極度傾斜：影城 115/169（68%）、國別 日本 98／美國 66／
 * 其餘 5 筆、版本 2D 126／4DX 20／IMAX 7。一個佔 68% 的扇形不傳達任何東西，
 * 而 375px 下每個標籤只分到約 90px，`林口MITSUI OUTLET PARK威秀影城`
 * 會被截到無法辨識（§5.2）。
 *
 * ── 為什麼這一張不用 ECharts ──────────────────────────────────
 * §5.2 要「標籤壓在條上」是為了讓長中文片名有整個容器寬可用；§1.3 又要求
 * 「條的填色不要用色階淺端，標籤要壓在條上就把標籤移到條的上方一行」。
 * 兩條加起來的結論就是**名稱自己一行、條在下面一行**——那是 HTML 排版，
 * 不是圖表。用 CSS 做還順便拿到：375px 自動換行、螢幕閱讀器讀得到數字、
 * 鍵盤可達、零 canvas。年表 YearStrip 也是同樣的理由不用圖表庫。
 *
 * ── ★★ 顏色不可以在 JS 裡用 `useColorMode()` 挑（踩雷 #88）─────────────────
 * 這支本來寫成 `const fill = computed(() => chartPalette(colorMode.value === 'dark')…)`
 * 再寫進 inline style。**在 `ssr: false` 的 `/app` 上完全正常**，
 * 2026-09-06 把它搬到 SSR 的 `/u/` 之後立刻炸：
 *
 *   [Vue warn] Hydration style mismatch
 *     - rendered on server: style="background-color:#685946"   ← 亮色的 heat[4]
 *     - expected on client: style="background-color:#A59788"   ← 暗色的 heat[4]
 *   Hydration completed but contains mismatches.
 *
 * 伺服器端算出來的是一種模式、瀏覽器 hydrate 時是另一種，而**畫面看起來
 * 完全正常**，只在 console 留一行。前一棒的交接筆記就是這樣預言的：
 * 「`/app` 是 `ssr: false` 所以看不到，同一個元件搬到 `/u/` 就會炸」。
 *
 * 正解（與 `YearStrip` 同一招）：把**亮暗兩組值都**印成 custom property
 * ——兩邊都是常數，SSR 與 client 必然相同——再由 Nuxt UI 註冊的
 * `@variant dark (&:where(.dark, .dark *))` 決定用哪一組。
 * ⚠️ 不要改用 SFC `<style scoped>` 裡的 `:global(.dark) X` 去挑，**實測沒有生效**。
 *
 * ── 「其他 N 家」為什麼是按鈕，不是原生的揭露元素（2026-09-07）─────────
 * 1. **展開狀態必須由 Vue 擁有。** 實測 David 的 13 個年度裡，只有 2016（7 家）
 *    與全期（15 家）會長出「其他」那一列，其餘 11 年 ≤5 家、那一列根本不存在
 *    ⇒ 換年份**一定要收回去**（而兩個頁面都沒有給這支 `:key`，換年份不 remount）。
 *    原生揭露元素的開合是 DOM 狀態，要收就得綁 `:open` 再接 `@toggle` 同步回來
 *    ——比一個 ref 多兩個會對不起來的地方，換到的「免費狀態」並不免費。
 * 2. **原生揭露元素的標題列會把整塊變成觸發區。** 這裡的一列是「名稱＋數字」
 *    一行、「長條」一行；整列可點就等於宣告「這條長條可以點」，
 *    而其他長條一條都不能點（這支至今沒有 @pick）。用按鈕才能把觸發區
 *    精準地只包住第一行。
 * ⇒ 與 `SCREENS §10.4` 同一個裁決的形狀：可及性的展開屬性 + 按鈕，
 *   不是 `div @click`、不是 `title`。
 *
 * ⚠️ 這段註解刻意**不寫**那幾個標籤名與屬性名的字面 token（踩雷 #166：
 *   `src.includes(...)` 型的字串比對檢查會被註解裡的同名字串餵飽，
 *   於是呼叫被整個拿掉照樣綠）。要守這個檔請解析 DOM，不要比字串。
 */
const props = defineProps<{
  items: DistItem[]
  /** 場次的量詞，例如「場」。 */
  unit?: string
}>()

/**
 * 全部長條共用**同一把尺**：最長那一條（第一列）當 100%。
 *
 * ★★ 展開出來的長尾也用這一把，不可以換成長尾自己的最大值。實測 David 全期，
 *    「其他 10 家」裡 3 場的那一條若拿自己當滿版，會被畫得跟 120 場的主場一樣長
 *    ——那比不展開更糟，因為它看起來像資料。代價是展開後會看到十根幾乎一樣短的
 *    小刺，那是誠實的代價（David 2026-09-07 裁決）。
 */
const scale = computed(() => Math.max(1, props.items[0]?.records ?? 1))

/** 長條寬度只有這一個算式——收合列與展開列共用，免得日後兩邊漂移。 */
function barWidth(records: number) {
  return `${Math.max(2, (records / scale.value) * 100)}%`
}

/** 「其他」那一列是否展開。一組 items 裡最多只有一列有 `rest`，一個布林就夠。 */
const openRest = ref(false)

/**
 * ★ 換年份要自動收回去。
 *
 * ⚠️ **watch 的是 `props.items` 這個陣列參考本身，不要「化簡」成 `items.length`。**
 *   實測全期是 6 列（5 + 其他 10 家）、2016 也是 6 列（5 + 其他 2 家）——
 *   長度一模一樣。用長度當 source，全期(展開中) → 2016 這一步就不會觸發重置，
 *   而那正是這個 watch 唯一要擋的 bug。
 */
watch(() => props.items, () => {
  openRest.value = false
})

/**
 * 展開清單的 id，給按鈕的關聯屬性用。
 *
 * ⚠️ **一定要 `useId()`，不可以 `Math.random()` / `Date.now()` / 模組層的計數器**：
 *   `/u/` 是 SSR，伺服器與瀏覽器各產一個就是 hydration mismatch，而
 *   **屬性的 mismatch Vue 不會幫你修**（踩雷 #98：按鈕文字被改正、href 停在舊值）。
 * ⚠️ 也不可以提到模組範圍或改寫成常數：同一頁有三個實例（影城／版本／國別），
 *   共用一個 id 會讓關聯屬性指到別人的清單。
 */
const restId = useId()

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
  <ul class="space-y-3" :style="BAR_VARS">
    <li v-for="(it, i) in items" :key="it.name">
      <!--
        「其他 N 家」那一列：**只有這一列可以點，而且觸發區刻意只到名稱那一行**。
        底下那條長條與其他列長得一模一樣，如果它也吃點擊，使用者會以為每一條
        都能點——而實際上一條都不能。
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
            沒有這個箭頭，「其他 10 家」看起來只是一行字，沒有人會去點它。
            ⚠️ `motion-reduce:transition-none`：DS §6 要求尊重 prefers-reduced-motion
               ——這個 repo 目前**沒有**任何全域規則在做這件事，所以每一處都得自己寫。
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

      <!-- 一般列：與改動前完全相同。 -->
      <div v-else class="flex items-baseline justify-between gap-3">
        <span class="min-w-0 text-sm" :class="i === 0 ? 'font-medium text-highlighted' : 'text-toned'">
          {{ it.name }}
        </span>
        <span class="shrink-0 text-sm tabular-nums text-muted">{{ it.records }}{{ unit ?? '' }}</span>
      </div>

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
        展開後的完整清單。
        ⚠️ 必須留在這個 `<li>` 裡：外層是 `<ul>`，它的直接子元素只能是 `<li>`。
           （不是因為 `--bar-*` 會解析不到——那四個 custom property 印在最外層
           `<ul>` 上，這一層是它的後代，繼承得到。把理由寫對，下一個人才不會
           「驗一次發現顏色好端端的」就推論整段註解都不可信。）
        ⚠️ 刻意**沒有**進場動畫：DS §6「其餘一律沒有進場動畫」。直接出現。
        ⚠️ 這裡不重算基準，用同一個 `barWidth()`。
      -->
      <ul v-if="it.rest?.length && openRest" :id="restId" class="mt-3 space-y-3 border-l border-default pl-3">
        <li v-for="sub in it.rest" :key="sub.name">
          <div class="flex items-baseline justify-between gap-3">
            <!-- 巢狀這一層第一列**不加粗**：它只是長尾裡最大的一條，不是主場。 -->
            <span class="min-w-0 text-sm text-toned">{{ sub.name }}</span>
            <span class="shrink-0 text-sm tabular-nums text-muted">{{ sub.records }}{{ unit ?? '' }}</span>
          </div>
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
</template>
