# 线框工坊 / Wireframe Studio

Windows 桌面线框编辑器。用户定义信息层级、字号、对齐和组件关系，Codex 接收工程与设计约束。

## 安装

从 [GitHub Releases](https://github.com/baobao2333/wireframe-studio/releases/latest) 下载 `Wireframe-Studio-Setup-<version>-x64.exe`。支持 Windows 10/11 x64，按当前用户安装，不依赖浏览器、Node.js 或开发服务器。

安装器与主程序使用 `CN=baobao2333` 的 Authenticode 自签名证书。此名称不是 GitHub 或微软认证的身份，证书不在 Windows 公共信任链中，仍可能显示“未知发布者”或 SmartScreen 提示。应用不会将证书导入系统信任根。安装前核对仓库及 Release 的 SHA-256；不要安装来源不明的文件。

## 编辑与导出

- GrapesJS 编辑引擎，基础组件、组合组件与“我的组件”库；支持拖动、嵌套、撤销、重做和富文本。
- 编辑信息层级、字号、间距、颜色、对齐和实现备注。
- 打开 `.wireframe` 和兼容 JSON；当前工程与组件库自动保存到当前 Windows 用户的应用数据目录。原浏览器版数据不会自动迁移，可先导出 `project.json` 再在桌面版打开。
- 导出 ZIP 包含 PNG、SVG、HTML、React TSX、工程 JSON、设计规范和 Codex 交接文本。导出代码是静态界面，不是已完成的业务应用。

## 图片识别

默认调用当前用户已安装并登录的本机 Codex，不另保存 API Key。图片会通过 Codex 发送到用户已配置的模型服务，并非纯离线识别；不修改全局模型或 provider 配置。模型使用与额度遵循用户的 Codex 账号和设置。

模型结果始终是待确认草稿，保留置信度与备注。复杂插画或棋盘可能只得到占位组件，须检查布局、文本与层级后再交给 Codex。

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
npm start
npm run package
```

安装器位于 `release/`，采用精简的 `build/desktop-app/` 运行时。OCR 由 `scripts/prepare-ocr.mjs` 从依赖复制。`npm run dev:web` 仅保留旧版迁移和开发预览，不用于桌面分发。

`npm run package` 供公开源码构建未签名开发包。发布者同步 `package.json` 和 `desktop/release.json`，使用 `npm run package:signed` 构建签名安装器，再生成签名清单。签名证书须已存在于本机当前用户的个人证书存储中，并匹配 `desktop/publisher.json`；缺少证书时签名构建失败，不会静默生成未签名发布包。当前证书私钥不可导出，不进入仓库；`assets/publisher.cer` 只包含公开证书。

```sh
npm run package:signed
node scripts/make-hot-update.mjs --version 1.0.6 --min-app-version 1.0.6 --tag v1.0.6 --output release --private-key .release-secrets/update-private-key.pem --native-path release/Wireframe-Studio-Setup-1.0.6-x64.exe --native-version 1.0.6
node scripts/verify-release.mjs
npm run test:signature -- --signed release/Wireframe-Studio-Setup-1.0.6-x64.exe
```

每个 Release 上传安装器、`.blockmap`、`latest.yml`、`renderer-<version>.zip`、`renderer-update.json` 和 `SHA256SUMS.txt`。私钥须单独备份。轮换公钥需要新桌面运行时，不能静默替换已有安装的信任根。

源码公开可查，暂未授予额外开源许可。依赖与 vendored 资源保留各自许可证。Electron 和 Chromium 的第三方许可随安装器提供。
