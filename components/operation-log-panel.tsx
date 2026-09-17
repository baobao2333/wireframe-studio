import { useEffect, useState } from "react";
import { ChevronRight, Download, FolderOpen, RefreshCw, ScrollText } from "lucide-react";
import { desktop } from "@/lib/desktop";
import type { OperationLogStatus, OperationRecord } from "@/lib/operation-log";
import styles from "./operation-log-panel.module.css";

const labels: Record<string, string> = {
  "component.drag.start": "开始拖动", "component.drag.end": "结束拖动", "component.drag.cancel": "取消拖动",
  "component.resize.start": "开始缩放", "component.resize.end": "结束缩放", "component.resize.cancel": "取消缩放",
  "component.update": "组件变化", "component.style": "样式变化", "component.add": "增加组件", "component.remove": "删除组件",
  selection: "选中组件", viewport: "画布视口", "project.save.start": "开始保存", "project.save": "保存完成",
  "project.load.start": "开始载入", "project.load": "载入完成", "project.failed": "工程操作失败",
  "history.undo": "撤销", "history.redo": "重做", "session.start": "启动", "session.end": "关闭", "renderer.ready": "界面就绪", "control.outcome": "Codex 操作",
};
const geometry = (value: OperationRecord["before"]) => value
  ? [value.x, value.y, value.width, value.height].map((n, index) => `${["X", "Y", "W", "H"][index]}=${n === null ? "?" : Math.round(n * 100) / 100}`).join(" ") : "";

export function OperationLogPanel() {
  const [status, setStatus] = useState<OperationLogStatus | null>(null);
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    if (!desktop?.logStatus) return;
    setBusy(true); setError("");
    try { setStatus(await desktop.logStatus()); setRecords(await desktop.logRecent(100)); }
    catch { setError("操作日志读取失败，工程数据不受影响。"); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!desktop?.logStatus) return;
    let active = true;
    void desktop.logStatus().then(async value => {
      if (active) setStatus(value);
      const recent = await desktop!.logRecent(100);
      if (active) setRecords(recent);
    }).catch(() => { if (active) setError("操作日志读取失败，工程数据不受影响。"); });
    return () => { active = false; };
  }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); }
    catch { setError("日志操作未完成，请刷新查看状态。"); }
    finally { setBusy(false); }
  }
  return <details className={styles.panel}>
    <summary><ChevronRight className={styles.chevron} size={14} /><ScrollText size={16} />本地操作日志</summary>
    {!desktop?.logStatus ? <p role="status">当前运行时不支持操作日志</p> : <>
      <div className={styles.toolbar}>
        <span role="status">{!status ? "读取中" : status.error ? `记录失败 · ${status.error}` : `本次启动 ${status.sequence} 条`}</span>
        <button title="刷新操作日志" aria-label="刷新操作日志" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} /></button>
        <button title="打开日志目录" aria-label="打开日志目录" disabled={busy} onClick={() => void run(() => desktop!.logReveal())}><FolderOpen size={16} /></button>
        <button title="导出最近 200 条日志" aria-label="导出最近 200 条日志" disabled={busy} onClick={() => void run(async () => {
          const recent = await desktop!.logRecent(200);
          await desktop!.saveExport("operation-log.json", new TextEncoder().encode(JSON.stringify(recent, null, 2)).buffer as ArrayBuffer);
        })}><Download size={16} /></button>
      </div>
      <p className={styles.session}>会话 {status?.sessionId || "-"}</p>
      <p className={styles.session}>最近 {records.length} 条 · 含历史会话 · 几何单位 px</p>
      <div className={styles.list} aria-label="最近操作记录">
        {records.length ? [...records].reverse().map(record => <div key={`${record.sessionId}:${record.sequence}`} className={styles.row}>
          <time dateTime={record.time} title={record.time}>{new Date(record.time).toLocaleDateString()}<br />{new Date(record.time).toLocaleTimeString()}</time>
          <span>{labels[record.event] || record.event}</span>
          <code>{record.componentId || record.code || ""}</code>
          {(record.before || record.after) && <code className={styles.geometry}>
            {geometry(record.before)}{record.before && record.after ? " -> " : ""}{geometry(record.after)}
            {record.viewport ? ` · ${Math.round(record.viewport.zoom * 100) / 100}%` : ""}
          </code>}
        </div>) : <p>暂无记录</p>}
      </div>
      {error && <p role="alert" className="update-warning">{error}</p>}
    </>}
  </details>;
}
