# SQLPilot — DBA 智能助手（v0.1）

桌面端数据库 AI Agent，支持 Oracle 11g/19c、OceanBase 4.x（MySQL 租户）、MySQL。
大模型可配置多家厂商（厂商/型号直接选择，含思考级别），全部数据留在本机。

## 核心概念

- **项目**：选择一个文件夹注册为项目，是会话的工作单元（文件产出、连接关联都以项目为单位）
- **会话**：必须挂在一个项目下发起（点项目名或"＋"选择项目）；权限模式、模型、思考级别均为**会话级**设置，互不影响
- **数据库连接**：可选关联到某个项目（编辑连接时下拉选择）；不关联则为全局连接，所有会话可用
- **权限五档**：计划（agent 也会对复杂任务自动进入）→ 只读 → 确认执行 → 会话放开 → 完全放开
- **技能（Skills）**：Markdown 指令（含名称/描述），新建或导入 .md；启用后模型在任务匹配时自动 read_skill 并遵循执行
- **对象浏览器**：聊天输入框上方 🗃 对象（或侧边栏树里双击表名）→ 打开"数据 / 结构 / DDL"标签页；数据页支持分页、点列头排序、WHERE 过滤、复制为 TSV（可粘贴 Excel）
- **SQL 控制台**：聊天输入框上方 🗄 SQL。单击连接查看数据库信息面板（版本/状态/字符集/会话/存储，Oracle·MySQL·OB 各自适配）；▶/双击新建查询会话窗口（CodeMirror 高亮，Ctrl+Enter 执行，选中可单独执行）；Oracle 信息面板含**活跃会话**交互表——默认 `gv$session where wait_class<>'Idle' and username is not null order by last_call_et` 的常用排障列，列集按当前库 GV$SESSION 真实结构动态获取、可勾选、可刷新
- **事务语义按数据库特性**：Oracle 连接**不自动提交**——控制台 DML 执行后事务保持打开，用工具栏 ✓ 提交 / ↩ 回滚（或直接执行 COMMIT/ROLLBACK）；DDL 在 Oracle 内部隐式提交（数据库自身行为）；MySQL/OB 为原生 autocommit，执行即生效
- **每个查询窗口 = 独立数据库会话**：窗口之间的未提交事务互相隔离（看不到、也不会被别窗口的 COMMIT 误提交），与 Navicat 行为一致；关闭窗口即断开该会话，未提交事务由数据库回滚
- **计划模式**：agent 对涉及写操作/多步骤的任务自动调用 enter_plan_mode 进入规划，输出结构化计划（目标/步骤/SQL/风险/回滚），点"批准并执行"后切换到确认执行模式开工；也可手动强制

## 启动

```bash
npm install    # 首次
npm run dev    # 构建并启动（开发）
# 之后日常启动：
npm run build && npm start
```

要求：Node.js 20+（本机已装 24）。依赖已全部安装完成。

## 打包成 exe 安装包（分发给同事）

```bash
npm run pack:exe
# 产物：release/SQLPilot-Setup-<版本>.exe（NSIS 安装器，支持自选目录）
# 免安装版：release/win-unpacked/ 整目录拷走即可运行
```

注意：安装包未做代码签名，首次运行 SmartScreen 提示"未知发布者"属正常（更多信息 → 仍要运行）。

## 首次使用四步

1. **建项目**：左侧"项目"区 ＋ → 选择文件夹 → 命名（会话必须挂项目）
2. **加连接**：左侧"数据库连接"区 ＋ → 填主机/端口/账号 → 测试连接 → 保存（可选关联到项目）
3. **配模型**：右上角 ⚙ 设置 → 选厂商（DeepSeek/GLM/千问/Kimi/OpenAI/Claude）→ 选型号 → 填 API Key
4. **开会话**：点击项目名即在该项目下新建会话；思考级别在输入框左下角切换

## Oracle 11g 需要 Instant Client

19c 连接走纯协议免客户端；**11g 必须** Instant Client：

1. Oracle 官网下载 **Instant Client for Windows x64 — Basic（完整版）**，选 **19.x 版本**
   （19c 客户端同时兼容 11.2.0.4+ 和 19c，一份即可。注意：**Basic Light 实测会导致 DPI-1047 加载失败**，缺 oraociei19 等组件，请用完整 Basic 包）
2. 解压到如 `D:\instantclient_19_28`
3. ⚙ 设置 → 通用 → 填入目录并保存（或在单个连接里覆盖）

## 权限模式（顶栏）

| 模式 | 行为 |
|---|---|
| 🔒 只读 | 仅 SELECT/EXPLAIN/SHOW 等，写语句直接拦截 |
| ⚙️ 确认执行 | 写操作弹窗确认（仅此次/本会话/拒绝） |
| 🟡 会话放开 | 普通 DML 写确认一次后本会话自动；DDL 与高危（DROP/TRUNCATE 等）仍逐次确认 |
| 🔴 完全放开 | 全部自动执行（红色状态提醒） |

双保险：只读账号的连接即使放开权限也执行不了写操作。所有 SQL 均记录审计日志（设置页可查）。
"本会话均允许"的放行范围按**工具+操作类别+目标**隔离：批准写文件不会顺带放开删文件，批准 DML 不会顺带放开 DDL。

## 技术栈与结构

```
Electron 33 + Vue 3 + TypeScript（esbuild 打包主进程，Vite 打包渲染层）
src/main/          主进程
  db/oracle.ts     Oracle 适配器（11g thick / 19c thin 自适应）
  db/mysql.ts      MySQL / OB MySQL 租户适配器
  db/guard.ts      SQL 语句分类守门
  agent/llm.ts     LLM 双协议（OpenAI 兼容 + Anthropic，SSE 流式）
  agent/loop.ts    Agent 循环 + 系统提示词
  tools/index.ts   工具集（schema 浏览 / 只读查询 / 受控写）
  secrets.ts       密码 DPAPI 加密存储
src/renderer/      界面（连接树 / 对话 / 设置 / 确认弹窗，日/夜双主题）
```

- 数据文件位置：`%APPDATA%/sqlpilot/`（config.json、secrets.json、audit.log、sessions.json；旧版 DBAgent 数据首次启动自动迁移）
  - 数据库密码与大模型 API Key 均经 Windows DPAPI 加密存储，config.json 不落明文
- 对话历史持久化在 sessions.json，重启自动恢复，"清空对话"即删除；单会话历史超过 **200 条**时自动从最近的用户消息边界截断（防止上下文无限膨胀）

- **会话上下文占用**：输入框左下 📊 徽标实时显示"估算 tokens / 模型窗口 · 百分比"（>60% 黄、>80% 红）；悬停看明细：系统提示词+历史估算、最近一次请求的**真实计量**（输入/输出 tokens、**缓存命中与命中率**——厂商返回时）。窗口大小取厂商预设（如 GLM-Flash 1M、Claude 200K），提供商表单可覆盖

## 隐私：发给大模型的内容与两项保护

对话时发送给模型厂商 API 的是：系统提示词 + 全部对话历史（含工具结果：查表数据最多 30 行预览、读到的文件/日志内容、命令输出等）+ 工具定义。**密码与 API Key 永远不进对话内容**（Key 仅在 HTTPS 请求头做认证）。两项可选保护：

- **系统提示词脱敏**（⚙ 设置 → 通用，默认开）：不发送连接的服务名/库名、SSH 服务器的地址与账号、项目本地路径等明细，模型按名称寻址，能力不受影响
- **发送前预览**（⚙ 设置 → 通用，默认关）：开启后每次请求发出前弹窗展示**完整请求体**（就是实际发出去的 JSON），可逐次确认发送/取消；关闭功能即恢复直发

## 开发调试

- 并行起第二个实例（不与正在使用的实例抢单实例锁）：设置环境变量 `SQLPILOT_USER_DATA` 指向独立数据目录后启动，可配合 `--remote-debugging-port=9223` 用 CDP 驱动界面做自动化验证
- F12 开发者工具，Ctrl+R 刷新界面

## 已知边界（M2 计划）

- OB Oracle 租户连接尚未接入（需 pyobclient spike）
- 无内嵌终端（xterm.js + SSH 在 M2）
- 停止任务会在最近的检查点结束：LLM 流式输出立即中断，正在执行的数据库工具会等它跑完（最长 60 秒超时）后停止

## 开源协议

本项目以 [GPL-3.0](LICENSE) 协议开源（Copyright © 2026 echodddb）：可自由使用、修改和分发（含商用），但基于本项目代码的二次分发必须同样以 GPL-3.0 开源并保留版权声明。
