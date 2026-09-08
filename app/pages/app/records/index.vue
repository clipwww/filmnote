<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { MyRecord } from '~/composables/useMyRecords'
import type { Database } from '~/types/database.types'
import { watchedAtText } from '~/utils/format-datetime'
import { costText, venueSegment } from '~/utils/ticket'

/**
 * `/app/records` — 個人紀錄管理（`SCREENS.md §10`）。
 *
 * ── 2026-09-06：從票根卡列表改成表格 ───────────────────────────────────
 * David：「紀錄管理用 Table + 一些簡易 Filter」。這是**這一頁的呈現改變，
 * 不是 `TicketCard` 退場**——`/u/`、`/film/` 的「誰看過」、匯入預覽都還在用它，
 * 而且這一頁的刪除確認框裡仍然是票根卡（要確認「刪的是哪一筆」時，
 * 一張看得出是什麼的卡片比一列表格好）。
 *
 * 兩種呈現各自對的地方：
 *   · 票根卡是**一筆一筆看**——公開頁、單筆分享、確認框。
 *   · 表格是**橫著比**——「我在哪家戲院花最多」「哪些沒填票價」要對齊欄位才看得出來。
 *
 * ── 2026-09-06（第二次）：這一頁的定位從「全部紀錄」改成「個人紀錄管理」──
 * David：「這邊比較像是個人的資料維護後台」。頁名、日期格式、備註與公開狀態欄、
 * 操作欄固定，四件事都是同一個定位的結果：
 *   · **頁名**：「全部紀錄」講的是範圍，「個人紀錄管理」講的是你在這裡做什麼。
 *   · **日期**用機器可讀的 `YYYY/MM/DD HH:mm`（見 `#watchedOn-cell` 的註解）。
 *   · **備註與公開狀態**要看得到——維護資料時「這筆為什麼特別」與「誰看得到」
 *     跟票價一樣是要對帳的欄位，藏起來就得一筆一筆點進編輯頁才知道。
 *   · **操作欄固定**：九欄在窄螢幕上必然要橫捲，而「刪掉／編輯」是每一列都要
 *     按得到的東西，捲出畫面等於這張表在手機上只能看不能改。
 *
 * ── 2026-09-07：長備註改成點開 Dialog 看全文 ──────────────────────────
 * David 看過三個並排預覽之後選的是「**短備註留在格子裡，只有長的給鈕**」——
 * 不是「一律 Dialog」。所以上面那條「備註要看得到、藏起來就得一筆一筆點進
 * 編輯頁」**仍然成立**：73 筆有備註裡的 54 筆（實測）照樣印在格子裡；
 * 剩下 19 筆長的，全文改成在**這一頁**點開對話框看，一樣不用進編輯頁。
 * 改掉的只是「原地展開把那一列撐高」這個動作。
 *
 * ⚠️ 這一輪**沒有**解掉「靜止時備註被固定欄蓋住 93px」（見 `columns` 上方的
 * 算術）。David 是在明知這一點的情況下選的：他要的是**長備註看得完整**，
 * 不是重排表格。不要因為看到備註欄變窄就以為那個問題被處理過了。
 *
 * ── 篩選維度是從真實資料長出來的 ───────────────────────────────────────
 * 年份／影城／版本／有無票價。前三個的選項直接從**當年**的紀錄取相異值——
 * 不從全部紀錄取，否則會出現一堆選了就 0 筆的選項，而使用者無從得知為什麼。
 * 「有無票價」是第四個維度：174 筆裡有 5 筆沒有金額，那正是要補資料的那幾筆。
 *
 * ⚠️ 不用 `UTable` 的 `virtualize`：它要求容器有確定高度（踩雷 #54），
 * 而這一頁的容器是隨內容長的。改用原本就有的分批載入——單一年份大多在 30 筆
 * 以內，攤開也不會變成一萬 px 的頁面。
 */
useSeoMeta({ title: '個人紀錄管理' })

const supabase = useSupabaseClient<Database>()
const toast = useToast()

const { records, status, refresh } = useMyRecords()

/* ── 篩選 ─────────────────────────────────────────────────────────────── */
const years = computed(() => [...new Set(records.value.map(r => r.year))])
const selectedYear = ref<string | null>(null)
/** null 代表「還沒選過」⇒ 用最近的一年；'' 代表使用者選了「全部」。 */
const activeYear = computed(() => selectedYear.value ?? years.value[0] ?? '')

const byYear = computed(() =>
  activeYear.value ? records.value.filter(r => r.year === activeYear.value) : records.value)

const ALL = '__all__'
const venue = ref(ALL)
const format = ref(ALL)
const cost = ref(ALL)

/** 選項只從當年的紀錄長出來：選了就 0 筆的選項比沒有選項更難用。 */
function options(values: (string | null | undefined)[], allLabel: string) {
  const seen = [...new Set(values.map(v => v?.trim()).filter((v): v is string => !!v))].sort()
  return [{ label: allLabel, value: ALL }, ...seen.map(v => ({ label: v, value: v }))]
}
const venueOptions = computed(() => options(byYear.value.map(r => r.venueName), '所有影城'))
const formatOptions = computed(() => options(byYear.value.map(r => r.formatLabel), '所有版本'))
const costOptions = [
  { label: '票價不限', value: ALL },
  { label: '有填票價', value: 'has' },
  { label: '沒填票價', value: 'none' },
]

/** 分批載入的一批。單一年份大多在 30 筆以內，攤開也不會變成一萬 px 的頁面。 */
const PAGE = 24
const shown = ref(PAGE)

// 換年份時把其餘篩選重設：留著一個當年不存在的影城，畫面會是空的而且看不出原因。
watch(activeYear, () => {
  venue.value = ALL
  format.value = ALL
  cost.value = ALL
  shown.value = PAGE
})

const filtered = computed(() => byYear.value.filter((r) => {
  if (venue.value !== ALL && r.venueName?.trim() !== venue.value)
    return false
  if (format.value !== ALL && r.formatLabel?.trim() !== format.value)
    return false
  if (cost.value === 'has' && (r.cost === null || r.cost === undefined))
    return false
  if (cost.value === 'none' && r.cost !== null && r.cost !== undefined)
    return false
  return true
}))

const hasNarrowed = computed(() => venue.value !== ALL || format.value !== ALL || cost.value !== ALL)
function clearFilters() {
  venue.value = ALL
  format.value = ALL
  cost.value = ALL
}

watch(filtered, () => {
  shown.value = PAGE
})
const visible = computed(() => filtered.value.slice(0, shown.value))
const hasMore = computed(() => filtered.value.length > shown.value)

/* ── 備註（短的印在格子裡，長的點開對話框）─────────────────────────────
 * ⚠️ 備註是自由文字：實測 174 筆裡 73 筆有備註、平均 14.3 字、最長 67 字、
 * **5 筆含換行**、規格上限 2000 字（DB 的 `viewing_record_memo_check`）。
 * 所以「摺成單行」這一步不能省——換行在單行的格子裡會被畫成一個看不見的
 * 斷點，讀起來像少了字。全文才用 `whitespace-pre-wrap` 還原原本的斷行。
 *
 * ⚠️ 觸發器一定要是 `<button>`：`title` 屬性在觸控裝置上沒有 hover，
 * `<div @click>` 則是鍵盤到不了。**`UTooltip` 也是同一個失效模式**——
 * reka-ui 的 `TooltipTrigger` 對 `pointerType === 'touch'` 的 pointermove
 * 直接 return、隨後的 focus 又被 `isPointerDown` 擋掉、click 直接 onClose，
 * 375px 上它**根本不會開**。所以 tooltip 只能當桌機的加值層，
 * **唯一保證讀得到全文的路徑是那個 `UModal`**。
 *
 * ── 2026-09-07 David：「短備註留在格子裡，只有長的給鈕」 ────────────────
 * 門檻沿用改動前的 16 個全形字（實測：73 筆有備註裡 54 筆短、19 筆長），
 * **刻意不因為欄寬變窄而下修**——下修會把「掃一眼就讀到」的那 54 筆也趕進
 * 對話框，那正是他看過預覽後否決的那一版。
 *
 * ⚠️ 於是門檻（16 字）跟欄寬（`max-w-32`＝128px，約 9 個全形字）**不再對齊**，
 * 這是刻意的，代價各自處理：
 *   · 短備註（沒有按鈕）改成**折行**不截字。截了就永遠讀不到——它沒有按鈕。
 *     最長的那筆短備註是 16 字（「一人包場，真正的一個人看電影XD」），
 *     在 128px 下折成兩行，而作品欄本來就常態兩行，列高不會因此變一種新的樣子。
 *   · 長備註（有按鈕）交給 CSS 的 `truncate` 截，**不再用 JS 先截一次**。
 *     兩邊都截會出現兩個省略號；只有 CSS 截、而且截了一定有按鈕，才是對的。
 */
const MEMO_INLINE_MAX = 16

/** 摺成單行：換行在格子裡會被畫成一個看不見的斷點，讀起來像少了字。 */
function memoOneLine(memo: string) {
  return memo.replace(/\s+/g, ' ').trim()
}
function memoIsLong(memo: string) {
  // `[...s]` 而不是 `.length`：emoji 是兩個 UTF-16 碼元，用 slice 會切出半個字。
  return /\n/.test(memo) || [...memoOneLine(memo)].length > MEMO_INLINE_MAX
}

/**
 * 全文對話框。**一個 Modal 服務整張表**（24 列各生一個 `DialogRoot` 是白花的），
 * 所以「開出來的是哪一列」全靠 `memoRecord` 這一個 ref。
 *
 * ⚠️ 關閉時**刻意不清空** `memoRecord`：`UModal` 有 200ms 的關閉動畫
 * （主題的 `transition` 變體），清空的話這 200ms 內內文會先變空、副標變空字串、
 * footer 的 `:to` 變成 `/app/records/undefined/edit`，畫面上是「字先消失、
 * 框才淡出」。留著上一筆沒有任何壞處：`memoOpen` 是 false 時它看不見。
 */
const memoOpen = ref(false)
const memoRecord = ref<MyRecord | null>(null)

function openMemo(record: MyRecord) {
  memoRecord.value = record
  memoOpen.value = true
}

/**
 * 觸發鈕的無障礙名稱。一張表裡最多 24 顆長得一樣的鈕，**只寫「備註」或
 * 「備註：{片名}」不夠**——同一部片會有多筆重刷紀錄，日期才分得出是哪一筆。
 * ⚠️ 這是純文字的 aria-label，分隔用**半形空格**（跟 `ticketMetaLine()` 一致）；
 * 全形空白是給畫面上看得到的字用的。
 */
function memoFilmTitle(record: MyRecord) {
  // ⚠️ 刻意**不**共用 `#film-cell` 的兩種 fallback（「（作品不明）」／「（作品待審核）」）：
  //    那兩個字串講的是「這筆紀錄的作品欄怎麼了」，在「備註：…」這個句子裡讀起來
  //    像在說備註本身有問題。這裡只需要一個指得出是哪一筆的名字。
  return record.film?.titleZh || record.film?.titleOriginal || '這筆紀錄'
}
function memoTriggerLabel(record: MyRecord) {
  return `備註：${watchedAtText(record.watchedOn, record.watchedTime)} ${memoFilmTitle(record)}`
}
/** 對話框副標。畫面上看得到 ⇒ 分隔用全形空白（DS §7，不用中點）。 */
const memoDialogSubtitle = computed(() => {
  const record = memoRecord.value
  return record ? `${watchedAtText(record.watchedOn, record.watchedTime)}\u3000${memoFilmTitle(record)}` : ''
})

/* ── 表格 ─────────────────────────────────────────────────────────────── */
/**
 * ⚠️ 操作欄用 `UTable` 內建的 column pinning（`:column-pinning`），但**必須把
 * 底色蓋成不透明**：Nuxt UI 的 `pinned` 變體給的是 `bg-default/75`，捲動時
 * 底下的欄位會透出來疊在按鈕上。`bg-default!` 的 `!` 是必要的——
 * 半透明那一版來自元件主題，沒有 important 不保證蓋得掉（踩雷 #186）。
 *
 * ⚠️ 而 `bg-default` 是**票根紙**（`--ui-bg`＝paper-25／暗 paper-900），
 * `body` 是**台紙**（paper-50／paper-950）。兩者不同色 ⇒ sticky 格的底色必須跟
 * 表格自己的底一致，所以整張表也塗 `bg-default`，否則亮色下會出現一條淺帶。
 *
 * ── ⚠️ 操作欄釘**右**緣，而且「靜止時蓋住備註 93px」是**已知且被接受的**代價 ──
 * `position: sticky` 的固定欄**沒有辦法「佔位」，只能「疊上去」**（踩雷 #188）：
 * 內容比容器寬時，它會蓋住當下落在容器邊緣的那一欄。試過兩條路，兩條都量過：
 *   · 「捲動容器尾端補一段等寬 padding」＝**無效**，沒有預留出空間，只是換成
 *     蓋住別欄（實測：公開狀態 68px + 備註 25px，比蓋一欄還糟）。
 *   · 「改釘左緣」＝靜止時遮蔽真的變 0px，但**捲動時換成日期與作品被蓋**
 *     （實測捲到底：47px／45px），片名會少掉開頭幾個字而且沒有任何記號
 *     （截尾有「…」，截頭沒有），列的身分在捲動中消失。
 * **David 2026-09-06 看過兩版之後選釘右**：接受靜止時備註被蓋 93px
 * （備註多的年份只露約一個字），換取捲動時零遮蔽、以及影城與作品一個字都不截。
 * ⚠️ 所以**不要把它改成釘左，也不要為了消滅那 93px 去截欄寬**——
 * 那兩條路都被走過而且被否決了，理由在 `SCREENS §10.5` 與踩雷 #188。
 *
 * ── ⚠️ 2026-09-07：備註欄改窄，而那 93px **一點都沒有變** ────────────────
 * 很容易誤會「欄變窄 ⇒ 遮蔽變小」。不是。遮蔽量的規律是
 *   **遮蔽 = min(表格寬 − 容器寬, 固定欄寬)**，被蓋的是表格座標
 *   `[容器寬 − 固定欄寬, 容器寬]` 這一段。
 * 1280 下容器 1118px、固定欄 93px、2024 年備註欄**左緣在 997px**。備註欄不論
 * 多寬，靜止時露出來的都只有 `[997, 1025]` 這 28px，扣掉 `td` 的 16px 左內距
 * 之後剩 12px 的字寬——**不到一個字，改前改後一樣**。要讓它整欄露出來，
 * 備註欄得窄到 28px 以內（比「備」這個字還窄），那已經不是欄位了。
 * ⇒ 改窄換到的是**表格總寬變短、橫捲距離變短**，不是遮蔽變小。
 * 想動遮蔽只有兩條路，而兩條都在上面被否決了。不要重新開這個案子。
 */
const columns: TableColumn<MyRecord>[] = [
  { accessorKey: 'watchedOn', header: '日期', meta: { class: { td: 'w-40', th: 'w-40' } } },
  { id: 'film', header: '作品', meta: { class: { td: 'w-72', th: 'w-72' } } },
  { id: 'venue', header: '影城', meta: { class: { td: 'w-64', th: 'w-64' } } },
  { accessorKey: 'formatLabel', header: '版本' },
  { accessorKey: 'ticketCount', header: '張' },
  { accessorKey: 'cost', header: '票價' },
  { id: 'visibility', header: '公開狀態' },
  // ⚠️ 備註要**指定寬度**不能只給 max-w：九欄的自動配寬會把它壓到 86px，
  //    變成一行兩個字、十幾行高的一條——實測看到才發現，數字量不出來。
  // ⚠️ 2026-09-07 從 w-56（224px）收到 w-40（160px）：長備註的全文已經改由
  //    對話框負責，這一欄只需要放得下「掃一眼」的那 54 筆短備註。
  //    `w-40` 是 `td` 的**外**寬（border-box，含 `p-4` 的左右各 16px），
  //    所以內層要配 `max-w-32`（128px）才對得起來——`td` 的 `w-*` 只是建議，
  //    真正決定欄寬的是內層元素（踩雷 #187）。兩個數字對不上就會多出一段
  //    永遠空著的內距，或反過來把 `td` 撐回去。
  { accessorKey: 'memo', header: '備註', meta: { class: { td: 'w-40', th: 'w-40' } } },
  {
    id: 'actions',
    header: '操作',
    meta: { class: { td: 'bg-default! border-s border-default', th: 'bg-default! border-s border-default' } },
  },
]
const columnPinning = { right: ['actions'] }

/* ── 刪除（破壞性動作一律二次確認，§10 品質底線）───────────────────────── */
const pending = ref<MyRecord | null>(null)
const deleting = ref(false)
/** UModal 的 open 要 boolean，pending 存的是「哪一筆」，中間需要一層轉換。 */
const confirmOpen = computed({
  get: () => pending.value !== null,
  set: (v: boolean) => {
    if (!v)
      pending.value = null
  },
})

async function confirmRemove() {
  const target = pending.value
  if (!target)
    return
  deleting.value = true
  const { error } = await supabase.from('viewing_record').delete().eq('id', target.id)
  deleting.value = false
  if (error) {
    toast.add({ title: '刪不掉', description: error.message, color: 'error' })
    return
  }
  pending.value = null
  toast.add({ title: '刪掉了', color: 'success' })
  await refresh()
}
</script>

<template>
  <!-- 九欄的表格在 max-w-5xl 裡每一欄都被壓扁；這一頁是對帳用的，寬度給它。 -->
  <div class="mx-auto max-w-6xl px-4 py-8">
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-bold tracking-tight">
        個人紀錄管理
      </h1>
      <UButton to="/app/records/new" icon="i-lucide-plus">
        記一場
      </UButton>
    </div>

    <div v-if="status === 'pending'" class="mt-8 space-y-2">
      <USkeleton v-for="i in 8" :key="i" class="h-11 w-full rounded-sm" />
    </div>

    <p v-else-if="!records.length" class="mt-8 text-muted">
      還沒有任何紀錄。
    </p>

    <template v-else>
      <!-- 年份切換。捲軸自己橫向捲，頁面 body 永遠不橫向捲（§10 品質底線）。 -->
      <div class="mt-6 -mx-4 overflow-x-auto px-4">
        <div class="flex w-max gap-1.5">
          <UButton
            v-for="y in years"
            :key="y"
            :variant="activeYear === y ? 'solid' : 'ghost'"
            :color="activeYear === y ? 'primary' : 'neutral'"
            size="sm"
            class="tabular-nums"
            @click="selectedYear = y"
          >
            {{ y }}
          </UButton>
          <UButton
            :variant="activeYear === '' ? 'solid' : 'ghost'"
            :color="activeYear === '' ? 'primary' : 'neutral'"
            size="sm"
            @click="selectedYear = ''"
          >
            全部（{{ records.length }}）
          </UButton>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <USelect v-model="venue" :items="venueOptions" size="sm" class="min-w-40 max-w-64" />
        <USelect v-model="format" :items="formatOptions" size="sm" class="min-w-28" />
        <USelect v-model="cost" :items="costOptions" size="sm" class="min-w-28" />
        <UButton
          v-if="hasNarrowed"
          variant="ghost"
          color="neutral"
          size="sm"
          icon="i-lucide-x"
          @click="clearFilters"
        >
          清掉篩選
        </UButton>
        <span class="ms-auto text-sm text-muted tabular-nums">{{ `${filtered.length} 筆` }}</span>
      </div>

      <!--
        ⚠️ 橫向捲的容器是 `UTable` 自己的 root（主題本來就給了 `overflow-auto`），
        **不是外面再包一層 `overflow-x-auto`**。sticky 認的是最近的捲動祖先：
        `min-w-*` 掛在 root 上時 root 自己不捲、捲的是外層 div ⇒ 操作欄會黏在
        「整張表的右緣」而不是「畫面的右緣」，看起來就像 sticky 沒生效（踩雷 #185）。
        所以最小寬度掛在 `base`（真正的 <table>），root 保持可捲。

        ── 這張表在 1280 也橫捲，那是選的不是將就（2026-09-06 主 session 裁決）──
        中間版本為了「1280 剛好塞得下九欄」，把影城欄截到 192px，長店名變成
        「林口MITSUI OUTLET …」而**廳別被吃掉**。那個方向是反的，兩個理由：
          · 固定操作欄本來就是這次要做的東西，而它存在的目的正是**讓橫捲變得可用**。
            為了迴避一個剛被做成可用的橫捲，去截掉使用者親手填的資料，是本末倒置。
          · `SPEC` 的核心價值第 2 條是「記得住你在哪看的——連版本與廳別都留得下來」。
            廳別被截掉正好打在那句話上。
        ⇒ 欄寬以「不截使用者填的東西」為準，1280 與 375 都靠橫捲 + 固定操作欄解決。
        ⚠️ 連帶：**公開狀態欄移到備註左邊**。固定欄在沒捲動時一定會蓋住最後一個
        資料欄，而被蓋住的那一欄不該是「一眼掃哪幾筆是公開的」那一欄；備註本來
        就是「瞄一眼、要看全文再展開」的欄位，由它來當那個位置的代價最小。
      -->
      <UTable
        :data="visible"
        :columns="columns"
        :column-pinning="columnPinning"
        class="mt-4 rounded-sm border border-default bg-default"
        :ui="{ base: 'min-w-5xl', th: 'whitespace-nowrap' }"
      >
        <template #watchedOn-cell="{ row }">
          <!--
            ⚠️ 標準格式 `YYYY/MM/DD HH:mm`，**刻意不用票根卡那一套**
            （`Jul` / `26 Sun` / `16:00`）。這裡曾經寫著「跟票根卡一致——使用者
            不會覺得同一份資料在兩頁該長得不一樣」，2026-09-06 David 推翻了它：
            「這邊比較像是個人的資料維護後台」。分界線是頁面的性質，不是資料——
            回顧用的頁面（`/app`、`/u/`、`/film/`）留票根語彙，維護後台用機器
            可讀、可對帳、可跟訂票紀錄比對的標準格式。
            ⚠️ 沒有場次時間的那幾列只印日期，不補佔位（見 `watchedAtText()`）。
          -->
          <span class="text-highlighted tabular-nums whitespace-nowrap">
            {{ watchedAtText(row.original.watchedOn, row.original.watchedTime) }}
          </span>
        </template>

        <template #film-cell="{ row }">
          <div class="min-w-0 max-w-72">
            <NuxtLink
              v-if="row.original.film?.slug"
              :to="`/film/${row.original.film.slug}`"
              class="block truncate text-highlighted hover:underline underline-offset-4"
            >
              {{ row.original.film?.titleZh || row.original.film?.titleOriginal || '（作品不明）' }}
            </NuxtLink>
            <span v-else class="block truncate text-muted">
              {{ row.original.film?.titleZh || '（作品待審核）' }}
            </span>
            <span
              v-if="row.original.film?.titleOriginal && row.original.film.titleOriginal !== row.original.film.titleZh"
              class="block truncate text-[12px] text-muted"
            >
              {{ row.original.film.titleOriginal }}
            </span>
          </div>
        </template>

        <template #venue-cell="{ row }">
          <div class="max-w-64 truncate">
            {{ venueSegment(row.original) ?? '—' }}
          </div>
        </template>

        <template #formatLabel-cell="{ row }">
          <span class="whitespace-nowrap">{{ row.original.formatLabel ?? '—' }}</span>
        </template>

        <template #ticketCount-cell="{ row }">
          <span class="tabular-nums">{{ row.original.ticketCount ?? '—' }}</span>
        </template>

        <!-- 票價三態必須看得出差別（§4.3）：null 是「沒有」、0 是「免費」。 -->
        <template #cost-cell="{ row }">
          <span class="tabular-nums" :class="costText(row.original.cost) ? '' : 'text-dimmed'">
            {{ costText(row.original.cost) ?? '—' }}
          </span>
        </template>

        <!--
          ⚠️ 語意：預設是**公開**，`isPrivate` 才是例外（`visibility` 這個 enum
          只有 public／private 兩個值，所以這是忠實的二元，沒有第三態被摺進來）。
          ⚠️ **不靠顏色表達**——色盲與螢幕閱讀器拿不到顏色。兩態都有文字，
          icon 只是第二個訊號（形狀：地球／鎖）。兩態同字重也是刻意的：
          實測 174 筆全部是公開，把「公開」做成醒目樣式等於整欄都在喊。
        -->
        <template #visibility-cell="{ row }">
          <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
            <UIcon
              :name="row.original.isPrivate ? 'i-lucide-lock' : 'i-lucide-globe'"
              class="size-4 shrink-0 text-dimmed"
              aria-hidden="true"
            />
            {{ row.original.isPrivate ? '私密' : '公開' }}
          </span>
        </template>

        <!--
          ⚠️ 沒有備註的那 101 筆（174 筆裡的 58%）**整格留白**，不畫「—」。
          一整欄的破折號會蓋過真正有備註的那 73 筆，而這一欄的用處正是
          「哪幾筆有話要說」。留白本身就是答案，不需要一個符號來宣告它。
        -->
        <template #memo-cell="{ row }">
          <div v-if="row.original.memo?.trim()" class="min-w-0 max-w-32">
            <!--
              長備註：`<button>` 開對話框看全文。
              ⚠️ 外面那層 `UTooltip` 是**桌機的加值層，不是路徑**——它在觸控裝置上
              不會開（見檔頭 `memoIsLong` 上方的註解）。拿掉 `UModal` 只留它，
              等於把全文變成滑鼠專屬，那正是 `SCREENS §10.4` 早就判掉的
              `title` 屬性。
              ⚠️ `:ui` 必須覆寫：tooltip 主題的 `content` 是 `h-6` 固定高、
              `text` 是 `truncate`，不覆寫的話多行備註只看得到第一行的一小截，
              **而且不會有任何錯誤**。這裡直接用 `#content` 插槽自己畫，
              免得跟主題那個 `truncate` 在 tailwind-merge 裡比大小。
            -->
            <UTooltip
              v-if="memoIsLong(row.original.memo)"
              :ui="{ content: 'h-auto max-w-xs items-start px-2.5 py-1.5' }"
            >
              <template #content>
                <span class="line-clamp-3 text-xs break-words">{{ memoOneLine(row.original.memo) }}</span>
              </template>
              <button
                type="button"
                class="block max-w-full cursor-pointer rounded-xs text-start underline decoration-dotted decoration-default underline-offset-4 hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                aria-haspopup="dialog"
                :aria-label="memoTriggerLabel(row.original)"
                @click="openMemo(row.original)"
              >
                <span class="block truncate">{{ memoOneLine(row.original.memo) }}</span>
              </button>
            </UTooltip>
            <!--
              短備註：**折行不截字**。這一支沒有按鈕，截掉就永遠讀不到
              （`SCREENS §10.4` 立的規矩）。`td` 主題帶 `whitespace-nowrap`，
              所以要自己寫回 `whitespace-normal` 才折得了行。
            -->
            <span v-else class="block whitespace-normal break-words">{{ memoOneLine(row.original.memo) }}</span>
          </div>
        </template>

        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UButton
              :to="`/app/records/${row.original.id}/edit`"
              variant="ghost"
              color="neutral"
              icon="i-lucide-pencil"
              size="sm"
              aria-label="編輯這筆"
            />
            <UButton
              variant="ghost"
              color="error"
              icon="i-lucide-trash-2"
              size="sm"
              aria-label="刪掉這筆"
              @click="pending = row.original"
            />
          </div>
        </template>
      </UTable>

      <!-- 篩到 0 筆時要說得出「放寬哪一個」，不然使用者只看到一張空表（DS §8）。 -->
      <p v-if="!filtered.length" class="mt-4 text-sm text-muted">
        {{ hasNarrowed ? '這幾個篩選條件下沒有紀錄。' : `${activeYear || '全部'} 沒有紀錄。` }}
        <UButton v-if="hasNarrowed" variant="link" color="primary" size="sm" class="p-0" @click="clearFilters">
          清掉篩選
        </UButton>
      </p>

      <div v-if="hasMore" class="mt-4 flex justify-center">
        <UButton variant="soft" color="neutral" @click="shown += PAGE">
          {{ `再顯示 ${Math.min(PAGE, filtered.length - shown)} 筆（共 ${filtered.length} 筆）` }}
        </UButton>
      </div>
    </template>

    <!--
      備註全文。**整張表共用這一個對話框**，是哪一筆由 `memoRecord` 決定。
      ⚠️ 不要傳 `:scrollable`：預設（false）的主題已經是「`body` 自己捲、
      標題固定、`content` 有 `max-h-[calc(100dvh-2rem)]` 與 `w-[calc(100vw-2rem)]`」，
      2000 字的備註在 375 上也捲得動。傳了反而變成整個 overlay 捲、標題跟著捲走。
      ⚠️ `whitespace-pre-wrap` 才會還原使用者打的斷行（實測 5 筆含換行）；
      `break-words` 是給沒有空白的長英數字串用的，不然框會被撐破。
    -->
    <UModal v-model:open="memoOpen" title="備註" :description="memoDialogSubtitle">
      <template #body>
        <p class="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {{ memoRecord?.memo }}
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            v-if="memoRecord"
            :to="`/app/records/${memoRecord.id}/edit`"
            variant="ghost"
            color="neutral"
          >
            編輯這筆
          </UButton>
          <UButton color="neutral" @click="memoOpen = false">
            關掉
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="confirmOpen" title="刪掉這筆">
      <template #body>
        <p>
          刪掉之後救不回來。
        </p>
        <!-- 確認框裡用票根卡不用表格列：要確認「刪的是哪一筆」時，
             一張看得出是什麼的卡片比一列對齊的欄位好。 -->
        <div v-if="pending" class="mt-4">
          <TicketCard :record="pending" :link-film="false" />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="pending = null">
            算了
          </UButton>
          <UButton color="error" :loading="deleting" @click="confirmRemove">
            刪掉這筆
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
