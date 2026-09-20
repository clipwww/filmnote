import type { FilmOption } from '~/composables/useFilmSearch'

/**
 * `/app/records/new` 的草稿。存在的理由只有一個情境：使用者記到一半發現片庫裡沒有這部片、
 * 被送去 `/app/films/new`，回來時**其餘欄位必須原樣還在**（`SCREENS §11`）——沒有這一層，
 * 「找不到片」這條路會懲罰那些已經填完日期、影城、票價的人。
 */
/*
 * 用 `sessionStorage` 不是 `localStorage`：一筆記到一半的紀錄不該活過分頁。
 * 讀取是**取走**（take）不是複製——草稿被還原之後就不該再存在，否則下次乾淨地開新表單時
 * 會冒出上次的殘骸。
 */
const KEY = 'filmnote:record-draft'

export interface RecordDraft {
  film?: FilmOption | null
  watchedOn?: string
  watchedTime?: string
  venueId?: string | null
  ticketCount?: number | null
  cost?: number | null
  hallLabel?: string
  formatCode?: string | null
  memo?: string
  isPublic?: boolean
}

export function useRecordDraft() {
  function save(draft: RecordDraft) {
    if (import.meta.server)
      return
    try {
      sessionStorage.setItem(KEY, JSON.stringify(draft))
    }
    catch {
      // 無痕視窗或封鎖 storage：存不下草稿不是錯誤，不要因此中斷流程
    }
  }

  function clear() {
    if (import.meta.server)
      return
    try {
      sessionStorage.removeItem(KEY)
    }
    catch {
      // 同上：清不掉草稿不是錯誤
    }
  }

  /** 讀但不清掉。 */
  function read(): RecordDraft | null {
    if (import.meta.server)
      return null
    try {
      const raw = sessionStorage.getItem(KEY)
      return raw ? (JSON.parse(raw) as RecordDraft) : null
    }
    catch {
      return null
    }
  }

  /** 讀出來並清掉。沒有草稿時回 null。 */
  function take(): RecordDraft | null {
    const draft = read()
    clear()
    return draft
  }

  /**
   * 疊上去而不是覆蓋。⚠️ `/app/films/new` 建立完作品之後只知道「哪一部片」，其餘欄位是使用者
   * 離開 `/app/records/new` 之前存的 ⇒ 用 `save({ film })` 會把日期、影城、票價整組洗掉，
   * 而那正是這整層草稿要保住的東西。
   */
  function merge(partial: RecordDraft) {
    save({ ...(read() ?? {}), ...partial })
  }

  return { save, read, take, merge, clear }
}
