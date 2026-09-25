/**
 * 「替片庫既有作品補 TMDB id」的前置檢查。純函式，端點與測試共用。
 */
// ★ 這一支存在的理由：`link_film_to_tmdb()` 遇到「這個 TMDB id 已經在某一列上」時**不報錯，
//   而是 `merge_films(p_film, existing)`**——把一部政府片合併進別的片、回傳別的 id。
//   它的查詢 `where tmdb_id = p_tmdb` 連已合併的死列都算。那條路在「補 id」這個動作裡
//   永遠是錯的，所以擋在呼叫之前，而不是指望預覽的判斷還沒過期。
// ⚠️ 只放行 `tmdb_id is null` 的作品：已經有 id 的改 id 會撞 `film_identity_one_primary`
//   （0017 記載的陷阱，舊的主 tmdb 鍵不會被移除）——那是另一件事，不在這裡做。

export interface LinkTarget {
  id: string
  tmdb_id: number | null
  merged_into_film_id: string | null
}

/** 目前持有這個 TMDB id 的列，**含已合併的**。 */
export interface TmdbHolder {
  id: string
  merged_into_film_id: string | null
}

export type LinkCheck
  = | { ok: true }
    | { ok: false, status: 404 | 409, reason: string }

export function linkPreconditions(target: LinkTarget | null, holders: readonly TmdbHolder[], identityTaken: boolean): LinkCheck {
  if (!target)
    return { ok: false, status: 404, reason: '找不到這部作品' }
  if (target.merged_into_film_id)
    return { ok: false, status: 409, reason: '這部作品已經被合併掉了，請改補它合併進去的那一部' }
  if (target.tmdb_id !== null)
    return { ok: false, status: 409, reason: `這部已經有 TMDB id（${target.tmdb_id}）。改 id 不在這裡做` }
  if (holders.length) {
    const h = holders[0]!
    return {
      ok: false,
      status: 409,
      reason: `這個 TMDB id 已經在另一部作品上（${h.id}${h.merged_into_film_id ? '，已合併' : ''}）——補上去會變成把這部合併過去`,
    }
  }
  // identity 觸發器是 `on conflict (key) do update set film_id`：鍵在別人身上時會被**搶過來**。
  if (identityTaken)
    return { ok: false, status: 409, reason: '這個 TMDB id 的識別鍵已經屬於另一部作品' }
  return { ok: true }
}
