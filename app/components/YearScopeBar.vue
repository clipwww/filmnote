<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

/**
 * 導覽列上的年份切換器（2026-09-14 David：「往下滑時希望 header 也有選項可以直接切換年份」）。
 *
 * ── 它解決的是「捲下去之後就切不了年份」──────────────────────────────
 * 年表（`YearStrip`）是這兩頁的檢視視角選擇器，但它坐在最上面的第一條 band。
 * 往下捲到時段熱點圖、去了哪裡、票根列表之後，唯一能換年份的東西已經在畫面外
 * ——要換年得先捲回頂端。這個元件把同一個選擇搬到常駐的導覽列上。
 *
 * ── ⚠️ 為什麼是 Teleport 進導覽列，而不是自己做第二條 sticky bar ──────
 * `default.vue` 的註解寫得很清楚：導覽列總高 57px 是手調出來的常數
 * （`h-14` 56px ＋ `border-b` 1px）。第二條 bar 就得釘 `top-[57px]`，而那個
 * 57 是**抄**來的——哪天列高改了，這裡不會編譯失敗、不會有測試變紅，只會在
 * 某個畫面上靜靜地錯開一條縫。而且多一層 sticky 就多一個 z-index 要跟
 * `UDrawer` 的遮罩（50，見 `app.config.ts` 的 z 階）對帳。
 * Teleport 進既有的那一條，兩件事都不會發生：位置由導覽列自己決定，
 * z 階也直接繼承導覽列的 30。
 *
 * ── 元件是多根的，這是刻意的 ──────────────────────────────────────
 * 第一根是留在原地的 sentinel（觀測點），第二根是 Teleport。它不是頁面根節點，
 * 多根不會有 attribute fallthrough 的問題（呼叫端沒有傳 class 進來）。
 */
const props = defineProps<{
  years: number[]
  /** `null` = 全部年度。跟 `YearStrip` 同一個語意，不是「還沒選」。 */
  selected: number | null
}>()

const emit = defineEmits<{ 'update:selected': [year: number | null] }>()

/**
 * 導覽列的總高：`default.vue` 的 `h-14`（56px）＋ `border-b`（1px）。
 *
 * ⚠️ **這個數字跟 `default.vue` 綁在一起，改列高要一起改。** `SCREENS §0.1`
 * （全站外殼／頂部導覽列）的
 * 「跟著導覽列走的偏移」那一欄已經有一個同類的常數
 * （`LegalDocumentView.vue` 的 `md:top-18`），這裡是第二個。
 */
const HEADER_H = 57

const sentinel = useTemplateRef<HTMLElement>('sentinel')

/** 切換器現在該不該出現。初值 false：頁面頂端時年表就在畫面上，不需要它。 */
const shown = ref(false)

let io: IntersectionObserver | null = null

/**
 * ── ⚠️ 判準不是 `isIntersecting`，是「sentinel 已經捲到導覽列上方」────
 *
 * sentinel 在**視窗下方**（使用者還沒捲到）時 `isIntersecting` 同樣是 false。
 * 只看它的話，`/app` 一載入、年表還在下面沒被捲到，切換器就已經跑出來了
 * ——而那時年表本人就在畫面上，兩個一樣的選擇器同時在。
 * 所以要再問一句「它是從**上面**離開的嗎」：`boundingClientRect.bottom < HEADER_H`。
 *
 * ── 為什麼還要 `rootMargin` ─────────────────────────────────────
 * 預設的 root 是視窗，`isIntersecting` 要到 sentinel 完全越過 y=0 才翻成 false，
 * 那時 `bottom < 57` 早就成立了 ⇒ 上面那句話會變成永遠為真的裝飾，而切換器會
 * 晚 57px 才出現（sentinel 被導覽列蓋住的那段路，它還沒現身）。
 * 把 root 的上緣往下推 57px 之後，翻面的時機**正好**是「滑進導覽列下面」，
 * 而 `bottom < HEADER_H` 這一項才真的在分辨「上方離開」與「下方還沒到」。
 * 兩處用同一個常數。
 */
onMounted(() => {
  const el = sentinel.value
  if (!el)
    return

  io = new IntersectionObserver(([entry]) => {
    if (!entry)
      return
    shown.value = !entry.isIntersecting && entry.boundingClientRect.bottom < HEADER_H
  }, { rootMargin: `-${HEADER_H}px 0px 0px 0px` })

  io.observe(el)
})

// 換頁時 observer 不會自己停，而它抓著一個已經不在文件裡的節點。
onBeforeUnmount(() => {
  io?.disconnect()
  io = null
})

/**
 * 新到舊。**不假設呼叫端的順序**——`/u/` 與 `/app` 的 `stripRows` 是各自算的，
 * 這裡自己排一次，之後誰改了上游都不會讓選單的順序無聲地反過來。
 */
const yearsDesc = computed(() => [...props.years].sort((a, b) => b - a))

/** 螢幕閱讀器與 `aria-label` 用的完整說法；按鈕上的可見文字是它的縮寫。 */
const currentLabel = computed(() => props.selected === null ? '全部年度' : `${props.selected} 年`)

/**
 * 選單用 `UDropdownMenu` ＋ `type: 'checkbox'`，形狀抄 `AppNav.vue` 的外觀切換
 * （`themeGroup`，同檔 144–180 行是呼叫點）。
 *
 * ── 為什麼不是 `USelect`（`app/pages/app/records/index.vue:333` 那種）──
 * `USelect` 的 `v-model` 收不到 `null`——那是它的「還沒選」狀態，會顯示 placeholder。
 * 而這裡的 `null` 是一個**正當的值**（全部年度，見 `YearStrip` 檔頭）。要用它就得
 * 自己發明一個哨符字串再翻譯回來，那條路上有兩個可以寫錯的地方。checkbox 選單
 * 直接把「目前是哪一個」畫成勾勾，沒有哨符。
 *
 * ⚠️ `onUpdateChecked` 帶的是**新的** checked 狀態：點已經勾起來的那一項會收到
 * `false`。這一組是單選語意（不存在「什麼都沒選」），所以只在 `v` 為真時才發。
 */
const items = computed<DropdownMenuItem[][]>(() => [[
  {
    type: 'checkbox',
    label: '全部年度',
    checked: props.selected === null,
    onUpdateChecked: (v: boolean) => v && emit('update:selected', null),
  },
  ...yearsDesc.value.map(y => ({
    type: 'checkbox' as const,
    // 標籤跟年表上看到的一模一樣（純數字），兩個選擇器是同一件事的兩個入口。
    label: String(y),
    checked: props.selected === y,
    onUpdateChecked: (v: boolean) => v && emit('update:selected', y),
  })),
]])
</script>

<template>
  <!--
    觀測點。留在原地（呼叫端把這個元件放在年表那條 band 後面），高度 1px、
    `aria-hidden`——它不是內容，只是一個「捲過這裡了沒」的量尺。
  -->
  <div ref="sentinel" aria-hidden="true" class="h-px w-full" />

  <!--
    ⚠️ `<ClientOnly>` 是必要的：`/u/[username]` 是 SSR 頁，而 Teleport 的目標在
       伺服器端是用字串比對去找的，`to` 指到一個還沒 render 出來的容器時行為不穩
       （警告、或內容落在錯的地方）。而這條 bar 一開始本來就是隱藏的
       （`shown` 初值 false），SSR 少畫它**不會少畫任何東西** ⇒ 包起來零代價。
  -->
  <ClientOnly>
    <Teleport to="#header-year-scope">
      <!--
        ⚠️ 只動 `opacity`，150ms。**不要用位移或高度動畫**——導覽列的高度一變，
           它下面的整頁內容就會跟著跳（`h-14` 是版面的地基，見 `SCREENS §0.1`）。
        DS §6 說「其餘一律沒有進場動畫」，這裡不是進場動畫而是**互動回饋**：
        它回應的是使用者自己的捲動，而且守著同一節的兩條硬規則
        （≤200ms ease-out、只動 compositor 屬性）。
        `motion-reduce:transition-none`：這個 repo 沒有全域規則，每一處自己加。
      -->
      <Transition
        enter-active-class="transition-opacity duration-150 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-150 ease-out motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <!--
          `<Transition>` 要的是**單一個真實元素**。`UDropdownMenu` 的 vnode 根是
          「觸發鈕 ＋ Portal」的 fragment，直接包會拿到 Vue 的多根警告，所以外面
          墊一層 div。它同時是 375px 下的收縮點（`min-w-0`）。

          `years.length` 的守門：沒有任何紀錄的公開頁不該出現一個只剩「全部年度」
          的選單——那是一個選不出東西的選擇器。
        -->
        <div v-if="shown && years.length" class="flex min-w-0 items-center">
          <UDropdownMenu :items="items" :content="{ align: 'center', sideOffset: 6 }">
            <!--
              375px 下這一行要塞三樣東西：字標約 45px（`BrandWordmark` 比例 2.065:1 × 22）
              ＋「filmnote」約 46px、右邊 `AppNav` 的選單鈕約 120–150px，
              扣掉 `px-4` 之後可用寬 343px ⇒ 中間這顆必須在 60px 上下。
              所以：`size="xs"` 比 `AppNav` 的 `sm` 小一階、`variant="ghost"` 不畫框，
              而且「全部年度」在 sm 以下只印「全部」（選單裡仍然是完整的四個字，
              `aria-label` 也唸完整的）。量到的寬度約 58px，字標不會被擠掉。
              `size="xs"` 的鈕高 24px——剛好踩在 WCAG 2.5.8 的 24×24 下限上，
              再小就過不了，不要為了更窄而降。
            -->
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              trailing-icon="i-lucide-chevron-down"
              class="whitespace-nowrap"
              :aria-label="`檢視的年份：${currentLabel}`"
            >
              <span class="tabular-nums">{{ selected ?? '全部' }}</span>
              <!-- 相鄰元素之間的換行會被 Vue 的 whitespace 'condense' 吃掉 ⇒ 這裡不會多一個空白 -->
              <span v-if="selected === null" class="hidden sm:inline">年度</span>
            </UButton>
          </UDropdownMenu>
        </div>
      </Transition>
    </Teleport>
  </ClientOnly>
</template>
