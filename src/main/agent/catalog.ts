import type { ThinkingEffort } from '../types'

// 大厂商模型预设目录：新增/编辑提供商时直接选择，无需手填 URL 和模型名。
// 模型清单会随厂商更新而过时——所有字段仍可手动修改（vendor=custom）。

export interface ModelPreset {
  id: string
  label: string
  note?: string
  /** 上下文窗口（K tokens），用于会话上下文占用显示；厂商更新后可在提供商表单覆盖 */
  contextK?: number
}

export interface VendorPreset {
  id: string
  label: string
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  /** 思考级别注入方式 */
  thinkingStyle: 'openai_effort' | 'glm_thinking' | 'qwen_thinking' | 'anthropic_budget' | 'none'
  /** 表单里是否允许改 Base URL：本地桥/中转站的端口会变，不能写死 */
  editableBaseUrl?: boolean
  /** 选中该厂商时在表单里显示的一行说明（安装前置、端口、注意事项） */
  note?: string
  models: ModelPreset[]
}

export const VENDOR_CATALOG: VendorPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    thinkingStyle: 'none',
    models: [
      { id: 'deepseek-chat', label: 'deepseek-chat', note: '通用（官方别名，自动指向最新 V 系列）', contextK: 128 },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner', note: '深度思考（别名，自动指向最新 R 系列）', contextK: 128 }
    ]
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    thinkingStyle: 'glm_thinking',
    models: [
      { id: 'glm-5.3', label: 'GLM-5.3', note: '旗舰，Agent/工程能力强', contextK: 200 },
      { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', note: '多模态/低成本/1M 上下文', contextK: 1000 },
      { id: 'glm-5.3-flashx', label: 'GLM-5.3-FlashX', note: 'Flash 极速版', contextK: 128 },
      { id: 'glm-5.2', label: 'GLM-5.2', note: '上代旗舰', contextK: 128 }
    ]
  },
  {
    id: 'qwen',
    label: '阿里通义千问（百炼兼容模式）',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    thinkingStyle: 'qwen_thinking',
    models: [
      { id: 'qwen3.8-max', label: 'qwen3.8-max', contextK: 128 },
      { id: 'qwen3.7-plus', label: 'qwen3.7-plus', contextK: 128 },
      { id: 'qwen3.8-flash', label: 'qwen3.8-flash', note: '高速/低成本', contextK: 1000 }
    ]
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    thinkingStyle: 'none',
    models: [
      { id: 'kimi-k2-turbo-preview', label: 'Kimi-K2-Turbo', contextK: 256 },
      { id: 'kimi-k2-preview', label: 'Kimi-K2', contextK: 256 }
    ]
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    thinkingStyle: 'openai_effort',
    models: [
      { id: 'gpt-5', label: 'GPT-5', contextK: 400 },
      { id: 'gpt-5-mini', label: 'GPT-5-mini', contextK: 400 },
      { id: 'gpt-4.1', label: 'GPT-4.1', contextK: 1000 }
    ]
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    thinkingStyle: 'anthropic_budget',
    models: [
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', contextK: 200 },
      { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', contextK: 200 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextK: 200 }
    ]
  },
  {
    id: 'zhipu-coding',
    label: '智谱 GLM Coding Plan（ZCode 同款，Anthropic 协议）',
    protocol: 'anthropic',
    baseUrl: 'https://api.z.ai/api/anthropic',
    thinkingStyle: 'anthropic_budget',
    models: [
      { id: 'glm-5.3', label: 'GLM-5.3', note: '实测 Coding Plan 通道仅含此型号；flash/air 系列不在该通道', contextK: 200 }
    ]
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy（本地桥）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8790/v1',
    thinkingStyle: 'none',
    editableBaseUrl: true,
    // WorkBuddy 的模型走它自家私有协议（copilot.tencent.com + 签名头），凭据还是 App 运行时密钥
    // 加密的 AES-GCM 信封 —— 客户端里复刻这套等于每月跟着上游改一次。这里只对接社区本地桥：
    // 由桥负责登录态与协议转换，本客户端说标准 OpenAI 协议。
    note:
      '桥随 SQLPilot 一起分发，不用另装东西：点下面「启动」即可（默认 127.0.0.1:8790，被占用自动顺延）。' +
      'WorkBuddy 客户端需要已登录，没登录点「登录 WorkBuddy」。API Key 可以留空——主进程会自动注入本地令牌；' +
      '模型名点「拉取模型」按你账号的实际目录读取（会带上积分倍率与上下文窗口）。',
    models: [
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek-V4.1-Flash', note: '快、便宜（x0.11）', contextK: 300 },
      { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro', note: '代码/推理强（x0.51）', contextK: 300 },
      { id: 'glm-5.3', label: 'GLM-5.3', note: '工程/中文写作（x0.69）', contextK: 300 }
    ]
  },
  {
    id: 'custom',
    label: '自定义（手填 URL）',
    protocol: 'openai',
    baseUrl: '',
    thinkingStyle: 'none',
    models: []
  }
]

/** 把统一的思考级别换算成各厂商请求体参数（OpenAI 兼容协议侧） */
export function applyOpenAiThinking(body: any, style: VendorPreset['thinkingStyle'], effort: ThinkingEffort | undefined): void {
  if (!effort || effort === 'off' || style === 'none') return
  if (style === 'openai_effort') {
    body.reasoning_effort = effort
  } else if (style === 'glm_thinking') {
    body.thinking = { type: 'enabled' }
  } else if (style === 'qwen_thinking') {
    body.enable_thinking = true
  }
}

/** Anthropic 侧：返回 thinking 配置；null 表示不思考 */
export function anthropicThinking(style: VendorPreset['thinkingStyle'], effort: ThinkingEffort | undefined): { type: 'enabled'; budget_tokens: number } | null {
  if (!effort || effort === 'off' || style !== 'anthropic_budget') return null
  const budget = effort === 'low' ? 2048 : effort === 'medium' ? 8192 : 16384
  return { type: 'enabled', budget_tokens: budget }
}

export function findVendor(id: string | undefined): VendorPreset {
  return VENDOR_CATALOG.find((v) => v.id === id) || VENDOR_CATALOG[VENDOR_CATALOG.length - 1]
}

/** 会话上下文窗口（K tokens）：提供商覆盖 > 厂商预设匹配 > 默认 128K */
export function modelContextK(provider: { vendor?: string; model: string; contextK?: number }): number {
  if (provider.contextK && provider.contextK > 0) return provider.contextK
  const v = findVendor(provider.vendor)
  return v.models.find((m) => m.id === provider.model)?.contextK || 128
}
