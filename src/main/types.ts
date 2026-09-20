export type ConnType = 'oracle' | 'mysql' | 'ob-mysql' | 'ob-oracle'

/** plan = 计划模式（只读探索 + 输出计划等批准） */
export type PermissionMode = 'plan' | 'readonly' | 'confirm' | 'session' | 'yolo'

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high'

export const MODE_LABELS: Record<PermissionMode, string> = {
  plan: '计划',
  readonly: '只读',
  confirm: '确认执行',
  session: '会话放开',
  yolo: '完全放开'
}

export interface ConnProfile {
  id: string
  name: string
  type: ConnType
  host: string
  port: number
  /** Oracle: 服务名（如 orcl）；MySQL/OB: 数据库名 */
  serviceName?: string
  database?: string
  user: string
  role: 'readonly' | 'admin'
  /** Oracle 11g thick 模式需要 Instant Client 目录（留空则用全局设置） */
  instantClientDir?: string
  /** 可选：关联到某个项目（不关联 = 全局连接，任何会话可用） */
  projectId?: string | null
}

export interface ProviderConfig {
  id: string
  name: string
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  apiKey: string
  model: string
  /** 厂商预设 id（custom = 手动填写） */
  vendor?: string
  /** 思考级别（按厂商协议转换后注入请求） */
  effort?: ThinkingEffort
  /** 界面展示用：是否已存 Key（真实值不下发渲染层） */
  hasKey?: boolean
}

/** 项目挂载的 SSH 远程服务器（密码认证，密码经 DPAPI 加密存 secrets） */
export interface SshServer {
  id: string
  name: string
  host: string
  port: number
  user: string
  /** 生产/测试等标记，注入提示词提醒模型 */
  tag?: string
  note?: string
}

export interface ProjectConfig {
  id: string
  name: string
  rootPath: string
  /** 项目说明（注入系统提示词，如注意事项） */
  description?: string
  /** 挂载的 SSH 服务器 */
  servers?: SshServer[]
}

export interface AppConfig {
  connections: ConnProfile[]
  providers: ProviderConfig[]
  activeProviderId: string | null
  /** 新会话的默认权限模式（各会话独立设置自己的模式） */
  mode: PermissionMode
  /** 项目列表 */
  projects: ProjectConfig[]
  /** 技能启用状态（技能本体在 userData/skills/） */
  skillsEnabled: Record<string, boolean>
  /** 全局默认 Oracle Instant Client 目录 */
  instantClientDir?: string
  /** 界面主题 */
  theme?: 'dark' | 'light'
}

export interface ToolCall {
  id: string
  name: string
  args: string
}

export interface ChatMsg {
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  /** Anthropic 协议思考块原文与签名：开思考的工具轮次回传历史时需原样携带，否则 API 拒绝 */
  thinking?: string
  thinkingSig?: string
}

export interface QueryResult {
  columns: string[]
  rows: any[][]
  rowCount: number
  ms: number
  truncated?: boolean
}

export interface TableInfo {
  name: string
  type: string
}

export interface DbAdapter {
  kind: string
  connect(): Promise<void>
  test(): Promise<string>
  close(): Promise<void>
  listSchemas(): Promise<string[]>
  listTables(schema: string): Promise<TableInfo[]>
  describeTable(schema: string, table: string): Promise<{ columns: { name: string; type: string; nullable: string }[]; approxRows?: number }>
  getDdl(schema: string, table: string): Promise<string>
  query(sql: string, maxRows: number, timeoutMs: number): Promise<QueryResult>
  /** Oracle 类适配器需要：写操作后显式提交 */
  commit?(): Promise<void>
}
