# 开发

[English](development.md)

桥接插件和 Chrome/Firefox 扩展都属于本仓库 workspace；所有命令均在本仓库根目录执行。首次开发安装运行 `pnpm install`。

开发文档：[浏览器桥插件](../packages/browser/bridge-browser/README.zh.md)与[浏览器扩展](../extensions/dsh-browser/README.zh.md)。

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:runtime
pnpm run test:smoke

pnpm --filter @natgurlain/dsh-bridge-browser run build
pnpm --filter @natgurlain/dsh-bridge-browser run typecheck
pnpm --filter @natgurlain/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

注意：

- 启动前桥接插件必须已有 `lib/` 供 Loader 加载；`scripts/install.sh` 和根目录 `pnpm run build` 都会先构建插件再构建扩展。
- 工作区只安装一个确定的 DSH 版本（根 `package.json`、桥接插件的 devDependencies 与锁文件保持一致）。桥接插件的 `engines.dsh` 和 DSH peer 范围更宽，覆盖通过兼容性矩阵的版本（见 [docs/dsh-matrix.md](dsh-matrix.md)）。更换默认版本时必须同时更新 manifest、锁文件并重跑根目录检查。

`check:runtime` 检查实际解析的 DSH 依赖和锁文件；`test:smoke` 使用临时 DSH home 启动真实 web 宿主，验证桥接和重启后的会话读取，无需模型密钥。

### 本地 gate

检查在本地运行：GitHub Actions 尚未在本仓库运行过，因此这里的任何检查都没有经过 CI 验证。gate 是一条本地命令：

```sh
pnpm gate                  # 全部步骤；需要 Playwright Chromium
pnpm gate --skip-browser   # 没有 Chromium：跳过三个浏览器步骤
pnpm gate --list           # 按顺序列出步骤
```

步骤依次执行（不并行），失败后继续执行其余步骤，最后打印通过/失败汇总表；任何步骤失败则以非零状态退出。结果写入 `.artifacts/gate/result.json`（可用 `--output <file>` 修改）：提交哈希、工作区是否有未提交修改、日期，以及每个步骤的状态、退出码、耗时和测试数量；每个步骤的输出保存在同目录的 `<step>.log`。步骤依次为：冻结锁文件安装、`check:runtime`、`pnpm -r typecheck`、桥接与扩展的单元测试（`--maxWorkers=4`，逐个包运行）、MCP shim 测试、两个构建、`pnpm test:scripts`、`pnpm test:benchmark`、`pnpm test:smoke`（真实 DSH 宿主，含 MCP 和 dev loop）、`pnpm test:browser`、`pnpm test:model-free`（无模型的提示注入 canary 检查和对话框任务）以及 `pnpm test:uninstall:ui`。`.github/workflows/ci.yml` 只运行 `pnpm gate`。各阶段 gate 与步骤的对应关系、以及无模型注入检查能证明和不能证明什么，见[英文 README 的 The gate 一节](../README.md#the-gate)。

构建后运行 `pnpm test:browser`，需要已安装 Playwright Chromium，或通过 `CHROMIUM_PATH` 指定支持加载未打包扩展的 Chromium 可执行文件。测试会启动真实 DSH 和 Chromium，验证页面共享、开发者工具授权、输入、iframe 上传与定位，以及 CSS 修改。测试开启并确认跨站 iframe 的进程隔离，覆盖同源、跨源和嵌套 iframe 中的元素点击、输入与滚动。测试无需模型密钥，结果保存在 `.artifacts/browser-smoke/`。

构建扩展后运行 `pnpm test:uninstall`。设置界面测试使用 `pnpm test:uninstall:ui`，需要 Playwright Chromium。

