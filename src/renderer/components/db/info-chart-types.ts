/** 数据库信息页图形化看板的共享类型（主进程 conn:info 下发 → InfoCharts 渲染） */
export interface InfoKpi {
  label: string
  value: string
  sub?: string
  tone?: 'ok' | 'warn' | 'bad'
  /** 采集来源 key：磁贴自带 data-src，悬停显示该指标的来源而不是整页的 */
  src?: string
}

export interface InfoChartItem {
  label: string
  value: number
  /** 悬停补充说明，如「12.4 GB / 30 GB」「123 张表」 */
  hint?: string
}

export interface InfoChart {
  id: string
  title: string
  /** gauge=单值占比环 / donut=分类占比环 / bars=横向条形 / stack=单条堆叠 */
  kind: 'gauge' | 'donut' | 'bars' | 'stack'
  unit?: string
  /** gauge 用：value / total；渲染层据此算百分比 */
  value?: number
  total?: number
  caption?: string
  note?: string
  /** 与同组 sections/tables 在同一张卡片内展示（图与明细必须挨着，不单独成区） */
  group?: string
  items: InfoChartItem[]
}

/** 明细：键值区（服务器、会话、内存等） */
export interface InfoSection {
  title: string
  group?: string
  rows: { k: string; v: string }[]
}

/** 明细：表格（表空间、对象统计、容量 TOP N 等） */
export interface InfoTable {
  title: string
  group?: string
  columns: string[]
  rows: any[][]
}

/** 主题块：一个主题的图表 + 明细（同框展示，图不再单独成区） */
export interface InfoBlock {
  key: string
  title: string
  charts: InfoChart[]
  sections: InfoSection[]
  tables: InfoTable[]
  /** 单图 + 单明细 → 左右并排 */
  split: boolean
  /** 明细多于一条 → 各条保留自己的小标题 */
  multi: boolean
}
