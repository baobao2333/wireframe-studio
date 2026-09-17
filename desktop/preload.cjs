// Sandboxed Electron preload supports the restricted CommonJS loader only.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel, callback) => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld(
  "wireframeDesktop",
  Object.freeze({
    info: () => call("app:info"),
    logAppend: (event) => call("logs:append", event),
    logStatus: () => call("logs:status"),
    logRecent: (limit) => call("logs:recent", limit),
    logFlush: () => call("logs:flush"),
    logReveal: () => call("logs:reveal"),
    storageGet: (key) => call("storage:get", key),
    storageSet: (key, value) => call("storage:set", key, value),
    openProject: () => call("project:open"),
    openImage: () => call("image:open"),
    saveProject: (project, saveAs) => call("project:save", project, saveAs),
    acceptProject: (path) => call("project:accept", path),
    onProject: (callback) => listen("project:opened", callback),
    saveExport: (filename, data) => call("export:save", filename, data),
    revealFile: (path) => call("file:reveal", path),
    copyText: (text) => call("clipboard:write", text),
    visionStart: (input) => call("vision:start", input),
    visionGet: (id) => call("vision:get", id),
    visionCancel: (id) => call("vision:cancel", id),
    updateCheck: () => call("update:check"),
    updateDownload: () => call("update:download"),
    updateApply: () => call("update:apply"),
    nativeUpdateDownload: () => call("native-update:download"),
    nativeUpdateApply: () => call("native-update:apply"),
    rendererReady: (version) => ipcRenderer.send("renderer:ready", version),
    closeReady: () => ipcRenderer.send("renderer:close-ready"),
    onCommand: (callback) => listen("app:command", callback),
    onUpdate: (callback) => listen("update:state", callback),
    controlStatus: () => call("control:status"),
    controlConfigure: (enabled) => call("control:configure", enabled),
    controlConnect: () => call("control:connect"),
    controlResult: (id, result) => call("control:result", id, result),
    onControlRequest: (callback) => listen("control:request", callback),
    onControlState: (callback) => listen("control:state", callback),
  }),
);
