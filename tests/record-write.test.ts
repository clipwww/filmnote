import type { SupabaseClient } from '@supabase/supabase-js'
import type { RecordForm } from '../app/schemas/record'
import type { Database } from '../app/types/database.types'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// ⚠️ 相對路徑：vitest 的 `~` 指向 ./src，不是 ./app（見 vitest.config.ts）。
import { createRecord, recordWriteToast, updateRecord } from '../app/utils/record-write'

/**
 * 觀影紀錄寫入模組的介面測試（取代原本對 RecordEditForm 原始碼下的 regex）。
 * ⚠️ 假 client 只記錄「呼叫了什麼」：RLS（`record_update` 的 with check）與 trigger 看不見，
 * 那些仍要用 SQL／非 staff 帳號驗（#333；第 2 條的資料層證據見交接 records-ui §10.2）。
 */

type Call = [table: string, method: string, ...args: unknown[]]
interface Outcome { data?: unknown, error?: { message: string } | null }

/** 每個方法都回自己、最後被 await 時依表名吐出設定好的結果。 */
function fakeClient(outcomes: Record<string, Outcome> = {}) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const outcome = outcomes[table] ?? {}
      const builder: Record<string, unknown> = {}
      for (const m of ['insert', 'update', 'upsert', 'delete', 'select', 'eq', 'single']) {
        builder[m] = (...args: unknown[]) => {
          calls.push([table, m, ...args])
          return builder
        }
      }
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: outcome.data ?? null, error: outcome.error ?? null })
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient<Database>, calls }
}

const FILM = '11111111-1111-4111-8111-111111111111'
const RID = 'rec-1'

function form(over: Partial<RecordForm> = {}): RecordForm {
  return {
    film: { id: FILM },
    watchedOn: '2026-09-20',
    watchedTime: null,
    venueId: 'v1',
    ticketCount: null,
    cost: null,
    hallLabel: null,
    formatCode: null,
    memo: null,
    isPublic: true,
    ...over,
  }
}

const costCalls = (calls: Call[]) => calls.filter(c => c[0] === 'viewing_record_cost')
const recordMethods = (calls: Call[]) => calls.filter(c => c[0] === 'viewing_record').map(c => c[1])

describe('createRecord', () => {
  const ok = { viewing_record: { data: { id: RID } } }

  it('票價 null ⇒ 完全不碰 viewing_record_cost', async () => {
    const { client, calls } = fakeClient(ok)
    const r = await createRecord(client, { form: form({ cost: null }), userId: 'u1' })
    expect(r).toEqual({ status: 'saved', id: RID, hasCost: false })
    expect(costCalls(calls)).toEqual([])
  })

  it('★ 票價 0 ⇒ 寫一列 amount 0（招待票，不是「沒資料」）', async () => {
    const { client, calls } = fakeClient(ok)
    const r = await createRecord(client, { form: form({ cost: 0 }), userId: 'u1' })
    expect(r).toEqual({ status: 'saved', id: RID, hasCost: true })
    expect(costCalls(calls)).toEqual([['viewing_record_cost', 'insert', { record_id: RID, amount: 0 }]])
  })

  it('先紀錄後票價，紀錄帶 user_id 與 film_id', async () => {
    const { client, calls } = fakeClient(ok)
    await createRecord(client, { form: form({ cost: 320 }), userId: 'u1' })
    expect(calls.map(c => c[0])[0]).toBe('viewing_record')
    expect(calls.at(-1)?.[0]).toBe('viewing_record_cost')
    expect(calls[0]).toEqual(['viewing_record', 'insert', expect.objectContaining({ user_id: 'u1', film_id: FILM })])
  })

  it('紀錄寫不進去 ⇒ failed，而且不去寫票價', async () => {
    const { client, calls } = fakeClient({ viewing_record: { error: { message: 'rls' } } })
    const r = await createRecord(client, { form: form({ cost: 320 }), userId: 'u1' })
    expect(r).toEqual({ status: 'failed', error: { message: 'rls' } })
    expect(costCalls(calls)).toEqual([])
  })

  it('★ 票價寫失敗 ⇒ cost-failed（帶 id），分得出「紀錄其實存好了」', async () => {
    const { client } = fakeClient({ ...ok, viewing_record_cost: { error: { message: 'boom' } } })
    const r = await createRecord(client, { form: form({ cost: 320 }), userId: 'u1' })
    expect(r).toEqual({ status: 'cost-failed', id: RID, hasCost: false, error: { message: 'boom' } })
  })
})

describe('updateRecord', () => {
  it('★ viewing_record 只有一次 update().eq(id)，沒有 delete／insert（David 第 2 條、#334）', async () => {
    for (const cost of [null, 0, 450]) {
      for (const hadCost of [true, false]) {
        const { client, calls } = fakeClient()
        await updateRecord(client, { id: RID, form: form({ cost }), hadCost })
        expect(recordMethods(calls)).toEqual(['update', 'eq'])
        expect(calls.find(c => c[0] === 'viewing_record' && c[1] === 'eq')).toEqual(['viewing_record', 'eq', 'id', RID])
      }
    }
  })

  it('film_id 跟其他欄位一起送（換片走同一個 UPDATE）', async () => {
    const { client, calls } = fakeClient()
    await updateRecord(client, { id: RID, form: form(), hadCost: false })
    expect(calls[0]).toEqual(['viewing_record', 'update', expect.objectContaining({ film_id: FILM, venue_id: 'v1' })])
  })

  it('null 且原本有票價列 ⇒ 刪那一列', async () => {
    const { client, calls } = fakeClient()
    const r = await updateRecord(client, { id: RID, form: form({ cost: null }), hadCost: true })
    expect(costCalls(calls)).toEqual([
      ['viewing_record_cost', 'delete'],
      ['viewing_record_cost', 'eq', 'record_id', RID],
    ])
    expect(r).toEqual({ status: 'saved', id: RID, hasCost: false })
  })

  it('null 且原本沒有票價列 ⇒ 不發任何 delete', async () => {
    const { client, calls } = fakeClient()
    const r = await updateRecord(client, { id: RID, form: form({ cost: null }), hadCost: false })
    expect(costCalls(calls)).toEqual([])
    expect(r).toEqual({ status: 'saved', id: RID, hasCost: false })
  })

  it('★ 數字（含 0）⇒ upsert onConflict record_id，不是刪掉', async () => {
    for (const cost of [0, 450]) {
      const { client, calls } = fakeClient()
      const r = await updateRecord(client, { id: RID, form: form({ cost }), hadCost: false })
      expect(costCalls(calls)).toEqual([
        ['viewing_record_cost', 'upsert', { record_id: RID, amount: cost }, { onConflict: 'record_id' }],
      ])
      expect(r).toEqual({ status: 'saved', id: RID, hasCost: true })
    }
  })

  it('紀錄的 UPDATE 失敗 ⇒ failed，票價不動', async () => {
    const { client, calls } = fakeClient({ viewing_record: { error: { message: '42501' } } })
    const r = await updateRecord(client, { id: RID, form: form({ cost: 1 }), hadCost: true })
    expect(r.status).toBe('failed')
    expect(costCalls(calls)).toEqual([])
  })

  it('★ UPDATE 落地但票價失敗 ⇒ cost-failed，hasCost 反映那一列實際還在不在', async () => {
    const bad = { viewing_record_cost: { error: { message: 'boom' } } }
    const del = await updateRecord(fakeClient(bad).client, { id: RID, form: form({ cost: null }), hadCost: true })
    expect(del).toEqual({ status: 'cost-failed', id: RID, hasCost: true, error: { message: 'boom' } })
    const up = await updateRecord(fakeClient(bad).client, { id: RID, form: form({ cost: 9 }), hadCost: false })
    expect(up).toEqual({ status: 'cost-failed', id: RID, hasCost: false, error: { message: 'boom' } })
  })
})

describe('recordWriteToast（兩個呼叫端共用 ⇒ 部分失敗的講法一致）', () => {
  const titles = { saved: '已更新', failed: '更新失敗' }

  it('部分失敗說「存好了，但票價沒存成功」，不說整筆失敗', () => {
    const t = recordWriteToast({ status: 'cost-failed', id: RID, hasCost: false, error: { message: 'boom' } }, titles)
    expect(t).toEqual({ title: '已更新，但票價沒存成功', description: 'boom', color: 'error' })
  })

  it('整筆失敗與成功', () => {
    expect(recordWriteToast({ status: 'failed', error: { message: 'x' } }, titles))
      .toEqual({ title: '更新失敗', description: 'x', color: 'error' })
    expect(recordWriteToast({ status: 'saved', id: RID, hasCost: true }, titles))
      .toEqual({ title: '已更新', color: 'success' })
  })
})

/**
 * 接線：模組再完美，呼叫端不用它就等於沒測。這兩條守的是「頁面自己不再直接寫 viewing_record」。
 */
describe('寫入的呼叫端接線', () => {
  // 先剝註解再比對（§7 #166）：否則把呼叫留在 `// 以前是 await createRecord(supabase, …)` 也會綠。
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/\s.*$/gm, '')

  it('new.vue 走 createRecord，RecordEditForm 走 updateRecord', () => {
    const create = read('../app/pages/app/records/new.vue')
    const edit = read('../app/components/RecordEditForm.vue')
    expect(create).toMatch(/await createRecord\(supabase,/)
    expect(edit).toMatch(/await updateRecord\(supabase,/)
    for (const src of [create, edit]) {
      expect(src).not.toMatch(/from\('viewing_record(_cost)?'\)/)
      expect(src).toMatch(/toast\.add\(recordWriteToast\(result,/)
    }
  })

  it('抽屜遇到 cost-failed 只 refresh 不關（剛打的票價要留著給使用者重試）', () => {
    const edit = read('../app/components/RecordEditForm.vue')
    const list = read('../app/pages/app/records/index.vue')
    expect(edit).toMatch(/if \(result\.status === 'cost-failed'\)\s*emit\('refresh'\)\s*else\s*emit\('saved'\)/)
    expect(list).toMatch(/@refresh="refresh\(\)"/)
  })
})
