/**
 * 匯入進度的保存與續跑。
 *
 * 存在的理由很具體：TMDB 免費 key 會累積節流（實測後段比前段慢 6 倍），
 * 一次跑完 3,116 筆需要數十分鐘且隨時可能中斷。管線必須能從中斷處接續，
 * 而不是每次都從頭來過——這也是 SPEC 明列的實作約束。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface Checkpoint<T> {
  /** 已完成的項目，以項目 id 為鍵。 */
  done: Record<string, T>
  /** 最後一次寫入的時間。 */
  updatedAt: string
}

async function readCheckpoint<T>(path: string): Promise<Checkpoint<T>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Checkpoint<T>
  }
  catch {
    // 檔案不存在或內容損毀都視為「從頭開始」。損毀時重跑的成本，
    // 遠低於拿一份壞掉的進度去續跑。
    return { done: {}, updatedAt: new Date().toISOString() }
  }
}

async function writeCheckpoint<T>(path: string, checkpoint: Checkpoint<T>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(checkpoint, null, 2), 'utf8')
}

export interface ResumableOptions<Item, Result> {
  /** checkpoint 檔案路徑。 */
  path: string
  items: Item[]
  /** 自項目取出穩定的 id，作為 checkpoint 的鍵。 */
  keyOf: (item: Item) => string
  /** 處理單一項目。拋錯時該項目不計入完成，下次會重試。 */
  process: (item: Item) => Promise<Result>
  /** 每處理幾筆寫一次 checkpoint。 */
  flushEvery?: number
  /**
   * 同時處理的項目數。
   *
   * 這一層必須真的併發，下游客戶端的併發閘門才有作用——閘門只在
   * 多個請求同時在飛時才起效。預設 8 與 TmdbClient 的預設相同。
   */
  concurrency?: number
  /** 進度回報。 */
  onProgress?: (progress: { done: number, total: number, skipped: number }) => void
}

/**
 * 以固定數量的 worker 併發處理，並定期保存進度；已完成的項目在重跑時跳過。
 *
 * 這裡必須自己併發，不能只依賴下游客戶端的併發閘門——閘門只有在
 * 同時有多個請求在飛時才起作用，而呼叫端若逐筆 await，閘門永遠只看到
 * 一個請求。先前的版本正是如此，實測吞吐掉到 0.78 筆/秒（應有的
 * 五分之一）。
 *
 * 併發下仍然安全的理由：JS 是單執行緒，`checkpoint.done[key] = ...`
 * 與 flush 的判斷都發生在 await 之間的同步區塊，不會交錯；寫檔則以
 * `flushing` 串接，避免兩次寫入互相覆蓋。
 */
export async function runResumable<Item, Result>(
  options: ResumableOptions<Item, Result>,
): Promise<Record<string, Result>> {
  const {
    path,
    items,
    keyOf,
    process: processItem,
    flushEvery = 50,
    concurrency = 8,
    onProgress,
  } = options

  const checkpoint = await readCheckpoint<Result>(path)
  const pending = items.filter(item => !(keyOf(item) in checkpoint.done))
  const skipped = items.length - pending.length

  let sinceFlush = 0
  let done = skipped
  let cursor = 0
  /** 進行中的寫檔。串接而非平行，避免後寫的舊狀態蓋掉先寫的新狀態。 */
  let flushing: Promise<void> = Promise.resolve()

  function flush(): Promise<void> {
    checkpoint.updatedAt = new Date().toISOString()
    // 快照當下的內容再寫，避免寫入期間又有 worker 改動而寫出半套狀態。
    const snapshot: Checkpoint<Result> = {
      done: { ...checkpoint.done },
      updatedAt: checkpoint.updatedAt,
    }
    flushing = flushing.then(() => writeCheckpoint(path, snapshot))
    return flushing
  }

  /**
   * 第一個發生的錯誤。
   *
   * worker 不直接拋出，而是記錄下來並讓所有 worker 收斂——否則
   * `Promise.all` 會在第一個錯誤時就 reject，留下其他 worker 在背景
   * 繼續跑、繼續寫檔（會寫出半套的 checkpoint），也繼續消耗 API 配額。
   */
  let failure: unknown

  async function worker(): Promise<void> {
    while (cursor < pending.length && failure === undefined) {
      const item = pending[cursor++]!
      try {
        checkpoint.done[keyOf(item)] = await processItem(item)
      }
      catch (error) {
        failure ??= error
        return
      }

      done++
      sinceFlush++
      if (sinceFlush >= flushEvery) {
        sinceFlush = 0
        await flush()
        onProgress?.({ done, total: items.length, skipped })
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.max(1, Math.min(concurrency, pending.length)) },
    () => worker(),
  ))

  // 所有 worker 都已收斂，此時寫檔不會與任何人競爭。
  await flush()
  onProgress?.({ done, total: items.length, skipped })

  // 已完成的部分已經落地，下次重跑會接續。
  if (failure !== undefined)
    throw failure

  return checkpoint.done
}
