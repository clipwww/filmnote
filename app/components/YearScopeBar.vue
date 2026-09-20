<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

/**
 * 導覽列上的年份切換器。它解決的是「捲下去之後就切不了年份」——年表是這兩頁的檢視視角
 * 選擇器，但它坐在第一條 band，捲過去之後唯一能換年份的東西已經在畫面外。
 */
/*
 * ⚠️ Teleport 進既有的導覽列，不自己做第二條 sticky bar：後者得釘 `top-[57px]`，而那個 57 是
 * **抄**來的（導覽列 `h-14` 56 ＋ `border-b` 1），列高一改不會編譯失敗也不會有測試變紅，
 * 只會靜靜錯開一條縫；而且多一層 sticky 就多一個 z-index 要跟 `UDrawer` 的遮罩（50）對帳。
 */
/*
 * 元件是多根的（sentinel ＋ Teleport），這是刻意的。它不是頁面根節點，
 * 多根不會有 attribute fallthrough 的問題（呼叫端沒有傳 class 進來）。
 */
const props = defineProps<{
  years: number[]
  /** `null` = 全部年度。跟 `YearStrip` 同一個語意，不是「還沒選」。 */
  selected: number | null
}>()

const emit = defineEmits<{ 'update:selected': [year: number | null] }>()

/**
 * 導覽列總高 = `default.vue` 的 `h-14`（56）＋ `border-b`（1）。⚠️ **這個數字跟 `default.vue`
 * 綁在一起，改列高要一起改**（`SCREENS §0.1`「跟著導覽列走的偏移」的第二個同類常數）。
 */
const HEADER_H = 57

const sentinel = useTemplateRef<HTMLElement>('sentinel')

/** 切換器現在該不該出現。初值 false：頁面頂端時年表就在畫面上，不需要它。 */
const shown = ref(false)

let io: IntersectionObserver | null = null

/**
 * ⚠️ 判準不是 `isIntersecting` 是「sentinel 已經捲到導覽列**上方**」：sentinel 在視窗下方
 * （還沒捲到）時 `isIntersecting` 同樣是 false ⇒ 只看它的話，年表還在畫面上切換器就已經
 * 跑出來了。所以要再問一句 `boundingClientRect.bottom < HEADER_H`。
 */
/*
 * `rootMargin` 也必要：預設 root 是視窗，要到 sentinel 完全越過 y=0 才翻 false，那時
 * `bottom < 57` 早就成立 ⇒ 上面那句變成永遠為真的裝飾，而切換器會晚 57px 才出現。
 * 把 root 上緣往下推 57px 之後，翻面的時機正好是「滑進導覽列下面」。兩處用同一個常數。
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
 * 選單用 `UDropdownMenu` ＋ checkbox，不用 `USelect`：後者的 `v-model` 收不到 `null`（那是它的
 * 「還沒選」狀態），而這裡的 `null` 是一個**正當的值**（全部年度）。要用它就得自己發明一個
 * 哨符字串再翻譯回來，那條路上有兩個可以寫錯的地方。checkbox 直接把「目前是哪一個」畫成勾勾。
 */
/*
 * ⚠️ `onUpdateChecked` 帶的是**新的** checked 狀態：點已經勾起來的那一項會收到 `false`。
 * 這一組是單選語意（不存在「什麼都沒選」），所以只在 `v` 為真時才發。
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
    ⚠️ `<ClientOnly>` 是必要的：`/u/` 是 SSR，而 Teleport 的目標在伺服器端是用字串比對去找的，
       `to` 指到還沒 render 出來的容器時行為不穩。而這條 bar 一開始本來就隱藏（`shown` 初值
       false），SSR 少畫它不會少畫任何東西 ⇒ 包起來零代價。
  -->
  <ClientOnly>
    <Teleport to="#header-year-scope">
      <!--
        ⚠️ 只動 `opacity`，150ms。**不要用位移或高度動畫**——導覽列的高度一變，下面整頁就跟著跳。
        DS §6 說「其餘一律沒有進場動畫」，這裡不是進場動畫是**互動回饋**（回應使用者自己的捲動），
        並守著同一節的兩條硬規則。`motion-reduce:transition-none`：這個 repo 沒有全域規則。
      -->
      <Transition
        enter-active-class="transition-opacity duration-150 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-150 ease-out motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <!--
          `<Transition>` 要**單一個真實元素**，而 `UDropdownMenu` 的 vnode 根是「觸發鈕＋Portal」的
          fragment ⇒ 外面墊一層 div（它同時是 375px 下的收縮點）。
          `years.length` 的守門：沒有紀錄的公開頁不該出現一個只剩「全部年度」的選擇器。
        -->
        <div v-if="shown && years.length" class="flex min-w-0 items-center">
          <UDropdownMenu :items="items" :content="{ align: 'center', sideOffset: 6 }">
            <!--
              375px 下這一行要塞三樣：字標約 45px ＋「filmnote」約 46px ＋ 右邊 AppNav 約 120–150px，
              扣掉 `px-4` 可用寬 343px ⇒ 中間這顆必須在 60px 上下（實測約 58px，字標不會被擠掉）。
              ⚠️ `size="xs"` 的鈕高 24px 剛好踩在 WCAG 2.5.8 的 24×24 下限上，再小就過不了。
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
