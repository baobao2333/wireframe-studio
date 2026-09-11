# 线框工坊 / Wireframe Studio

Windows 桌面线框编辑器。用户定义信息层级、字号、对齐和组件关系，Codex 接收工程与设计约束。

## 安装

从 [GitHub Releases](https://github.com/baobao2333/wireframe-studio/releases/latest) 下载 `Wireframe-Studio-Setup-<version>-x64.exe`。支持 Windows 10/11 x64，按当前用户安装，不依赖浏览器、Node.js 或开发服务器。

安装器与主程序使用 `CN=baobao2333` 的 Authenticode 自签名证书。此名称不是 GitHub 或微软认证的身份，证书不在 Windows 公共信任链中，仍可能显示“未知发布者”或 SmartScreen 提示。应用不会将证书导入系统信任根。安装前核对仓库及 Release 的 SHA-256；不要安装来源不明的文件。

## 编辑与导出

- GrapesJS 编辑引擎，基础组件、组合组件与“我的组件”库；支持拖动、嵌套、撤销、重做和富文本。
- 编辑信息层级、字号、间距、颜色、对齐和实现备注。
- 图标支持 Lucide 图标库或 Unicode / emoji 符号占位，含常用符号组件与专属编辑。符号随工程、组件库和导出代码保留；彩色 emoji 的形状与配色由系统字体决定，单色符号可以改色。
- 符号不自动折行。溢出时可主动使用“适配符号字号”，只缩小字号并支持撤销；不会自动改变用户定义的区域尺寸或字号。
- 图片用完整矩形与两条对角线占位，随组件宽高调整；识别图片占位保留原图主色，不再用小图片图标代替区域大小。
- 打开 `.wireframe` 和兼容 JSON；当前工程与组件库自动保存到当前 Windows 用户的应用数据目录。原浏览器版数据不会自动迁移，可先导出 `project.json` 再在桌面版打开。
- 导出 ZIP 包含 PNG、SVG、HTML、React TSX、工程 JSON、设计规范和 Codex 交接文本。导出代码是静态界面，不是已完成的业务应用。

## Codex 会话控制

在已安装的应用工具栏打开 Codex 面板，选择连接。应用备份当前 Codex 配置，只添加 `wireframe-studio` 本机 STDIO MCP 服务，不改模型、provider 或其他服务。Codex 重新加载 MCP 配置后，可直接读取当前工程和组件库，按组件 ID 修改文字、富文本、字号、颜色、位置、层级与备注，并增加、复制、删除组件。无需重新识别图片，也不额外调用图片生成模型。

控制默认关闭。面板可随时暂停；关闭应用后不可编辑。修改检查工程版本和锁定状态，拒绝过期请求和正在进行的手工编辑。每批操作占一个原生撤销步骤，自动保存失败会明确返回 `applied=true, saved=false`，不能当作未执行重复提交。自动保存针对应用工程副本，另存的 `.wireframe` 文件仍由用户主动保存。

默认只读取精简结构，不返回原图或 HTML；需要看效果时单独获取 PNG 预览。连接只监听本机，使用每次启停轮换的令牌。配置已存在但指向其他程序时不会覆盖。不要手动公开应用数据目录中的 `control/connection.json`。

控制入口为安装目录中的 `resources/app.asar/control/entry.mjs`，使用应用自身 EXE 和仅对此子进程设置的 `ELECTRON_RUN_AS_NODE=1` 启动。`--codex-control` 从标准输入接收 `{ "tool": "wireframe_get_state", "args": {} }`，向标准输出返回 JSON。写操作需要最新 `expectedRevision` 和唯一 `requestId`；重试同一操作时保持 ID 不变。`--codex-mcp` 是 Codex 配置使用的常驻 STDIO 模式。两种模式均不新开编辑器窗口；Windows GUI 模式不用于 STDIO。

## 图片识别

默认调用当前用户已安装并登录的本机 Codex，不另保存 API Key。图片会通过 Codex 发送到用户已配置的模型服务，并非纯离线识别；不修改全局模型或 provider 配置。模型使用与额度遵循用户的 Codex 账号和设置。

识别子任务使用 `medium` 推理强度，并按实际 MCP 列表逐一禁用外部工具；这些覆盖只作用于该次识别。5 分钟时保留等待，不直接丢弃任务，10 分钟仍未收到完整结果才停止；用户始终可取消。失败信息区分已观测到的额度、登录和连接问题，不把所有失败都归为图片过大。

应用数据目录的 `vision/diagnostics` 最多保留 100 条任务摘要，仅包含任务 ID、时间、阶段、事件计数、输出字符数和错误类别等诊断字段，不保存原图、文件名、正文、模型推理或密钥。原图和结果临时文件仍在任务结束后删除。

模型结果始终是待确认草稿，保留置信度与备注。复杂插画或棋盘可能只得到占位组件，须检查布局、文本与层级后再交给 Codex。

新识别初稿会从原图局部取样校准颜色，保留画布背景，区分文字描边与组件边框。渐变和复杂图片仅保留主色近似，不是原图片内容。文字按可用字体实际测量，并保留原图显式换行；最多缩小 20% 来校准字体差异，仍放不下时保留字号并记录待确认原因，不改文字或区域尺寸。已保存、已确认和手工组件不自动校准。属性面板可切换换行方式并编辑文字描边。

识别面板显示准备、模型识别、组件校验和完成阶段，以及已用时、最近事件、本机服务响应和超时剩余时间。阶段来自实际任务与 Codex JSONL 事件，不估算模型完成百分比；长时间没有新事件不等于连接已断开。进度中不展示模型推理或原始消息内容。

不使用模型时，可显式选择本机 OCR。识别引擎与中英文语言包随安装器提供，无需联网下载。临时模型输入输出在任务结束后清理；工程中的参考图片随用户主动保存或导出。

## 更新

“帮助 > 应用与更新”检查固定 GitHub Releases 源。启动时也检查，但不强制安装。

- 界面热更新：Ed25519 验签、SHA-256 和压缩包路径/大小校验，通过后保存工程并重载界面。
- 新界面启动未确认或异常退出时回退上一版本，更新前保留工程备份。
- 运行时更新：下载 NSIS 安装包，核对已签名清单中的版本与 SHA-256，并通过 Windows Authenticode 核对固定证书。下载结束与安装前都重新验证，用户确认后安装并重新启动。

Ed25519 更新签名不等同于 Windows Authenticode 的公共 CA 身份认证。自签名更新只接受固定证书，不能仅靠相同用户名通过；只有 Windows 验证成功或精确的自签名根不受信任结果可接受，文件篡改等其他错误仍会拒绝。发布私钥不在仓库、安装器或 CI 中。GitHub 不可用时仍可编辑本地工程。

## 构建

需要 Node.js >=24 和 Windows x64。

```sh
npm ci
npm test
npm run test:desktop
npm run lint
npx tsc --noEmit
npm run build
npm run test:control
npm start
npm run package
```

安装器位于 `release/`，采用精简的 `build/desktop-app/` 运行时。OCR 由 `scripts/prepare-ocr.mjs` 从依赖复制。`npm run dev:web` 仅保留旧版迁移和开发预览，不用于桌面分发。

`npm run package` 供公开源码构建未签名开发包。发布者同步 `package.json` 和 `desktop/release.json`，使用 `npm run package:signed` 构建签名安装器，再生成签名清单。签名证书须已存在于本机当前用户的个人证书存储中，并匹配 `desktop/publisher.json`；缺少证书时签名构建失败，不会静默生成未签名发布包。当前证书私钥不可导出，不进入仓库；`assets/publisher.cer` 只包含公开证书。

```sh
npm run package:signed
node scripts/make-hot-update.mjs --version 1.1.1 --min-app-version 1.1.1 --tag v1.1.1 --output release --private-key .release-secrets/update-private-key.pem --native-path release/Wireframe-Studio-Setup-1.1.1-x64.exe --native-version 1.1.1
node scripts/verify-release.mjs
npm run test:signature -- --signed release/Wireframe-Studio-Setup-1.1.1-x64.exe
```

每个 Release 上传安装器、`.blockmap`、`latest.yml`、`renderer-<version>.zip`、`renderer-update.json` 和 `SHA256SUMS.txt`。私钥须单独备份。轮换公钥需要新桌面运行时，不能静默替换已有安装的信任根。

解包构建位于 `release/native-<version>/win-unpacked`，安装器等分发文件仍位于 `release`。构建新版本不会覆盖正在运行的旧候选目录。

源码公开可查，暂未授予额外开源许可。依赖与 vendored 资源保留各自许可证。Electron 和 Chromium 的第三方许可随安装器提供。
