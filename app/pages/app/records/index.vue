<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { MyRecord } from '~/composables/useMyRecords'
import type { Database } from '~/types/database.types'
import { watchedAtText } from '~/utils/format-datetime'
import { matchesQuery, pageSlice } from '~/utils/record-list'
import { costText, venueSegment } from '~/utils/ticket'

/**
 * `/app/records` — 個人紀錄管理（`SCREENS.md §10`）。2026-09-06 從票根卡列表改成表格：
 * 票根卡是**一筆一筆看**（公開頁、單筆分享、刪除確認框都還在用），表格是**橫著比**
 * （「哪家戲院花最多」「哪些沒填票價」要對齊欄位才看得出來）。
 */
/*
 * 定位是「個人資料維護後台」，四件事都是它的結果：頁名、日期用機器可讀的
 * `YYYY/MM/DD HH:mm`、備註與公開狀態要看得到（維護時跟票價一樣是要對帳的欄位）、
 * 操作欄固定（九欄在窄螢幕必然橫捲，捲出畫面等於這張表在手機上只能看不能改）。
 */
/*
 * 2026-09-07 長備註改成點開 Dialog：**短的留在格子裡、只有長的給鈕**（實測 73 筆有備註中
 * 54 短 19 長）。⚠️ 這一輪**沒有**解掉「靜止時備註被固定欄蓋住 93px」（見 `columns` 上方的
 * 算術），那是明知的取捨——不要因為備註欄變窄就以為那個問題被處理過了。
 */
/*
 * 2026-09-21 年份從 tab 列變成篩選器之一、**預設「所有年份」**（David 的原話：「年份變成
 * 篩選選項之一，預設全部」）。⚠️ 連帶代價：影城／版本的選項改由**全部年份**長出來——
 * 實測（`db:sql` 查活體）全期 174 筆有 15 家影城、6 種版本，舊預設的 2026 年 8 筆只有
 * 3 家、2 種 ⇒ 兩個選單第一次打開會從 4／3 項變成 16／7 項（都含「所有…」那一項）。
 * 那是這一改的已知代價、不是 bug；要不要為此限制選項是 David 的事，不要自己改回去。
 */
/*
 * 篩選維度：年份／影城／版本／有無票價，外加關鍵字搜尋（作品名／影城／影廳／備註四欄）。
 * 「有無票價」那一維是因為 174 筆裡有 5 筆沒有金額。
 * ⚠️ 不用 `UTable` 的 `virtualize`：它要容器有確定高度（#54），而這裡的容器隨內容長。
 */
useSeoMeta({ title: '個人紀錄管理' })

const supabase = useSupabaseClient<Database>()
const toast = useToast()

const { records, status, refresh } = useMyRecords()

/* ── 篩選 ─────────────────────────────────────────────────────────────── */
const ALL = '__all__'
/** 年份現在跟另外三個篩選器同型（`ALL` = 所有年份），**預設就是 `ALL`**。 */
const year = ref(ALL)
const venue = ref(ALL)
const format = ref(ALL)
const cost = ref(ALL)
const q = ref('')

/**
 * 年份選項**新到舊**。`records` 已按 `watched_on` 新到舊排序、`Set` 保留插入序
 * ⇒ 這裡刻意**不走下面的 `options()`**：那一支會 `.sort()` 成升冪，年份會變成舊的在最上面。
 */
const years = computed(() => [...new Set(records.value.map(r => r.year))])
const yearOptions = computed(() => [
  { label: `所有年份（${records.value.length}）`, value: ALL },
  ...years.value.map(y => ({ label: y, value: y })),
])

const byYear = computed(() =>
  year.value === ALL ? records.value : records.value.filter(r => r.year === year.value))

/**
 * 選項只從**目前年份範圍內**的紀錄長出來：選了就 0 筆的選項比沒有選項更難用。
 * ⚠️ 預設變成「所有年份」之後，這一支第一次算出來的是全期的 16／7 項（見檔頭的實測數字），
 * 不再是當年的 4／3 項。選了某一年才會收斂回那一年。
 */
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

/** 一頁的筆數。預設「所有年份」之後全集是 174 筆（實測）⇒ 不分頁會是很長的一張表。 */
const PER_PAGE = 24

// 換年份時把其餘篩選重設：留著一個當年不存在的影城，畫面會是空的而且看不出原因。
// ⚠️ 預設改成「所有年份」之後這條**行為沒變、但更容易遇到**（以前開頁就已經在某一年，
//    現在使用者的第一次選年份一定會走到這裡，把他剛設好的影城／版本清掉）。
watch(year, () => {
  venue.value = ALL
  format.value = ALL
  cost.value = ALL
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
  // 搜尋與三個篩選器是**疊加**不是取代：比對規則見 `~/utils/record-list`。
  // 不加 debounce——資料早就全在客端（174 筆），逐字元重算量不出延遲。
  return matchesQuery(r, q.value)
}))

const hasNarrowed = computed(() =>
  year.value !== ALL || venue.value !== ALL || format.value !== ALL || cost.value !== ALL || !!q.value.trim())
function clearFilters() {
  year.value = ALL
  venue.value = ALL
  format.value = ALL
  cost.value = ALL
  q.value = ''
}

/* ── 頁碼分頁 ─────────────────────────────────────────────────────────────
 * 全集早就在客端（`useMyRecords` 一次取完），所以換頁**不重新請求**、也不動 DB。
 */
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PER_PAGE)))

/**
 * ⚠️ 監看的是**篩選與搜尋的輸入值**，不是 `filtered`。
 * 改成監看 `filtered` 會壞掉的地方：`refresh()`（存檔、刪除之後都會呼叫）會換掉
 * `filtered` 的 identity ⇒ 每一次存檔都把使用者踢回第 1 頁。
 */
watch([year, venue, format, cost, q], () => {
  page.value = 1
})

/**
 * 刪掉最後一頁唯一那筆之後 `page` 會落在範圍外 ⇒ 表會是空的而且畫面上沒有任何解釋。
 * ⚠️ 這裡是**夾回最後一頁不是跳回第 1 頁**：跳回第 1 頁就是上面那條 watch 明文要避免的事。
 */
watch(pageCount, (n) => {
  if (page.value > n)
    page.value = n
})

const visible = computed(() => pageSlice(filtered.value, page.value, PER_PAGE))

/* ── 備註（短的印在格子裡，長的點開對話框）──
 * ⚠️ 備註是自由文字：實測 174 筆裡 73 筆有備註、平均 14.3 字、最長 67 字、**5 筆含換行**、
 * 上限 2000 字。所以「摺成單行」不能省——換行在單行格子裡會被畫成看不見的斷點，
 * 讀起來像少了字；全文才用 `whitespace-pre-wrap` 還原。 */
/*
 * ⚠️ 觸發器一定要是 `<button>`：`title` 在觸控沒有 hover、`<div @click>` 鍵盤到不了。
 * **`UTooltip` 也是同一個失效模式**——reka-ui 對 touch 的 pointermove 直接 return、
 * 隨後的 focus 被擋、click 直接 onClose ⇒ 375px 上**根本不會開**。全文只能靠 `UModal`。
 */
/*
 * 門檻沿用 16 個全形字，**刻意不因欄寬變窄而下修**——下修會把那 54 筆也趕進對話框。
 * ⚠️ 於是門檻與欄寬（`max-w-32` ≈ 9 個全形字）不再對齊，代價各自處理：短備註改成**折行
 * 不截字**（它沒有按鈕，截了就永遠讀不到；最長那筆 16 字在 128px 下折兩行）；
 * 長備註交給 CSS 的 `truncate`，**不再用 JS 先截一次**（兩邊都截會出現兩個省略號）。
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
 * 全文對話框。**一個 Modal 服務整張表**（24 列各生一個 `DialogRoot` 是白花的），開出來的是
 * 哪一列全靠 `memoRecord`。⚠️ 關閉時**刻意不清空**：`UModal` 有 200ms 關閉動畫，清空會讓
 * 內文先變空、底下那顆「編輯這筆」的 `:to` 跟著算不出目標 ⇒ 字先消失、框才淡出。
 * （2026-09-21：那個 `:to` 從 `/app/records/<id>/edit` 改成 `?edit=<id>`，理由同上不變。）
 */
const memoOpen = ref(false)
const memoRecord = ref<MyRecord | null>(null)

function openMemo(record: MyRecord) {
  memoRecord.value = record
  memoOpen.value = true
}

/**
 * 觸發鈕的無障礙名稱。一張表裡最多 24 顆長得一樣的鈕，**只寫「備註：{片名}」不夠**——
 * 同一部片會有多筆重刷紀錄，日期才分得出是哪一筆。
 * ⚠️ 純文字 aria-label，分隔用**半形空格**（全形空白是給畫面上看得到的字用的）。
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
 * ⚠️ 操作欄用內建 column pinning，但**必須把底色蓋成不透明**：主題給的是 `bg-default/75`，
 * 捲動時底下的欄位會透出來疊在按鈕上。`!` 是必要的（主題那版沒有 important 蓋不掉，#186）。
 * ⚠️ `bg-default` 是票根紙、`body` 是台紙，兩者不同色 ⇒ 整張表也要塗，否則亮色會出現淺帶。
 */
/*
 * ⚠️ 操作欄釘**右**緣，而「靜止時蓋住備註 93px」是**已知且被接受的**代價：sticky 沒辦法
 * 「佔位」只能「疊上去」（#188）。兩條替代路都量過並否決：容器尾端補 padding = 無效
 * （改成公開狀態 68px + 備註 25px，更糟）；改釘左 = 捲動時日期 47px／作品 45px 被蓋，
 * 片名少掉開頭幾個字而且沒有任何記號（截尾有「…」、截頭沒有）。不要重開這個案子。
 */
/*
 * ⚠️ 2026-09-07 備註欄改窄，那 93px **一點都沒有變**：遮蔽 = min(表格寬 − 容器寬, 固定欄寬)。
 * 1280 下容器 1118、固定欄 93、備註欄左緣 997 ⇒ 露出來的永遠只有 `[997,1025]` 這 28px，
 * 扣掉 16px 內距剩 12px（不到一個字）。改窄換到的是表格總寬變短，不是遮蔽變小。
 */
const columns: TableColumn<MyRecord>[] = [
  { accessorKey: 'watchedOn', header: '日期', meta: { class: { td: 'w-40', th: 'w-40' } } },
  { id: 'film', header: '作品', meta: { class: { td: 'w-72', th: 'w-72' } } },
  { id: 'venue', header: '影城', meta: { class: { td: 'w-64', th: 'w-64' } } },
  { accessorKey: 'formatLabel', header: '版本' },
  { accessorKey: 'ticketCount', header: '張' },
  { accessorKey: 'cost', header: '票價' },
  { id: 'visibility', header: '公開狀態' },
  // ⚠️ 備註要**指定寬度**不能只給 max-w：九欄的自動配寬會把它壓到 86px，變成一行兩個字、
  //    十幾行高的一條（實測看到才發現，數字量不出來）。
  // ⚠️ `w-40` 是 `td` 的**外**寬（含 `p-4` 左右各 16px）⇒ 內層要配 `max-w-32` 才對得起來；
  //    `td` 的 `w-*` 只是建議，真正決定欄寬的是內層元素（#187）。
  { accessorKey: 'memo', header: '備註', meta: { class: { td: 'w-40', th: 'w-40' } } },
  {
    id: 'actions',
    header: '操作',
    meta: { class: { td: 'bg-default! border-s border-default', th: 'bg-default! border-s border-default' } },
  },
]
const columnPinning = { right: ['actions'] }

/* ── 編輯抽屜（David 2026-09-21 第 1 條）──────────────────────────────────
 * 「改成點編輯開 Drawer，不使用換頁，這樣不用處理返回上一頁狀態都被清掉」。
 *
 * 開關走 query string `?edit=<id>`，先例是 `3792b6a` 的 `/u/` `?view=wall`。
 * ⚠️ 只換 query **不會讓頁面重掛**：`<NuxtPage>` 的 key 來自
 * `generateRouteKey()` → `interpolatePath()`，那支拿的是**路由的 path 樣板**代入 params
 * （`nuxt/dist/pages/runtime/utils.js:6-13`，查過原始碼不是推的）⇒ query 從來不在 key 裡。
 * ⚠️ 捲動位置同理：Nuxt 預設的 scrollBehavior 在 `to.path === from.path` 且兩邊都沒有 hash
 * 時 `return false`（`nuxt/dist/pages/runtime/router.options.js`）⇒ 不捲。
 * ⇒ 篩選／頁碼／捲動位置全部留著，而瀏覽器「上一頁」只是把 `?edit` 拿掉＝關抽屜。
 */
/*
 * ⚠️ 只有 `typeof === 'string'` 才算：重複的 `?edit=a&edit=b` 會變成陣列
 * （`/u/` 那支 `:101` 同一個警告）。
 */
const route = useRoute()
const editingId = computed(() => (typeof route.query.edit === 'string' ? route.query.edit : null))
const editingRecord = computed(() => records.value.find(r => r.id === editingId.value) ?? null)

/** 開抽屜的連結目標。**開是 push**（這樣「上一頁」才關得掉），關才是 replace。 */
function editLink(id: string) {
  return { query: { ...route.query, edit: id } }
}
/**
 * 關抽屜。⚠️ **一定要 `replace: true`**：不 replace 的話 history 會是
 * `[列表, 列表?edit=X, 列表]`，使用者關掉之後按「上一頁」抽屜會**重新打開**。
 * X 鈕／ESC／點遮罩／儲存完都走這一支。
 */
async function closeEditor() {
  await navigateTo({ query: { ...route.query, edit: undefined } }, { replace: true })
}

/**
 * 存檔後：**先 `refresh()` 再關抽屜**，那一列才會是原地更新而不是「關掉之後才跳一下」。
 * 頁碼不會動——回第 1 頁的 watch 監看的是篩選輸入值，不是 `filtered`（見上面那條）。
 */
async function onEditorSaved() {
  await refresh()
  await closeEditor()
}

/**
 * 深連結（直接貼 `?edit=<id>` 進來）時 `records` 可能還在載 ⇒ 那不是「找不到」。
 * 載完了還是找不到，才說找不到並把 query 收掉——否則網址會一直掛著一個開不了的抽屜。
 */
watch([editingId, status], () => {
  if (editingId.value && status.value !== 'pending' && !editingRecord.value) {
    toast.add({ title: '找不到這筆紀錄', color: 'error' })
    closeEditor()
  }
})

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
  <div class="mx-auto max-w-6xl px-4 py-8">
    <!-- 九欄的表格在 max-w-5xl 裡每一欄都被壓扁；這一頁是對帳用的，寬度給它。 -->
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-bold tracking-tight">
        個人紀錄管理
      </h1>
      <UButton to="/app/records/new" icon="i-lucide-plus">
        記一場
      </UButton>
    </div>

    <!--
      ⚠️ 骨架**只擋第一次載入**，不擋 `refresh()`。`useAsyncData` 的 `refresh()` 會把 `status`
         打回 `'pending'`（`nuxt/dist/app/composables/asyncData.js:330`，無條件）⇒ 只看 `status`
         的話，每次存檔或刪除都會把整張表換成 8 個骨架、**文件高度當場塌掉、捲動位置跟著跑掉**。
         那直接違反第 1 條的「捲動位置沒變」。加上 `!records.length` 之後，refresh 期間畫面上
         留的是舊資料，換好才換掉。
    -->
    <div v-if="status === 'pending' && !records.length" class="mt-8 space-y-2">
      <USkeleton v-for="i in 8" :key="i" class="h-11 w-full rounded-sm" />
    </div>

    <p v-else-if="!records.length" class="mt-8 text-muted">
      還沒有任何紀錄。
    </p>

    <template v-else>
      <!--
        年份 2026-09-21 從 tab 列變成這一排裡的一個 `USelect`（David：「年份變成篩選選項之一，
        預設全部」）。⚠️ 搜尋框吃整行（`w-full` + `sm:w-72`）：375 下四個選單已經佔滿兩行，
        搜尋框再擠進去會變成一個放不下一個詞的框。
      -->
      <div class="mt-6 flex flex-wrap items-center gap-2">
        <UInput
          v-model="q"
          icon="i-lucide-search"
          placeholder="搜尋作品、影城、影廳、備註"
          size="sm"
          class="w-full sm:w-72"
        >
          <!-- 清空鈕是 `<button>` 不是 icon：`<UInput>` 的 icon 點不到也 tab 不到。 -->
          <template v-if="q" #trailing>
            <UButton
              variant="link"
              color="neutral"
              size="sm"
              icon="i-lucide-x"
              aria-label="清掉搜尋字"
              class="p-0"
              @click="q = ''"
            />
          </template>
        </UInput>
        <USelect v-model="year" :items="yearOptions" size="sm" class="min-w-32 tabular-nums" />
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
        ⚠️ 橫向捲的容器是 `UTable` 自己的 root（主題本來就給 `overflow-auto`），**不是外面再包一層**：
           sticky 認的是最近的捲動祖先，`min-w-*` 掛在 root 上時 root 自己不捲 ⇒ 操作欄會黏在
           「整張表的右緣」而不是「畫面的右緣」（#185）。最小寬度掛在 `base`（真正的 table）。
      -->
      <!--
        這張表在 1280 也橫捲，那是選的不是將就：中間版本為了塞下九欄把影城截到 192px，長店名變成
        「林口MITSUI OUTLET …」而**廳別被吃掉**——而固定操作欄存在的目的正是讓橫捲變可用，
        為了迴避它去截使用者親手填的資料是本末倒置（也正好打在 SPEC 第 2 條上）。
      -->
      <!--
        ⚠️ 連帶：**公開狀態欄移到備註左邊**。固定欄在沒捲動時一定會蓋住最後一個資料欄，而被蓋的
           不該是「一眼掃哪幾筆是公開的」那一欄；備註本來就是「瞄一眼、要全文再展開」，代價最小。
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
            ⚠️ 標準格式 `YYYY/MM/DD HH:mm`，**刻意不用票根卡那一套**。這裡曾經寫「跟票根卡一致」，
               2026-09-06 被推翻：分界線是**頁面的性質不是資料**——回顧用的頁面留票根語彙，
               維護後台用機器可讀、可跟訂票紀錄對帳的標準格式。沒有場次時間的只印日期，不補佔位。
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
          ⚠️ 語意：預設是**公開**，`isPrivate` 才是例外（enum 只有兩個值，是忠實的二元）。
          ⚠️ **不靠顏色表達**（色盲與螢幕閱讀器拿不到顏色）：兩態都有文字，icon 只是第二個訊號。
             兩態同字重也是刻意的——實測 174 筆全部公開，把「公開」做成醒目樣式等於整欄都在喊。
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
              長備註：`<button>` 開對話框看全文。⚠️ 外層的 `UTooltip` 是**桌機的加值層不是路徑**
                 （觸控不會開）：拿掉 `UModal` 只留它，等於把全文變成滑鼠專屬，那正是 `SCREENS §10.4`
                 早就判掉的 `title` 屬性。
            -->
            <!--
              ⚠️ `:ui` 必須覆寫：tooltip 主題的 `content` 是 `h-6` 固定高、`text` 是 `truncate`，不覆寫的話
                 多行備註只看得到第一行的一小截，**而且不會有任何錯誤**。直接用 `#content` 自己畫。
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
            <!--
              ⚠️ **必須是真的連結不是 `@click` 切 ref**：只有真的推一筆 history，
                 瀏覽器「上一頁」才關得掉抽屜（第 1 條的字面要求）。同 `/u/` 的 `?view=wall`。
            -->
            <UButton
              :to="editLink(row.original.id)"
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

      <!--
        篩到 0 筆時要說得出「放寬哪一個」，不然使用者只看到一張空表（DS §8）。
        ⚠️ 這裡不必再分「沒篩選也 0 筆」那一支：`records.length === 0` 上面已經擋掉，
           而年份現在是篩選器之一 ⇒ 走到這裡 `hasNarrowed` 必定為真。
      -->
      <p v-if="!filtered.length" class="mt-4 text-sm text-muted">
        這幾個條件下沒有紀錄。
        <UButton variant="link" color="primary" size="sm" class="p-0" @click="clearFilters">
          清掉篩選
        </UButton>
      </p>

      <!--
        頁碼分頁取代「再顯示 24 筆」。⚠️ **不要傳 `:to`**：傳了整組頁碼會變成路由連結，
        每次換頁都推一筆 history，而這一頁的狀態還沒進 URL ⇒ 上一頁會回到一張重設過的表。
      -->
      <!--
        ⚠️ `sibling-count` 用主題預設的 2，**不要調小**。實跑 reka-ui 自己的 `getRange()`
        （`showEdges` 預設 false ⇒ 走 `siblingCount*2+1` 那一支、根本不長省略號）：
        174 筆 = 8 頁時頁碼鈕最多 5 顆、加四顆控制鈕共 9 顆；調成 1 只剩 3 顆頁碼，
        少掉的是脈絡不是寬度。⚠️ 像素寬**沒有在瀏覽器實量過**（375 逐一點過那關未跑）。
      -->
      <!--
        橫向捲交給這一層自己的容器（沿用年份 tab 列本來的 `-mx-4 overflow-x-auto px-4`）：
        頁面 body 永遠不橫向捲（§10 品質底線）。⚠️ 這是兜底不是量測——不管將來筆數長到幾頁、
        主題把鈕改多寬，溢出都關在這個容器裡。
      -->
      <div v-if="pageCount > 1" class="mt-4 -mx-4 overflow-x-auto px-4">
        <div class="flex justify-center">
          <UPagination
            v-model:page="page"
            :total="filtered.length"
            :items-per-page="PER_PAGE"
            size="sm"
            class="w-max"
          />
        </div>
      </div>
    </template>

    <!--
      ★ 編輯抽屜。**位置有兩個硬條件**：
        1. 在根 `div` **之內**（`tests/page-root.test.ts`：`<template>` 只能有一個根節點，
           而且直接子註解自己就是一個根節點 ⇒ 不可以跟根元素當兄弟）。
        2. 在上面那個 `v-else` 的 `<template>` **之外**：那一段在 `refresh()` 期間會被
           `status` 的分支影響，抽屜跟著卸載的話「存檔 → 原地更新」就會變成閃一下。
      ⚠️ 用 `USlideover` 不用 `UDrawer`：David 說的是「Drawer」而兩個都在，選側滑是因為
         這是**有日期／時間／兩個下拉的表單**——底部抽屜在 375 上一叫出虛擬鍵盤就會被推掉
         一半（§3 的硬條件正是「375 要填得完、下拉打開時不被鍵盤蓋掉」），側滑是滿版高度、
         內容自己捲，沒有這個互動。`/u/` 那個 `UDrawer` 是唯讀清單，不是同一種東西。
    -->
    <USlideover
      :open="!!editingRecord"
      title="編輯紀錄"
      :description="editingRecord ? watchedAtText(editingRecord.watchedOn, editingRecord.watchedTime) : ''"
      @update:open="(v: boolean) => { if (!v) closeEditor() }"
    >
      <template #body>
        <!--
          ⚠️ `:key` 綁 record id：`refresh()` 會換掉 `records` 的 identity，
             key 不變才不會重掛表單、不會把使用者正在打的字清掉。
        -->
        <RecordEditForm
          v-if="editingRecord"
          :key="editingRecord.id"
          :record="editingRecord"
          @saved="onEditorSaved"
          @cancel="closeEditor"
        />
      </template>
    </USlideover>

    <!--
      備註全文，**整張表共用這一個對話框**（是哪一筆由 `memoRecord` 決定）。
      ⚠️ 不要傳 `:scrollable`：預設主題已經是「body 自己捲、標題固定」，2000 字在 375 上也捲得動；
         傳了反而變成整個 overlay 捲、標題跟著捲走。
      ⚠️ `whitespace-pre-wrap` 才會還原使用者打的斷行（實測 5 筆含換行）；`break-words` 給長英數字串。
    -->
    <UModal v-model:open="memoOpen" title="備註" :description="memoDialogSubtitle">
      <template #body>
        <p class="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {{ memoRecord?.memo }}
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <!--
            ⚠️ 點下去要**先把對話框關掉**：不關的話 Modal 與抽屜會同時開著，
               兩個 focus trap 互咬（鍵盤會被關在後面那個裡面出不來）。
          -->
          <UButton
            v-if="memoRecord"
            :to="editLink(memoRecord.id)"
            variant="ghost"
            color="neutral"
            @click="memoOpen = false"
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
