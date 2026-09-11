import { useEffect, useState } from "react";
import { AlertCircle, Check, Circle, Loader2, X } from "lucide-react";
import type { ModelProgress } from "@/lib/model-client";

const steps = ["准备图片", "模型识别", "校验组件", "完成"];
const stageIndex = { starting: 0, recognizing: 1, receiving: 1, validating: 2, complete: 3 };
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};

export function RecognitionProgress({ progress, onCancel }: {
  progress: ModelProgress;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(progress.observedAt);
  const running = progress.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const tick = running ? Math.max(0, now - progress.observedAt) : 0;
  const elapsed = progress.elapsedMs + tick;
  const age = progress.activityAgeMs === null ? null : progress.activityAgeMs + tick;
  const remaining = progress.remainingMs === null ? null : Math.max(0, progress.remainingMs - tick);
  const serviceAge = progress.serviceSeenAt === null ? null : Math.max(0, Math.max(now, progress.observedAt) - progress.serviceSeenAt);
  const stalledService = running && serviceAge !== null && serviceAge >= 10000;
  const step = stageIndex[progress.stage];
  const StatusIcon = running ? Loader2 : progress.state === "complete" ? Check : progress.state === "failed" ? AlertCircle : X;
  return (
    <section className="recognition-progress" aria-label="模型识别进度" data-state={progress.state}>
      <div className="recognition-progress-heading">
        <div role="status" aria-live="polite">
          <StatusIcon size={16} className={running ? "spin" : undefined} />
          <strong>{progress.message}</strong>
        </div>
        <span className="recognition-elapsed">已用时 {duration(elapsed)}</span>
      </div>
      <ol className="recognition-steps" aria-label="识别阶段">
        {steps.map((label, index) => {
          const done = progress.state === "complete" || index < step;
          const active = running && index === step;
          const Icon = done ? Check : active ? Loader2 : Circle;
          return <li key={label} data-state={done ? "done" : active ? "active" : "pending"} aria-current={active ? "step" : undefined}>
            <Icon size={14} className={active ? "spin" : undefined} /><span>{label}</span>
          </li>;
        })}
      </ol>
      <dl className="recognition-activity">
        <div><dt>最近事件</dt><dd>{age === null ? "尚未收到" : age < 1000 ? "刚刚" : `${Math.floor(age / 1000)} 秒前`}</dd></div>
        <div><dt>已收事件</dt><dd>{progress.eventCount}</dd></div>
        {progress.outputChars > 0 && <div><dt>已收结果</dt><dd>{progress.outputChars.toLocaleString()} 字符</dd></div>}
        {progress.nodeCount !== null && <div><dt>组件</dt><dd>{progress.nodeCount}</dd></div>}
      </dl>
      {progress.warning && <p className="recognition-warning" role="status">{progress.warning}</p>}
      {running && <>
        <p className={stalledService ? "recognition-warning" : "recognition-service"}>
          {stalledService ? "本机服务响应中断，尚不能确认任务状态。" : serviceAge === null ? "等待本机服务响应" : "本机服务有响应"}
          {remaining !== null && <span>超时剩余 {duration(remaining)}</span>}
        </p>
        {!stalledService && step === 1 && age !== null && age >= 30000 && <p className="recognition-waiting">模型尚未返回新事件，仍在等待结果。</p>}
        {step === 1 && elapsed >= 300000 && remaining !== null && <p className="recognition-warning">已超过 5 分钟，尚未收到完整结果。不会在此时中断；达到等待上限后停止，也可现在取消。</p>}
        <button type="button" className="cancel-parse" onClick={onCancel}><X size={14} />取消解析</button>
      </>}
    </section>
  );
}
