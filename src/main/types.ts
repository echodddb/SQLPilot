import type { MaskingConfig } from './masking'
export type ConnType = 'oracle' | 'mysql' | 'ob-mysql' | 'ob-oracle'

export type ObConnectMode = 'obproxy' | 'observer'

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
  /** OceanBase MySQL 租户：生产默认走 OBProxy，排障可直连 Observer */
  obConnectMode?: ObConnectMode
  /** OceanBase 账号身份拆分存储；兼容旧的 user@tenant#cluster 完整写法 */
  obTenant?: string
  obCluster?: string
  /** MySQL/OceanBase SSL；CA 用于服务端证书校验 */
  ssl?: boolean
  sslCa?: string
  sslVerifyServer?: boolean
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
  /** 上下文窗口（K tokens）：会话上下文占用显示用；留空用厂商预设 */
  contextK?: number
}

/**
 * 终端字符编码。远端 locale 不是 UTF-8 时（老版 CentOS / AIX / 国产化系统常见 GBK），
 * 主进程按此编解码，xterm 始终吃字符串——否则中文全是乱码。
 */
export type TermEncoding = 'utf-8' | 'gbk' | 'gb18030' | 'big5' | 'latin1'

/** 终端配色方案（schemes.ts 里定义具体色板；这里只存 id） */
export type TermScheme = 'follow' | 'github' | 'mobaxterm' | 'solarized-light' | 'monokai' | 'dracula'

export interface TermPrefs {
  fontSize: number
  fontFamily: string
  lineHeight: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  scheme: TermScheme
  /** 回滚缓冲行数 */
  scrollback: number
  /** 选中即复制（MobaXterm/XShell 习惯） */
  copyOnSelect: boolean
  /** 右键直接粘贴（否则弹菜单） */
  rightClickPaste: boolean
  /** 粘贴多行命令时二次确认，防误执行 */
  confirmMultilinePaste: boolean
  encoding: TermEncoding
}

/** 项目挂载的 SSH 远程服务器（密码/私钥认证，口令经 DPAPI 加密存 secrets） */
export interface SshServer {
  id: string
  name: string
  host: string
  port: number
  user: string
  /** 生产/测试等标记，注入提示词提醒模型 */
  tag?: string
  note?: string
  /** 会话分组（侧栏按组分节；空 = 未分组） */
  group?: string
  /** 认证方式：password = 密码；key = 私钥文件 */
  auth?: 'password' | 'key'
  /** 私钥文件绝对路径（auth=key 时必填；支持 OpenSSH / PEM） */
  keyPath?: string
  /** 设备/系统编码，默认 utf-8 */
  encoding?: TermEncoding
  /** SFTP 文件名编码（与终端编码分开：有些机器 locale 是 UTF-8 但文件名是 GBK） */
  fileEncoding?: TermEncoding
  /** 登录后自动进入的目录 */
  cwd?: string
  /** 该会话的配色方案（缺省跟随全局） */
  scheme?: TermScheme
  /** 该会话的字号（缺省跟随全局） */
  fontSize?: number
  /**
   * 标签标识色（hex，如 #f85149）。只用于标签栏/会话列表区分，与终端配色 (scheme) 无关。
   * 未设置时按 tag 自动推断（生产红 / 测试黄 / 开发绿）。
   */
  color?: string
  /** 跳板机：先连这台服务器，再从它转发到目标（ProxyJump） */
  jumpId?: string
}

/**
 * 云管平台接入（左侧一级模块「云管平台」）。
 * 目前只接 OceanBase 云平台（OCP）；type 预留，后续加其它云平台时按 type 分发。
 * 密码不落在这里：DPAPI 加密存 secrets.json，键 cloud:<id>。
 */
export interface CloudPlatform {
  id: string
  name: string
  /** ocp = 调 OCP 的 REST 接口；oracle = 直连数据库查 v$ / dba_ 视图 */
  type: 'ocp' | 'oracle'
  /** OCP 平台地址，形如 http://192.168.1.130:8080（可带 context path，如 /ocp）；oracle 类型不用 */
  baseUrl?: string
  /** Oracle 直连：主机 / 端口 / 服务名 */
  host?: string
  port?: number
  serviceName?: string
  username: string
  /** 内网自签证书时跳过 TLS 校验 */
  insecure?: boolean
  /** Oracle 连接身份（SYSDBA/SYSOPER 需要口令文件与 thick 模式） */
  role?: 'default' | 'sysdba' | 'sysoper'
  /** Oracle 11g 等老版本不支持 thin 模式，需要 Instant Client 目录 */
  instantClientDir?: string
}

export interface ProjectConfig {  id: string
  name: string
  rootPath: string
  /** 项目说明（注入系统提示词，如注意事项） */
  description?: string
  /** 引用的全局服务器 id（servers 全局注册后项目只存引用） */
  serverIds?: string[]
  /** @deprecated 旧版内联服务器定义：loadConfig 迁移为全局注册表 + serverIds，仅兼容读取 */
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
  /** 全局 SSH 服务器注册表（项目经 serverIds 引用；密码 DPAPI 加密存 secrets，键 server:<id>） */
  servers: SshServer[]
  /** 终端外观与交互偏好（字体/配色/复制粘贴/编码，全局共享） */
  termPrefs?: TermPrefs
  /** 技能启用状态（技能本体在 userData/skills/） */
  skillsEnabled: Record<string, boolean>
  /** Oracle Instant Client 目录（全局默认，连接 11g 时需要） */
  instantClientDir?: string
  /** 文件脱敏规则（按文件类型独立配置） */
  masking?: MaskingConfig
  /** 云管平台清单（目前仅 OCP） */
  cloudPlatforms?: CloudPlatform[]
  /** 界面主题 */
  theme?: 'dark' | 'light'
  /** 空闲多久自动锁屏（分钟，0 = 关闭；默认 3）——锁屏走开机动画，需手动进入 */
  lockIdleMin?: number
  /** 系统提示词脱敏：不发送连接主机/账号、服务器地址、项目路径等明细（默认开启） */
  maskPromptDetails?: boolean
  /** LLM 发送前预览：每次请求弹窗展示完整内容，用户确认后才发出（默认关闭） */
  previewLlm?: boolean
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
  query(sql: string, maxRows: number, timeoutMs: number, binds?: any): Promise<QueryResult>
  /** Oracle 类适配器需要：写操作后显式提交。返回 false = 连接已被重置、事务未提交 */
  commit?(): Promise<boolean>
  /** 回滚当前事务。返回 false = 连接已被重置（事务已由服务端回滚） */
  rollback?(): Promise<boolean>
  /** 结果网格编辑支持信息：行标识方式与不可更新列（无则该表不可编辑） */
  editSupport?(schema: string, table: string): Promise<EditSupport>
}

export interface EditSupport {
  editable: boolean
  reason?: string
  /** Oracle 用 rowid 定位行；MySQL/OB 用主键（或唯一键）列定位 */
  keyMode: 'rowid' | 'cols'
  keyCols: string[]
  /** 虚拟列/生成列等不可作为 UPDATE 目标的列 */
  readonlyCols: string[]
}
