# dsh Browser Agent

> 基于 Yuxiang Lin 及贡献者的 [dsh-browser](https://github.com/omdsh-dev/dsh-browser)（MIT 许可）。见 [NOTICE](NOTICE)。

[English](README.md) | **中文**

<img width="1701" height="897" alt="dsh 浏览器操作" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 连接到你正在使用的 Chrome 或 Firefox 标签页。模型可以读取页面内容、操作控件、导航和管理标签页，同时保留登录态、会话和 Cookie。侧边栏提供对话界面。

`dsh` 是由 DeepSeek AI 开发的开源、插件化 agent harness（智能体框架）。本仓库将配套的浏览器桥插件与 Chrome/Firefox MV3 扩展组成一个独立的 pnpm workspace。

页面会转换为结构化文本和带编号的交互元素清单。工具通过编号或选择器定位元素；`browser_screenshot` 经批准后截取受控标签页的可视区域。宿主声明图片能力时，侧栏也可发送 PNG、JPEG、WebP 和 GIF 附件。

> [!IMPORTANT]
> 工作区固定使用 DSH 0.2.2-rc.2。

## 快速安装

安装器会安装桥插件和 Chrome 扩展。它下载当前 `main` 分支并从源码构建；目前不使用发布资产，也不校验校验和（见 [RELEASING.md](RELEASING.md)）。

macOS 与 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/natgurlain/dsh-browser-agent/refs/heads/main/scripts/install.sh | bash
```

Windows（PowerShell）：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/natgurlain/dsh-browser-agent/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

安装器打开 `chrome://extensions` 后，请按提示加载或重新加载 **dsh 浏览器助手**。如果 dsh 已经在运行，安装完成后请重启。前置要求、启动命令、更新方式和开发者安装详见[详细安装与使用](#详细安装与使用)。

> [!IMPORTANT]
> npm 上未加 scope 的 [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) 包属于另一个项目，与本仓库无关。本项目目前没有发布 npm 包，请使用上方安装器。

## 性能基准

在 2026 年 8 月 18 日完成的 60 次配对端到端评测中，两个后端分配到的 30 次运行均全部成功；dsh 浏览器操作使用了更少的模型/工具轮次，并以更短时间完成任务：

| 后端 | 成功率 | 平均端到端耗时 | 平均浏览器工具调用 |
|---|---:|---:|---:|
| **dsh 浏览器操作** | **30/30** | **5.32 秒** | **3.4** |
| 对齐工具契约的 Playwright 基线 | 30/30 | 6.67 秒 | 4.7 |

Playwright / 扩展的配对耗时比为 **1.24**（95% CI **1.16–1.34**）：Playwright 耗时约多 24%；等价地说，dsh 浏览器操作将延迟降低约 20%，每个任务平均节省 1.35 秒。评测使用 6 个浏览器任务、5 个确定性 seed、相同的 DSH profile 与模型（`deepseek-v4-flash`），并通过独立页面状态验证结果。详见[评测方法与复现说明](benchmark/README.md)。

## 核心能力

| 能力 | 工具 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 结构化文本快照：标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化，`frame` 单读一个 iframe，`query` 按文本/选择器/角色定位任意元素并给出选择器 |
| 点击 | `browser_click` | 按编号或选择器点击、双击；支持鼠标按键和修饰键 |
| 文本 | `browser_type` | 输入文本（React/Vue 受控组件兼容），`replace` 清空重填；`mode` 可选插入或逐键输入（自动补全类字段） |
| 按键 | `browser_press` | 单键或组合键（`modifiers`），`action: down/up` 跨调用按住，`repeat` 重复 |
| 滚动 | `browser_scroll` | 向上、向下滚动页面或指定 iframe，或滚动到顶部、底部 |
| 剪贴板 | `browser_clipboard` | `write` 写入系统剪贴板（文本/HTML）；`paste` 以粘贴事件或真实快捷键粘贴到页面 |
| 文件 | `browser_upload` | 把本机文件附加到 `input[type=file]`（Chrome） |
| 页面导航 | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内导航，或新开标签页并跟随（`active:false` 时保持当前页在前台） |
| 列出标签页 | `browser_list_tabs` | 列出可访问标签页的稳定 ID、标题、URL、窗口/顺序以及活动/受控状态 |
| 跟随标签页 | `browser_follow_tab` | 将后续浏览器工具绑定到 `browser_list_tabs` 返回的标签页；默认不激活，`activate: true` 才切到前台 |
| 关闭标签页 | `browser_close_tab` | 关闭 `browser_list_tabs` 返回的标签页 |
| 悬停 / 拖拽 | `browser_hover` / `browser_drag` | 用真实指针悬停元素（打开悬停菜单）；拖到另一元素或按偏移拖动，可拖拽源使用 HTML5 拖放事件 |
| 对话框 | `browser_dialog` | 回应 alert/confirm/prompt/离开页面对话框；被对话框阻塞的调用会立即以 `dialog open: …` 失败（Chrome） |
| 下载 | `browser_downloads` | 列出最近下载或等待下载完成，返回本地文件路径；首次使用时请求可选的 `downloads` 权限 |
| PDF | `browser_save_pdf` / `browser_pdf_text` | 把标签页保存为 PDF 到代理工作区（Chrome）；提取标签页中 PDF 的文本 |
| 选择选项 | `browser_select` | 按值、标签或序号在 `<select>`、ARIA listbox 或 combobox 中选择选项 |
| 提取表格 | `browser_extract` | 从表格或重复元素（schema）提取行，可跨页；`saveTo` 把 CSV/JSON 写入会话工作区 |
| 批量操作 | `browser_run` | 按顺序执行最多 25 个浏览器操作，只需一张批准卡片；遇到第一个错误或 `expect` 失败即停止 |
| 监视页面 | `browser_watch` / `browser_watches` | 当选择器或文本出现/消失、URL 匹配或出现某个请求时唤醒本会话；列出或取消监视器。需先在设置中开启，每个监视器都需批准 |
| 批量阅读 | `browser_fanout` | 最多 8 个子代理各用一个后台标签页并行阅读（默认只读，`allowActions` 才可操作），返回结构化答案 |
| 委派 | `delegate_browser_task` | 普通 DSH 会话把页面工作交给浏览器子代理，页面快照不会占满该会话 |
| 已保存工作流 | `browser_workflow_list` / `browser_workflow_run` | 列出并重放之前保存的工作流（见[学习功能](#学习功能实验性默认全部关闭)） |
| 读取区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待稳定 | `browser_wait` | 页面加载与渲染稳定检测 |
| 发送图片 | `session.prompt` / `session.attachment` | 按宿主能力启用图片草稿、纯图片消息和持久历史预览 |
| 引用选中内容 | 侧栏输入框 | 在页面里划选的文字会出现在输入框，随下一条消息一起发送，并带上来源与不可信内容边界 |
| 继续生成 | 侧栏 | 请求失败后，点击出现的“继续生成”按钮继续对话 |

点击、文本输入和滚动操作在指定文档中执行，支持跨域 iframe。Chrome 通过调试器执行原生键盘事件、光标位置插入、系统粘贴和文件上传。截图要求受控标签页处于活动状态且窗口聚焦，可以使用 `browser_follow_tab { activate: true }` 将页面切到前台。

每次点击前都会对目标中心做命中测试；被其他元素遮挡的目标会以 `covered by <元素>` 拒绝，而不是点到上层元素。`browser_click { trusted: true }` 使用真实鼠标输入（Chrome）；对自定义元素的普通点击若没有任何可见效果，会自动用真实输入重试一次。侧栏中的**停止按钮**（或 Ctrl+Shift+K / ⌘⇧K；Firefox 为 Alt+Shift+K；可在浏览器扩展快捷键页面改绑）会取消待确认请求和正在执行的操作、撤销会话信任与开发者工具授权、关闭不受限访问、断开调试器，并在你点击「重新连接」前保持断开。代理控制的标签页显示 **AI** 徽标。

### 可见性与控制

- **批准卡片**在操作发生前显示将要点击、输入或打开的确切内容，每张卡片只绑定这一个操作。
- **暂停 / 接管。** “此步后暂停”让当前操作完成，并在你继续前挂起下一步。“接管”暂停代理，让你自己操作页面；继续后交还控制权，模型会被告知发生了什么变化。
- **代理叠加层。** 代理操作前，幽灵光标和轮廓会标出每个目标；受控标签页带有彩色边框和停止按钮（可在设置中关闭叠加层）。
- **步骤时间线与审计日志。** 侧栏列出一次运行的每个步骤。每个操作、批准和紧急停止都会写入 `~/.dsh/browser-audit/` 下防篡改的审计日志，可在设置中导出。
- **站点规则。** 在设置中把站点设为禁止、只读或总是询问。代理读取不可信内容后，向其他站点写入需要重新批准（污染规则）。
- **严格模式**（Chrome）。对你列出的站点或某个代理会话，页面发出的写请求会在网络层挂起，直到你批准。

### 在 Claude Code、Cursor 或 Codex 中使用浏览器（MCP）

在 `bridge-browser` 插件配置中设置 `mcp: { enabled: true }`，然后在 MCP 客户端中注册 stdio shim `packages/browser/mcp-server/bin/dsh-browser-mcp.mjs`，例如 `claude mcp add dsh-browser -- node /abs/path/to/dsh-browser-mcp.mjs`。每个 MCP 调用都经过与 DSH 自身会话相同的批准卡片、站点策略、污染规则、紧急停止和审计日志，每张卡片都会标明发出请求的 MCP 客户端。Cursor 和 Codex 的配置示例见 [packages/browser/mcp-server/README.md](packages/browser/mcp-server/README.md)。

### 学习功能（实验性，默认全部关闭）

在侧栏 **设置 → 学习功能（实验性）** 中开启。每个重放或学到的操作仍然经过暂停闸门、站点策略、污染规则、紧急停止、批准卡片和审计日志。

- **保存为工作流。** 开启“记录运行”后，代理每个成功的步骤会和重新定位该元素的方式（角色、可访问名称、文本，以及 CSS 后备）一起保存在内存中。**保存为工作流** 会把它们写入会话工作区的 `browser-workflows/<名称>.workflow.json`，由你选择哪些输入值成为参数。输入到敏感字段的值从不存储，而是作为必填参数。每个保存的工作流也会作为 DSH 技能提供。
  - `browser_workflow_run` 重放工作流，每一步都重新查找元素；元素不存在或有歧义时停下，把这一步交给模型。
  - 面板可以把工作流定时在它所属的会话中运行，最短每分钟一次。批准卡片照常询问，无人回应时默认拒绝。含敏感输入的工作流不能定时。
- **观察我。** 观察期间记录你在标签页上的点击和输入，从不记录密码，敏感字段会被遮盖。在表格或列表行上重复两次后，面板会提供 **按同样方式完成剩余 N 项**，它作为一个 `browser_run` 程序运行，只需批准一张卡片。
- **站点驱动**（仅 Chrome，需允许开发者工具）。对你列出的站点，代理操作背后的同源请求会被建议为一个类型化工具（`browser_site_<主机>_<名称>`）。经你批准才会保存；Cookie、令牌和敏感字段从不存储，令牌每次都从页面读取。每次使用都会在单独的卡片上显示确切请求；驱动失败时代理改用页面界面。驱动可以导出和导入为 JSON。
- **失败样例。** 步骤失败时，在会话工作区的 `browser-fixtures/` 下保存脱敏的页面副本（敏感值已遮盖，脚本已移除）和预期操作。被阻止或未共享的页面会跳过，每次保存都会记入审计日志。`node benchmark/import-fixtures.mjs <目录>` 可把这些文件转为基准任务文件。`benchmark/online-mind2web/` 在运行时加载 Online-Mind2Web 子集，并用其他地方产生的结果生成静态排行榜。两者都还没有 runner：`benchmark/run.mjs` 只运行内置任务（见 [benchmark/README.md](benchmark/README.md)）。

## 详细安装与使用

前置要求：Node.js `>=24.9.0`、Corepack/pnpm，以及 Chrome 125+ 或 Firefox 140+。Windows 还需要系统自带的 Windows PowerShell 5.1，或 PowerShell 7+。

### 安装或更新

运行[快速安装命令](#快速安装)即可安装或更新。安装器打开 `chrome://extensions` 后，首次安装时加载 `~/.dsh/browser-extension` 目录；更新后点击**重新加载**。如果 dsh 已在运行，请重启。

如需从源码 checkout 安装当前分支：

```sh
git clone https://github.com/natgurlain/dsh-browser-agent.git
cd dsh-browser-agent
./scripts/install.sh
```

Windows 请在 checkout 中运行 `.\scripts\install.ps1`。拉取或切换版本后，请重新运行安装器并重新加载扩展。

### 卸载

在扩展的**设置 → 卸载 dsh-browser**中复制命令，然后在终端运行。

也可以直接运行。macOS 或 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/natgurlain/dsh-browser-agent/refs/heads/main/scripts/uninstall.sh | bash
```

Windows 请运行：

```powershell
& { $ErrorActionPreference = 'Stop'; $d=New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('dsh-browser-uninstall.'+[Guid]::NewGuid().ToString('N'))); try { $s=Join-Path $d.FullName 'uninstall.ps1'; Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/natgurlain/dsh-browser-agent/refs/heads/main/scripts/uninstall.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s } finally { Remove-Item -LiteralPath $d.FullName -Recurse -Force } }
```

在源码目录中运行 `bash scripts/uninstall.sh` 或 `.\scripts\uninstall.ps1`。

### Firefox 源码构建

Firefox 使用独立的 MV3 manifest、事件页后台和 Sidebar。在 checkout 中构建后，打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，再选取 `extensions/dsh-browser/dist-firefox/manifest.json`：

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

桥地址仍会自动探测。Firefox 附加组件不由安装器安装，因此需要把 `~/.dsh/ext-bridge-token` 中的桥接 token 复制到扩展设置中（dsh 启动日志会报告该文件路径）。签名发布时可直接使用同一份 `dist-firefox/` 产物。

### 启动与使用

启动托管安装：

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

使用源码 checkout 时，请在仓库根目录运行 `pnpm start`。受支持的精确公开版本为：

```sh
npx @deepseek-ai/dsh@0.2.2-rc.2 web
```

Chrome 本机使用无需配置：安装器会把桥接 token 放到已安装的扩展目录中，插件会让这份副本保持最新。Firefox 需要填写上述本地桥 token。打开页面，点击 DeepSeek 鲸鱼图标，等待侧边栏显示**已连接**。已有 HTTP(S) 标签页会在第一次操作时自动加载。在浏览器受保护页面和扩展商店中，模型可以读取标签页元数据，并通过浏览器级能力导航到 HTTP(S)、后退、前进和刷新，但不能读取或操作受保护页面的 DOM。

## 故障排查

**侧边栏一直显示「未连接」**

- 确认 DSH 正在运行。安装或更新后，重启 DSH 并重新打开侧栏。
- 打开**设置 → 自动检测**，选择需要连接的 DSH 实例。
- 使用 Firefox 时，在设置中填写 `~/.dsh/ext-bridge-token` 中的 token。
- 连接远程 DSH 时，在设置中填写服务器地址和对应的桥接 token。
- 如果插件配置固定了自己的 `token`，请把该 token 粘贴到扩展设置中；已安装扩展里的副本只跟随 `~/.dsh/ext-bridge-token`。
- 更新后请同时重新加载扩展并重启 DSH：桥接握手带有版本号，旧版扩展或插件会被拒绝，并以「protocol version mismatch」关闭连接。

### 桥接安全

- 所有客户端（包括本机回环）都通过桥接令牌完成双向 HMAC 质询-应答（握手 v3）；令牌本身不经过网络，扩展会拒绝无法反向证明令牌的桥接。
- 两侧证明都绑定扩展实际拨号的地址和端口，桥接会与它接受的套接字核对，因此从其他端口转发握手的本地进程无法完成握手。握手之后每一帧（双向）都带有按连接派生的密钥和严格递增序号的 MAC；未封装、重放、乱序或篡改的帧会直接断开连接。帧只做认证、不加密。经端口转发（Docker `-p`、SSH 隧道）以不同端口访问桥接时会被拒绝，除非在插件配置 `forwardedPorts` 中列出该回环端口**并且**设置 `allowForwardedPorts: true`。在转发端口上监听的程序位于中间，可以读取每一帧（会话记录、页面内容），因此只列出你控制的转发：在列出的端口空闲时绑定它的本地进程可以借它中转。双方声明的能力（caps）也绑定在两侧证明中（协议 v4），即使是受信任的转发也无法开启开发者工具组或修改快照上限。桥接 URL 中的 DNS 名称仅在桥接监听回环地址时被接受；局域网或远程桥接必须用 IP 地址连接。
- 插件配置中固定的 `token` 至少 32 个可打印字符且具备足够熵（例如 `openssl rand -hex 32`），否则插件启动失败，因为截获的握手可让本地观察者离线猜测弱 token。
- Chrome 连接只接受 manifest key 固定的扩展 ID（`klmdgljhcjbbpjcplbanjeclilghnaoh`）。若使用不同 key 的构建或 Web Store 版本，请在 bridge-browser 插件配置中设置 `allowedChromeExtensionIds`；用 `pnpm --filter dsh-browser-extension run build:store` 构建商店包，该命令会去掉商店不接受的 `key`。
- 桥只转发扩展实际用到的 Host 方法。扩展只能在桥接自己创建的会话中发送提示、修改设置、注入页面快照或删除会话：`session.create` 总是新建会话（忽略扩展传入的 `sessionId`、`cwd`、`workspaceId`），归属记录在 `~/.dsh/browser-bridge-sessions.json` 和桥接工作区目录中。桌面端和 CLI 会话不再出现在侧边栏的历史列表中；它们驱动浏览器时，仍可查看历史（用于审批）和停止，但不能从浏览器发送提示。子代理会话始终不可访问。
- 新的浏览器会话即使宿主默认是完全访问，也会以受限预设启动；切换到完全访问预设，以及在当前运行完全访问预设的会话中发送提示、注入或执行命令都会被拒绝。只有宿主预设表中沙箱为 `read-only` 或 `workspace-write` 的预设（或列在 `safePermissionPresets` 中的预设）被视为受限；未知预设、改名的完全访问预设以及 `custom` 都会被拒绝，`/permission` 只接受严格的 `/permission <preset>` 形式。在插件配置中设置 `allowDangerFullAccess: true` 可解除这些限制。
- 中转站的已存密钥只会发送到保存时的地址：用不同地址测试模型列表需要重新输入密钥；修改中转站地址但未重新输入密钥时，已存密钥会被清除。

## 开发

桥接插件和 Chrome/Firefox 扩展都属于本仓库 workspace；所有命令均在本仓库根目录执行。首次开发安装运行 `pnpm install`。

开发文档：[浏览器桥插件](packages/browser/bridge-browser/README.zh.md)与[浏览器扩展](extensions/dsh-browser/README.zh.md)。

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
- `@deepseek-ai/dsh` 与桥接插件的依赖固定在同一条经过验证的公开发布线上；升级时必须同时更新 manifest、锁文件并重跑根目录检查。

`check:runtime` 检查实际解析的 DSH 依赖和锁文件；`test:smoke` 使用临时 DSH home 启动真实 web 宿主，验证桥接和重启后的会话读取，无需模型密钥。每次推送到 `main` 和每个拉取请求时，CI 都会运行这些检查（`pnpm install --frozen-lockfile`，使用缓存的 pnpm store），同时在 Linux、macOS 和 Windows 上运行 `pnpm test:scripts`，并运行 `pnpm test:benchmark`。

构建后运行 `pnpm test:browser`，需要已安装 Playwright Chromium，或通过 `CHROMIUM_PATH` 指定支持加载未打包扩展的 Chromium 可执行文件。测试会启动真实 DSH 和 Chromium，验证页面共享、开发者工具授权、输入、iframe 上传与定位，以及 CSS 修改。测试开启并确认跨站 iframe 的进程隔离，覆盖同源、跨源和嵌套 iframe 中的元素点击、输入与滚动。测试无需模型密钥，结果保存在 `.artifacts/browser-smoke/`。

构建扩展后运行 `pnpm test:uninstall`。设置界面测试使用 `pnpm test:uninstall:ui`，需要 Playwright Chromium。

## 安全

- 助手读取的页面文字和你发送的附件会交给当前选择的模型。
- 页面内容共享可以选择**自动共享**（默认）、**每次询问**或**关闭**。
- 文本快照会遮盖密码和卡号值；截图保留可见像素，不会遮盖字段。
- 页面操作默认需要审批。你可以信任指定网站，或开启**允许模型完全控制浏览器**。开发者工具需要单独授权。
- 切换标签页后，助手会询问接下来操作哪个页面。
