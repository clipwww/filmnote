/**
 * 讓 `#pipeline/…` 在 **Nuxt 的型別檢查**裡解析得到。
 *
 * ⚠️ 這是繞路，不是正解。正解是在 `nuxt.config.ts` 加一行 alias：
 *
 *     alias: { '#pipeline': fileURLToPath(new URL('./src', import.meta.url)) },
 *
 * 那一行會同時修好三件事（打包器解析、vue-tsc 解析、以及 server 端可以直接用
 * `#pipeline/…` 而不必寫相對路徑）。`nuxt.config.ts` 是共用檔，本 session 不能
 * 自行修改，所以先用這份宣告把型別檢查撐住。
 * **alias 加上去之後，請直接刪掉本檔（連同這個 shared 目錄，如果它空了）。**
 *
 * 為什麼非補不可：`package.json` 的 `imports` 寫的是 `"#pipeline/*": "./src/*"`
 * ——目標沒有副檔名。Node 的 imports 解析（TypeScript 的 Bundler 模式與 rollup
 * 都照它走）不做副檔名補齊，所以 `#pipeline/types` 在那兩者眼裡就是不存在。
 * 它之所以在 `pnpm typecheck:pipeline` 與 `pnpm test` 裡是好的，是因為那兩邊各自
 * 另有一份 tsconfig `paths` 與 vitest 的 `resolve.alias` 蓋過去了。
 * 同一個別名在四個工具裡有兩種結果——這正是踩雷 #80 的內容。
 *
 * server 端一旦以相對路徑匯入 `src/tmdb/client.ts`，那個檔案就被拉進 Nuxt 的
 * 型別檢查範圍，於是它自己那行 `import type … from '#pipeline/types'` 就會炸。
 * 這份宣告修的是那一個。
 *
 * ★ 用 `import('…').T` 的形式而不是 `export *`：實測 `export *` 在
 *   `declare module` 區塊裡拿不到成員（相對路徑版的症狀是「模組找到了但沒有
 *   任何 exported member」，`@@/` 版則連模組都找不到）。import type 則穩定地
 *   相對於本檔解析，而且不必把型別的形狀抄一份過來——只轉介名字，不複製定義。
 *
 * ★ 為什麼放在 shared 目錄而不是 server 目錄：Nuxt 產的四個子專案裡，**app
 *   專案也會把 server 端的 util 拉進型別檢查**——`.nuxt/types/nitro-routes.d.ts`
 *   為了推導 `$fetch('/api/…')` 的回傳型別而引用了路由檔。但 app 專案的
 *   `exclude` 含有 server 目錄，所以放在 server 底下的環境宣告它看不到
 *   （exclude 只擋初始檔案集合，擋不住被 import 進來的檔案 ⇒ 錯誤照報，
 *   修正卻不生效）。shared 目錄下的 `.d.ts` 是 app 與 server 兩個專案都會
 *   include 的唯一位置。
 *
 * ★ 註解裡不要寫 glob。`**` 後面接 `/` 再接 `*` 會出現 `*` `/` 相鄰的字元序列，
 *   在區塊註解裡就是結束符號，整份檔案會從那裡開始被當成程式碼
 *   （症狀是莫名其妙的 TS1109 / TS1160）。
 */

declare module '#pipeline/types' {
  export type TmdbMovieDetail = import('../src/types').TmdbMovieDetail
  export type TmdbSearchResult = import('../src/types').TmdbSearchResult
}
