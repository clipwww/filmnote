# 影記 / filmnote — 設計系統

> 本文是視覺與元件層的唯一真值。所有數值都經過實測或計算，證據附在該節。
> 對應 `docs/SPEC.md` 的四個價值主張與 `docs/BUILD_PLAN.md §3` 的路由結構。
> 逐畫面的版面與互動見 `docs/design/SCREENS.md`。

---

## 0. 設計論點

### 主要物件不是海報，是票根

Letterboxd 是海報導向的，因為它每部片都有海報。我們有 10% 沒有（268/2669 部 `tmdb_id` 為 NULL），而且我們真正比它多的東西——**官方核准片名、影城、廳別、版本、票價、場次時間**——正好是一張台灣電影票根上印的東西。

所以：**紀錄的預設呈現是票根式的欄位卡，海報是選配的鑲嵌**。

這一個決定同時解掉三件事：

1. 海報缺席不再是降級。沒海報的作品不是「破圖的海報卡」，它就是一張票根，跟有海報的那張一樣完整。
2. 我們的差異化資訊（影城、廳別、票價）獲得版面主權，而不是擠在海報底下的小字。
3. 我們不會長得像 Letterboxd。

Letterboxd 自己的無海報處理是 `#1F282F` 灰盒中央塞 9–18px 的小字（實測其 `main-CoHtwXNO.css` 的 `--poster-no-image-background`）；Airtable 官方建議把沒圖的**濾掉**。這是我們可以打贏的地方——不是因為技術，而是因為我們手上有官方核准片名，文字卡承載的資訊本來就比海報多。

**驗收標準：無海報的卡片要好到使用者不會希望它變成海報。**

### 資料是墨，不是彩虹

實測 David 的 169 筆紀錄：有觀影的 165 天當中，**161 天是 1 場、4 天是 2 場，沒有任何一天 ≥3 場**（`fixture.stats.dailyAll`）。

這推翻了「照抄 GitHub 五階綠色」的預設做法——五階裡有三階永遠不會被畫出來。日層級的資料實際上是**二元的**。

因此年度出席圖**不是熱力圖，是出席圖**：沒去／去了／去了兩場。第三階留給雙片連映（David 的備註裡真的有「4DX連映馬拉松場(下)」），讓那些日子自己跳出來。

而全站的序列色階一律**單色相明度階（紙 → 墨）**。理由有三，每一個都是硬的：

- ECharts 的 heatmap **不支援 decal**（色盲用的紋理），單色相明度階是唯一可存取的序列色方案。
- 分級章五色（普 #5CB731、護 #00A2ED、輔12 #FFD300、輔15 #D66800、限 #E30009）**亮度非單調**——實算 0.364 → 0.320 → 0.678 → 0.242 → 0.164。它是類別色，不是序列色，不能當色階用。
- 墨階讀起來像印刷密度，跟票根／單據的敘事一致。而且它把彩色完全讓給互動，讓「一個視圖一個重點色」這條紀律真的守得住。

### 避開的東西，以及為什麼

實測 Letterboxd 線上 CSS（2026-09-04 `main-CoHtwXNO.css`, 1.1 MB）後確認，以下四項**同時**是 AI 生成設計的預設**和** Letterboxd 的簽名，屬雙重危險，全部放棄：

| 手法 | Letterboxd 實證 | 我們的替代 |
|---|---|---|
| 近黑底 + 單一螢光重點色 | `--theme-background-color:#14181C` + `#00E054` | 墨階資料 + 單一低調琥珀 |
| ALL-CAPS + 追蹤字距眉標 | `letter-spacing:.075em` 用於全部微標籤 | 中文本來沒有大小寫；用中文小標配量詞 |
| 中點分隔 meta 串（`A · B · C`） | CSS `content:'·' / '•' / '—'` | 開眼式括號量詞串：`林口威秀 (7廳) 2D 16:00 2張` |
| 等寬字型當資料微標籤 | `--font-stack-pitch-sans` | Inter 的 `tnum` 表格數字 |

另外兩項：

- **藍灰中性軸**。Letterboxd 全部中性色落在 hue≈210 的同一條軸上（`#334455`→`#DDEEFF`，3-digit 縮寫用了約 1,100 次），全站沒有一個真正的中性灰。這是它最不被察覺卻最具識別性的資產。我們的中性色必須離開那條軸——改放暖軸（hue 40–50，chroma 極低）。
- **秀泰官網已整套採用 shadcn/Tailwind 預設**（`--primary: oklch(40.1% .146 301.28)` = `#572D88`）。在台灣，「做成圓角 SaaS 卡片」等於長得像影城訂票網站。圓角一律 ≤4px。

不用漸層。不用發光。不在按鈕文字後面加「→」。

---

## 1. 色彩

### 1.1 中性軸：紙與墨

暖軸、極低彩度。亮底取樣自**開眼電影網的 `#FCFBF8`**——它是台灣影視網站實際在用的紙色，而不是設計稿上常見的 `#F4F1EA` 那種高彩度奶油色。

```
--paper-0   #FCFBF8   頁面底（亮）
--paper-1   #F6F4EE   卡片／浮起面
--paper-2   #EDEAE3   分隔、輸入框底、空值格
--paper-3   #DEDACF   邊框（強）

--ink-0     #171512   主文字            對 paper-0 對比 17.61:1
--ink-1     #4A453D   次文字             9.18:1
--ink-2     #6E675C   輔助文字            5.40:1
--ink-3     #8C8477   佔位、停用          3.57:1   ← 僅用於非文字或大字
```

暗色模式不是把亮色反相，是換一組：

```
--dark-0    #12110F   頁面底（暗）
--dark-1    #1C1A17   卡片／浮起面
--dark-2    #2A2621   分隔、輸入框底
--dark-3    #3D3830   邊框

--dim-0     #F2EFE8   主文字             對 dark-0 對比 16.43:1
--dim-1     #C4BDB0   次文字             10.6:1
--dim-2     #A8A196   輔助文字            7.37:1
--dim-3     #787164   佔位、停用          3.90:1
```

### 1.2 重點色：琥珀（單一）

hue 45–47。刻意遠離陶土色（hue 15）與 Letterboxd 橘（hue 30）——**這 15° 的差距是有意的，不要在實作時「微調」回去**。

```
--color-amber-50   #FBF6E4
--color-amber-100  #F6EBC2
--color-amber-200  #EBD68C
--color-amber-300  #DEBE52
--color-amber-400  #C9A62B   ← 暗色模式的文字／邊框（對 dark-0 8.06:1）
--color-amber-500  #AD8A14
--color-amber-600  #8A6800   ← 亮色模式的文字／邊框（對 paper-0 5.00:1）
--color-amber-700  #6E5303
--color-amber-800  #584209
--color-amber-900  #48360C
--color-amber-950  #2A1F05
```

已驗證的配對：

| 用法 | 亮色 | 暗色 |
|---|---|---|
| 實心按鈕 | `amber-600` 底 + 白字 → **5.17:1** | `amber-400` 底 + `ink-0` 字 → **7.79:1** |
| 連結／邊框／focus ring | `amber-600` → 5.00:1 | `amber-400` → 8.06:1 |
| 選取態底色 | `amber-50` | `amber-950` |

**一個視圖只用一次重點色。** 琥珀只出現在：主要動作、目前選取項、focus ring、「今天／本年」標記。不當裝飾用。

### 1.3 序列色階：墨階（圖表專用）

7 階，亮度單調遞減（已驗算）。零值不屬於色階，是中性的 `paper-2` / `dark-2`——**零與一必須看得出差別**。

```
亮色  --heat-0 #EDEAE3(零)  1 #D6D0C4  2 #B3AB9B  3 #8C8477  4 #615B50  5 #3A362F  6 #171512
      亮度      0.8240              0.6339     0.4108     0.2341     0.1060     0.0374     0.0076

暗色  --heat-0 #1F1D19(零)  1 #2E2B25  2 #454037  3 #615B50  4 #8C8477  5 #B3AB9B  6 #E4DFD4
      亮度      0.0124              0.0244     0.0521     0.1060     0.2341     0.4108     0.7402
```

年度出席圖只用 3 階（零／1 場／2 場以上）。時段熱點圖用完整 7 階。

⚠️ **少於 7 階時，要在色階上「拉開取值」，不要取相鄰階。**

這條規則是實作 mockup 時量出來的，不是理論。第一版的年表把 0/1/2 對到 `heat-0 / heat-2 / heat-4`，結果在暗色模式下「沒去」與「1 場」的對比只有 **1.64:1**——整張年表在螢幕上幾乎看不見。改成拉開到 `heat-0 / heat-4 / heat-6` 之後是 **4.55:1**。

| 對應方式 | 亮色 0↔1 | 暗色 0↔1 |
|---|---|---|
| 相鄰階 `0 / 2 / 4` | 1.90:1 ❌ | 1.64:1 ❌ |
| **拉開 `0 / 4 / 6`** | **5.60:1** ✅ | **4.55:1** ✅ |

WCAG 1.4.11 對「承載意義的圖形物件」要求 3:1。**最重要的那一個區分（有去／沒去）必須過門檻**；次要區分（1 場／2 場）落在 2.7:1 可以接受，因為它只影響 165 天裡的 4 天。

同一條規則適用於分布長條圖：**條的填色不要用色階淺端**。若標籤要壓在條上，就把標籤移到條的上方一行，讓填色可以自由加深——否則填色會被標籤的可讀性綁死在淺端，整張圖變成一片看不出長短的方塊。

### 1.4 分級章：類別色，不是色階

文化部影視局官方分級章顏色（49×49px 實際取樣）。**只在作品頁與作品詳情使用**，不進搜尋結果、不進列表。

| 級別 | 底色 | 章內文字色 | 對比 |
|---|---|---|---|
| 普遍級 | `#5CB731` | `--ink-0` | 7.18:1 |
| 保護級 | `#00A2ED` | `--ink-0` | 6.41:1 |
| 輔12 | `#FFD300` | `--ink-0` | 12.64:1 |
| 輔15 | `#D66800` | `--ink-0` | 5.07:1 |
| 限制級 | `#E30009` | `#FFFFFF` | 4.92:1 |

⚠️ 章內文字色**逐級不同**。白字在 普/護/輔12 上全部不及格（2.54 / 2.84 / 1.44）。

形式是**實色方塊 + 級別字**，旁邊的說明文字用 `ink-0`——這正是真實分級章的樣子（彩色方塊內一個字），而且色彩只當標記、不當文字，可存取性由結構保證而非靠運氣。

### 1.5 語意色

沿用 Nuxt UI 的別名，但把 `neutral` 換成暖軸：

- `primary` → amber
- `neutral` → 上面的 paper/ink 暖階
- `error` `success` `warning` `info` → 沿用 Nuxt UI 預設，僅用於表單驗證與 toast，不進資料視覺化

### 1.6 落地：Nuxt UI v4 的 token 覆寫

⚠️ **只改 `app.config.ts` 的 `ui.colors.neutral` 是不夠的。** 實測 `node_modules/@nuxt/ui/dist/runtime/index.css`：亮色的 `--ui-bg` 硬寫死 `#fff`（不從 neutral 派生），`--ui-text-inverted` 也是 `#fff`，暗色的 `--ui-text-highlighted` 同樣是 `#fff`。只換 neutral 只會暖化文字與邊框，頁面底色仍是純白，紙感直接失效。

給 `app/assets/css/main.css`（w4:p4 擁有此檔，以下為建議內容）：

```css
@import 'tailwindcss';
@import '@nuxt/ui';

@theme {
  /* 中性：暖軸 */
  --color-paper-50:  #FCFBF8;
  --color-paper-100: #F6F4EE;
  --color-paper-200: #EDEAE3;
  --color-paper-300: #DEDACF;
  --color-paper-400: #8C8477;
  --color-paper-500: #6E675C;
  --color-paper-600: #4A453D;
  --color-paper-700: #3D3830;
  --color-paper-800: #2A2621;
  --color-paper-900: #1C1A17;
  --color-paper-950: #12110F;

  /* 重點：琥珀 */
  --color-amber-50:  #FBF6E4;
  --color-amber-100: #F6EBC2;
  --color-amber-200: #EBD68C;
  --color-amber-300: #DEBE52;
  --color-amber-400: #C9A62B;
  --color-amber-500: #AD8A14;
  --color-amber-600: #8A6800;
  --color-amber-700: #6E5303;
  --color-amber-800: #584209;
  --color-amber-900: #48360C;
  --color-amber-950: #2A1F05;

  /* 字型：拉丁在前、CJK 交給平台（見 §2） */
  --font-sans: 'Inter', 'PingFang TC', 'Noto Sans CJK TC', 'Noto Sans TC',
               'Microsoft JhengHei', 'Source Han Sans TC', sans-serif;
  --font-sans--font-feature-settings: 'cv05', 'ss01';
}

/* ⚠️ 這四行不能省——Nuxt UI 把它們寫死成 #fff */
:root {
  --ui-bg: var(--color-paper-50);
  --ui-text-inverted: var(--color-paper-50);
}
.dark {
  --ui-bg: var(--color-paper-950);
  --ui-text-highlighted: var(--color-paper-50);
}

/* 中文排版基準（見 §2.4） */
:root { --week-start: 0; } /* 0 = 週日起始（台灣慣例） */
body { line-height: 1.75; }
```

`app/app.config.ts`：

```ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'amber', neutral: 'paper' },
  },
})
```

**驗收方式**：做一頁把 `UCard` / `UModal` / `UDropdownMenu` / `UPopover` / `UToast` / `UInput` 各 variant 並排（overlay 類元件常直接吃 `bg-default`），亮暗兩版各截圖，數還有幾處露出純白 `#fff`。

---

## 2. 字體排印

### 2.1 決策：中文不用 webfont

這是本專案最違反直覺、但證據最硬的一個決定。

實測（以本專案自己的 `.data/films.json` 為語料）：

| 方案 | 首屏成本 | 問題 |
|---|---|---|
| Google Fonts 送 Noto Sans TC 單字重 | 首屏 20 片 / **675 KB** | 全套 105 片共 2.14 MB |
| Google Fonts 雙字重 | 首屏 **1,272 KB** | 要第二個字重會**靜默切成 variable**，等於把 100–900 全吃下來 |
| 自架 static 子集（全站 3,141 字） | 單一請求 **≈393 KB** | **UGC 會破字** ← 致命 |
| **平台系統字型** | **0 KB** | 需明確寫出各平台家族名 |

自架子集看起來最漂亮，但實測 David 一人的 169 筆紀錄就用到 599 個不重複字元，其中 **30 個不在 films.json + venues.json 的 3,120 字全站字彙內**——含 `🎉`、`斎`（心斎橋）、`猗窩座`、`儸`、`殞`。這些字正好落在**備註**與**找不到的片名**，也就是硬約束 (1) 與整個情感內容區。子集化會讓它們變成豆腐格。

**所以：中文由平台字型供應，拉丁與數字由 Inter 供應。**

這不是妥協，是決定。PingFang TC、微軟正黑體、Noto Sans CJK TC 都是好字，產品因此在每個平台上看起來都像原生的。省下的 675 KB 直接變成首屏速度。

### 2.2 字型堆疊

```css
--font-sans: 'Inter', 'PingFang TC', 'Noto Sans CJK TC', 'Noto Sans TC',
             'Microsoft JhengHei', 'Source Han Sans TC', sans-serif;
```

三件事必須理解，否則會出現簡體或日文字形：

1. **Inter 排第一是刻意的。** Inter 沒有漢字，所以中文自動落到下一個；但數字與拉丁字母由 Inter 供應，`tabular-nums` 與 `slashed-zero` 才會真的生效——**Noto Sans TC 完全沒有 `tnum`／`pnum`／`lnum`**（實測其 GSUB 只有 aalt ccmp dlig fwid hist hwid liga locl pwid ruby vert vrt2），`tabular-nums` 掛在它身上是空操作。
2. **必須寫出語言專屬家族名。** macOS 上蘋方是三個獨立家族（蘋方-繁 / 蘋方-簡 / 蘋方-港），寫 `"PingFang TC"` 才保證繁體字形。Windows 上若只寫 `sans-serif`，Chromium 在缺語言提示時**一律用簡體字型**（Chromium issue 41188235）。
3. **`nuxt.config.ts` 已有 `htmlAttrs: { lang: 'zh-Hant-TW' }`**，語言提示這一半到位了。缺的只有 CSS 端的家族名。

Inter 與 Noto Sans TC 的視覺尺寸幾乎完全吻合（x-height 0.546 vs 0.543 em、cap-height 0.728 vs 0.733 em，差距 <1%），**不需要 `size-adjust`**。

Inter 走 `@nuxt/fonts`（0.14.0 已隨 `@nuxt/ui` 安裝並自動註冊），只取 Latin 子集。

### 2.3 原文片名要有自己的堆疊

實測 `.data/films.json` 全部 2,669 筆：**344 部（12.9%）的原文片名有字元是 Noto Sans TC 畫不出來的**，共缺 583 字——諺文 312、日本新字體 69、印度系 60、泰文 51、阿拉伯文 37、希伯來文 12。相對地中文片名只有 5 部（0.19%）缺字。

也就是說「中文片名／原文片名」並排的那一行，**每八筆就有一筆會出現字型不一致**。

處理方式是把它變成刻意的層級差，而不是 bug：

```css
.title-original {
  font-family: 'Inter', 'PingFang TC', 'Hiragino Sans', 'Noto Sans JP',
               'Apple SD Gothic Neo', 'Noto Sans KR', 'Noto Sans Thai', sans-serif;
  font-size: 0.8125rem;      /* 13px，明顯小於中文片名 */
  color: var(--ink-2);
}
```

小一級、淡一階，讀者看到的是「附註」而不是「破面」。

### 2.4 度量

| 用途 | 字級 | 行高 | 說明 |
|---|---|---|---|
| 數字英雄（年份、場次） | 48–72px | 1.0 | Inter，`tabular-nums` |
| 頁面標題 | 28px | 1.35 | |
| 區塊標題 | 20px | 1.4 | |
| 片名（卡片） | 16px | 1.45 | |
| 內文 | 16px | **1.75** | 中文需要比拉丁更鬆 |
| 欄位標籤／輔助 | 13px | 1.5 | |
| 微標籤 | 12px | 1.5 | 不用 ALL-CAPS，不用等寬 |

⚠️ **行高一律寫死無單位值，絕不用 `line-height: normal`。** Noto Sans TC 的 hhea 預設行框是 **1.448 em**（asc 1160 / desc −288），Inter 只有 **1.21 em**，且兩者的 OS/2 typo 值又都是 1.000 em 與 hhea 不一致。用 `normal` 會讓同一段落的中英文行框不同，且跨瀏覽器不一致。

**行長**：中文內文 `max-width: 34ch`（≈560px）。不要沿用拉丁設計的 65ch——實算 66 個拉丁字元（Inter 加權平均推進 0.478 em）≈ **31.5 em ≈ 32 個漢字**，寫 65ch 等於一行 65 個漢字，資訊密度爆炸。

### 2.5 中文排版細則

```css
:root {
  line-break: strict;        /* 避免「。、」跑到行首。2020-07 起全瀏覽器可用 */
}
h1, h2, .title-zh {
  font-feature-settings: 'palt' 1;   /* 大標的標點收緊 */
  word-break: auto-phrase;           /* Chrome 119+，漸進增強 */
  text-wrap: balance;                /* Chromium 限 6 行、Firefox 10 行 */
}
```

四條規矩：

1. **絕不動 `letter-spacing`。** baseline-ui 的規則對 CJK 更嚴格——負字距會破壞漢字的 1 em 字身框。要收緊改用 `font-feature-settings: "palt" 1`（Noto Sans TC 的 GPOS 確實有 `palt`／`halt`）。
2. **不要用 `text-wrap: pretty` 解中文標題的孤字。** Firefox 完全不支援（Chrome 130 / Safari 26 才有），且 Chrome 官方說明文完全沒提到 CJK。打底靠 `line-break: strict`。
3. **UI 上不顯示《》。** `《》` 在中文字型裡是 1.000 em 全形，跟漢字同寬，片名頭尾各吃掉一個字寬，在緊湊卡片標題特別明顯。資料層保留，顯示層用字重與顏色區分片名。`text-spacing-trim` 只有 Chrome 123+ 支援，不能依賴。
4. **不要在 HTML 裡手打空格做中英間距。** `text-autospace` 初始值就是 `normal`，Chrome 140 / Safari 18.4 / Firefox 145 起是瀏覽器預設行為。量測欄寬時要預留這個浮動（新舊瀏覽器寬度會不同）。

### 2.6 品牌字

**「影記」二字以 inline SVG 路徑輸出**，不依賴任何字型。兩個字，畫一次，零位元組，且在任何平台上長得一模一樣——這是全站唯一保證一致的字型表現。

---

## 3. 空間與形狀

4px 基準。間距階：`4 8 12 16 24 32 48 64 96`。

**圓角**（刻意小；大圓角會讀成 SaaS 卡片，在台灣還會讀成影城訂票網站）：

```
--radius-chip   2px    分級章、版本標籤
--radius-card   4px    票根卡、面板
--radius-poster 3px    海報（與 Letterboxd 同——2:3 與小圓角是品類慣例，照抄無風險）
--radius-full   9999px 頭像
```

**陰影**：預設 `none`。層級用**邊框與底色**表達，不用投影。唯二例外是 overlay（`UModal` / `UPopover` / `UDrawer`），用 Tailwind 預設 `shadow-lg`。

分隔線 1px `paper-3` / `dark-3`。

**海報格幾何**（品類慣例，直接沿用）：比例 `2/3`，欄寬離散為 `70 / 110 / 150 / 230px`，gap `8px`。

---

## 4. 元件語彙

以下名稱全部來自 Nuxt UI v4.11.0 的實檔清單（124 個元件，已與官網 `/docs/components` 逐項比對一致）。**不在清單上的名字一律要自製。**

### 4.1 直接可用

| 需求 | 元件 | 註記 |
|---|---|---|
| 片名搜尋 | `UCommandPalette` | `searchDelay` debounce、`loading`、group 層級 `ignoreFilter` 交給後端過濾 |
| 表單 | `UForm` + `UFormField` | `validateOnInputDelay` 預設 300ms；每欄有 label/description/help/hint/error 五個文案槽 |
| 日期／時間 | `UInputDate` + `UInputTime` | 值型別是 `@internationalized/date` 的 `CalendarDate` / `Time`，不是 ISO 字串 |
| 影城選單 | `USelectMenu` | 巢狀陣列分組 + `{ type: 'label' }` 群組標題 |
| 手機底部面板 | `UDrawer direction="bottom"` | |
| 桌機側面板 | `USlideover` | |
| 對話框 | `UModal` | |
| 提示 | `UToast` + `UToaster` + `useToast()` | |
| 紀錄表格 | `UTable` | `virtualize`（TanStack Virtual） |
| 空狀態 | `UEmpty` | 只解決清單型空狀態 |
| 骨架 | `USkeleton` | |
| 分頁 | `UPagination` | 無 infinite scroll 元件 |
| 版面 | `UPage*` / `UDashboard*` / `UPageCard` | v4 已把 Pro 全數併入免費 |

### 4.2 必須自製

| 元件 | 為什麼 | 說明 |
|---|---|---|
| **`StatLine`** | v4 **沒有** `UStat` / `UMeter` 或任何同義元件 | 見 §4.4——而且我們刻意不做成 stat tile |
| **`TicketCard`** | 全站主要物件 | 見 §4.3 |
| **`RatingSeal`** | 分級章 | 實色方塊 + 級別字，逐級不同的文字色（§1.4） |
| **`YearStrip`** | 多年度年表 | 見 `SCREENS.md`，兼任年份選擇器 |
| 圖表四種 | ECharts 包裝 | 見 §5 |

### 4.3 TicketCard — 主要物件

一張紀錄的標準呈現。左邊窄帶是日期（票根的撕線位置，但**不畫齒孔、不畫虛線**——結構取自票根，材質不取）。

```
┌────┬──────────────────────────────────────────┬──────┐
│ 7  │ 劇場版 吉伊卡哇 人魚島的秘密              │      │
│ 26 │ ちいかわ 　　　　　　　　  ← 原文，小一級  │ 海報 │
│ 六 │ 林口威秀 (7廳) 2D 16:00 2張 NT$520        │ 選配 │
└────┴──────────────────────────────────────────┴──────┘
```

規則：

- **沒有海報時，海報欄不存在**，卡片自然變寬。不留灰色佔位，不畫破圖圖示。
- meta 行用**開眼式括號量詞串**（`(7廳)`、`2張`），不用中點分隔。
- 票價是 meta 行**最後一項**。被隱藏時它就是不存在，行變短——**絕不渲染 `NT$ ———` 之類的佔位**，那等於公告「這裡有一個價格」。
- `NT$0` 的 16 筆是免費／兌換票，顯示為 **「免費」/「兌換」**，不是 `NT$0`、也不是空白。這必須與「已隱藏」在視覺上不同。
- 日期帶的數字用 Inter `tabular-nums`。

網格模式下同一份資料轉成 2:3 直式：有海報就是海報，沒海報就是**票根卡**——片名設大、國別年份片長排成欄位。兩者是兩種正當的物件，不是一種的降級版。

### 4.4 數字不做成 stat tile

「大數字 + 小標籤 + 一排補充數據 + 漸層」是儀表板的預設長相，也正是要避開的東西。

我們把年度數字排成**一行有量詞的句子**，放在圖表下面當圖說：

```
2026 年看了 24 場、41 張票，花了 NT$9,860
```

數字用 Inter `tabular-nums` 放大到 1.5 倍字級並用 `ink-0`，量詞與連接詞維持內文字級與 `ink-2`。**圖是主角，數字是圖說**——這對得上「看得見自己的軌跡」，也避開了 stat tile 的版面。

---

## 5. 資料視覺化

ECharts 6.1.0 + vue-echarts 8.2.0（皆已安裝，不需新增套件）。

### 5.1 四張圖

| 圖 | 座標系 | 用途 |
|---|---|---|
| **年表 YearStrip** | 自製 SVG／CSS grid | 每年一列 × 53 週。全站簽名，兼任年份選擇器 |
| **年度出席圖** | `calendar` + `heatmap` | 選定年份的 7×53 日格 |
| **時段熱點圖** | `cartesian2d` + `heatmap` | 星期（7 欄）× 時段（縱向），**沿用舊專案的直式方向** |
| **月度趨勢** | `line` | 12 點，可疊多年 |
| **分布（影城／版本／國別）** | 橫式 `bar` | **不用圓餅圖** |

### 5.2 為什麼不用圓餅圖

實測 David 的分布極度傾斜：影城 林口威秀 115/169（**68%**）、國別 日本 98 / 美國 66 / 其餘 5 筆、版本 2D 126 / 4DX 20 / IMAX 7。一個佔 68% 的扇形不傳達任何東西。

而且 375px 下圓餅圖每個標籤只分到約 90px，`林口MITSUI OUTLET PARK威秀影城` 這種長度會被截到無法辨識。

**橫式長條 + `label` 置於 `insideTopLeft` + `width` 給滿容器寬**，實測 375px 下五個長片名全數完整顯示。長尾收成「其他 N 家」。

影城分布另外用一句話開頭，因為那才是真正的洞察：

> 你的主場是**林口威秀**，68% 的場次在這裡。

### 5.3 ECharts 硬限制（違反會靜默壞掉）

以下每一條都是實測，不是文件推測：

1. **絕不把 CSS 變數丟給 ECharts。** zrender 的顏色解析器不支援 `oklch()` / `color-mix()` / `var()`，而 Nuxt UI 4 的 token 正是 oklch。連續型 visualMap 會印 `"'var(--c-lo)' is an illegal color, fallback to '#000000'"` 並真的渲染成黑色。**在 JS 端先解析成 hex 再傳入**——所以本文的圖表色階全部以 hex 定義，不進 oklch token 系統。
2. **日曆的格子間距沒有專屬選項**，由 `calendar.itemStyle.borderWidth` 控制（`borderColor` 設成卡片底色）。要 2–3px 縫隙就設 `borderWidth: 3`。
3. **日曆只能設 `left` 與 `top`。** 同時設 `right` / `width` 會覆蓋 `cellSize` 的寬度分量，格子靜默變形成 6.9×14 的長條。這是最容易踩且錯了不會報錯的雷。
4. **`cellSize: 'auto'` 不是手機的解答**——寬高各自拉滿容器，375×180 下方格變成 6.90×23.40 的長條，直接破壞方格語彙。
5. **整年日曆固定 53 欄 × 7 列，總寬 = 53 × cellSize。** `cellSize:14` → 742px、`11` → 583px。**ECharts 自己完全不提供橫向捲動**，375px 手機上只會裁切。手機唯一乾淨解是固定像素寬（720–780px）放進外層 `overflow-x: auto`，並預先捲到最右（最近一週），兩側加漸層遮罩與捲動提示。
6. **`cartesian2d` heatmap 完全不畫空格**（實測 3 筆資料的 7×6 格盤只產生 5 個 path）。時段熱點圖必須把 7×N 全格補上 `value: 0`，否則「從未」的格子直接消失、露出卡片底色，看起來像破洞。`calendar` 則相反，會自動替區間內每天畫底色格。
7. **`cartesian2d` heatmap 兩軸都必須 `type:'category'` 且 `boundaryGap: true`**，違反會在 dev build 直接 throw。時段軸必須是字串桶，不能用 value 軸做連續小時。`visualMap` 是必需元件（可 `show:false`）。
8. **NaN / null 整格跳過。** 「零次」餵 `0`，「無資料」才留空。
9. 深淺色切換用 ECharts 6 的 `instance.setTheme()`（vue-echarts 8 的 `:theme` prop 已接上），**不需要 dispose 重建**——網路上大量 v5 教學的結論在此不適用。但 `visualMap.pieces` 與明確的 `itemStyle.color` 不受 theme 影響，必須另外重算 option。

### 5.4 出席圖的分段

```js
visualMap: {
  type: 'piecewise', show: false,
  pieces: [
    { value: 0,        color: '#EDEAE3' },  // 沒去（中性，不屬於色階）
    { min: 1, max: 1,  color: '#B3AB9B' },  // 去了
    { min: 2,          color: '#171512' },  // 兩場以上（雙片連映）
  ],
}
```

只有三階，因為資料只支援三階（161 天 1 場、4 天 2 場、0 天 ≥3 場）。**不要為了「以後可能會有」而預留永遠不會被畫出來的色階。**

`calendar.dayLabel.firstDay: 0`（週日起始，台灣慣例），`nameMap: 'ZH'`。舊專案是「因為 dayjs 的 zh-tw locale 沒定義 weekStart 而退回 0」——新版要**顯式寫出來**，否則哪天有人補上 `weekStart:1`，整張圖會無聲位移。

⚠️ 週起始日對時段熱點圖有取捨：週日起始（台灣慣例）會讓 `日` 在頭、`五六` 在尾，而 David 的資料顯示週五六日晚間是絕對熱區——週一起始能讓週末三列相鄰、洞察更明顯。**兩張圖必須一致**，這裡選台灣慣例的週日起始，並在熱點圖用較重的列標籤字重讓週末成組。以 `--week-start` token 控制，改一行即可翻轉。

### 5.5 從舊專案繼承什麼

舊 `../log` 是「兩套技術、一套配色」：貢獻圖與熱點圖是手寫 D3 v7 直接操作 SVG，折線／長條／圓餅是 Chart.js 4.5.1。

**繼承**：

- **格子節距** 15px 方塊 + 2px 間距（節距 17）。15px 對手指剛好，是觸控友善的尺寸，保留。
- **時段熱點圖的直式方向**（星期在橫軸 7 欄、小時在縱軸）。這在手機上比常見的橫式 7×24 合理得多——7 欄天生塞得進 375px，永遠不需要橫向捲動。這是舊碼裡最有價值的判斷。
- **「點格子 → 從底部滑出當日／當時段片單」的互動語彙**，含 90% 高度的 bottom sheet。這是這個產品最有價值的互動，原樣保留（改用 `UDrawer direction="bottom"`）。
- **標題字串格式**：`2024/03/15 (週五)`、`週三 14:00~15:00`。

**丟掉**：

- **GitHub 2013 的綠色階** `#eee → #d6e685 → #8cc665 → #44a340 → #1e6823`（熱點圖再往下接 `#18541c / #134016 / #0d2d0f`）。改用墨階。後三階深綠在暗底上幾乎會消失，整條無法支援深色模式。
- **白色 2px 描邊當格線**。在任何非白底（卡片底、深色模式）會變成刺眼白格線。改用真正的 gap。
- **硬編碼的 930×150 SVG 尺寸**。改由「欄數 × 節距 + padding」算出。
- **月份標籤用 4.333 週/月近似值定位**，會逐月漂移。改成對齊該月第一天所在欄。
- **`.attr('title', …)`**——那是加在 `<rect>` 上的 HTML title *屬性*，SVG 需要的是 `<title>` 子元素，所以舊站的貢獻圖**其實沒有任何 tooltip**。
- **d3 與 Chart.js 兩套 runtime**。新站統一 ECharts（年表除外，它是純 SVG／CSS grid，不需要圖表庫）。

**補上**（純增益，不違背舊語彙）：色階圖例、hover/focus tooltip、鍵盤可達性（舊碼的 `rect` 沒有 `role` / `tabindex` / `aria-label`，螢幕閱讀器完全取不到資料）。

### 5.6 可存取性

ECharts heatmap **不支援 decal**，所以色盲友善完全靠單色相明度階（§1.3 已驗算單調）。此外每張圖必須提供：

- `aria-label` 描述圖表在說什麼
- 一份**資料表 fallback**（`<details>` 收合的 `UTable`），螢幕閱讀器與「我就是想看數字」的使用者共用
- 格子可 focus，`Enter` 等同點擊

---

## 6. 動態

**只有一個編排過的時刻**：存檔成功後，新的紀錄列「印」進帳本——由上而下 180ms 的 reveal，只動 `transform` 與 `opacity`。像熱感應印表機吐出票根，而且它回應的是使用者剛完成的動作、顯示了什麼改變。

其餘一律沒有進場動畫。沒有逐區塊的 fade-and-slide-up，沒有每張卡片的 hover transition。

- 互動回饋 ≤ 200ms，`ease-out`
- 只動 compositor 屬性（`transform` / `opacity`）
- 尊重 `prefers-reduced-motion`：改為直接出現
- 不對大面積 `blur()` / `backdrop-filter` 做動畫

---

## 7. 明暗模式

由 `@nuxt/ui` 自動註冊的 `@nuxtjs/color-mode` 以 `.dark` / `.light` class 驅動（`classSuffix` 被強制設為空字串）。

- 亮色是**紙**：`paper-50` 底、`ink-0` 字。記錄的情境是散場後的明亮商場走道。
- 暗色是**放映廳**：`paper-950` 底、`dim-0` 字。看統計的情境常是晚上。

墨階在暗色模式**整條反轉**（紙色在高值端），不是把亮色階調暗——實測舊專案那三階深綠 `#18541c / #134016 / #0d2d0f` 在暗底上會直接消失。

琥珀在兩個模式維持同一 hue，只換明度端點：亮色用 `amber-600`，暗色用 `amber-400`。

---

## 8. 文案

繁體中文。主動語態。句子大小寫（中文本來就沒有大小寫——這正好讓我們自然避開 ALL-CAPS 眉標的陷阱）。

| 情境 | 寫 | 不寫 |
|---|---|---|
| 送出紀錄 | 記下來 | 送出、提交 |
| 完成 toast | 記好了 | 成功！ |
| 搜尋無結果 | 找不到這部片？自己新增 | 查無資料、沒有結果 |
| 全新帳號 | 記下你的第一場 | 尚無紀錄 |
| 票價隱私 | 公開票價 | 啟用、開啟票價功能 |
| 刪除確認 | 刪掉這筆 | 確定要刪除嗎？ |

三條規矩：

1. 動作名稱從頭到尾一致——按鈕寫「記下來」，toast 就寫「記好了」，不會變成「已儲存」。
2. 錯誤說發生了什麼跟怎麼修，不道歉、不模糊。
3. 空狀態是邀請，給一個明確的下一步動作。

---

## 9. 法遵元件（不是禮貌，是授權生效要件）

政府資料開放授權條款第 1 版：「未盡顯名標示義務者，**視為自始未取得授權**」。

`AttributionFooter` 出現在每一個公開頁：

- 政府開放資料顯名聲明（文化部影視及流行音樂產業局「電影片分級及相關資訊」、「全國電影院資料」）
- `This product uses the TMDB API but is not endorsed or certified by TMDB.` + TMDB logo
- **TMDB logo 的視覺份量必須小於本站標誌**（TMDB 條款要求）
- 連向 `/legal/terms`、`/legal/privacy`、`/legal/copyright`、`/legal/dmca`

海報一律熱連結 `image.tmdb.org`，**絕不自建海報代理**——那等同轉存。

---

## 10. 品質底線

- 響應式到 375px；`h-dvh` 不用 `h-screen`；固定元素尊重 `safe-area-inset`
- 每個互動元件有可見的 focus ring（琥珀，2px offset）
- 只有圖示的按鈕一定有 `aria-label`
- 破壞性動作用 `UModal` 二次確認
- 載入態用結構性骨架（`USkeleton`），不用轉圈
- 錯誤顯示在動作發生的地方旁邊
- 寬內容（表格、圖表、程式碼）在自己的 `overflow-x: auto` 容器內捲動，**頁面 body 永遠不橫向捲動**
- 固定的 z-index 階，不用任意值
- 數字一律 `tabular-nums`（由 Inter 供應，見 §2.2）
