import { describe, expect, it } from 'vitest'
import { parseInline, parseLegalMarkdown } from '../app/utils/legal-markdown'

describe('parseInline', () => {
  it('拆出粗體與行內碼，其餘留成文字', () => {
    expect(parseInline('請看 **第 4 節** 與 `/legal/dmca`。')).toEqual([
      { type: 'text', value: '請看 ' },
      { type: 'strong', value: '第 4 節' },
      { type: 'text', value: ' 與 ' },
      { type: 'code', value: '/legal/dmca' },
      { type: 'text', value: '。' },
    ])
  })

  it('沒有標記時回一個 text', () => {
    expect(parseInline('純文字')).toEqual([{ type: 'text', value: '純文字' }])
  })
})

describe('parseLegalMarkdown', () => {
  it('h1 當標題、不進正文', () => {
    const doc = parseLegalMarkdown('# 服務條款\n\n## 1. 我們提供什麼\n\n內文。')
    expect(doc.title).toBe('服務條款')
    expect(doc.blocks.filter(b => b.type === 'heading')).toHaveLength(1)
  })

  it('條號長出錨點 id，h3 用連字號', () => {
    const doc = parseLegalMarkdown('## 3. 侵權通知\n\n### 3.1 聯繫窗口\n')
    expect(doc.blocks[0]).toMatchObject({ id: 's3', label: '3', text: '侵權通知', level: 2 })
    expect(doc.blocks[1]).toMatchObject({ id: 's3-1', label: '3.1', text: '聯繫窗口', level: 3 })
  })

  // 拿 label + text 重組會憑空長出一個句點：h2 原文有、h3 原文沒有。
  it('標題顯示用原文那一行，不重組標點', () => {
    const doc = parseLegalMarkdown('## 3. 侵權通知\n\n### 3.1 聯繫窗口\n')
    expect(doc.blocks.map(b => (b.type === 'heading' ? b.display : ''))).toEqual(['3. 侵權通知', '3.1 聯繫窗口'])
  })

  it('目錄只收 h2', () => {
    const doc = parseLegalMarkdown('## 1. 甲\n\n### 1.1 乙\n\n## 2. 丙\n')
    expect(doc.toc.map(t => t.label)).toEqual(['1', '2'])
  })

  // 這一條是整個剖析器存在的理由之一：一般 markdown 用空格接合軟換行，
  // 對中文會多出一個看得見的空隙。
  it('中文軟換行直接相接，不補空格', () => {
    const doc = parseLegalMarkdown('本服務不提供電影片分級查詢、\n不提供影評或評分排行。')
    expect(doc.blocks[0]).toEqual({
      type: 'paragraph',
      inlines: [{ type: 'text', value: '本服務不提供電影片分級查詢、不提供影評或評分排行。' }],
    })
  })

  it('拉丁換行才補空格', () => {
    const doc = parseLegalMarkdown('This product uses\nthe TMDB API.')
    expect(doc.blocks[0]).toEqual({
      type: 'paragraph',
      inlines: [{ type: 'text', value: 'This product uses the TMDB API.' }],
    })
  })

  it('接縫一側是中文就不補空格（中英交界交給 text-autospace）', () => {
    const doc = parseLegalMarkdown('本服務使用\nTMDB 的 API。')
    expect(doc.blocks[0]).toMatchObject({
      inlines: [{ type: 'text', value: '本服務使用TMDB 的 API。' }],
    })
  })

  it('表格：標頭與內容分開，儲存格各自吃行內語法', () => {
    const doc = parseLegalMarkdown('| 情況 | 做法 |\n|---|---|\n| **已比對** | 連結至 TMDB |\n')
    expect(doc.blocks[0]).toEqual({
      type: 'table',
      head: [{ inlines: [{ type: 'text', value: '情況' }] }, { inlines: [{ type: 'text', value: '做法' }] }],
      rows: [[
        { inlines: [{ type: 'strong', value: '已比對' }] },
        { inlines: [{ type: 'text', value: '連結至 TMDB' }] },
      ]],
    })
  })

  it('有序清單的縮排續行併回同一項，不是新的一項', () => {
    const doc = parseLegalMarkdown('1. 立即移除該內容。\n2. 轉送通知給提供者。\n   轉送的內容包含姓名。\n')
    expect(doc.blocks[0]).toMatchObject({
      type: 'list',
      ordered: true,
      items: [
        [{ type: 'text', value: '立即移除該內容。' }],
        [{ type: 'text', value: '轉送通知給提供者。轉送的內容包含姓名。' }],
      ],
    })
  })

  it('無序清單', () => {
    const doc = parseLegalMarkdown('- 「電影片分級及相關資訊」\n- 「全國電影院資料」\n')
    expect(doc.blocks[0]).toMatchObject({ type: 'list', ordered: false, items: [[{ type: 'text', value: '「電影片分級及相關資訊」' }], [{ type: 'text', value: '「全國電影院資料」' }]] })
  })

  it('引言的空白列分段', () => {
    const doc = parseLegalMarkdown('> 第一段。\n>\n> 第二段。\n')
    expect(doc.blocks[0]).toMatchObject({ type: 'quote', paragraphs: [[{ type: 'text', value: '第一段。' }], [{ type: 'text', value: '第二段。' }]] })
  })

  // 以 `|` 開頭卻沒有分隔列的行曾經讓迴圈停在原地。有這一條，回歸會炸在這裡
  // 而不是讓 build 掛住。
  it('看起來像表格但不是的行不會讓剖析器卡住', () => {
    const doc = parseLegalMarkdown('| 這一行沒有分隔列\n\n## 1. 之後還讀得到\n')
    expect(doc.toc).toHaveLength(1)
  })

  it('沒有編號的標題退回序號式 id，不會撞號', () => {
    const doc = parseLegalMarkdown('## 前言\n\n## 附則\n')
    expect(doc.blocks.map(b => (b.type === 'heading' ? b.id : ''))).toEqual(['s-1', 's-2'])
  })
})
