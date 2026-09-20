/**
 * 套用 `src/import/title-corrections.ts` 的人工對照，修復編碼損毀的中文片名。
 *   pnpm tsx --env-file=.env scripts/fix-corrupted-titles.ts [--apply]   # 預設試跑
 * 是修復腳本而不是在匯入管線裡修：損毀已經在線上資料裡了，靠匯入修得重跑整個政府資料
 * 匯入，會連帶重算一堆無關的東西。匯入端的守門員是 `inspectTitleZh()`——這支管既有的，
 * 那支管未來的，兩者都要有。
 */
// 冪等：以 `(rocYear, permitNo)` 定位，只更新「目前確實含私用區字元」的列 ⇒ 跑第二次回報
// 0 筆，不會把已經正確的片名再寫一次。
// ★ 同時更新 `film` 與 `certificate`：只改 film 會讓 certificate 留著損毀字串，而它是
//   「政府核准了什麼」的舉證材料，日後對帳會對不起來。

import process from 'node:process'
import { Client, types as pgTypes } from 'pg'
import { TITLE_CORRECTIONS } from '#pipeline/import/title-corrections'
import { hasPrivateUseChars } from '#pipeline/normalize/defensive'

for (const oid of [1082, 1114, 1184, 1083])
  pgTypes.setTypeParser(oid, v => v)

const apply = process.argv.includes('--apply')

const url = process.env.DATABASE_URL
if (!url) {
  console.error('缺少 DATABASE_URL。')
  process.exit(1)
}

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()

let fixedFilms = 0
let fixedCerts = 0
let skipped = 0

try {
  await client.query('begin')

  for (const c of TITLE_CORRECTIONS) {
    // certificate 的 (roc_year, permit_no) 是定位鍵；film 經 certificate.film_id 找。
    const { rows } = await client.query<{
      cert_id: string
      film_id: string | null
      cert_title: string
      film_title: string | null
      film_original: string | null
    }>(
      `select ct.id as cert_id, ct.film_id, ct.title_zh as cert_title,
              f.title_zh as film_title, f.title_original as film_original
         from public.certificate ct
         left join public.film f on f.id = ct.film_id
        where ct.roc_year = $1 and ct.permit_no = $2`,
      [c.rocYear, c.permitNo],
    )

    if (rows.length === 0) {
      console.warn(`⚠️  找不到 ${c.rocYear} 年 ${c.permitNo}（${c.titleOriginal}），略過`)
      continue
    }

    for (const row of rows) {
      // ★ 人工核對：原文片名必須對得上，否則這筆對照可能配到別部片。
      //   permit_no 跨年度不唯一（踩雷 #44），錯配的後果是把一個錯的片名寫上去。
      if (row.film_original && row.film_original !== c.titleOriginal) {
        console.error(
          `❌ ${c.rocYear} 年 ${c.permitNo} 的原文片名是「${row.film_original}」，`
          + `對照表寫的是「${c.titleOriginal}」——不一致，拒絕更新這一筆。`,
        )
        continue
      }

      const certNeedsFix = hasPrivateUseChars(row.cert_title)
      const filmNeedsFix = row.film_title !== null && hasPrivateUseChars(row.film_title)

      if (!certNeedsFix && !filmNeedsFix) {
        skipped++
        console.log(`↷ ${c.rocYear} 年 ${c.permitNo}：已無損毀字元，略過（冪等）`)
        continue
      }

      console.log(
        `${apply ? '✏️ ' : '（試跑）'} ${c.rocYear} 年 ${c.permitNo}（${c.titleOriginal}）`
        + `[${c.confidence}]\n`
        + `    certificate：${JSON.stringify(row.cert_title)} → ${JSON.stringify(c.titleZh)}\n`
        + `    film       ：${JSON.stringify(row.film_title)} → ${JSON.stringify(c.titleZh)}`,
      )

      if (!apply)
        continue

      if (certNeedsFix) {
        await client.query(
          `update public.certificate set title_zh = $1 where id = $2`,
          [c.titleZh, row.cert_id],
        )
        fixedCerts++
      }
      if (filmNeedsFix && row.film_id) {
        // title_zh_source 維持 'gov'：這是政府核准的片名，只是我們把它修回來了。改成
        // 別的值會讓 TMDB 日後有權覆蓋它——那正是絕不能發生的事。
        await client.query(
          `update public.film set title_zh = $1, updated_at = now() where id = $2`,
          [c.titleZh, row.film_id],
        )
        fixedFilms++
      }
    }
  }

  if (apply) {
    await client.query('commit')
    console.log(`\n✅ 已更新 film ${fixedFilms} 列、certificate ${fixedCerts} 列，略過 ${skipped} 筆。`)
  }
  else {
    await client.query('rollback')
    console.log(`\n（試跑，未寫入。加 --apply 才會真的更新。）略過 ${skipped} 筆。`)
  }

  // 收尾檢查：跑完之後整個片庫都不該再有私用區字元（與 verify-core.sql 的 D1 同一個
  // 不變量），在這裡也查一次是為了不必等下一次 verify:all 才知道修完了沒。
  const { rows: left } = await client.query<{ n: string }>(
    `select count(*) as n from public.film
      where exists (select 1 from regexp_split_to_table(
                      coalesce(title_zh,'') || coalesce(title_original,''), '') ch
                     where ascii(ch) between 57344 and 63743)`,
  )
  const remaining = Number(left[0]?.n ?? 0)
  console.log(remaining === 0
    ? '✅ 片庫已無含私用區字元的片名。'
    : `⚠️  仍有 ${remaining} 部作品的片名含私用區字元（對照表沒有涵蓋到它們）。`)
}
finally {
  await client.end()
}
