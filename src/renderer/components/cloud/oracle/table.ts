/** OraTable 的列定义（单独放 .ts：SFC 的 script setup 不允许 export） */
export interface OraCol {
  key: string
  label: string
  type?: 'text' | 'num' | 'pct' | 'size' | 'mono' | 'state' | 'time' | 'bar'
  align?: 'left' | 'right'
  width?: string
  hint?: string
  /** false = 该列不参与排序（如 SQL 文本） */
  sort?: boolean
}
