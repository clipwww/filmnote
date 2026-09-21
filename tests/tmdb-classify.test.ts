import type { KnownFilm, ReleaseLike } from '#pipeline/tmdb/classify'
import { describe, expect, it } from 'vitest'
import { classifyReleases } from '#pipeline/tmdb/classify'

/**
 * ② 疑似已存在那條路徑在活體上實跑是 **0 筆、而且從未有真實樣本走過**
 * （`ac1e021` 自己標了未驗證）。那 267 部沒有 tmdb_id 的是 110–113 年的舊片，
 * 跟「現在上映中」本來就不重疊 ⇒ **「② 是 0」不等於「那道檢查是對的」**。
 * 這一檔就是拿合成樣本讓它第一次真的命中（派工簡報 §8 卡點 #5）。
 */

function film(partial: Partial<KnownFilm>): KnownFilm {
  return {
    id: 'f-0',
    tmdb_id: null,
    title_zh: '',
    title_original: '',
    origin: 'gov',
    ...partial,
  }
}

function release(partial: Partial<ReleaseLike>): ReleaseLike {
  return { id: 1, title: '', original_title: '', ...partial }
}

describe('classifyReleases', () => {
  // ① 的判準是 tmdb_id，不是片名——片名完全不同也必須落進 ①。
  it('tmdb_id 已在片庫 ⇒ ①（即使片名對不上）', () => {
    const lib = [film({ id: 'f-1', tmdb_id: 4242, title_zh: '片庫裡叫這個' })]
    const out = classifyReleases([release({ id: 4242, title: 'TMDB 叫那個' })], lib)
    expect(out.known.map(r => r.id)).toEqual([4242])
    expect(out.suspected).toHaveLength(0)
    expect(out.fresh).toHaveLength(0)
  })

  // ★ 這就是那條「從未有真實樣本走過」的路徑：拿一部沒有 tmdb_id 的既有作品的片名當樣本。
  it('片名對上一部沒有 tmdb_id 的既有作品 ⇒ ②（該補 id，不是新增）', () => {
    const lib = [film({ id: 'f-spy', title_zh: '間諜家家酒 代號：白', title_original: 'SPY x FAMILY CODE: White' })]
    const out = classifyReleases([release({ id: 9001, title: '間諜家家酒 代號：白', original_title: 'X' })], lib)
    expect(out.suspected).toHaveLength(1)
    expect(out.suspected[0]!.hits.map(h => h.id)).toEqual(['f-spy'])
    expect(out.fresh).toHaveLength(0)
  })

  // 〔反向對照〕沒有這一條，上面那條在「什麼都判成 ②」時也會綠。
  it('片名誰也對不上 ⇒ ③ 候選新增', () => {
    const lib = [film({ id: 'f-spy', title_zh: '間諜家家酒 代號：白' })]
    const out = classifyReleases([release({ id: 9002, title: '這部片庫裡絕對沒有' })], lib)
    expect(out.fresh.map(r => r.id)).toEqual([9002])
    expect(out.suspected).toHaveLength(0)
  })

  // 比對走 normalizeTitle：全形半形、版本標註、標點的差異不可以讓重複作品溜過去。
  it('② 的比對吃得下版本標註與全形標點的差異', () => {
    const lib = [film({ id: 'f-x', title_zh: '紅豬' })]
    const out = classifyReleases([release({ id: 9003, title: '紅豬（數位修復版）' })], lib)
    expect(out.suspected).toHaveLength(1)
    expect(out.suspected[0]!.hits[0]!.id).toBe('f-x')
  })

  // 原文片名也要比——政府資料有片商用英文片名登記的案例（§7 #F3）。
  it('② 也比 original_title 對片庫的 title_original', () => {
    const lib = [film({ id: 'f-y', title_original: 'SPY x FAMILY CODE: White' })]
    const out = classifyReleases([release({ id: 9004, title: '別的名字', original_title: 'SPY x FAMILY CODE: White' })], lib)
    expect(out.suspected).toHaveLength(1)
    expect(out.suspected[0]!.hits[0]!.id).toBe('f-y')
  })

  // ⚠️ 已經有 tmdb_id 的作品**不進**片名索引：它們不是「會被重複新增」的那一群，
  //    把它們算進去會讓 ② 充滿噪音，然後沒有人會再看 ② 一眼。
  it('有 tmdb_id 的既有作品不會被拿來當 ② 的線索', () => {
    const lib = [film({ id: 'f-z', tmdb_id: 777, title_zh: '同名不同片' })]
    const out = classifyReleases([release({ id: 9005, title: '同名不同片' })], lib)
    expect(out.suspected).toHaveLength(0)
    expect(out.fresh.map(r => r.id)).toEqual([9005])
  })

  // 空片名不可以互相對上——片庫有 title_original 為空的列，全部撞在一起會讓 ② 爆掉。
  it('空片名不產生 ② 命中', () => {
    const lib = [film({ id: 'f-blank', title_zh: '', title_original: '' })]
    const out = classifyReleases([release({ id: 9006, title: '', original_title: '' })], lib)
    expect(out.suspected).toHaveLength(0)
    expect(out.fresh.map(r => r.id)).toEqual([9006])
  })

  // 同一部片被兩個欄位同時命中時只算一次，否則 ② 的數字會虛胖。
  it('同一部既有作品被兩個欄位命中只算一次', () => {
    const lib = [film({ id: 'f-dup', title_zh: 'ECHO', title_original: 'ECHO' })]
    const out = classifyReleases([release({ id: 9007, title: 'ECHO', original_title: 'ECHO' })], lib)
    expect(out.suspected).toHaveLength(1)
    expect(out.suspected[0]!.hits).toHaveLength(1)
  })
})
