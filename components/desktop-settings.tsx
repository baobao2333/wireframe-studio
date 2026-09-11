import { useEffect, useState } from "react";
import {
  Download,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { desktop, type DesktopInfo, type UpdateState } from "@/lib/desktop";

const labels: Record<string, string> = {
  idle: "暂无可用界面更新",
  checking: "正在检查更新",
  available: "有新版本",
  downloading: "正在下载",
  ready: "更新已校验",
  applied: "更新已应用",
  incompatible: "需要先升级桌面运行时",
  error: "更新未完成",
};
export function DesktopSettings({
  open,
  onOpenChange,
  beforeApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  beforeApply: () => Promise<void>;
}) {
  const [info, setInfo] = useState<DesktopInfo | null>(null),
    [state, setState] = useState<UpdateState | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open || !desktop) return;
    let active = true;
    const refresh = () =>
      void desktop!
        .info()
        .then((value) => {
          if (active) {
            setInfo(value);
            setState(value.updates);
          }
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    refresh();
    const timer = setInterval(refresh, 2000),
      unsubscribe = desktop.onUpdate(setState);
    return () => {
      active = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [open]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      const next = await desktop!.info();
      setInfo(next);
      setState(next.updates);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const native = info?.nativeUpdate,
    nativeAvailable = state?.native && state.native.version !== info?.version;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent className="studio-dialog desktop-settings">
        <DialogTitle>应用与更新</DialogTitle>
        <DialogDescription>线框工坊 · Wireframe Studio</DialogDescription>
        <dl className="app-details">
          <div>
            <dt>桌面运行时</dt>
            <dd>{info?.version || "读取中"}</dd>
          </div>
          <div>
            <dt>界面版本</dt>
            <dd>{info?.rendererVersion || "读取中"}</dd>
          </div>
          <div>
            <dt>本机 Codex</dt>
            <dd>
              {info ? (info.codex.available ? "已找到" : "未安装") : "读取中"}
            </dd>
          </div>
          <div>
            <dt>工程存储</dt>
            <dd>{info?.dataPath || "读取中"}</dd>
          </div>
          <div>
            <dt>分发源</dt>
            <dd>baobao2333/wireframe-studio · GitHub Releases</dd>
          </div>
        </dl>
        <section className="update-section">
          <h3>
            <ShieldCheck size={16} />
            界面热更新
          </h3>
          <p role="status">
            {state ? labels[state.status] || state.status : "读取中"}
            {state?.availableVersion ? ` · ${state.availableVersion}` : ""}
          </p>
          {state?.status === "downloading" && (
            <progress
              max={100}
              value={state.progress?.percent || 0}
              aria-label="界面更新下载进度"
            />
          )}
          {state?.rollbackReason && (
            <p className="update-warning">{state.rollbackReason}</p>
          )}
          {state?.error && (
            <p className="update-warning">{state.error.message}</p>
          )}
          <div className="update-actions">
            <button
              className="command"
              disabled={busy || state?.status === "downloading"}
              onClick={() => void run(() => desktop!.updateCheck())}
            >
              <RefreshCw size={16} />
              检查更新
            </button>
            {state?.status === "available" && (
              <button
                className="command primary"
                disabled={busy}
                onClick={() => void run(() => desktop!.updateDownload())}
              >
                <Download size={16} />
                下载 {state.availableVersion}
              </button>
            )}
            {state?.status === "ready" && (
              <button
                className="command primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await beforeApply();
                    await desktop!.updateApply();
                  })
                }
              >
                <RotateCw size={16} />
                保存并更新界面
              </button>
            )}
          </div>
        </section>
        {nativeAvailable && (
          <section className="update-section">
            <h3>桌面运行时 {state!.native!.version}</h3>
            <p>
              {native?.status === "ready"
                ? "安装包已通过完整性校验"
                : native?.status === "downloading"
                  ? `正在下载 · ${Math.round(native.percent || 0)}%`
                  : "可升级运行时，安装后自动重新启动"}
            </p>
            {native?.error && <p className="update-warning">{native.error}</p>}
            <button
              className="command"
              disabled={busy || native?.status === "downloading"}
              onClick={() =>
                void run(async () => {
                  if (native?.status === "ready") {
                    await beforeApply();
                    await desktop!.nativeUpdateApply();
                  } else await desktop!.nativeUpdateDownload();
                })
              }
            >
              {native?.status === "ready" ? (
                <RotateCw size={16} />
              ) : (
                <Download size={16} />
              )}{" "}
              {native?.status === "ready"
                ? "保存并安装运行时"
                : "下载运行时更新"}
            </button>
          </section>
        )}
        {busy && (
          <p className="update-pending">
            <Loader2 className="spin" size={16} />
            正在处理
          </p>
        )}
        {error && (
          <p role="alert" className="update-warning">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
