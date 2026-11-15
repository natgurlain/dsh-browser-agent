# dsh 浏览器操作扩展（Chrome 与 Firefox MV3）

[English](README.md) | 中文

dsh 的**浏览器操作端**：让模型直接读取并操作你在浏览器里打开的页面——抓取内容、点击元素、填写表单、滚动与导航，全部在真实页面执行、登录态保留。侧边栏面板是与模型对话的入口。

浏览器页面以结构化文本和带编号的交互元素清单呈现。`browser_screenshot` 也可经批准后截取受控页面的可视区域。DSH 宿主声明图片能力时，侧栏接收 PNG、JPEG、WebP 和 GIF，并渲染会话中的持久图片附件。

## 模型能做什么

| 能力 | 动作 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化，`frame` 单读 iframe，`region` 只读一部分，`query` 定位任意元素并给出选择器；`mode`（`full` / `interactive` / `text`）、`viewportOnly` 与 `collapse`（默认开启，合并相似的连续元素）可缩减输出 |
| 截取可视区域 | `browser_screenshot` | 捕获可见像素，不遮盖字段；除非启用了完全控制，否则需要截图审批 |
| 点击 | `browser_click` | 按编号或选择器点击、双击；支持鼠标按键和修饰键 |
| 文本 | `browser_type` | 输入文本，`replace` 清空重填；`mode` 选择光标插入或逐字符按键 |
| 按键 | `browser_press` | 单键与组合键，可跨调用按住修饰键 |
| 滚动 | `browser_scroll` | 向上、向下滚动页面、iframe 或元素所在的滚动容器，或滚动到顶部、底部；`untilItems` / `maxRounds` / `itemSelector` 可持续滚动无限列表直到不再增长 |
| 剪贴板 / 文件 | `browser_clipboard` / `browser_upload` | 写入或粘贴文本与富文本；把本机文件附加到 file input |
| 导航 | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内跳转，或新开标签页并跟随 |
| 列出标签页 | `browser_list_tabs` | 列出可访问标签页的稳定 ID、标题、URL 和活动/受控状态 |
| 跟随标签页 | `browser_follow_tab` | 将后续浏览器工具绑定到已列出的标签页；默认后台，`activate: true` 才切前台 |
| 关闭标签页 | `browser_close_tab` | 关闭已列出的标签页 |
| 悬停 / 拖拽 | `browser_hover` / `browser_drag` | 用真实指针悬停元素；拖到另一元素或按偏移拖动，可拖拽源使用 HTML5 拖放事件 |
| 对话框 | `browser_dialog` | 回应 alert/confirm/prompt/离开页面对话框；被对话框阻塞的调用立即以 `dialog open: …` 失败（Chrome） |
| 下载 | `browser_downloads` | 列出或等待下载，返回本地文件路径；首次使用时请求可选的 `downloads` 权限 |
| PDF | `browser_save_pdf` / `browser_pdf_text` | 把标签页保存为 PDF 到代理工作区（Chrome）；提取标签页中 PDF 的文本 |
| 读区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待 | `browser_wait` | 页面加载与渲染稳定，或等待文本/选择器出现（`gone`：消失）、URL 匹配或网络空闲 |
| 选择选项 | `browser_select` | `<select>`、ARIA listbox 或 combobox，按值、标签或序号选择 |
| 提取行数据 | `browser_extract` | 从表格或重复元素按 schema 提取行，可跨页；`saveTo` 把 CSV/JSON 写入会话工作区（敏感值掩码） |
| 步骤程序 | `browser_run` | 最多 25 个动作按顺序执行，只需一张审批卡片；遇到第一个错误或 `expect` 失败即停止 |
| 页面监视 | `browser_watch` / `browser_watches` | 选择器/文本出现或消失、URL 匹配或出现某个请求时唤醒会话；需在设置中开启**允许助手监视页面**并经审批；可在侧栏查看和取消 |
| 并行读取 | `browser_fanout` | 最多 8 个子代理，各用一个后台标签页（除非 `allowActions`，否则只读）；授予 `tabGroups` 时会把这些标签页编组，结束后释放 |
| 工作流（默认关闭） | `browser_workflow_list` / `browser_workflow_run` | 重放从已记录运行保存的工作流；每一步仍经过站点规则和审批卡片 |
| 查看元素与 CSS | `browser_devtools_elements` / `browser_devtools_set_element_style` / `browser_devtools_set_element_attribute` | 高权限：计算样式、盒模型、命中规则，并可现场修改 CSS 与属性来调试 |
| 执行页面 JS | `browser_console_eval` / `browser_console_logs` | 高权限：在页面自身上下文执行代码，并读取记录的控制台输出 |
| 网络抓包 | `browser_devtools_network` / `browser_devtools_list_requests` / `browser_devtools_get_request` / `browser_devtools_request_body` | 高权限：已捕获请求列表、单条详情与正文（凭据类请求头默认脱敏） |
| 图片对话 | `session.prompt` / `session.attachment` | 按宿主能力启用图片选择、纯图片发送和持久历史预览 |
| 引用你划选的内容 | 侧栏输入框 | 你在页面里选中的文字会变成输入框里的引用，随下一条消息一起发送 |

## 架构

- **background**（`src/background/`）：桥连接（token 认证 + 指数退避重连 + 保活）、网关 RPC 客户端，以及**失败关闭地分发工具到用户受控标签页**。
- **content script**（`src/content/`）：纯文本快照（可读性主文 + 编号交互清单 + 表单字段）、**稳定编号**（`data-dsh-el`）、delta 变化、点击/输入/按键/滚动/选择/提取/导航动作及操作后校验、敏感字段掩码，以及带防抖的划选监听——只有侧栏打开且页面共享不是「关闭」时才会启用。它还负责页面上的助手叠加层（幽灵光标、带「停止」链接的受控页边框、接管横幅）、为调试器驱动的指针和键盘准备焦点与坐标、评估常驻页面监视，并为默认关闭的学习功能服务（定位信息、已消毒的失败样例、「观察我」、站点驱动请求）。
- **页面世界监听垫片**（`src/main-world/`，`listener-shim.js`）：第二个内容脚本，以 `world: "MAIN"` 在 `document_start` 注入。它记录哪些元素被页面脚本变成可点击（`addEventListener`、`onclick` 属性、React/Vue/Svelte/Solid 处理器），让交互清单能列出只靠脚本响应点击的普通 `<div>`。它与页面同处一个世界，因此不持有任何秘密、不暴露全局变量；唯一输出是每个元素一个比特（「可点击」），以 DOM 事件传给内容脚本，后者把它当作不可信提示（有上限、过滤不可见元素、绝不挤掉真实控件）。扩展加载前已打开的标签页没有垫片，退回到内容脚本自身的线索（指针光标、`jsaction`/`ng-click`/`data-action` 类属性）。
- **panel**（`src/panel/`）：React 对话界面（可续接会话/历史/实时事件/设置）；图片选择和预检由宿主声明的限制控制，持久图片通过会话授权读取；消息以已消毒的 Markdown 渲染，`ask_user_question` 请求会显示成可直接作答的卡片，手动切页时显示控制权交接条，运行中的回合提供标准停止按钮，页面划选的段落显示为可移除的引用卡片，并在下一条消息中包在不可信内容边界里发送。工具调用显示为带审计标记的步骤时间线；侧栏提供暂停与接管、紧急停止（也可用 `Ctrl+Shift+K`，Firefox 为 `Alt+Shift+K`，或叠加层的「停止」链接）以及审计日志导出。
- **协议**：`@natgurlain/dsh-bridge-browser` workspace 包中的 `protocol.ts` 是两端共享的真源，具体通过该包的源码 export 共享。

## 构建

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

请在仓库根目录执行这些命令。Chrome 产物输出到 `extensions/dsh-browser/dist/`；Firefox 产物输出到 `extensions/dsh-browser/dist-firefox/`。

开发扩展时，Chrome 从 `chrome://extensions` 加载 `extensions/dsh-browser/dist/`；Firefox 从 `about:debugging#/runtime/this-firefox` 加载 `extensions/dsh-browser/dist-firefox/manifest.json`。代码更新后需重新构建并重新加载。

## 安装与使用

安装、更新、启动和卸载方式见根目录 README 的[详细安装与使用](../../README.zh.md#详细安装与使用)。

## 输入区控制：权限模式、模型、命令与 Skill

输入区提供与 Web GUI 对齐的控件，全部由桥插件自有的 Host 方法支撑：

- **权限模式**（左侧 chip）：部署的预设表（`read-only`、`workspace-write`、`danger-full-access`，实验 Auto integration 挂载时还有 `auto`）加上当前会话的取值。选择预设会执行宿主自己的 `/permission <preset>` 命令，因此 `permission/preset` 选择与两个旋钮事件都会像 Web GUI 选择一样写入会话日志。「完全权限」与「Auto review」会先要求显式确认；推导态 `custom` 只作展示、不可选；菜单底部提示新会话的默认值。首次发送消息创建会话之前，选择会被记住，并在 materialize 时、第一条提示词准入之前应用。
- **模型与推理强度**（右侧 chip）：按 provider 分组的模型目录，以及当前模型声明的推理强度（含「默认」）。选择只影响**下一轮**装配，因此回合运行中 chip 依然可用。目录读取失败时该行会说明原因并提供重试，而不是静默变灰；漏掉的 `turn/end` 会在面板下次变为可见时按宿主的 `running` 标记纠正。
- **`/` 选单**：在空行输入 `/` 会打开宿主命令目录（`/compact`、`/permission`、`/plan`、`/goal`、`/feedback`、`/export` 等）与该会话的用户可调用 skill，其中包含标记为 `modelInvocable: false` 的 skill（带「仅用户可调用」角标）——它们正是为显式调用而存在。`↑`/`↓` 移动、`Enter`/`Tab` 接受、`Esc` 关闭；选中某行会插入其确切文本，方便继续补参数。提交时面板按与宿主适配器一致的规则裁决：命令名走 `commands.execute`（其输出永远不会变成模型消息），skill 名按字面文本发送（由宿主注入 skill 正文），无法识别的 `/…` 行会被**拒绝**且草稿保留——若想按普通文本发送，请在行首加一个空格。命令不支持附件；临时会话（尚未创建）的命令/skill 目录在第一条消息创建会话前返回空。

## 页面读取与控制

- **文本快照**：标题、URL、正文、编号元素和表单的默认预算为 32k 字符（插件可配，经 `hello.ok` 协商给扩展）。经过审批后，截图还可提供页面图像。
- **页面文字是不可信输入**：快照和局部文本读取会放进带随机 nonce 的信任边界，并明确要求模型不得把网页中的命令当成指令。这只是纵深防御；扩展侧的操作审批才是强制安全边界。
- **稳定编号**：元素编号跨快照保持（WeakMap + `data-dsh-el`），模型可以说"点 7 号"；页面大改时显式提示"编号已重排"。
- **delta 模式**：`browser_snapshot({delta:true})` 只返回变化元素的编号，省 token。
- **隐私**：文本快照中的密码和卡号值以 `••••` 呈现，可访问名称不使用敏感字段的当前值。截图直接捕获可见像素，不会遮盖字段。开发者工具需要独立授权。
- **标签页绑定**：提交提示时会在模型开始工作前绑定活动标签页；如果直接调用浏览器工具，也会在需要时完成首次绑定。手动切换标签页或窗口后，后续工具会暂停，并询问助手留在原页面还是跟随当前页面；此时还可以点「跳转回到助手页面」，把你自己正在看的标签页切回助手所在的页面。选择留在原页面后允许后台操作，但不会改变用户正在看的页面；选择跟随后会重置页面引用状态。受控页关闭后失败关闭，直到用户选择当前页面；切页还会撤销尚未完成的操作审批。
- **分级审批**：默认「自动共享」允许模型按需读取受控标签页而不额外弹窗；「每次询问」可恢复逐次读取确认，「关闭」会阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取，之后仍可在设置中关闭。状态变更工具仍然失败关闭，并显示实际 origin 和完整载荷：输入文本（目标为密码、卡号、一次性验证码、PIN、SSN、IBAN、API 密钥/令牌或未能检查的字段时默认遮盖，可点击显示）、全部上传路径，以及解码参数后的完整目标 URL（过长或疑似令牌的值会被标出）。审批与工具名、参数、origin 和目标文档的 SHA-256 绑定，执行前重新校验，任何变化都会拒绝执行；导航 URL 带有被标出的值时，受信任域名也会再次确认。用户可拒绝、仅允许一次，或只在当前侧栏会话中信任单个 origin。最后一个侧栏关闭或 Service Worker 重启会清空临时信任；永久信任需在设置中显式管理。侧栏关闭时，审批会保留到**侧栏关闭时的审批等待**设置的时长（默认 10 分钟，可设 1–14 分钟）；启用通知后，系统通知可把用户带回侧栏。会话级审批只会在其所属会话恢复完成后显示。调用方取消或桥接超时时，会先撤销尚未完成的审批，过期动作不会继续执行。
- **完全控制需显式开启**：**允许模型完全控制浏览器**只有设置保存成功后才会生效，启用后页面读取、页面操作以及标签页列出/跟随/关闭均无需确认。调用在收到时固定其访问模式，因此开启完全控制不会追溯提升已经开始的受限调用。关闭会立即生效：取消尚未下发操作的调用，等待已经下发到浏览器的操作完成，再保存限制设置。快速重新开启也会在旧权限撤销完成前保持受限，并发保存会按请求顺序落盘。受保护页面的 DOM 内容始终不可访问。
- **会话续接**：重新打开侧栏时默认恢复最近活跃的浏览器会话；若该会话不可用，则恢复最新的非空持久会话，最后才创建新会话。可在设置中关闭。

## 安全策略（站点规则、会话污染、严格模式、托管策略）

策略层在所有审批捷径（完全控制、受信任 origin、自动页面共享、开发者工具授权）之前运行。它可以直接拒绝调用，或强制一张其他授权都无法覆盖的逐次审批卡片。

- **站点规则**（设置 → 站点策略）：`blocked`（禁止读取、操作和跳转到该站点）、`read-only`（读取遵循页面共享设置；点击、输入等改动会被拒绝；允许离开该站点）、`ask`（每次调用都询问）、`trusted`（不询问）。格式：`example.com`（含子域名）、`*bank*` 这样的主机通配，或 `github.com/settings` 这样的路径前缀。同一层内以最严格的匹配为准；包含被禁止 iframe 的快照会整体被拒绝。
- **内置保护**（默认开启）：银行与支付（精选列表加 `*bank*` / `*creditunion*` 启发式）、密码管理器保险库、身份账户页面（`accounts.google.com`、`login.microsoftonline.com`、`appleid.apple.com`、`github.com/settings` 等）以及云管理控制台（`console.aws.amazon.com`、`portal.azure.com`、`console.cloud.google.com` 等）默认只读。同一站点上用户规则优先于内置规则。
- **完全访问**现在表示「除受策略限制的站点外全部信任」：它不再解除 `blocked`、`read-only`、`ask` 站点，也不跳过污染提示。迁移：已有设置保持原值（下次保存时记为 `settingsVersion` 2）；内置只读规则开始生效，包括原本开启了完全访问的用户。
- **会话污染**：任何成功的浏览器结果（页面读取、快照、提取、控制台/网络读取，以及引用页面内容的操作结果）或注入会话的跟随快照都会污染该会话，直到用户在侧栏横幅上点击**清除**。污染期间，即使开启完全访问或受信任 origin，以下操作也会询问：URL 携带被 URL 风险分析标出的数据时跳转/新开到与上次读取页面不同的 origin；向内容来源之外的 origin 的字段输入或粘贴；剪贴板写入；文件写入（`browser_save_pdf`、`browser_extract { saveTo }`）；上传。在 dsh 一侧，同一会话的宿主工具变为只读：除只读文件工具、规划/提问工具和 `browser_*` 外一律拒绝（命令行、文件写入、`web_fetch`、子代理、定时任务、MCP/插件工具），由单调的工具守卫执行。宿主侧污染保存在内存中，宿主重启即遗忘（扩展侧污染保存在 `chrome.storage.session`）。
- **严格模式**（仅 Chrome，在设置中按站点开启，或经策略端口按会话开启）：调试器在该标签页启用 CDP Fetch 域。代理调用期间（或其后 3 秒内）发出的 POST/PUT/PATCH/DELETE 和表单提交会等待一张卡片「将向 <origin/路径> 发送 <字段，敏感字段已遮盖>」；GET/HEAD/OPTIONS 以及代理回合之外用户自己的提交直接放行。拒绝、超时（120 秒）或没有侧栏都会让请求失败。若无法布设拦截，该标签页上的代理调用会被拒绝。无法拦截：WebSocket 消息、在被暂停页面目标之外发出的 `navigator.sendBeacon`/keepalive 请求、进程外（跨站）iframe 和 Service Worker 的请求。布设期间 Chrome 会显示调试提示条。Firefox 不可用（没有调试器 API）——严格模式站点上的调用会被拒绝并给出说明。
- **企业托管策略**（`chrome.storage.managed`，schema 为 `managed-schema.json`；Firefox 从 `policies.json` 的 `3rdparty.extensions` 读取相同的键）：`siteRules`（高于所有用户规则的强制规则）、`disableDevTools`、`disableUnrestricted`、`disableScreenshots`、`enforceSiteDefaults`，以及 `allowedOrigins`（限定代理可读取、操作或跳转的网页 origin，其余一律拒绝）。托管值覆盖用户设置，包括之后的保存。哪些扩展 ID 可以连接属于桥接侧配置（桥接插件配置中的 `allowedChromeExtensionIds`），不是浏览器托管键。
- **侧栏外的回答**：策略强制的卡片（站点 `ask`、污染、严格模式）不会转发给 dsh 的审批服务，也不能通过系统通知或宿主转发的回答允许（拒绝仍然有效）；必须在侧栏中处理。站点策略的禁止会在任何卡片出现之前直接拒绝。

## 开发者工具（需显式开启，高权限）

开发者工具组通过 Chrome 调试协议（`chrome.debugger`）驱动受控标签页，因此可以查看并修改页面元素与 CSS、在页面自身上下文执行 JavaScript、以及抓取网络请求（含页面层拦截拿不可靠的响应正文）。

- **默认关闭**：用户通过设置或限定范围的会话授权之前，开发者工具调用会请求审批。弹窗提供仅允许一次、本对话中信任此 origin 的开发者工具、拒绝。授权只覆盖一个对话在一个 origin 上的调用，30 分钟后失效，标签页导航到其他 origin、最后一个侧栏关闭或 worker 重启时提前失效。`browser_console_eval` 始终显示完整代码并逐次确认，除非用户在该卡片上勾选「本对话中信任在 <origin> 上执行 JavaScript」；设置与开发者工具授权都不覆盖它。`includeSensitiveHeaders` / `includeSensitiveBody` 每次都需要单独确认，卡片会写明。**允许模型完全控制浏览器**开关与持久化 origin 白名单都不覆盖这一组。
- **持久授权**：设置里的**允许开发者工具**跨侧栏会话授权这一组工具（JavaScript 执行与关闭脱敏除外）。关闭设置会断开调试器并取消进行中的开发者工具调用，包括通过会话信任允许的调用。页面导航会取消旧文档尚未完成的审批。
- **每个标签页只允许一个调试器**：Chrome 会拒绝第二个调试器，因此附加期间浏览器自带的开发者工具无法在同一标签页打开。工具返回会说明原因并提示先关闭该标签页的 DevTools。
- **数据处理**：抓包只存在内存中，上限为 200 条请求与 500 条控制台记录，附加时与每次顶层导航时都会重置。`Authorization`、`Cookie`、`Set-Cookie` 等请求头默认显示为 `[redacted]`，除非某次调用显式选择；疑似认证 URL 的正文默认脱敏。
- **平台**：仅 Chrome。Firefox 构建不申请 `debugger` 权限，因此宿主也不会在该平台注册这一组工具。

## 权限说明

Chrome 使用 `sidePanel`，Firefox 使用 `sidebar_action`。两者都申请 `storage`（设置与最近会话）、`notifications`（可选的审批提醒）、`tabs` + `activeTab` + `scripting`（观察切页并向受控标签页注入脚本）、`webNavigation`（将操作绑定到 frame 文档）、`alarms`（后台保活）和 `<all_urls>` 主机权限。内容脚本在 HTTP(S) 页面运行。Chrome 还申请用于真实输入和开发者工具的 `debugger`，以及用于剪贴板操作的 `clipboardWrite` 和 `offscreen`。可选权限在首次使用时申请：`downloads`（`browser_downloads`），以及 Chrome 上的 `tabGroups`（为 `browser_fanout` 的标签页编组）和 `pageCapture`（MHTML 失败样例）。Firefox 不申请这些 Chrome 专用能力，只提供 `downloads`。`commands` 注册紧急停止快捷键（`Ctrl+Shift+K`，macOS 为 `Command+Shift+K`；Firefox 为 `Alt+Shift+K`），`storage.managed_schema`（Chrome）在 `managed-schema.json` 中声明企业策略键。Firefox AMO manifest 声明了发送给用户配置的 dsh/模型服务的浏览活动、网页内容与操作、对话内容。显式返回助手页面或调用 `browser_follow_tab { activate: true }` 可以激活标签页；手动切换标签页需要确认控制权交接。

## 已知限制

- 同时只有一个扩展连接桥。未打开侧栏的浏览器 Profile 不会抢占连接；另一个已打开的侧栏顶替连接后，被替换的一端会主动让权，不再反复重连互踢。
- 开发者工具需要 Chrome 125 以上、设置或会话授权或逐次审批，以及可用的调试连接。连接保持期间会显示 Chrome 的调试提示，包括网络抓包期间。
- 标签页绑定属于整个扩展连接，而不是单个对话会话。
- 可访问的跨源 iframe 会进入快照，并通过稳定的 `(frame, index)` 地址执行操作；受保护或已销毁的 frame 会标记为不可访问，不影响整页快照。
- 令牌无自动轮换。
- `browser_press` 的合成按键不触发浏览器原生默认行为，例如 Tab 焦点移动、方向键滚动或 Enter 激活。Chrome 的真实输入通道支持这些操作；Firefox 使用合成输入。
