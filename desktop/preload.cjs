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
    rendererReady: () => ipcRenderer.send("renderer:ready"),
    closeReady: () => ipcRenderer.send("renderer:close-ready"),
    onCommand: (callback) => listen("app:command", callback),
    onUpdate: (callback) => listen("update:state", callback),
  }),
);
