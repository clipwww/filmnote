/**
 * `StatLine` 的資料形狀（`DESIGN_SYSTEM §4.2` / `§4.4`）。
 * 型別放在 utils 而不是 SFC 裡，因為 `<script setup>` 不能匯出型別。
 */
export interface StatSegment {
  /** 數字前面的引導文字。內文字級、`text-muted`。 */
  prefix?: string
  /** 數字本體。放大 1.5 倍、`tabular-nums`、最高對比。 */
  value: string
  /** 緊接在數字後面的量詞與連接詞。內文字級、`text-muted`。 */
  suffix?: string
}
