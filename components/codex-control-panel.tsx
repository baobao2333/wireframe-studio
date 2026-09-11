"use client";

import { useId, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Loader2,
  Pause,
  Plug,
  RefreshCw,
  SquareTerminal,
  Unplug,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import styles from "./codex-control-panel.module.css";

export type CodexControlStatus = {
  enabled: boolean;
  ready: boolean;
  connected: boolean;
  busy: boolean;
  lastCommand?: {
    summary: string;
    at: string;
    status: "applied" | "failed";
  };
  error?: string;
};

export type CodexControlPanelProps = {
  status: CodexControlStatus | null;
  onConnect: () => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onRefresh: () => Promise<void>;
};

type Action = { kind: "connect" | "refresh" } | { kind: "toggle"; enabled: boolean };
const actionErrors = {
  connect: "未能连接 Codex，请重试。",
  refresh: "未能刷新连接状态，请重试。",
  toggle: "未能更改编辑权限，请重试。",
};

function connectionState(status: CodexControlStatus | null) {
  if (status?.busy) return { label: "执行中", tone: "busy", Icon: Loader2 };
  if (status?.ready && !status.enabled) return { label: "已暂停", tone: "paused", Icon: Pause };
  if (!status?.ready || !status.connected) return { label: "未连接", tone: "offline", Icon: Unplug };
  return { label: "可编辑", tone: "ready", Icon: CircleCheck };
}

function commandTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function CodexControlPanel({ status, onConnect, onToggle, onRefresh }: CodexControlPanelProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [failedAction, setFailedAction] = useState<Action | null>(null);
  const running = useRef(false);
  const permissionId = useId();
  const state = connectionState(status);
  const connected = Boolean(status?.ready && status.connected);
  const disabled = pending !== null || Boolean(status?.busy);
  const lastCommand = status?.lastCommand;
  const lastTime = lastCommand ? commandTime(lastCommand.at) : null;
  const error = failedAction ? actionErrors[failedAction.kind] : status?.error || null;
  const retryAction: Action = failedAction ?? { kind: "refresh" };
  const retryDisabled = pending !== null || (retryAction.kind !== "refresh"
    && (Boolean(status?.busy) || !status?.ready || (retryAction.kind === "connect" && connected)));

  async function run(action: Action) {
    if (running.current) return;
    running.current = true;
    setPending(action);
    setFailedAction(null);
    try {
      if (action.kind === "connect") await onConnect();
      else if (action.kind === "toggle") await onToggle(action.enabled);
      else await onRefresh();
    } catch {
      // Callback errors can contain local connection credentials or internal traces.
      setFailedAction(action);
    } finally {
      running.current = false;
      setPending(null);
    }
  }

  function changeOpen(value: boolean) {
    setOpen(value);
    if (value) void run({ kind: "refresh" });
  }

  return (
    <TooltipProvider delayDuration={250}>
      <Dialog open={open} onOpenChange={changeOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" className={styles.trigger}
                aria-label={`本机 Codex：${state.label}${error ? "，操作未完成" : ""}`}>
                <SquareTerminal size={17} aria-hidden="true" />
                <span className={styles.statusDot} data-status={error ? "error" : state.tone} aria-hidden="true" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>本机 Codex · {state.label}</TooltipContent>
        </Tooltip>
        <DialogContent className={styles.panel} showCloseButton={false}>
          <header className={styles.heading}>
            <DialogTitle className={styles.title}>本机 Codex</DialogTitle>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon-sm" className={styles.iconButton}
                aria-label="关闭 Codex 面板" title="关闭">
                <X size={16} aria-hidden="true" />
              </Button>
            </DialogClose>
          </header>
          <DialogDescription className={styles.description}>
            {!status ? "尚未读取连接状态。" : !status.ready ? "连接服务未就绪，请刷新后重试。"
              : !status.enabled ? "当前工程的 Codex 编辑已暂停。"
                : connected ? "当前工程的编辑权限" : "等待本机 Codex 连接。"}
          </DialogDescription>
          <div className={styles.connectionRow}>
            <div className={styles.state} data-status={state.tone} role="status" aria-live="polite">
              <state.Icon size={17} className={status?.busy ? styles.spin : undefined} aria-hidden="true" />
              <strong>{state.label}</strong>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" className={styles.iconButton}
                  aria-label="刷新连接状态" aria-busy={pending?.kind === "refresh"} disabled={pending !== null}
                  onClick={() => void run({ kind: "refresh" })}>
                  <RefreshCw size={16} className={pending?.kind === "refresh" ? styles.spin : undefined} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={5}>刷新连接状态</TooltipContent>
            </Tooltip>
          </div>
          <Button type="button" className={styles.connect} disabled={disabled || !status?.ready || connected}
            onClick={() => void run({ kind: "connect" })}>
            {pending?.kind === "connect" ? <Loader2 size={16} className={styles.spin} aria-hidden="true" />
              : connected ? <Check size={16} aria-hidden="true" /> : <Plug size={16} aria-hidden="true" />}
            {pending?.kind === "connect" ? "正在连接" : connected ? "已连接 Codex" : "连接 Codex"}
          </Button>
          <div className={styles.permissionRow}>
            <label htmlFor={permissionId}>允许编辑</label>
            {pending?.kind === "toggle" && <Loader2 size={14} className={styles.spin} aria-label="正在更改编辑权限" />}
            <Switch id={permissionId} checked={status?.enabled ?? false} disabled={disabled || !status?.ready}
              onCheckedChange={(enabled) => void run({ kind: "toggle", enabled })} />
          </div>
          <section className={styles.lastCommand} aria-label="最后动作">
            <div className={styles.commandHeading}>
              <h3>最后动作</h3>
              {lastTime && <time dateTime={new Date(lastCommand!.at).toISOString()}>{lastTime}</time>}
            </div>
            {lastCommand ? <>
              <p className={styles.summary}>{lastCommand.summary}</p>
              <p className={styles.commandResult} data-failed={lastCommand.status === "failed"}>
                {lastCommand.status === "failed" ? <CircleAlert size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                {lastCommand.status === "failed" ? "未完成" : "已应用"}
              </p>
            </> : <p className={styles.empty}>暂无动作</p>}
          </section>
          {error && <div className={styles.error} role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <p>{error}</p>
            <Button type="button" variant="ghost" size="icon-sm" className={styles.iconButton}
              aria-label="重试失败操作" title="重试" disabled={retryDisabled}
              onClick={() => void run(retryAction)}>
              <RefreshCw size={16} aria-hidden="true" />
            </Button>
          </div>}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
