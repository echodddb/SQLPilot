# SQLPilot 发布打包规范（AppLab 应用集市）

> 每次发包前照这份走一遍。规则都是踩过坑之后定下来的，改之前先想清楚代价。

## 0. 一条命令

```bash
python release/pack-applab.py          # 构建 → 打包 → 组装 → 压缩 → 脱敏扫描 → 结构自检
python release/pack-applab.py --skip-build   # 复用已有 dist/，只重打包装包
python release/pack-applab.py --scan-only    # 只扫现有 zip
```

产物：`release/SQLPilot-<version>-applab.zip`，可直接上传。

脚本会**硬性拦截**：源码里有真实内网信息、包内夹带配置文件、缺必备文件、出现非法路径 —— 任何一项不过就直接失败退出，不会产出"看着像好的"包。

---

## 1. 交付形态：目录版，别改

| 形态 | 启动 | 结论 |
|---|---|---|
| **目录版（现在用）** | **1.2s** | ✅ 解压即用 |
| 便携版单文件（portable） | 20–30s | ❌ 每次启动都要把 72MB 运行时解压到临时目录 |
| asar 归档 | — | ❌ 主进程读 `package.json` 报 ENOENT，弹 "JavaScript error occurred in the main process" |

对应配置（`electron-builder.yml`）：

```yaml
asar: false          # 必须是 false，见上面第三条
win:
  target: [nsis]     # 打包时用 --win dir，不产出安装包
```

**不要**再用 `--win portable`，也**不要**加 `-c.npmRebuild=false`（会让 oracledb 的 ABI 与 Electron 不匹配）。

---

## 2. 包结构（硬性）

```
SQLPilot-<version>-applab.zip
├── SQLPilot.exe              主程序
├── *.dll / *.pak / *.bin     运行库（必须和 exe 同目录）
├── package.json              name / version / description（平台读这个）
├── README.md                 使用说明 + 截图
├── CHANGELOG.md
├── locales/                  只留 zh-CN / zh-TW / en-US / en-GB
├── resources/app/            dist + node_modules + resources + vendor
│   └── node_modules/         ⚠ 必须有！asar 关掉后依赖在这里
└── screenshots/              README 引用的图
```

规则：

- **所有文件在根目录**，不套 `applab/` 之类的外层文件夹（平台会自动剥一层）
- 路径分隔符统一 `/`，zip 内出现反斜杠即视为不合格
- 排除 `__MACOSX`、`.DS_Store`、`.versions`
- **绝不能排除 `node_modules`** —— 这是曾经踩过的坑：脚本里为了"干净"排除了它，结果包内没有依赖，启动就报 `package.json` ENOENT

---

## 3. 版本与元数据

三处必须一致，脚本从根 `package.json` 自动同步：

1. `package.json` → `version`（也是 zip 文件名、exe 的资源版本）
2. `package-lock.json` 顶层两处 `version`
3. `release/templates/CHANGELOG.md` 要有对应版本的条目

发新版时：

```bash
# 1 改版本
#    package.json / package-lock.json → version
# 2 写 CHANGELOG 条目
# 3 打包
python release/pack-applab.py
```

`release/templates/package.json` 由脚本动态生成，不用手改。

---

## 4. 脱敏（最容易翻车的一环）

### 禁止出现在包里的内容

- 内网 IP / 具体网段（真实环境里出现过的任何网段，文档与示例统一用 192.168.1.x）
- 真实库名、schema、表空间、数据文件名（具体清单见 `release/pack-applab.py` 的 `SENSITIVE` 规则）
- 真实账号、主机名、实例名
- 行业/业务背景词（能反推出客户所属行业的词）
- 任何 `config.json` / `secrets.json` / `sessions.json` / `audit.log`

### 三个高发位置

1. **输入框 placeholder 与报错文案** —— 开发时图省事填了真实地址
2. **代码注释** —— 举例用了真实环境
3. **README 截图** —— 界面里带着真实会话内容

### 截图必须用空数据目录拍

```bash
SQLPILOT_USER_DATA=<空目录> npx electron . --remote-debugging-port=9390
```

否则会把你本机的项目、会话、SQL 全拍进去。截图放在 `release/templates/screenshots/`，同名覆盖即可。

### 加新关键词

改 `release/pack-applab.py` 里的 `SENSITIVE` 列表，同步本文档的禁止清单。

---

## 5. 打包命令（脚本内部用的）

```bash
npx electron-builder --win dir -c.directories.output=release/applab-build
```

产物在 `release/applab-build/win-unpacked/`，脚本会复制到 `release/applab/` 再压缩。

如果 `cpu-features` 编译报错（node-gyp 与 Python 3.13 不兼容）：

```bash
rm -rf node_modules/cpu-features      # ssh2 的可选加速件，删了不影响功能
```

---

## 6. 验证清单（交付前必做，脚本不做这些）

- [ ] 解压到一个**全新的空目录**，双击 `SQLPilot.exe`
- [ ] 窗口出现 < 5 秒；任务管理器里有 4 个 `SQLPilot.exe` 进程
- [ ] 用全新数据目录跑一次，确认首次启动能过（技能播种、配置初始化）

```bash
# 模拟全新用户
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
    SQLPILOT_USER_DATA="E:/tmp/sqlpilot-fresh" \
    SQLPILOT_BOOT_LOG="E:/tmp/boot.log" \
    ./SQLPilot.exe
# 等 10 秒后看 boot.log 是否有 did-finish-load
```

- [ ] 打开设置 → 模型厂商：**已配置列表应为空**（有内容说明打进了本机配置）
- [ ] 云管平台：**平台列表应为空**
- [ ] 包内扫一遍：`python release/pack-applab.py --scan-only` 全绿
- [ ] 记录体积（当前约 104MB；平台若限 100MB 需另议）

---

## 7. 环境坑（血泪史）

### `ELECTRON_RUN_AS_NODE=1`

本机 shell 里有这个变量（宿主环境设的）。它会让**任何 Electron 可执行文件退化成纯 Node**：

- 双击无窗口、进程 38MB 就退出
- `--remote-debugging-port` 报 `bad option`
- 配置不写、技能不播种

**验证 exe 必须** `env -u ELECTRON_RUN_AS_NODE`。曾经因为这个误判"打包产物启动不了"，绕了几十分钟去怀疑签名、asar、原生模块。

### `NODE_OPTIONS` 带 `--require` 钩子

打包应用不支持大多数 NODE_OPTIONS，会打印警告甚至异常。验证时一并 `-u NODE_OPTIONS`。

### 单实例锁残留

反复 `Stop-Process` 会留下 `%APPDATA%\SQLPilot\Singleton*`，导致新实例静默退出。测试前清掉：

```powershell
Get-ChildItem "$env:APPDATA\SQLPilot" -Filter "Singleton*" | Remove-Item -Force
```

### 别用 timeout 判断崩溃

`timeout 15 ./SQLPilot.exe` 结束时，Electron 会打印 `[renderer gone] crashed`、`GPU process exited` —— 那是被终止导致的，不是真崩溃。要判断是否正常，看**窗口句柄**和 `boot.log`。

---

## 8. 故障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 主进程弹 "A JavaScript error occurred" + `package.json` ENOENT | asar 归档；或压缩包漏了 `node_modules` | 确认 `asar: false`，确认 zip 内有 `resources/app/node_modules` |
| 双击没反应，进程 38MB 就没了 | `ELECTRON_RUN_AS_NODE=1` | `env -u ELECTRON_RUN_AS_NODE` 再启动 |
| 启动要 20–30 秒 | 用的是 portable 单文件 | 换目录版 |
| 启动后提示"已有实例在运行" | 单实例锁残留 | 删 `Singleton*` |
| `cpu-features` 编译失败 | node-gyp 与本机 Python 不兼容 | `rm -rf node_modules/cpu-features` |
| 上传平台报 100MB 限制 | 目录版约 104MB | 删 `LICENSES.chromium.html`（约 -2MB）或改 NSIS |
| 界面里出现不该有的环境 | 本机 `%APPDATA%\SQLPilot` 的历史配置 | 与包无关；演示前清空该目录 |

---

## 9. 相关文件

| 文件 | 作用 |
|---|---|
| `release/pack-applab.py` | 一键打包（本文档的可执行版本） |
| `release/templates/README.md` | 上架说明模板，含截图引用 |
| `release/templates/CHANGELOG.md` | 更新日志模板 |
| `release/templates/screenshots/` | 4 张干净截图（空数据目录拍摄） |
| `electron-builder.yml` | 打包配置（`asar: false` 不要动） |
| `src/main/index.ts` | 启动日志开关 `SQLPILOT_BOOT_LOG` |

旧的 `build-applab-zip.py` / `scan-secrets.py` / `verify-zip.py` 已合并进 `pack-applab.py` 并删除，别再单独维护一份逻辑。
