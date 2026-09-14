import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

/**
 * **每一個頁面元件的 `<template>` 只能有一個根節點。**
 *
 * ── 這條守的是什麼（2026-09-14 David 實跑抓到）────────────────────────────
 * `app.pageTransition`（換頁淡入，DS §6 第二個編排過的時刻）的 `<Transition>`
 * hooks 掛在頁面元件 render 出來的**根 vnode** 上。根不是單一元素時：
 *
 *   · **多根（Fragment）** ⇒ Nuxt 在換頁時噴
 *     `[NUXT_E4004] … does not have a single root node and will cause errors
 *      when navigating between routes.`，而且淡入整個不生效。
 *   · **根是 `v-if`** ⇒ 條件為 falsy 時 render 成註解節點，淡入對它是 no-op
 *     ⇒ 那一次換頁變成硬切。這一種 **Vue 完全不會警告**（`isElementRoot()`
 *     明文放行 `Comment`，理由是「可能只是 v-if 分支切換」）。
 *
 * ── ★ 為什麼需要一支測試，而不是「大家記得就好」────────────────────────
 * 真正踩到的方式毫無戒心：`<template>` 的**直接子註解自己就是一個根節點**。
 * 2026-09-14 為了修「根不能是 v-if」而動的那次改動，把解釋這條規則的說明註解
 * 放在了根元素**上方**——於是修補本身製造出同一個病，而 `pnpm typecheck` /
 * `lint` / `test` / `build` **四個全綠**，只有真的在瀏覽器裡換一次頁才會看到。
 *
 * ⇒ 說明註解只能放在根元素**裡面**。這支就是釘住那件事的東西。
 *
 * ── 涵蓋範圍 ──────────────────────────────────────────────────────────
 * `app/pages/**` 的每一個 `.vue`，**包含 `-` 前綴的那些**。`-` 前綴在 Nuxt 4 不會
 * 變成路由，但它們是頁面的根元件（`-StaffGate.vue` 就是 `/admin/*` 四頁的根），
 * 而 `<Transition>` 看的是**整條根節點鏈 render 出來的東西**，不是頁面檔那一層。
 * 漏掉它們的話，照字面掃頁面根的普查會給出一個乾淨的假象。
 */

const PAGES_DIR = fileURLToPath(new URL('../app/pages', import.meta.url))

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory())
      return vueFiles(path)
    return path.endsWith('.vue') ? [path] : []
  })
}

/**
 * `<template>` 的根子節點，濾掉排版用的空白。
 *
 * ⚠️ NodeTypes 的數字別憑記憶寫：`ELEMENT = 1`、`TEXT = 2`、`COMMENT = 3`、
 *    `INTERPOLATION = 5`（`@vue/compiler-core`）。COMMENT 是 3 不是 5——
 *    寫錯的話註解會被當成插值濾掉，這支測試就變成永遠綠的裝飾品。
 */
function rootNodes(src: string, filename: string) {
  const ast = parse(src, { filename }).descriptor.template?.ast
  return (ast?.children ?? []).filter((node) => {
    if (node.type === 2)
      return node.content.trim().length > 0 // 純空白不算節點
    return true
  })
}

/** 診斷訊息用：`<div>` / `註解` / `文字`。 */
function describeNode(node: { type: number, tag?: string }): string {
  if (node.type === 1)
    return `<${node.tag}>`
  if (node.type === 3)
    return '註解'
  return `type ${node.type}`
}

describe('頁面根節點（換頁淡入的前提）', () => {
  const files = vueFiles(PAGES_DIR)

  it('掃得到頁面檔（避免整支測試空轉成假綠燈）', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it.each(files.map(f => [f.slice(PAGES_DIR.length + 1), f] as const))(
    '%s 的 template 只有一個根節點',
    (rel, path) => {
      const src = readFileSync(path, 'utf8')
      const roots = rootNodes(src, path)
      // `redirect` 型的頁面（只有 definePageMeta）沒有 template，不在這條規矩內。
      if (!src.includes('<template>'))
        return
      expect(
        roots.map(describeNode),
        `${rel} 有 ${roots.length} 個根節點。說明註解要放在根元素裡面，不是上面。`,
      ).toHaveLength(1)
      expect(roots[0]?.type, `${rel} 的根不是元素`).toBe(1)
    },
  )

  it.each(files.map(f => [f.slice(PAGES_DIR.length + 1), f] as const))(
    '%s 的根元素沒有 v-if（falsy 時會 render 成註解節點，Vue 不會警告）',
    (rel, path) => {
      const src = readFileSync(path, 'utf8')
      if (!src.includes('<template>'))
        return
      const root = rootNodes(src, path)[0]
      if (!root || root.type !== 1)
        return
      const directives = root.props
        .filter(p => p.type === 7)
        .map(p => (p as { name: string }).name)
      expect(directives, `${rel} 的根元素帶了 v-if/v-else`).not.toContain('if')
      expect(directives, `${rel} 的根元素帶了 v-else`).not.toContain('else')
    },
  )
})
