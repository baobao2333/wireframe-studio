import { componentDefinition } from "./editor-library";
import type { Project, WNode } from "./wireframe";

const textKinds = new Set(["text", "richtext", "button", "tag", "avatar", "checkbox", "radio", "input", "select"]);
const roundedSize = (size: number, scale: number) => Math.max(8, Math.floor(size * scale * 100) / 100);
const appendNote = (node: WNode, note: string) => {
  node.note = [node.note, note].filter(Boolean).join("\n");
};

export async function refineRecognitionTypography(project: Project, signal?: AbortSignal): Promise<Project> {
  if (typeof document === "undefined") throw Error("文字排版校准需要可用的界面环境");
  await document.fonts.ready;
  signal?.throwIfAborted();
  const result = structuredClone(project);
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, { position: "fixed", left: "-20000px", top: "0", visibility: "hidden", pointerEvents: "none", contain: "layout style" });
  document.body.appendChild(host);
  let calibrated = 0, unresolved = 0, count = 0;
  try {
    for (const node of result.nodes) {
      if (node.origin !== "detected" || node.reviewed || !textKinds.has(node.type) || !node.text) continue;
      signal?.throwIfAborted();
      node.textLayout = "source-lines";
      const probe = document.createElement("div");
      const definition = componentDefinition(node);
      for (const [key, value] of Object.entries(definition.style || {})) probe.style.setProperty(key, String(value));
      Object.assign(probe.style, { position: "static", height: "auto", display: "block", minHeight: "0", maxHeight: "none", margin: "0" });
      const spans: HTMLElement[] = [];
      if (node.type === "richtext") {
        for (const run of node.runs || []) {
          const span = document.createElement("span");
          Object.assign(span.style, { fontSize: `${run.fontSize}px`, fontWeight: run.fontWeight, fontStyle: run.italic ? "italic" : "normal" });
          span.textContent = run.text;
          probe.appendChild(span);
          spans.push(span);
        }
      } else probe.textContent = node.text;
      host.appendChild(probe);
      const computed = getComputedStyle(probe);
      const px = (value: string) => parseFloat(value) || 0;
      const inset = px(computed.paddingLeft) + px(computed.paddingRight) + px(computed.borderLeftWidth) + px(computed.borderRightWidth);
      const outline = node.textStroke && node.textStroke !== "none" ? node.textStrokeWidth || 0 : 0;
      const hasChoiceControl = node.type === "checkbox" || node.type === "radio";
      const controlInset = hasChoiceControl ? 28 : node.type === "select" ? 18 : 0;
      const range = document.createRange();
      range.selectNodeContents(probe);
      const measure = (scale: number) => {
        probe.style.fontSize = `${roundedSize(node.fontSize, scale)}px`;
        spans.forEach((span, index) => { span.style.fontSize = `${roundedSize(node.runs![index].fontSize, scale)}px`; });
        const width = range.getBoundingClientRect().width + inset + outline + controlInset;
        const height = Math.max(probe.getBoundingClientRect().height + outline, hasChoiceControl ? 18 : 0);
        return { width, height, fits: width <= node.w + 0.01 && height <= node.h + 0.01 };
      };
      const original = measure(1);
      if (!original.fits) {
        // Small font-metric corrections are draft calibration, not permission to hide a bad box.
        const minimumScale = Math.max(0.8, 8 / node.fontSize, ...(node.type === "richtext" ? (node.runs || []).map(run => 8 / run.fontSize) : []));
        const minimum = measure(minimumScale);
        if (!minimum.fits) {
          appendNote(node, "原图行数已保留，但可用字体与识别区域不匹配；未强行缩字，请确认区域与字号。");
          unresolved++;
        } else {
          let lower = minimumScale, upper = 1;
          for (let step = 0; step < 12 && upper - lower > 0.0001; step++) {
            const middle = (lower + upper) / 2;
            if (measure(middle).fits) lower = middle;
            else upper = middle;
          }
          const oldSize = node.fontSize;
          node.fontSize = roundedSize(oldSize, lower);
          node.runs = node.runs?.map(run => ({ ...run, fontSize: roundedSize(run.fontSize, lower) }));
          appendNote(node, `按原图行数校准可用字体：基础字号 ${oldSize}px → ${node.fontSize}px；文字、区域尺寸和富文本比例保留，待确认。`);
          calibrated++;
        }
      }
      probe.remove();
      if (++count % 16 === 0) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  } finally { host.remove(); }
  signal?.throwIfAborted();
  if (calibrated || unresolved) result.notes = [result.notes, `原图排版校准：${calibrated} 个文本区域按可用字体校准，${unresolved} 个区域仍需确认。未修改已确认或手工组件。`].filter(Boolean).join("\n");
  return result;
}
