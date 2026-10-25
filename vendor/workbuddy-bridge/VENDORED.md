# vendor/workbuddy-bridge

把 WorkBuddy 的模型接进 SQLPilot 的**受管本地桥**，随安装包一起分发（用户不需要另装 DeepSeek Harness 或 Node）。

- 上游项目：https://github.com/Ianzhyh/workbuddy-to-dsh
- 版本：1.10.1（clone 时 HEAD `d1c93be` 之前的 main，见下）
- 许可：MIT（见同目录 `LICENSE`、`NOTICE.md`，未改动版权声明）

## 为什么用桥而不是直连

WorkBuddy 的 access/refresh token 是 AES-256-GCM 字段信封（`{suite,keyId,nonce,authTag,ciphertext}`），
解封密钥由桌面端主进程在运行时持有，只以环境变量形式注入它自己的子进程，磁盘上没有可解材料；
上游 `copilot.tencent.com/v2/chat/completions` 还带 HMAC 签名头。复刻这套既会随上游频繁失效，
也属于绕开对方的凭据保护。桥用**官方授权流程**取令牌，只做协议翻译。

## 本目录与原仓库的差异

- 只保留运行时需要的东西：`bridge/`、`lib/`、`dashboard/`、`config.mjs`。
- 删除了全部 `*.test.mjs` 与仓库级文档（未改动任何运行时代码）。
- SQLPilot 侧只通过 `src/main/workbuddy.ts` 启动它：
  - `WORKBUDDY_PORT`：由 SQLPilot 选空闲端口（默认 8790 起顺延）
  - `WORKBUDDY_LOCAL_TOKEN`：由 SQLPilot 生成并用 DPAPI 存 `secrets.json`，不读桥自己的 `.bridge-token`
  - `WORKBUDDY_STATE_FILE`：指向 SQLPilot 的 `userData/wb-bridge-state.json`，不污染安装目录
- 桥的日志写到 `userData/wb-bridge.log`（超过 2MB 轮转）。

## 升级方式

```bash
git clone --depth 1 https://github.com/Ianzhyh/workbuddy-to-dsh /tmp/wb2dsh
cp -r /tmp/wb2dsh/{bridge,lib,dashboard,config.mjs,LICENSE,NOTICE.md} sqlpilot/vendor/workbuddy-bridge/
rm -f sqlpilot/vendor/workbuddy-bridge/{bridge,lib,dashboard}/*.test.mjs
```

升级后跑一遍 `node test/unit-workbuddy.mjs`（端口挑选 / 状态机）与设置页的「启动 → 拉取模型 → 测试模型」。
