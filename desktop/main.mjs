import {
  app,
  BrowserWindow,
  Menu,
  protocol,
  ipcMain,
  dialog,
  shell,
  clipboard,
  net,
  session,
  nativeImage,
} from "electron";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve, extname, sep, basename } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import updaterPackage from "electron-updater";
import { createStorage, atomicJson } from "./storage.mjs";
import { createVisionService } from "./vision-service.mjs";
import { createHotUpdater } from "./hot-update.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const release = JSON.parse(
  await readFile(join(directory, "release.json"), "utf8"),
);
const origin = "wireframe://studio",
  repoUrl = `https://github.com/${release.repository}`;
const resourceRoot = app.isPackaged
  ? process.resourcesPath
  : resolve(directory, "..");
const bundledRoot = app.isPackaged
  ? join(app.getAppPath(), "renderer")
  : join(resourceRoot, "dist-renderer");
const icon = app.isPackaged
  ? join(process.resourcesPath, "app.ico")
  : join(resourceRoot, "assets", "app.ico");
app.setName("Wireframe Studio");
app.setAppUserModelId("com.baobao2333.wireframe-studio");
if (process.env.WIREFRAME_TEST_USER_DATA)
  app.setPath("userData", resolve(process.env.WIREFRAME_TEST_USER_DATA));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "wireframe",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);
if (!app.requestSingleInstanceLock()) app.quit();
else
  void start().catch((error) => {
    console.error(error);
    dialog.showErrorBox("线框工坊启动失败", error.message);
    app.exit(1);
  });

async function start() {
  let window,
    allowClose = false,
    currentProjectPath = null,
    bootTimer,
    rendererCrashed = false;
  const knownFiles = new Set(),
    pendingOpen = [],
    pendingAcceptance = new Set();
  let rendererIsReady = false;
  const userData = app.getPath("userData");
  await mkdir(userData, { recursive: true });
  const storage = createStorage(join(userData, "documents"));
  const vision = createVisionService({
    runtimeDir: join(userData, "vision", "jobs"),
    instructionsPath: app.isPackaged
      ? join(resourceRoot, "vision-instructions.txt")
      : join(resourceRoot, "server", "vision-instructions.txt"),
  });
  let nativeUpdate = { status: "idle" },
    nativeExpected,
    nativeDownloaded;
  async function verifyInstaller(file, expected) {
    const info = await stat(file);
    if (info.size !== expected.size) throw Error("安装包大小校验失败");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== expected.sha256)
      throw Error("安装包完整性校验失败");
  }
  const send = (channel, value) => {
    if (window && !window.isDestroyed())
      window.webContents.send(channel, value);
  };
  await app.whenReady();
  const hot = await createHotUpdater({
    appVersion: release.appVersion,
    bundledVersion: release.rendererVersion,
    bundledRoot,
    userDataDir: userData,
    publicKeyPath: join(directory, "update-public-key.pem"),
    fetchImpl: (url, options) => net.fetch(url, options),
    onState: (state) => send("update:state", state),
  });
  const autoUpdater = updaterPackage.autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({
    provider: "github",
    owner: release.repository.split("/")[0],
    repo: release.repository.split("/")[1],
  });
  autoUpdater.on("error", (error) => {
    nativeUpdate = { status: "error", error: error.message };
  });
  autoUpdater.on("download-progress", (p) => {
    nativeUpdate = { status: "downloading", percent: p.percent };
  });
  autoUpdater.on("update-downloaded", async (info) => {
    try {
      const expected = nativeExpected;
      if (!expected || expected.version !== info.version)
        throw Error("安装包版本未通过签名清单校验");
      await verifyInstaller(info.downloadedFile, expected);
      nativeDownloaded = info.downloadedFile;
      nativeUpdate = { status: "ready", version: info.version };
    } catch (e) {
      nativeDownloaded = null;
      nativeUpdate = { status: "error", error: e.message };
    }
  });
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".gz": "application/gzip",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
  };
  protocol.handle("wireframe", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "studio" || request.method !== "GET")
        return new Response("Not found", { status: 404 });
      const pathname = decodeURIComponent(url.pathname),
        ocr = pathname.startsWith("/ocr/");
      const root = ocr
        ? app.isPackaged
          ? join(resourceRoot, "ocr")
          : join(resourceRoot, "public", "ocr")
        : hot.getActiveRoot();
      const relative = ocr
        ? pathname.slice(5)
        : pathname === "/"
          ? "index.html"
          : pathname.slice(1);
      const file = resolve(root, relative);
      if (!file.startsWith(resolve(root) + sep))
        return new Response("Forbidden", { status: 403 });
      const data = await readFile(file);
      return new Response(data, {
        headers: {
          "Content-Type": types[extname(file)] || "application/octet-stream",
          "Content-Security-Policy": [
            "/ocr/shape-worker.js",
            "/ocr/worker.min.js",
          ].includes(pathname)
            ? "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob:; worker-src 'self';"
            : "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' about:; object-src 'none'; base-uri 'self'; form-action 'none'",
          "Cache-Control": "no-cache",
        },
      });
    } catch (e) {
      return new Response(
        e.code === "ENOENT" ? "Not found" : "Resource error",
        { status: e.code === "ENOENT" ? 404 : 500 },
      );
    }
  });
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  function trusted(event) {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !event.senderFrame.url.startsWith(origin + "/")
    )
      throw Error("拒绝非应用界面的请求");
  }
  const handle = (name, fn) =>
    ipcMain.handle(name, async (event, ...args) => {
      trusted(event);
      return fn(...args);
    });
  async function openProjectPath(path) {
    const size = (await stat(path)).size;
    if (size > 32 * 1024 * 1024) throw Error("工程文件超过 32 MB");
    const content = await readFile(path, "utf8");
    JSON.parse(content);
    await storage.backup();
    pendingAcceptance.add(path);
    knownFiles.add(path);
    return { name: basename(path), content, path };
  }
  handle("app:info", async () => ({
    version: release.appVersion,
    rendererVersion: hot.getState().currentVersion,
    dataPath: userData,
    projectPath: currentProjectPath,
    codex: await vision.status(),
    updates: hot.getState(),
    nativeUpdate,
    repository: repoUrl,
    platform: process.platform,
  }));
  handle("storage:get", (key) => storage.get(key));
  handle("storage:set", (key, value) => storage.set(key, value));
  handle("project:open", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "打开线框工程",
      properties: ["openFile"],
      filters: [{ name: "线框工程", extensions: ["wireframe", "json"] }],
    });
    return result.canceled ? null : openProjectPath(result.filePaths[0]);
  });
  handle("project:accept", async (path) => {
    if (path !== null && !pendingAcceptance.has(path))
      throw Error("此工程尚未通过打开操作授权");
    if (path === null) await storage.backup();
    currentProjectPath = path;
    pendingAcceptance.clear();
  });
  handle("project:save", async (project, saveAs) => {
    if (!project || project.format !== "wireframe-studio")
      throw Error("工程格式无效");
    let path = currentProjectPath;
    if (saveAs || !path) {
      const result = await dialog.showSaveDialog(window, {
        title: "保存线框工程",
        defaultPath: join(
          app.getPath("documents"),
          `${safeName(project.meta?.name || "未命名界面")}.wireframe`,
        ),
        filters: [{ name: "线框工程", extensions: ["wireframe"] }],
      });
      if (result.canceled || !result.filePath) return null;
      path = result.filePath;
    }
    await atomicJson(path, project);
    currentProjectPath = path;
    knownFiles.add(path);
    return { path };
  });
  handle("export:save", async (filename, data) => {
    if (
      typeof filename !== "string" ||
      !/^.{1,120}\.(zip|png|svg|html|json)$/.test(filename) ||
      filename !== safeName(filename)
    )
      throw Error("导出文件名无效");
    const bytes = Buffer.from(data);
    if (bytes.length > 64 * 1024 * 1024) throw Error("导出文件超过 64 MB");
    const result = await dialog.showSaveDialog(window, {
      title: "导出给 Codex",
      defaultPath: join(app.getPath("documents"), filename),
      filters: [
        {
          name: extname(filename).slice(1).toUpperCase(),
          extensions: [extname(filename).slice(1)],
        },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, bytes);
    knownFiles.add(result.filePath);
    return { path: result.filePath };
  });
  handle("file:reveal", (path) => {
    if (!knownFiles.has(path)) throw Error("只能打开本次工程或导出文件的位置");
    shell.showItemInFolder(path);
  });
  handle("clipboard:write", (text) => {
    if (typeof text !== "string" || text.length > 4 * 1024 * 1024)
      throw Error("复制内容过大");
    clipboard.writeText(text);
  });
  handle("vision:start", (input) => vision.start(input));
  handle("image:open", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择界面截图",
      properties: ["openFile"],
      filters: [
        { name: "界面截图", extensions: ["png", "jpg", "jpeg", "webp"] },
      ],
    });
    if (result.canceled) return null;
    const path = result.filePaths[0];
    if ((await stat(path)).size > 20 * 1024 * 1024)
      throw Error("图片不能超过 20 MB");
    const bytes = await readFile(path);
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp =
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
    if (!png && !jpeg && !webp)
      throw Error("请选择有效的 PNG、JPG 或 WebP 图片");
    return {
      name: basename(path),
      type: png ? "image/png" : jpeg ? "image/jpeg" : "image/webp",
      data: Uint8Array.from(bytes).buffer,
    };
  });
  handle("vision:get", (id) => vision.get(id));
  handle("vision:cancel", (id) => vision.cancel(id));
  handle("update:check", () => hot.check());
  handle("update:download", () => hot.download());
  let recovering = false;
  async function recoverRenderer(reason) {
    if (recovering) return;
    recovering = true;
    clearTimeout(bootTimer);
    try {
      await hot.rollback(reason);
      await reloadRenderer();
    } catch (e) {
      dialog.showErrorBox("无法恢复界面", e.message);
    } finally {
      recovering = false;
    }
  }
  async function reloadRenderer() {
    rendererIsReady = false;
    clearTimeout(bootTimer);
    if (hot.getState().pending)
      bootTimer = setTimeout(
        () =>
          void recoverRenderer("新界面未在 20 秒内完成启动，已恢复上一版本"),
        20000,
      );
    try {
      await window.loadURL(origin + "/index.html");
    } catch (e) {
      if (hot.getState().pending)
        await recoverRenderer(`新界面载入失败：${e.message}`);
      else throw e;
    }
  }
  handle("update:apply", async () => {
    if (vision.isBusy()) throw Error("请先完成或取消图片识别");
    await storage.flush();
    await storage.backup();
    await hot.apply();
    setImmediate(
      () =>
        void reloadRenderer().catch((e) =>
          dialog.showErrorBox("界面更新失败", e.message),
        ),
    );
  });
  handle("native-update:download", async () => {
    if (!app.isPackaged) throw Error("请在已安装的应用中更新运行时");
    const expected = hot.getState().native;
    if (!expected) throw Error("没有通过验签的安装包信息");
    if (["checking", "downloading"].includes(nativeUpdate.status))
      throw Error("安装包正在下载");
    nativeExpected = { ...expected };
    nativeDownloaded = null;
    nativeUpdate = { status: "checking" };
    try {
      const info = await autoUpdater.checkForUpdates();
      if (
        info?.updateInfo.version !== expected.version ||
        !info.updateInfo.files.some(
          (f) =>
            decodeURIComponent(f.url.split("/").pop()) === expected.filename,
        )
      )
        throw Error("GitHub 安装包与签名清单不一致");
      await autoUpdater.downloadUpdate();
    } catch (e) {
      nativeUpdate = { status: "error", error: e.message };
      throw e;
    }
  });
  handle("native-update:apply", async () => {
    if (nativeUpdate.status !== "ready" || !nativeDownloaded || !nativeExpected)
      throw Error("安装包尚未就绪");
    if (vision.isBusy()) throw Error("请先完成或取消图片识别");
    await verifyInstaller(nativeDownloaded, nativeExpected);
    await storage.flush();
    await storage.backup();
    await vision.dispose();
    allowClose = true;
    autoUpdater.quitAndInstall(false, true);
  });
  async function deliverOpen() {
    while (rendererIsReady && pendingOpen.length) {
      try {
        send("project:opened", await openProjectPath(pendingOpen.shift()));
      } catch (e) {
        dialog.showErrorBox("未能打开工程", e.message);
      }
    }
  }
  ipcMain.on("renderer:ready", async (event) => {
    try {
      trusted(event);
      clearTimeout(bootTimer);
      await hot.confirmBoot(hot.getState().currentVersion);
      rendererCrashed = false;
      rendererIsReady = true;
      await deliverOpen();
    } catch (e) {
      console.error(e);
    }
  });
  async function finishClose() {
    try {
      await storage.flush();
      await vision.dispose();
      allowClose = true;
      app.quit();
    } catch (e) {
      dialog.showErrorBox("未能保存工程", e.message);
    }
  }
  ipcMain.on("renderer:close-ready", async (event) => {
    try {
      trusted(event);
      await finishClose();
    } catch (e) {
      console.error(e);
    }
  });
  const command = (key) => () => send("app:command", key);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文件",
        submenu: [
          {
            label: "新建画布",
            accelerator: "CmdOrCtrl+N",
            click: command("new"),
          },
          {
            label: "打开工程…",
            accelerator: "CmdOrCtrl+O",
            click: command("open"),
          },
          { type: "separator" },
          {
            label: "保存工程",
            accelerator: "CmdOrCtrl+S",
            click: command("save"),
          },
          {
            label: "另存为…",
            accelerator: "CmdOrCtrl+Shift+S",
            click: command("save-as"),
          },
          {
            label: "导出给 Codex…",
            accelerator: "CmdOrCtrl+Shift+E",
            click: command("export"),
          },
          { type: "separator" },
          { label: "退出", click: () => window.close() },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { label: "撤销", accelerator: "CmdOrCtrl+Z", click: command("undo") },
          {
            label: "重做",
            accelerator: "CmdOrCtrl+Shift+Z",
            click: command("redo"),
          },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
        ],
      },
      {
        label: "视图",
        submenu: [
          {
            label: "适应画布",
            accelerator: "CmdOrCtrl+0",
            click: command("fit"),
          },
          { role: "togglefullscreen", label: "全屏" },
        ],
      },
      {
        label: "帮助",
        submenu: [
          { label: "应用与更新…", click: command("updates") },
          {
            label: "GitHub 项目主页",
            click: () => shell.openExternal(repoUrl),
          },
          {
            label: "安装 Codex",
            click: () => shell.openExternal("https://openai.com/codex/"),
          },
        ],
      },
    ]),
  );
  let bounds = { width: 1440, height: 940 };
  try {
    const b = JSON.parse(await readFile(join(userData, "window.json"), "utf8"));
    if (b.width >= 1000 && b.height >= 680)
      bounds = {
        width: Math.min(b.width, 2200),
        height: Math.min(b.height, 1400),
      };
  } catch (e) {
    if (e.code !== "ENOENT")
      console.error("Window state unavailable:", e.message);
  }
  window = new BrowserWindow({
    ...bounds,
    minWidth: 1000,
    minHeight: 680,
    title: "线框工坊",
    icon: nativeImage.createFromPath(icon),
    backgroundColor: "#f7f8fa",
    show: false,
    webPreferences: {
      preload: join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  if (process.env.WIREFRAME_TEST_TITLE) {
    window.setTitle(process.env.WIREFRAME_TEST_TITLE);
    window.on("page-title-updated", (event) => event.preventDefault());
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin + "/")) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error("Renderer:", event.message);
  });
  window.webContents.on("render-process-gone", () => {
    rendererCrashed = true;
    if (hot.getState().pending)
      void recoverRenderer("界面进程异常退出，已恢复上一版本");
    else
      dialog.showErrorBox(
        "界面进程异常退出",
        "请重新启动应用，最近一次成功保存的工程保留在本机。",
      );
  });
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (!allowClose) {
      event.preventDefault();
      if (rendererCrashed) void finishClose();
      else send("app:command", "close");
    }
  });
  window.on("resize", () => {
    if (!window.isMaximized())
      void atomicJson(join(userData, "window.json"), window.getBounds()).catch(
        (e) => console.error(e.message),
      );
  });
  app.on("second-instance", (_event, argv) => {
    const file = argv.find((a) => /\.wireframe$/i.test(a));
    if (file) {
      pendingOpen.push(resolve(file));
      void deliverOpen();
    }
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("before-quit", (event) => {
    if (!allowClose) {
      event.preventDefault();
      if (rendererCrashed) void finishClose();
      else send("app:command", "close");
    }
  });
  const initial = process.argv.find((a) => /\.wireframe$/i.test(a));
  if (initial) pendingOpen.push(resolve(initial));
  await reloadRenderer();
  setTimeout(
    () =>
      void hot
        .check()
        .catch((error) => console.error("Update check:", error.message)),
    8000,
  ).unref();
}
function safeName(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 120);
}
