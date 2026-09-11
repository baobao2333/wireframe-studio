import {
  recognitionProject,
  type Project,
} from "./wireframe";
import { desktop, type VisionJob, type VisionProgress } from "./desktop";
import { refineRecognitionDraft } from "./recognition-refinement";
type ImageInput = { src: string; name: string; width: number; height: number };
export type ModelProgress = VisionProgress & {
  state: "running" | "complete" | "cancelled" | "failed";
  message: string;
  elapsedMs: number;
  observedAt: number;
  serviceSeenAt: number | null;
  remainingMs: number | null;
  taskId?: string;
};
export async function modelImage(
  image: ImageInput,
  width: number,
  signal: AbortSignal,
  onProgress: (progress: ModelProgress) => void,
): Promise<Project> {
  let id: string | undefined;
  const startedAt = Date.now();
  let progress: ModelProgress = {
    stage: "starting", state: "running", message: "准备图片与识别环境",
    elapsedMs: 0, observedAt: startedAt, serviceSeenAt: null, remainingMs: null,
    activityAgeMs: null, eventCount: 0, outputChars: 0, nodeCount: null,
    timeoutMs: 300000, warning: null,
  };
  const report = (update: Partial<ModelProgress>) => {
    progress = { ...progress, ...update, elapsedMs: Date.now() - startedAt, observedAt: Date.now() };
    onProgress(progress);
  };
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    if (id && !cancellation) {
      cancellation = (
        desktop
          ? desktop.visionCancel(id)
          : fetch(`/api/vision/jobs/${id}`, { method: "DELETE" })
              .then((response) => { if (!response.ok) throw Error("取消请求未成功"); })
      );
      void cancellation.catch(() => {});
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  report({});
  try {
    if (signal.aborted) throw Error("已取消识别");
    const input = { image: image.src, width, name: image.name };
    const start = desktop
      ? await desktop.visionStart(input)
      : await (async () => {
          const response = await fetch("/api/vision/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          });
          const start = (await response.json()) as {
            id: string;
            error?: string;
          };
          if (!response.ok) throw Error(start.error || "无法启动模型识别");
          return start;
        })();
    id = start.id;
    report({ taskId: id, message: "正在启动本机 Codex", serviceSeenAt: Date.now() });
    if (signal.aborted) {
      cancel();
      throw Error("已取消识别");
    }
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        signal.addEventListener("abort", finish, { once: true });
      });
      if (signal.aborted) break;
      const job = desktop
        ? await desktop.visionGet(id)
        : await (async () => {
            const r = await fetch(`/api/vision/jobs/${id}`, { signal });
            const job = (await r.json()) as VisionJob;
            if (!r.ok) throw Error(job.error);
            return job;
          })();
      if (signal.aborted) break;
      report({
        ...(job.progress || { stage: "recognizing", warning: "当前识别服务未提供事件进度，等待最终结果。" }),
        stage: job.status === "done" ? "validating" : job.progress?.stage || "recognizing",
        message: job.status === "done" ? "正在校验组件、层级与富文本" : job.message,
        serviceSeenAt: Date.now(),
        remainingMs: job.progress ? Math.max(0, job.progress.timeoutMs - job.elapsed) : null,
      });
      if (job.status === "failed") throw Error(job.error);
      if (job.status === "cancelled") throw Error("识别已取消");
      if (job.status === "done") {
        const checked = recognitionProject(job.result, image, width);
        report({ message: "正在校准原图色彩与文字排版" });
        const project = await refineRecognitionDraft(checked, signal);
        if (signal.aborted) throw Error("已取消识别");
        report({ stage: "complete", state: "complete", message: "识别与校验已完成", nodeCount: project.nodes.length });
        return project;
      }
    }
    throw Error("已取消识别");
  } catch (error) {
    if (signal.aborted) {
      try {
        await cancellation;
        report({ state: "cancelled", message: "已取消解析" });
      } catch {
        report({ state: "failed", message: "未能确认取消", warning: "取消请求未获确认。本机任务可能仍在运行，请勿重复提交。" });
      }
      throw error;
    }
    report({ state: "failed", message: "识别未完成" });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${id ? `（识别任务 ${id}）` : ""}`,
    );
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
