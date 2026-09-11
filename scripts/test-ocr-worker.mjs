import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryPrefix = "wireframe-ocr-worker-";
const resources = new Map([
  ["/ocr/shape-worker.js", path.join(root, "desktop/renderer/shape-worker.js")],
  ["/ocr/opencv.js", path.join(root, "node_modules/@techstark/opencv-js/dist/opencv.js")],
]);
const mainCsp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";
const workerCsp = "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self'";
const page = "<!doctype html><html><head><title>Worker check</title></head><body><script src='/check.js'></script></body></html>";
const script = `
(async () => {
  let worker;
  const report = (data) => { window.workerCheck = data; document.title = 'WORKER-CHECK-DONE'; };
  try {
    let mainEvalBlocked = false;
    try { new Function('return 1')(); } catch (error) { mainEvalBlocked = error.name === 'EvalError'; }
    const width = 400, height = 300;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    for (const [x,y,w,h] of [[40,30,160,60],[260,100,80,70],[35,160,200,2]]) {
      for (let row=y;row<y+h;row++) for(let col=x;col<x+w;col++) {
        const i=(row*width+col)*4;pixels[i]=pixels[i+1]=pixels[i+2]=30;
      }
    }
    worker = new Worker('/ocr/shape-worker.js');
    const result = new Promise((resolve,reject) => {
      worker.onerror = (event) => reject(Error(event.message));
      worker.onmessage = ({data}) => { if(data.type==='error') reject(Error(data.error)); else if(data.type==='result') resolve(data.boxes); };
    });
    worker.postMessage({width,height,pixels:pixels.buffer},[pixels.buffer]);
    const detached = pixels.byteLength === 0;
    const boxes = await result;
    report({origin:location.origin,href:location.href,mainEvalBlocked,detached,boxes});
  } catch (error) { report({error:String(error)}); }
  finally { worker?.terminate(); }
})();
`;

async function runElectron({ app, BrowserWindow, protocol }) {
  const dataPath = process.env.WIREFRAME_OCR_WORKER_TEST_USER_DATA;
  assert.ok(dataPath, "Run this check with: node scripts/test-ocr-worker.mjs");
  assert.equal(path.dirname(dataPath), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataPath).startsWith(temporaryPrefix));
  app.setName("Wireframe Worker CSP Check");
  app.setAppUserModelId("com.baobao2333.wireframe-studio.worker-check");
  app.setPath("userData", dataPath);
  app.disableHardwareAcceleration();
  protocol.registerSchemesAsPrivileged([{ scheme: "wireframe", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  await app.whenReady();
  protocol.handle("wireframe", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "studio" || request.method !== "GET") return new Response("Not found", { status: 404 });
    if (url.pathname === "/index.html") return new Response(page, { headers: { "Content-Type": "text/html", "Content-Security-Policy": mainCsp } });
    if (url.pathname === "/check.js") return new Response(script, { headers: { "Content-Type": "text/javascript", "Content-Security-Policy": mainCsp } });
    const resource = resources.get(url.pathname);
    if (!resource) return new Response("Not found", { status: 404 });
    return new Response(await readFile(resource), { headers: {
      "Content-Type": "text/javascript", "Content-Security-Policy": url.pathname === "/ocr/shape-worker.js" ? workerCsp : mainCsp,
    } });
  });
  const window = new BrowserWindow({ show: false, width: 500, height: 400,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  let timer;
  try {
    const completed = new Promise((resolve, reject) => {
      window.on("page-title-updated", (_event, title) => { if (title === "WORKER-CHECK-DONE") resolve(); });
      window.webContents.once("render-process-gone", (_event, details) => reject(Error(JSON.stringify(details))));
      timer = setTimeout(() => reject(Error("Hidden worker CSP check timed out")), 60000);
    });
    await window.loadURL("wireframe://studio/index.html");
    await completed;
    const result = await window.webContents.executeJavaScript("window.workerCheck");
    assert.equal(result.error, undefined);
    assert.equal(result.href, "wireframe://studio/index.html");
    assert.equal(result.mainEvalBlocked, true);
    assert.equal(result.detached, true);
    assert.equal(window.isVisible(), false);
    assert.equal(result.boxes.length, 3);
    for (const [x, y, w, h] of [[40, 30, 160, 60], [260, 100, 80, 70], [35, 160, 200, 2]]) {
      assert.ok(result.boxes.some(box => Math.abs(box.x - x) <= 2 && Math.abs(box.y - y) <= 2 && Math.abs(box.w - w) <= 2 && Math.abs(box.h - h) <= 2));
    }
    console.log(JSON.stringify({ passed: true, visible: false, ...result }));
  } finally { clearTimeout(timer); window.destroy(); }
}

async function launch() {
  const electron = (await import("electron")).default;
  await access(electron);
  for (const resource of resources.values()) await access(resource);
  const dataPath = await mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
  try {
    const env = { ...process.env, WIREFRAME_OCR_WORKER_TEST_USER_DATA: dataPath };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const child = spawn(electron, [filename], { cwd: root, env, stdio: "inherit", windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(Error("Electron worker check exceeded 90 seconds")); }, 90000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); if (code === 0) resolve(); else reject(Error(`Electron worker check failed (${signal || code})`)); });
    });
  } finally {
    assert.equal(path.dirname(dataPath), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataPath).startsWith(temporaryPrefix));
    await rm(dataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.versions.electron) {
  const electron = await import("electron");
  runElectron(electron).then(() => electron.app.exit(0), error => { console.error(error); electron.app.exit(1); });
} else {
  launch().catch(error => { console.error(error); process.exitCode = 1; });
}
