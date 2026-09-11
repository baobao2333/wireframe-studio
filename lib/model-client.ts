import {
  recognitionProject,
  type Project,
} from "./wireframe";
import { desktop, type VisionJob } from "./desktop";
type ImageInput = { src: string; name: string; width: number; height: number };
export async function modelImage(
  image: ImageInput,
  width: number,
  signal: AbortSignal,
  onStatus: (message: string) => void,
): Promise<Project> {
  let id: string | undefined;
  const cancel = () => {
    if (id)
      void (
        desktop
          ? desktop.visionCancel(id)
          : fetch(`/api/vision/jobs/${id}`, { method: "DELETE" })
      ).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
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
      if (job.status === "failed") throw Error(job.error);
      if (job.status === "cancelled") throw Error("识别已取消");
      onStatus(`${job.message} · ${Math.round(job.elapsed / 1000)} 秒`);
      if (job.status === "done") {
        return recognitionProject(job.result, image, width);
      }
    }
    throw Error("已取消识别");
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${id ? `（识别任务 ${id}）` : ""}`,
    );
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
