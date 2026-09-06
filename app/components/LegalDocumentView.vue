<script setup lang="ts">
import type { LegalDocKind } from '~/composables/useLegalDocument'
import { effectiveDateText, useLegalDocument } from '~/composables/useLegalDocument'

/**
 * 三份條款頁共用的版面（`SCREENS §15.1`）。`/legal/dmca` **不走這裡**——
 * 那是表單不是文件，`legal_doc_kind` 這個 enum 裡根本沒有 dmca。
 *
 * 版面：標題 → 版本與生效日 → 目錄（桌機左側 sticky／手機收合）→ 34em 內文。
 *
 * ── 版本與生效日為什麼是硬要件 ────────────────────────────────────────
 * `legal_acceptance` 綁的是 `document_id`，使用者同意的是**某一版**。
 * 畫面上看不到版本，那筆同意紀錄對使用者就是不可查證的（§15.1）。
 * 歷史版本也要查得到——`unique (kind, version)`、舊版留著，就是為了舉證。
 *
 * ── 目錄為什麼手機預設收合 ────────────────────────────────────────────
 * 法律文件的閱讀行為是掃讀與跳讀，不是從頭讀到尾；但在 375px 上把十條目錄
 * 攤開，等於在正文前面墊了一整屏。用原生 `<details>` 而不是元件：法遵頁的 HTML
 * 是伺服器送出來的，**目錄在 JS 到位之前就要能展開**——這一頁對「不得置於任何牆後」
 * 的承諾不該建立在「使用者的 JS 有跑起來」之上。
 */
const props = defineProps<{ kind: LegalDocKind }>()

const { versions, current, shown, isHistorical, parsed, selectedId } = useLegalDocument(props.kind)

const showHistory = ref(false)

function view(id: number | null) {
  selectedId.value = id
  showHistory.value = false
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-10">
    <template v-if="shown && parsed">
      <header>
        <h1 class="text-[28px]/[1.35] font-bold tracking-tight [font-feature-settings:'palt'_1]">
          {{ parsed.title }}
        </h1>

        <!-- 分隔用的中點組在字串裡：相鄰節點的空白會被 whitespace: condense 吃掉 -->
        <p class="mt-1.5 text-[13px] text-muted">
          <span class="tabular-nums">{{ shown.version }}</span>
          <span>{{ ` · ${effectiveDateText(shown.effective_at)} 生效 · ` }}</span>
          <button
            type="button"
            class="text-primary hover:underline"
            :aria-expanded="showHistory"
            @click="showHistory = !showHistory"
          >
            看歷史版本
          </button>
        </p>
      </header>

      <!--
        歷史版本：不做成顯眼的功能（§15.1），但一定要查得到。
        `content_sha256` 一起列出來——0007 把它做成由 trigger 算、寫入端無法指定，
        目的就是拿來對帳；只存不顯示的話，對帳只能由我們自己做。
      -->
      <div v-if="showHistory" class="mt-4 border border-default rounded-sm p-4 text-[13px]">
        <p class="text-muted">
          {{ versions && versions.length > 1
            ? '這份文件的全部版本。舊版留著是為了舉證：同意紀錄綁的是版本，不是文件。'
            : '目前只有這一個版本。改版時會新增一列，舊版留在這裡。' }}
        </p>
        <ul class="mt-3 space-y-2">
          <li v-for="v in versions" :key="v.id" class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <button
              type="button"
              class="tabular-nums"
              :class="v.id === shown.id ? 'font-semibold text-highlighted' : 'text-primary hover:underline'"
              :disabled="v.id === shown.id"
              @click="view(v.id === current?.id ? null : v.id)"
            >
              {{ v.version }}
            </button>
            <span class="text-muted tabular-nums">{{ `${effectiveDateText(v.effective_at)} 生效` }}</span>
            <span v-if="v.id === current?.id" class="text-muted">現行版本</span>
            <span v-if="v.content_sha256" class="text-dimmed tabular-nums">{{ `sha256 ${v.content_sha256.slice(0, 12)}` }}</span>
          </li>
        </ul>
      </div>

      <UAlert
        v-if="isHistorical"
        color="warning"
        variant="subtle"
        class="mt-4"
        :title="`你正在看 ${shown.version}，這不是現行版本。`"
        description="現行版本才是目前生效的條款。"
      >
        <template #actions>
          <UButton color="neutral" variant="outline" size="xs" @click="view(null)">
            回到現行版本
          </UButton>
        </template>
      </UAlert>

      <div class="mt-7 grid gap-x-10 gap-y-6 md:grid-cols-[180px_minmax(0,1fr)]">
        <!-- 手機：收合。原生 details，不依賴 JS -->
        <details class="group border-b border-default pb-3 md:hidden">
          <summary class="flex cursor-pointer list-none items-center gap-1 text-[13px] text-muted marker:hidden">
            <!-- 沒有這個箭頭，收合起來的目錄看起來只是一行字，沒有人會去點它 -->
            <UIcon name="i-lucide-chevron-right" class="size-4 transition-transform group-open:rotate-90" />
            <span>{{ `目錄（${parsed.toc.length} 條）` }}</span>
          </summary>
          <nav class="mt-2 grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-1 gap-y-1.5 text-[13px]">
            <template v-for="entry in parsed.toc" :key="entry.id">
              <span class="text-dimmed tabular-nums">{{ entry.label }}</span>
              <a :href="`#${entry.id}`" class="text-toned hover:text-highlighted">{{ entry.text }}</a>
            </template>
          </nav>
        </details>

        <!-- 桌機：左側 sticky -->
        <nav class="hidden self-start md:sticky md:top-4 md:grid md:grid-cols-[1.5rem_minmax(0,1fr)] md:gap-x-1 md:gap-y-2 text-[13px]">
          <template v-for="entry in parsed.toc" :key="entry.id">
            <span class="text-dimmed tabular-nums">{{ entry.label }}</span>
            <a :href="`#${entry.id}`" class="text-toned hover:text-highlighted">{{ entry.text }}</a>
          </template>
        </nav>

        <div class="min-w-0">
          <LegalProse :blocks="parsed.blocks" />
          <slot name="after" />
        </div>
      </div>
    </template>

    <!--
      讀不到就明講，並把唯一還走得通的管道留下來。
      條款頁沒有「空狀態」這個選項，但假裝有內容更糟。
    -->
    <div v-else class="py-16">
      <h1 class="text-2xl font-bold tracking-tight">
        這份文件現在讀不到
      </h1>
      <p class="mt-3 max-w-[34em] text-toned">
        文件內容存在資料庫裡，這次沒有取到。重新整理通常就好了；還是不行的話，
        著作權相關的事情可以直接用侵權通知表單聯絡我們。
      </p>
      <UButton to="/legal/dmca" variant="soft" class="mt-5">
        前往侵權通知
      </UButton>
    </div>
  </div>
</template>

<style scoped>
/*
  深連結落地時要看得出「是這一條」。條號可深連結是 §15.1 的硬要件
  （侵權通知、客服回覆、admin 備註都會指向特定一條），而跳過去之後
  沒有任何視覺回饋的話，讀的人要自己數標題。
  用 `:target` 而不是 JS 的 scroll spy：它在靜態檔上、在 JS 到位之前就成立。
  ⚠️ `::deep` 是必要的——標題在 LegalProse 裡，scoped 樣式到不了。
*/
:deep(h2:target),
:deep(h3:target) {
  border-inline-start: 2px solid var(--ui-primary);
  padding-inline-start: 0.625rem;
  margin-inline-start: -0.75rem;
}

/* Safari 的 summary 預設是 list-item，marker:hidden 到不了 */
summary::-webkit-details-marker {
  display: none;
}
</style>
