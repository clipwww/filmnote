/**
 * 掃 git 歷史裡有沒有殘留憑證。**Step 11 的第一次 push 之前必跑。**
 *
 *   pnpm tsx --env-file=.env scripts/scan-git-secrets.ts
 *
 * ── 為什麼不用 `git log -p | grep` ────────────────────────────────────────
 * 那只看得到**可達**的物件。被 `git commit --amend`、`git rebase`、
 * `git reset --hard` 拿掉的那些 commit 仍然躺在 .git/objects 裡，直到 gc 為止，
 * 而 `git push` 不會送它們——但**任何人 clone 之後 `git fsck --lost-found` 就撈得到**，
 * 而且 GitHub 的 API 可以直接以 SHA 取得懸空物件（force-push 之後那些物件
 * 在 GitHub 上仍然可讀，這是有名的資料外洩途徑）。
 *
 * 實測本 repo（2026-09-06）：可達物件 900 個，`--batch-all-objects` 是 **943** 個
 * ——**43 個物件只有這支掃得到**。
 *
 * ── 輸出紀律 ──────────────────────────────────────────────────────────────
 * ★ 命中時**絕不印出憑證本身**，只印物件 SHA、規則名稱與所在路徑。
 *   印出來就等於把它從 git 歷史搬進終端機記錄、CI log 與這份對話。
 */

import type { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

interface Rule {
  name: string
  /** 一律加 `g`，因為要數命中次數。 */
  re: RegExp
}

/**
 * 規則刻意寫得比較寬。這支的失敗成本不對稱：漏掉一個真的憑證是外洩，
 * 多報一個假陽性只是花兩分鐘看一眼。
 */
const RULES: Rule[] = [
  { name: 'Supabase secret key（sb_secret_）', re: /sb_secret_[\w-]{10,}/g },
  { name: 'Supabase publishable key（sb_publishable_）', re: /sb_publishable_[\w-]{10,}/g },
  { name: 'Supabase access token（sbp_）', re: /\bsbp_[a-f0-9]{40,}/g },
  // 舊版 anon / service_role 是 JWT。JWT 的 header 幾乎一定以 eyJ 開頭。
  { name: 'JWT（eyJ… 三段式）', re: /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g },
  { name: 'Postgres 連線字串含密碼', re: /postgres(?:ql)?:\/\/[^\s:/]+:[^\s@]+@/g },
  { name: '私鑰檔頭', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  // `KEY=值` 形式。值必須夠長才算，否則 .env.example 的空值與佔位符會全中。
  //
  // ⚠️ `=` 兩側只能是**空白或 tab，不能是 \s**。第一版寫 `\s*=\s*`，於是
  //    `NUXT_TMDB_API_KEY=`（空值，換行）會把**下一行的變數名**吃進來當成值
  //    ⇒ .env.example 與 BUILD_PLAN 的說明區塊全部命中，實測一次噴 27 筆假陽性。
  //    空值正是最該被略過的情況，卻變成警報——而一支每次都報 27 筆的掃描
  //    等於沒有掃描（§7 #104 的同一個家族）。
  { name: '環境變數賦值（KEY=長字串）', re: /\b(?:[A-Z][A-Z0-9_]*_)?(?:SECRET|TOKEN|PASSWORD|APIKEY|API_KEY)[A-Z0-9_]*[ \t]*=[ \t]*["']?[\w\-./+]{16,}/g },
]

/** 佔位符與說明文字。命中這些就不算。 */
const PLACEHOLDER = /your[-_]?|example|placeholder|xxxx|<[^>]+>|\.\.\.|dummy|changeme|REDACTED/i

function git(args: string[]): Buffer {
  return execFileSync('git', args, { maxBuffer: 512 * 1024 * 1024 })
}

interface Hit {
  sha: string
  rule: string
  count: number
  paths: string[]
}

function main(): void {
  // ★ --batch-all-objects：**包含不可達的**鬆散物件與 packfile 內容。
  const listing = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)'])
    .toString('utf8')
    .trim()
    .split('\n')

  const blobs = listing
    .map(l => l.split(' '))
    .filter(([, type]) => type === 'blob')
    .map(([sha, , size]) => ({ sha: sha!, size: Number(size) }))

  const reachable = new Set(
    git(['rev-list', '--objects', '--all']).toString('utf8').split('\n').map(l => l.slice(0, 40)).filter(Boolean),
  )

  // 物件 → 它在歷史上出現過的路徑（只為了讓報告看得懂，掃描本身不靠它）
  const pathBySha = new Map<string, Set<string>>()
  for (const line of git(['rev-list', '--objects', '--all']).toString('utf8').split('\n')) {
    const sha = line.slice(0, 40)
    const path = line.slice(41)
    if (!sha || !path)
      continue
    const set = pathBySha.get(sha) ?? new Set()
    set.add(path)
    pathBySha.set(sha, set)
  }

  const hits: Hit[] = []
  let scanned = 0
  let skippedBinary = 0

  for (const { sha, size } of blobs) {
    // 字型與圖片不會藏憑證，而 14MB 的 .ttf 掃起來很慢。以「有沒有 NUL」判斷
    // 二進位，而不是以副檔名——歷史上的檔名可能已經不存在了。
    const content = git(['cat-file', 'blob', sha])
    if (content.includes(0)) {
      skippedBinary++
      continue
    }
    scanned++
    const text = content.toString('utf8')
    if (size > 2_000_000)
      continue

    for (const rule of RULES) {
      const matches = text.match(rule.re)
      if (!matches)
        continue
      const real = matches.filter(m => !PLACEHOLDER.test(m))
      if (!real.length)
        continue
      hits.push({
        sha,
        rule: rule.name,
        count: real.length,
        paths: [...(pathBySha.get(sha) ?? new Set(['(不可達物件，無路徑)']))],
      })
    }
  }

  console.log(`物件總數 ${listing.length}（blob ${blobs.length}）`)
  console.log(`其中不可達 ${blobs.filter(b => !reachable.has(b.sha)).length} 個 blob —— 只有 --batch-all-objects 掃得到`)
  console.log(`掃描文字 blob ${scanned} 個，略過二進位 ${skippedBinary} 個\n`)

  // ★ 額外一輪：拿**目前 .env 裡真的在用的憑證**去比對。上面的規則是形狀比對，
  //   這一輪是身分比對——形狀改版（例如 Supabase 換了 key 前綴）時它仍然有效。
  const liveSecrets = Object.entries(process.env)
    .filter(([k, v]) => /SECRET|KEY|TOKEN|PASSWORD|DATABASE_URL/.test(k) && v && v.length >= 20)
    .map(([k, v]) => [k, v!] as const)

  const liveHits: { key: string, sha: string, paths: string[] }[] = []
  if (liveSecrets.length) {
    for (const { sha } of blobs) {
      const content = git(['cat-file', 'blob', sha])
      if (content.includes(0))
        continue
      const text = content.toString('utf8')
      for (const [k, v] of liveSecrets) {
        if (text.includes(v))
          liveHits.push({ key: k, sha, paths: [...(pathBySha.get(sha) ?? new Set(['(不可達物件)']))] })
      }
    }
    console.log(`比對目前 .env 的 ${liveSecrets.length} 個憑證：${liveHits.length ? `❌ 命中 ${liveHits.length} 次` : '✅ 全部沒有出現在任何物件裡'}`)
    for (const h of liveHits)
      console.log(`   ❌ ${h.key} 出現在 ${h.sha.slice(0, 12)}（${h.paths.join(', ')}）`)
  }
  else {
    console.log('⚠️  沒有從環境變數讀到任何憑證 —— 這一輪等於沒跑。用 --env-file=.env 執行。')
  }

  console.log('')
  if (!hits.length) {
    console.log('✅ 形狀比對：沒有命中')
  }
  else {
    console.log(`❌ 形狀比對命中 ${hits.length} 筆（**不印出內容**，自己去看那個物件）：`)
    for (const h of hits) {
      const unreach = reachable.has(h.sha) ? '' : ' ⚠️不可達物件'
      console.log(`   ${h.sha.slice(0, 12)}${unreach}  ${h.rule} ×${h.count}  ${h.paths.slice(0, 3).join(', ')}`)
    }
    console.log('\n   逐一確認：git cat-file blob <sha> | less')
  }

  const bad = hits.length + liveHits.length
  console.log(`\n── 結論 ── ${bad === 0 ? '✅ 乾淨，可以 push' : `❌ 有 ${bad} 筆要處理，**先不要 push**`}`)
  if (bad)
    process.exit(1)
}

main()
