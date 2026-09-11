import type { Project, WNode } from "./wireframe";

type Pixels = { data: Uint8ClampedArray; width: number; height: number };
type Rect = { left: number; top: number; right: number; bottom: number };
type Bucket = { colors: number[]; r: number; g: number; b: number };
const AREA_SAMPLES = 2048;
const EDGE_SAMPLES = 512;

const rgb = (value: number): [number, number, number] => [value >>> 16, (value >>> 8) & 255, value & 255];
const distance = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0);
const hex = (value: number) => `#${value.toString(16).padStart(6, "0")}`;
const contains = (rect: Rect, x: number, y: number) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const center = (bucket: Bucket) => [bucket.r, bucket.g, bucket.b].map(value => value / bucket.colors.length);

function buckets(colors: number[], bits: number): Bucket[] {
  const groups = new Map<number, Bucket>();
  for (const value of colors) {
    const [r, g, b] = rgb(value);
    const key = ((r >>> bits) << 16) | ((g >>> bits) << 8) | (b >>> bits);
    const bucket = groups.get(key) ?? { colors: [], r: 0, g: 0, b: 0 };
    bucket.colors.push(value);
    bucket.r += r; bucket.g += g; bucket.b += b;
    groups.set(key, bucket);
  }
  return [...groups.values()];
}

function representative(bucket: Bucket, target = center(bucket)): number {
  let best = bucket.colors[0], nearest = Infinity;
  for (const color of bucket.colors) {
    const delta = distance(rgb(color), target);
    if (delta < nearest) { nearest = delta; best = color; }
  }
  return best;
}

function nearColor(colors: number[], intent: string, foreground: boolean): string | null {
  const target = rgb(Number.parseInt(intent.slice(1), 16));
  const groups = buckets(colors, 3);
  const largest = Math.max(0, ...groups.map(group => group.colors.length));
  const neutral = Math.max(...target) - Math.min(...target) <= 12;
  let best: number | null = null, score = Infinity;
  for (const group of groups) {
    if (group.colors.length < (foreground ? 2 : Math.max(3, Math.ceil(colors.length * 0.025)))) continue;
    const candidate = representative(group, target), channels = rgb(candidate);
    const delta = Math.sqrt(distance(channels, target));
    if (delta > 80 || (neutral && Math.max(...channels) - Math.min(...channels) > 24)) continue;
    // A nearly uniform background is not evidence of a different foreground color.
    if (foreground && group.colors.length > colors.length * 0.6 && delta > 18) continue;
    const candidateScore = delta + 8 * (1 - group.colors.length / largest);
    if (candidateScore < score) { score = candidateScore; best = candidate; }
  }
  return best === null ? null : hex(best);
}

function dominantColor(colors: number[]): string | null {
  if (colors.length < 24) return null;
  const groups: Bucket[] = [];
  for (const bucket of buckets(colors, 5).sort((a, b) => b.colors.length - a.colors.length)) {
    const mean = center(bucket);
    let match: Bucket | undefined, nearest = 40 ** 2;
    for (const group of groups) {
      const delta = distance(mean, center(group));
      if (delta < nearest) { nearest = delta; match = group; }
    }
    if (match) {
      match.colors.push(...bucket.colors);
      match.r += bucket.r; match.g += bucket.g; match.b += bucket.b;
    } else groups.push(bucket);
  }
  groups.sort((a, b) => b.colors.length - a.colors.length);
  const winner = groups[0];
  return winner && winner.colors.length >= Math.max(3, colors.length * 0.025) ? hex(representative(winner)) : null;
}

function addNote(node: WNode, note: string) {
  if (node.note.includes(note)) return;
  const next = [node.note, note].filter(Boolean).join(" ");
  if (next.length > 10000) throw new Error("组件备注已满，无法记录原图取色依据");
  node.note = next;
}

export function refineRecognitionColors(project: Project, pixels: Pixels): Project {
  if (!(pixels.data instanceof Uint8ClampedArray) || !Number.isSafeInteger(pixels.width) || !Number.isSafeInteger(pixels.height)
    || pixels.width <= 0 || pixels.height <= 0 || pixels.data.length !== pixels.width * pixels.height * 4)
    throw new Error("原图像素数据无效，无法校准颜色");
  if (!Number.isFinite(project.width) || !Number.isFinite(project.height) || project.width <= 0 || project.height <= 0)
    throw new Error("画布尺寸无效，无法映射原图颜色");
  const result = structuredClone(project);
  const scaleX = pixels.width / project.width, scaleY = pixels.height / project.height;
  const children = new Map<string | null, number[]>();
  project.nodes.forEach((node, index) => {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(index);
    children.set(node.parentId, siblings);
  });
  const painted: { index: number; node: WNode; rect: Rect; hidden: boolean }[] = [];
  const seen = new Set<number>();
  function walk(parent: string | null, hidden: boolean) {
    for (const index of children.get(parent) ?? []) {
      if (seen.has(index)) throw new Error("组件层级存在循环，无法判断颜色遮挡");
      seen.add(index);
      const node = project.nodes[index];
      painted.push({ index, node, hidden: hidden || node.hidden, rect: {
        left: Math.max(0, Math.floor(node.x * scaleX)), top: Math.max(0, Math.floor(node.y * scaleY)),
        right: Math.min(pixels.width, Math.ceil((node.x + node.w) * scaleX)),
        bottom: Math.min(pixels.height, Math.ceil((node.y + node.h) * scaleY)),
      } });
      walk(node.id, hidden || node.hidden);
    }
  }
  walk(null, false);
  if (seen.size !== project.nodes.length) throw new Error("组件层级无效，无法判断颜色遮挡");

  function obstruction(entry: typeof painted[number]): Rect[] {
    const { node, rect, hidden } = entry;
    if (hidden) return [];
    const textVisible = Boolean((node.text && (node.color !== "none" || (node.textStroke && node.textStroke !== "none" && (node.textStrokeWidth ?? 0) > 0)))
      || node.runs?.some(run => run.text && run.color !== "none"));
    const leafVisible = node.type !== "frame" && (node.type === "icon" ? node.color !== "none" || textVisible
      : !["text", "richtext"].includes(node.type) || textVisible);
    if (node.fill !== "none" || node.type === "image" || leafVisible) return [rect];
    if (node.stroke === "none" || node.strokeWidth <= 0) return [];
    const sx = node.strokeWidth * scaleX, sy = node.strokeWidth * scaleY;
    return [
      { ...rect, right: Math.min(rect.right, rect.left + sx) },
      { ...rect, left: Math.max(rect.left, rect.right - sx) },
      { ...rect, bottom: Math.min(rect.bottom, rect.top + sy) },
      { ...rect, top: Math.max(rect.top, rect.bottom - sy) },
    ];
  }

  const masks = painted.map(obstruction);
  for (let order = 0; order < painted.length; order++) {
    const entry = painted[order], node = result.nodes[entry.index], rect = entry.rect;
    if (entry.hidden || node.origin !== "detected" || node.reviewed) continue;
    const blockers = masks.slice(order + 1).flat().filter(mask => overlaps(mask, rect));
    const colors: number[] = [], fills: number[] = [], edges: number[] = [];
    const width = rect.right - rect.left, height = rect.bottom - rect.top;
    const insetX = Math.min(3, width * 0.1), insetY = Math.min(3, height * 0.1);
    const inner = { left: rect.left + insetX, right: rect.right - insetX, top: rect.top + insetY, bottom: rect.bottom - insetY };
    function read(x: number, y: number): number | null {
      if (!contains(rect, x, y) || blockers.some(mask => contains(mask, x, y))) return null;
      const offset = (y * pixels.width + x) * 4;
      if (pixels.data[offset + 3] < 240) return null;
      return (pixels.data[offset] << 16) | (pixels.data[offset + 1] << 8) | pixels.data[offset + 2];
    }
    if (width > 0 && height > 0) {
      const columns = Math.min(width, AREA_SAMPLES, Math.max(1, Math.floor(Math.sqrt(AREA_SAMPLES * width / height))));
      const rows = Math.min(height, Math.max(1, Math.floor(AREA_SAMPLES / columns)));
      for (let row = 0; row < rows; row++) {
        const y = rect.top + Math.floor((row + 0.5) * height / rows);
        for (let column = 0; column < columns; column++) {
          const x = rect.left + Math.floor((column + (row % 2 ? 0.25 : 0.75)) * width / columns);
          const value = read(x, y);
          if (value === null) continue;
          colors.push(value);
          if (contains(inner, x, y)) fills.push(value);
        }
      }
      if (node.stroke !== "none") {
        const visited = new Set<number>();
        const depths = Math.min(3, Math.max(1, Math.ceil(node.strokeWidth * Math.max(scaleX, scaleY))));
        const points = Math.floor(EDGE_SAMPLES / (4 * depths));
        for (let depth = 0; depth < depths; depth++) for (let index = 0; index < points; index++) {
          const x = rect.left + Math.floor((index + 0.5) * width / points);
          const y = rect.top + Math.floor((index + 0.5) * height / points);
          for (const [px, py] of [[x, rect.top + depth], [x, rect.bottom - 1 - depth], [rect.left + depth, y], [rect.right - 1 - depth, y]]) {
            if (!contains(rect, px, py)) continue;
            const key = py * pixels.width + px;
            if (visited.has(key)) continue;
            visited.add(key);
            const value = read(px, py);
            if (value !== null) edges.push(value);
          }
        }
      }
    }

    const insufficient = new Set<string>(), distant = new Set<string>();
    let changed = false;
    function calibrate(value: string, samples: number[], label: string, foreground: boolean, minimum = 12): string {
      if (value === "none") return value;
      if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("颜色校准需要有效的六位十六进制颜色");
      if (samples.length < minimum) { insufficient.add(label); return value; }
      const refined = nearColor(samples, value, foreground);
      if (!refined) { distant.add(label); return value; }
      if (refined === value.toLowerCase()) return value;
      changed = true;
      return refined;
    }

    if (node.type === "image" && node.fill === "none") {
      const dominant = dominantColor(fills);
      if (dominant) {
        node.fill = dominant;
        addNote(node, "图像仅按可见原图主色近似，渐变与图像细节未还原，待确认。");
      } else insufficient.add("图像主色");
    } else node.fill = calibrate(node.fill, fills, "填充", false);
    node.color = calibrate(node.color, colors, "文字颜色", true);
    node.stroke = calibrate(node.stroke, edges, "边框", false, 6);
    if (node.textStroke) node.textStroke = calibrate(node.textStroke, colors, "文字描边", true);
    for (const run of node.runs ?? []) run.color = calibrate(run.color, colors, "富文本颜色", true);
    if (changed) addNote(node, "颜色按原图局部近色取样校准，仍待确认。");
    if (insufficient.size) addNote(node, `${[...insufficient].join("、")}的可见原图取样不足，保留原估计，待确认。`);
    if (distant.size) addNote(node, `未找到与${[...distant].join("、")}估计接近的局部颜色，保留原值，待确认。`);
  }
  return result;
}
