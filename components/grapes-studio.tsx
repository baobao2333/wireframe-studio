"use client";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  Editor,
  Block,
  Component,
  ComponentDefinition,
  Plugin,
} from "grapesjs";
import formsPackage from "grapesjs-plugin-forms";
import type { PluginOptions as FormsOptions } from "grapesjs-plugin-forms";
import {
  Frame,
  ImagePlus,
  Download,
  FolderOpen,
  FilePlus2,
  Undo2,
  Redo2,
  Layers,
  Library,
  Search,
  BookmarkPlus,
  Trash2,
  Copy,
  Check,
  SlidersHorizontal,
  X,
  Maximize,
  ZoomIn,
  ZoomOut,
  MousePointer2,
  Hand,
  Code2,
  Loader2,
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  ChevronUp,
  ChevronDown,
  Save,
  Settings,
  Home,
  Bell,
  Menu,
  ChevronRight,
  Plus,
  Heart,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Shrink,
} from "lucide-react";
import {
  Type,
  TextCursorInput,
  Image,
  Minus,
  SquareCheck,
  CircleDot,
  ToggleRight,
  Tag,
  UserRound,
  Star,
  ChartNoAxesColumnIncreasing,
  PanelsTopLeft,
  Table2,
  List,
  PanelTop,
  RectangleEllipsis,
  IdCard,
  PanelTopOpen,
  type LucideIcon,
} from "lucide-react";
import { get, set } from "@/lib/storage";
import { desktop, copyText, type OpenedProject, type CodexControlState, type CodexControlRequest } from "@/lib/desktop";
import { DesktopSettings } from "./desktop-settings";
import { CodexControlPanel } from "./codex-control-panel";
import { createCodexController } from "@/lib/codex-control";
import { createColorPickerPositioning } from "@/lib/color-picker-positioning";
import appIcon from "@/assets/app.png?url";
import { toast, Toaster } from "sonner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { ImportDialog } from "./import-dialog";
import {
  blankProject,
  sampleProject,
  validateProject,
  type Project,
} from "@/lib/wireframe";
import {
  projectComponents,
  componentDefinition,
  baseCanvasCss,
  registerLibrary,
  readIcon,
  updateIcon,
  measureIconSymbol,
  fitIconSymbol,
} from "@/lib/editor-library";
import { iconChoices, symbolPresets, type IconName } from "@/lib/icon-assets";
import {
  freshDefinition,
  captureLibraryComponent,
  normalizeComponentStyle,
  normalizeToolbarPointer,
} from "@/lib/component-snapshot";
import {
  studioFile,
  validateStudioFile,
  fixedCanvasFile,
  handoffGrapes,
  exportHtml,
  exportReact,
  buildExport,
  type Meta,
  type LibraryItem,
} from "@/lib/grapes-export";

const defaultMeta: Meta = {
  engineRevision: 2,
  name: "项目概览 · 界面规范",
  width: 1120,
  height: 760,
  notes:
    "页面标题 32px，分区标题 18px，正文 16px，辅助信息 12px。布局间距以 8px 为基准。",
};
// The published UMD package exposes its plugin on the default export object.
const forms = (formsPackage as unknown as { default: Plugin<FormsOptions> })
  .default;
function Tool({
  label,
  children,
  active,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`icon-button ${active ? "active" : ""}`}
          aria-label={label}
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={5}>{label}</TooltipContent>
    </Tooltip>
  );
}
function Numeric({
  label,
  value,
  onCommit,
  min = 0,
  max = 6000,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const [draft, change] = useState<string | null>(null);
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        value={draft ?? String(value)}
        onChange={(e) => change(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (draft !== null && draft !== "" && Number.isFinite(n)) {
            onCommit(Math.max(min, Math.min(max, n)));
          }
          change(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}
const categoryOf = (b: Block) => b.category?.get("label") || "基础组件";
const blockIcons: Record<string, LucideIcon> = {
  text: Type,
  richtext: Type,
  button: RectangleEllipsis,
  input: TextCursorInput,
  select: ChevronDown,
  image: Image,
  frame: Frame,
  line: Minus,
  checkbox: SquareCheck,
  radio: CircleDot,
  switch: ToggleRight,
  tag: Tag,
  avatar: UserRound,
  icon: Star,
  progress: ChartNoAxesColumnIncreasing,
  tabs: PanelsTopLeft,
  table: Table2,
  list: List,
  nav: PanelTop,
  form: TextCursorInput,
  card: IdCard,
  toolbar: PanelTopOpen,
  metric: ChartNoAxesColumnIncreasing,
  row: List,
};
function BlockIcon({ id }: { id: string }) {
  const symbol = symbolPresets.find((item) => id === `symbol-${item.id}`);
  if (symbol) return <span className="symbol-block-glyph" aria-hidden="true">{symbol.text}</span>;
  const Icon = blockIcons[id.replace(/^(base|combo)-/, "")] || Library;
  return <Icon size={26} />;
}
const libraryIcons: Record<IconName, LucideIcon> = {
  search: Search, home: Home, user: UserRound, bell: Bell, settings: Settings,
  menu: Menu, "chevron-right": ChevronRight, plus: Plus, star: Star,
  heart: Heart, check: Check, close: X,
};
function IconInspector({ component }: { component: Component }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = readIcon(component);
  const symbolMode = draft !== null || value.text !== "";
  const symbolOverflow = symbolMode && measureIconSymbol(component)?.overflow;
  const element = component.getEl();
  const style = element?.ownerDocument.defaultView!.getComputedStyle(element);
  const color = style?.color || String(component.getStyle().color || "#34363c");
  const rgb = color.match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
  const hexColor = rgb
    ? "#" + rgb.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")
    : /^#[\da-f]{6}$/i.test(color) ? color : "#34363c";
  const chooseSymbol = (text: string) => {
    setDraft(null);
    updateIcon(component, text, value.icon);
  };
  return <section className="inspector-section">
    <h3>图标内容</h3>
    <Tabs value={symbolMode ? "symbol" : "library"} onValueChange={(mode) => {
      setDraft(null);
      updateIcon(component, mode === "symbol" ? value.text || symbolPresets[0].text : "", value.icon);
    }}>
      <TabsList className="icon-mode-tabs">
        <TabsTrigger value="symbol">符号</TabsTrigger>
        <TabsTrigger value="library">图标库</TabsTrigger>
      </TabsList>
    </Tabs>
    {symbolMode ? <>
      <label htmlFor="icon-symbol" className="spaced">Unicode 符号</label>
      <input id="icon-symbol" aria-label="图标符号" className="symbol-input"
        maxLength={10000} value={draft ?? value.text}
        onChange={(event) => {
          setDraft(event.target.value);
          updateIcon(component, event.target.value, value.icon);
        }}
        onBlur={() => setDraft(null)} />
      <div className="icon-picker-grid spaced" aria-label="常用符号">
        {symbolPresets.map((symbol) => <Tool key={symbol.id} label={`${symbol.label}符号`}
          active={value.text === symbol.text} aria-pressed={value.text === symbol.text}
          onClick={() => chooseSymbol(symbol.text)}>
          <span className="symbol-picker-glyph" aria-hidden="true">{symbol.text}</span>
        </Tool>)}
      </div>
    </> : <div className="icon-picker-grid spaced" aria-label="图标库">
      {iconChoices.map((choice) => {
        const Icon = libraryIcons[choice.id];
        return <Tool key={choice.id} label={`${choice.label}图标`}
          active={value.icon === choice.id} aria-pressed={value.icon === choice.id}
          onClick={() => updateIcon(component, "", choice.id)}><Icon size={18} /></Tool>;
      })}
    </div>}
    {symbolMode && <div className="field-pair spaced">
      <Numeric label="符号字号" value={parseFloat(style?.fontSize || String(component.getStyle()["font-size"] || 16))}
        min={8} max={160} onCommit={(size) => component.addStyle({ "font-size": `${size}px` })} />
    </div>}
    {symbolOverflow && <div className="icon-overflow-warning spaced" role="status">
      <span>符号超出区域</span>
      <Tool label="适配符号字号" onClick={() => {
        const result = fitIconSymbol(component);
        if (result.status === "too-small") toast.error("符号在 8px 下仍超出区域", { description: "原字号与区域尺寸未修改。" });
        else if (result.status === "unavailable") toast.error("暂时无法测量符号", { description: "原字号未修改。" });
      }}><Shrink size={16} /></Tool>
    </div>}
    <div className="icon-color-row spaced">
      <label htmlFor="icon-color">单色颜色</label>
      <input id="icon-color" type="color" aria-label="图标单色颜色" title="彩色 emoji 保留系统配色" value={hexColor}
        onChange={(event) => component.addStyle({ color: event.target.value })} />
    </div>
    {symbolMode && <div className="align-tools" aria-label="符号内容对齐">
      {(["left", "center", "right"] as const).map((alignment, index) => {
        const Icon = [AlignLeft, AlignCenter, AlignRight][index];
        return <Tool key={alignment} label={["符号左对齐", "符号居中", "符号右对齐"][index]}
          active={(style?.textAlign || component.getStyle()["text-align"]) === alignment}
          onClick={() => component.addStyle({ "text-align": alignment })}><Icon size={16} /></Tool>;
      })}
    </div>}
  </section>;
}

export default function GrapesStudio() {
  const host = useRef<HTMLDivElement>(null),
    layerHost = useRef<HTMLDivElement>(null),
    styleHost = useRef<HTMLDivElement>(null),
    traitHost = useRef<HTMLDivElement>(null),
    editor = useRef<Editor | null>(null),
    codexController = useRef<ReturnType<typeof createCodexController> | null>(null),
    fileRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false),
    [initError, setInitError] = useState(""),
    [instance, setInstance] = useState<Editor | null>(null),
    [meta, setMeta] = useState<Meta>(defaultMeta),
    metaRef = useRef(defaultMeta),
    [saved, setSaved] = useState("读取中"),
    [selection, setSelection] = useState<Component | null>(null),
    [, tick] = useState(0),
    [zoom, setZoom] = useState(60);
  const [leftTab, setLeftTab] = useState("library"),
    [rightTab, setRightTab] = useState("spec"),
    [category, setCategory] = useState("基础组件"),
    [query, setQuery] = useState(""),
    [blocks, setBlocks] = useState<Block[]>([]),
    [custom, setCustom] = useState<LibraryItem[]>([]),
    customRef = useRef<LibraryItem[]>([]);
  const [mobile, setMobile] = useState<"left" | "right" | null>(null),
    [pan, setPan] = useState(false),
    [importOpen, setImportOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [newOpen, setNewOpen] = useState(false),
    [saveLibraryOpen, setSaveLibraryOpen] = useState(false),
    [libraryName, setLibraryName] = useState("");
  const [exportTab, setExportTab] = useState("handoff"),
    [format, setFormat] = useState("bundle"),
    [exportBusy, setExportBusy] = useState(false),
    [exportResult, setExportResult] = useState<{
      url?: string;
      path: string;
    } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlState, setControlState] = useState<CodexControlState | null>(null);
  const canSave = useRef(false),
    sequence = useRef(0),
    panning = useRef<{ x: number; y: number; cx: number; cy: number } | null>(
      null,
    );
  const persist = () => {
    const ed = editor.current;
    if (!ed || !canSave.current) return;
    const seq = ++sequence.current;
    setSaved("保存中");
    set("wireframe-studio-v2", studioFile(ed, metaRef.current))
      .then(() => {
        if (seq === sequence.current) setSaved("已存到本机");
      })
      .catch((e) => {
        setSaved("保存失败");
        toast.error("保存失败，请立即导出项目", { description: String(e) });
      });
  };
  function changeMeta(patch: Partial<Meta>) {
    const next = { ...metaRef.current, ...patch };
    metaRef.current = next;
    setMeta(next);
    persist();
  }
  async function replaceProject(project: Project) {
    try {
      await flushProject();
      await desktop?.acceptProject(null);
      loadWireframe(project);
      return true;
    } catch (error) {
      toast.error("原工程未能备份，已取消切换", { description: String(error) });
      return false;
    }
  }
  function fit() {
    const ed = editor.current;
    if (!ed) return;
    ed.Canvas.fitViewport({ gap: 42, zoom: (z) => Math.min(100, z) });
  }
  function dimensions(width: number, height: number) {
    const ed = editor.current;
    if (!ed) return;
    ed.Devices.get("custom")?.set({
      width: `${width}px`,
      height: `${height}px`,
    });
    ed.getWrapper()?.addStyle({
      width: `${width}px`,
      height: `${height}px`,
      "min-height": `${height}px`,
      position: "relative",
      overflow: "hidden",
    });
    changeMeta({ width, height });
    requestAnimationFrame(fit);
  }
  function loadWireframe(p: Project) {
    const ed = editor.current;
    if (!ed) return;
    ed.UndoManager.stop();
    ed.setStyle(baseCanvasCss);
    ed.setComponents(projectComponents(p));
    ed.getWrapper()?.addStyle({
      "background-color": p.background === "none" ? "transparent" : p.background,
    });
    metaRef.current = {
      name: p.name,
      notes: p.notes,
      width: p.width,
      height: p.height,
      reference: p.reference,
      engineRevision: 2,
    };
    setMeta(metaRef.current);
    dimensions(p.width, p.height);
    ed.UndoManager.start();
    ed.UndoManager.clear();
    ed.select();
    setSelection(null);
    persist();
  }
  useEffect(() => {
    let alive = true,
      resize: ResizeObserver | undefined,
      colorPositioning: ReturnType<typeof createColorPickerPositioning> | undefined;
    (async () => {
      const grapes = (await import("grapesjs")).default;
      if (!alive || !host.current) return;
      colorPositioning = createColorPickerPositioning(styleHost.current!, grapes.$);
      const ed = grapes.init({
        container: host.current,
        height: "100%",
        width: "auto",
        storageManager: false,
        telemetry: false,
        cssIcons: "",
        colorPicker: colorPositioning.options,
        panels: { defaults: [] },
        plugins: [(ed) => forms(ed, { blocks: [] })],
        dragMode: "absolute",
        selectorManager: { componentFirst: true },
        avoidInlineStyle: true,
        devicePreviewMode: true,
        noticeOnUnload: false,
        assetManager: { upload: false },
        blockManager: { custom: true },
        layerManager: { appendTo: layerHost.current! },
        traitManager: { appendTo: traitHost.current! },
        styleManager: {
          appendTo: styleHost.current!,
          sectors: [
            {
              id: "geometry",
              name: "位置与尺寸",
              open: true,
              properties: [
                {
                  property: "position",
                  type: "select",
                  name: "定位",
                  options: [
                    { id: "absolute", label: "绝对" },
                    { id: "relative", label: "相对" },
                    { id: "static", label: "自动布局" },
                  ],
                },
                {
                  property: "left",
                  type: "number",
                  name: "X",
                  units: ["px", "%"],
                },
                {
                  property: "top",
                  type: "number",
                  name: "Y",
                  units: ["px", "%"],
                },
                {
                  property: "width",
                  type: "number",
                  name: "宽度",
                  units: ["px", "%", "auto"],
                },
                {
                  property: "height",
                  type: "number",
                  name: "高度",
                  units: ["px", "%", "auto"],
                },
                { property: "z-index", type: "integer", name: "层级" },
              ],
            },
            {
              id: "type",
              name: "文字",
              open: true,
              properties: [
                {
                  property: "font-size",
                  type: "number",
                  name: "基础字号",
                  units: ["px"],
                },
                {
                  property: "font-weight",
                  type: "select",
                  name: "字重",
                  options: [
                    { id: "400", label: "Regular" },
                    { id: "500", label: "Medium" },
                    { id: "600", label: "Semibold" },
                    { id: "700", label: "Bold" },
                  ],
                },
                {
                  property: "line-height",
                  type: "number",
                  name: "行高",
                  units: ["px", "em"],
                },
                {
                  property: "text-align",
                  type: "select",
                  name: "对齐",
                  options: [
                    { id: "left", label: "左对齐" },
                    { id: "center", label: "居中" },
                    { id: "right", label: "右对齐" },
                  ],
                },
                { property: "color", type: "color", name: "文字颜色" },
                { property: "white-space", type: "select", name: "换行", options: [
                  { id: "pre-wrap", label: "自动换行" },
                  { id: "pre", label: "保留原图行" },
                ] },
                { property: "-webkit-text-stroke-width", type: "number", name: "文字描边宽度", units: ["px"], min: 0, max: 12 },
                { property: "-webkit-text-stroke-color", type: "color", name: "文字描边颜色" },
              ],
            },
            {
              id: "appearance",
              name: "外观",
              open: false,
              properties: [
                { property: "background-color", type: "color", name: "填充" },
                {
                  property: "border-radius",
                  type: "number",
                  name: "圆角",
                  units: ["px", "%"],
                },
                {
                  property: "border-width",
                  type: "number",
                  name: "描边宽度",
                  units: ["px"],
                },
                { property: "border-color", type: "color", name: "描边颜色" },
                {
                  property: "border-style",
                  type: "select",
                  name: "描边样式",
                  options: [
                    { id: "solid", label: "实线" },
                    { id: "dashed", label: "虚线" },
                    { id: "none", label: "无" },
                  ],
                },
                {
                  property: "opacity",
                  type: "slider",
                  name: "透明度",
                  min: 0,
                  max: 1,
                  step: 0.05,
                },
              ],
            },
            {
              id: "layout",
              name: "容器布局",
              open: false,
              properties: [
                {
                  property: "display",
                  type: "select",
                  name: "布局",
                  options: [
                    { id: "block", label: "自由布局" },
                    { id: "flex", label: "Flex" },
                    { id: "grid", label: "Grid" },
                    { id: "none", label: "隐藏" },
                  ],
                },
                {
                  property: "flex-direction",
                  type: "select",
                  name: "方向",
                  options: [
                    { id: "row", label: "横向" },
                    { id: "column", label: "纵向" },
                  ],
                },
                {
                  property: "gap",
                  type: "number",
                  name: "间距",
                  units: ["px"],
                },
                {
                  property: "padding",
                  type: "number",
                  name: "内边距",
                  units: ["px"],
                },
                {
                  property: "justify-content",
                  type: "select",
                  name: "主轴对齐",
                  options: [
                    { id: "flex-start", label: "起点" },
                    { id: "center", label: "居中" },
                    { id: "space-between", label: "两端" },
                    { id: "flex-end", label: "终点" },
                  ],
                },
                {
                  property: "align-items",
                  type: "select",
                  name: "交叉轴",
                  options: [
                    { id: "stretch", label: "拉伸" },
                    { id: "center", label: "居中" },
                    { id: "flex-start", label: "起点" },
                  ],
                },
              ],
            },
          ],
        },
        deviceManager: {
          devices: [
            { id: "custom", name: "画布", width: "1120px", height: "760px" },
          ],
        },
        canvas: { styles: [], scripts: [] },
        i18n: {
          locale: "zh",
          messages: {
            zh: {
              styleManager: { empty: "选择一个组件" },
              layers: { root: "画布" },
              assetManager: { addButton: "添加图片", modalTitle: "图片资源" },
              traitManager: {
                empty: "选择一个组件",
                traits: {
                  labels: {
                    id: "标识",
                    title: "提示文字",
                    name: "字段名",
                    placeholder: "占位文字",
                    type: "类型",
                    required: "必填",
                    options: "选项",
                    for: "关联字段",
                    value: "值",
                    checked: "已勾选",
                    text: "文字",
                  },
                  options: {
                    type: {
                      text: "文本",
                      email: "邮箱",
                      password: "密码",
                      number: "数字",
                      submit: "提交",
                      reset: "重置",
                      button: "按钮",
                    },
                  },
                },
              },
            },
          },
        },
      });
      editor.current = ed;
      setInstance(ed);
      registerLibrary(ed);
      // GrapesJS toolbar pointers are frame-relative but still screen-scaled.
      ed.on(
        "toolbar:run:before",
        ({ event }: { event: { clientX: number; clientY: number } }) =>
          normalizeToolbarPointer(event, ed.Canvas.getZoom()),
      );
      const refresh = () => {
        setBlocks([...ed.BlockManager.getAll().models]);
        tick((v) => v + 1);
      };
      ed.on("block:add block:remove", refresh);
      ed.on("component:selected", (c) => {
        ed.UndoManager.skip(() => normalizeComponentStyle(c));
        setSelection(c);
        tick((v) => v + 1);
      });
      ed.on("component:deselected", () => {
        setSelection(ed.getSelected() || null);
        tick((v) => v + 1);
      });
      ed.on("update", () => {
        tick((v) => v + 1);
        persist();
        setExportResult(null);
      });
      ed.on("canvas:zoom", () => setZoom(ed.Canvas.getZoom()));
      ed.on("undo redo", () => {
        setSelection(ed.getSelected() || null);
        tick((v) => v + 1);
      });
      ed.on("component:add", (c) => {
        if (c.get("type") === "textnode") return;
        if (!c.getAttributes()["data-kind"]) {
          c.addAttributes({
            "data-kind": c.get("type") === "text" ? "text" : "frame",
            "data-priority": "secondary",
            "data-origin": "manual",
            "data-reviewed": "true",
          });
        }
        if (c.get("tagName") !== "span") c.set("resizable", true);
      });
      ed.on("block:drag:stop", (c) => {
        if (c) {
          ed.select(c);
          setSelection(c);
        }
      });
      ed.on("load", async () => {
        try {
          const [savedFile, library, old] = await Promise.all([
            get("wireframe-studio-v2"),
            get("wireframe-library-v2"),
            get("wireframe-studio-v1"),
          ]);
          if (!alive) return;
          if (savedFile) {
            const original = validateStudioFile(savedFile);
            const p = fixedCanvasFile(original);
            if (p !== original)
              await set("wireframe-studio-v2-before-canvas-repair", savedFile);
            await ed.loadProjectData(p.editor);
            if (!original.meta.engineRevision && old) {
              const source = validateProject(old),
                map = new Map(source.nodes.map((n) => [n.id, n]));
              const matches = ed
                .getWrapper()!
                .find("*")
                .filter((c) => map.has(c.getAttributes()["data-spec-id"]));
              if (matches.length) {
                await set("wireframe-studio-v2-before-style-repair", savedFile);
                let restored = 0;
                for (const c of matches) {
                  if (Object.keys(c.getStyle()).length) continue;
                  const n = map.get(c.getAttributes()["data-spec-id"])!;
                  c.addStyle(
                    componentDefinition(n, map.get(n.parentId || ""))
                      .style as Record<string, string>,
                  );
                  restored++;
                }
                if (!p.meta.reference) p.meta.reference = source.reference;
                if (restored)
                  toast.success(
                    `已恢复 ${restored} 个组件缺失的样式，原编辑内容保留`,
                  );
              }
            }
            metaRef.current = p.meta;
            setMeta(p.meta);
            dimensions(p.meta.width, p.meta.height);
          } else loadWireframe(old ? validateProject(old) : sampleProject());
          if (library) {
            if (!Array.isArray(library)) throw Error("组件库文件损坏");
            customRef.current = library;
            setCustom(library);
            library.forEach((item: LibraryItem) =>
              ed.BlockManager.add(item.id, {
                label: item.name,
                category: "我的组件",
                content: item.content,
              }),
            );
          }
          canSave.current = true;
          if (desktop?.onControlRequest) {
            codexController.current?.dispose();
            codexController.current = createCodexController(ed, {
              getMeta: () => metaRef.current,
              setMeta: next => { metaRef.current = next; setMeta(next); },
              persist: flushProject,
              canExecute: () => canSave.current && !ed.getEditing() &&
                !document.querySelector('[role="dialog"]') &&
                !document.activeElement?.matches('input,textarea,[contenteditable="true"]'),
            });
          }
          setSaved("已存到本机");
          persist();
          ed.UndoManager.clear();
          setReady(true);
          refresh();
          requestAnimationFrame(fit);
          desktop?.rendererReady(__WIREFRAME_UI_VERSION__);
        } catch (e) {
          setSaved("读取失败");
          toast.error("项目读取失败，未覆盖原有存储", {
            description: String(e),
            duration: 15000,
          });
          setReady(true);
          refresh();
        }
      });
      resize = new ResizeObserver(() => {
        if (canSave.current) fit();
      });
      resize.observe(host.current);
    })().catch((e) => {
      setInitError(String(e));
      setSaved("读取失败");
      toast.error("编辑器初始化失败", {
        description: String(e),
        duration: Infinity,
      });
    });
    return () => {
      alive = false;
      resize?.disconnect();
      canSave.current = false;
      codexController.current?.dispose();
      codexController.current = null;
      colorPositioning?.destroy();
      editor.current?.destroy();
      editor.current = null;
    };
  }, []);
  useEffect(() => {
    if (desktop) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (saved === "保存中" || saved === "保存失败") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saved]);
  async function flushProject() {
    if (!editor.current || !canSave.current) return;
    await set(
      "wireframe-studio-v2",
      studioFile(editor.current, metaRef.current),
    );
    setSaved("已存到本机");
  }
  async function nativeOpen(file?: OpenedProject) {
    try {
      const opened = file || (await desktop!.openProject());
      if (!opened) return;
      if (await openFile(new File([opened.content], opened.name)))
        await desktop!.acceptProject(opened.path);
    } catch (e) {
      toast.error("项目未打开", { description: String(e) });
    }
  }
  async function nativeSave(saveAs = false) {
    if (!editor.current || !canSave.current) return;
    try {
      await flushProject();
      const result = await desktop!.saveProject(
        studioFile(editor.current, metaRef.current),
        saveAs,
      );
      if (result) toast.success("工程已保存", { description: result.path });
    } catch (e) {
      toast.error("工程未保存", { description: String(e) });
    }
  }
  const handleCommand = useEffectEvent((command: string) => {
    if (command === "close") {
      void flushProject()
        .then(() => desktop!.closeReady())
        .catch((e) =>
          toast.error("无法关闭：工程尚未保存", { description: String(e) }),
        );
      return;
    }
    if (command === "updates") {
      setSettingsOpen(true);
      return;
    }
    if (!ready) return;
    if (command === "new") setNewOpen(true);
    if (command === "open") void nativeOpen();
    if (command === "save") void nativeSave();
    if (command === "save-as") void nativeSave(true);
    if (command === "export") setExportOpen(true);
    if (command === "undo") editor.current?.UndoManager.undo();
    if (command === "redo") editor.current?.UndoManager.redo();
    if (command === "fit") fit();
  });
  const handleProject = useEffectEvent((file: OpenedProject) => {
    void nativeOpen(file);
  });
  const handleControl = useEffectEvent(async (request: CodexControlRequest) => {
    let result: Record<string, unknown>;
    if (!codexController.current || Date.now() > request.deadline) {
      result = { ok: false, error: { code: "NOT_READY", message: "工程尚未就绪或命令已过期，请重新读取状态" }, applied: false, saved: false };
    } else {
      try {
        const response = await codexController.current.execute(request.tool, request.args);
        if (!response || typeof response !== "object" || Array.isArray(response)) throw Error("Invalid control result");
        result = response;
      }
      catch { result = { ok: false, error: { code: "CONTROL_FAILED", message: "控制命令未完成，请先读取当前工程" }, applied: null, saved: false }; }
    }
    await desktop!.controlResult(request.id, result);
  });
  async function refreshControl() {
    if (desktop?.controlStatus) setControlState(await desktop.controlStatus());
  }
  useEffect(() => {
    if (!desktop?.onControlRequest) return;
    const a = desktop.onControlRequest(request => {
      void handleControl(request).catch(() => toast.error("Codex 控制响应未送达，请读取工程后重试"));
    });
    const b = desktop.onControlState(setControlState);
    void desktop.controlStatus().then(setControlState).catch(() => setControlState({ enabled: false, ready: false, connected: false, busy: false, error: "无法读取本机控制状态" }));
    return () => { a(); b(); };
  }, []);
  useEffect(() => {
    if (!desktop) return;
    const a = desktop.onCommand((command) => handleCommand(command));
    const b = desktop.onProject((file) => handleProject(file));
    const c = desktop.onUpdate((state) => {
      if (state.status === "available")
        toast.info(`界面更新 ${state.availableVersion} 已发布`, {
          id: "app-update",
          action: { label: "查看", onClick: () => setSettingsOpen(true) },
        });
    });
    return () => {
      a();
      b();
      c();
    };
  }, []);
  function addBlock(block: Block) {
    const ed = editor.current;
    if (!ed) return;
    const def = freshDefinition(block.getContent() as ComponentDefinition);
    const c = ed.getWrapper()!.append(def)[0];
    ed.select(c);
    ed.Canvas.scrollTo(c);
    setSelection(c);
  }
  async function saveToLibrary() {
    const ed = editor.current,
      c = ed?.getSelected();
    if (!c || !libraryName.trim()) return;
    try {
      const item = {
        id: `custom-${crypto.randomUUID()}`,
        name: libraryName.trim(),
        content: captureLibraryComponent(c),
      };
      const next = [...customRef.current, item];
      await set("wireframe-library-v2", next);
      customRef.current = next;
      setCustom(next);
      ed!.BlockManager.add(item.id, {
        label: item.name,
        category: "我的组件",
        content: item.content,
      });
      setSaveLibraryOpen(false);
      setCategory("我的组件");
      setQuery("");
      toast.success("已保存到我的组件");
    } catch (e) {
      toast.error("组件库保存失败", { description: String(e) });
    }
  }
  async function removeLibrary(id: string) {
    const next = customRef.current.filter((i) => i.id !== id);
    try {
      await set("wireframe-library-v2", next);
      customRef.current = next;
      setCustom(next);
      editor.current!.BlockManager.remove(id);
      toast.success("已移出组件库，画布上的实例未改变");
    } catch (e) {
      toast.error(String(e));
    }
  }
  function attr(key: string, value: string) {
    selection?.addAttributes({ [key]: value });
    tick((v) => v + 1);
  }
  function setSize(key: string, value: number) {
    selection?.addStyle({ [key]: `${value}px` });
  }
  function align(side: string) {
    const c = selection;
    if (!c) return;
    const parent = c.parent()?.getEl(),
      el = c.getEl();
    if (!parent || !el) return;
    const width = parent.clientWidth,
      w = el.getBoundingClientRect().width;
    c.addStyle({
      left: `${side === "left" ? 0 : side === "center" ? (width - w) / 2 : width - w}px`,
    });
  }
  async function openFile(file: File) {
    try {
      if (file.size > 32 * 1024 * 1024) throw Error("项目文件不能超过 32 MB");
      const raw = JSON.parse(await file.text());
      await flushProject();
      if (raw.format === "wireframe-studio") {
        const p = fixedCanvasFile(validateStudioFile(raw));
        await editor.current!.loadProjectData(p.editor);
        changeMeta(p.meta);
        dimensions(p.meta.width, p.meta.height);
      } else loadWireframe(validateProject(raw));
      editor.current!.UndoManager.clear();
      persist();
      toast.success("项目已打开");
      return true;
    } catch (e) {
      toast.error("项目未打开", { description: String(e) });
      return false;
    }
  }
  const attrs = selection?.getAttributes() || {};
  const selectedElement = selection?.getEl();
  const style =
    selectedElement?.nodeType === 1
      ? selectedElement.ownerDocument.defaultView!.getComputedStyle(
          selectedElement,
        )
      : selection?.getStyle() || {};
  const visibleBlocks = blocks.filter(
    (b) =>
      categoryOf(b) === category &&
      String(b.getLabel()).toLowerCase().includes(query.toLowerCase()),
  );
  const previewCode =
    exportOpen && instance
      ? exportTab === "handoff"
        ? handoffGrapes(instance, meta)
        : exportTab === "html"
          ? exportHtml(instance, meta)
          : exportTab === "react"
            ? exportReact(instance)
            : JSON.stringify(studioFile(instance, meta), null, 2)
      : "";
  async function download() {
    const ed = editor.current;
    if (!ed) return;
    setExportBusy(true);
    setExportResult(null);
    try {
      const out = await buildExport(ed, meta, format);
      if (desktop) {
        const result = await desktop.saveExport(
          out.filename,
          await out.blob.arrayBuffer(),
        );
        if (result) {
          setExportResult(result);
          toast.success("文件已保存到本机", { description: result.path });
        }
        return;
      }
      const res = await fetch(
        `/api/exports?name=${encodeURIComponent(out.filename)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: out.blob,
        },
      );
      const result = (await res.json()) as {
        url: string;
        path: string;
        error?: string;
      };
      if (!res.ok) throw Error(result.error);
      setExportResult(result);
      toast.success("文件已保存到本机", {
        description: result.path,
        duration: 8000,
      });
    } catch (e) {
      toast.error("导出失败", { description: String(e) });
    } finally {
      setExportBusy(false);
    }
  }
  return (
    <TooltipProvider delayDuration={300}>
      <main className="studio grapes-studio">
        <header className="app-header">
          <div className="brand">
            <img src={appIcon} alt="" width={24} height={24} className="brand-icon"/>
            <h1>线框工坊</h1>
            <span>STUDIO</span>
          </div>
          <div className="header-project">
            <input
              aria-label="项目名称"
              value={meta.name}
              maxLength={160}
              onChange={(e) => changeMeta({ name: e.target.value })}
            />
            <span
              className={saved === "已存到本机" ? "save-ok" : "save-warning"}
            >
              <Check size={12} />
              <span>{saved}</span>
            </span>
          </div>
          <div className="header-actions">
            <Tool label="新建画布" onClick={() => setNewOpen(true)}>
              <FilePlus2 size={17} />
            </Tool>
            <Tool
              label="打开工程"
              disabled={!ready}
              onClick={() =>
                desktop ? void nativeOpen() : fileRef.current?.click()
              }
            >
              <FolderOpen size={17} />
            </Tool>
            {desktop && (
              <Tool
                label="保存工程"
                disabled={!ready}
                onClick={() => void nativeSave()}
              >
                <Save size={17} />
              </Tool>
            )}
            <button
              className="command"
              disabled={!ready}
              onClick={() => setImportOpen(true)}
            >
              <ImagePlus size={16} />
              导入图片
            </button>
            <button
              className="command primary"
              disabled={!ready}
              onClick={() => setExportOpen(true)}
            >
              <Download size={16} />
              导出给 Codex
            </button>
            {desktop && (
              <CodexControlPanel status={controlState} onRefresh={refreshControl}
                onConnect={async () => { try { setControlState(await desktop!.controlConnect()); } finally { await refreshControl(); } }}
                onToggle={async enabled => { try { setControlState(await desktop!.controlConfigure(enabled)); } finally { await refreshControl(); } }} />
            )}
            {desktop && (
              <Tool label="应用与更新" onClick={() => setSettingsOpen(true)}>
                <Settings size={17} />
              </Tool>
            )}
          </div>
        </header>
        <input
          type="file"
          className="sr-only"
          ref={fileRef}
          accept=".json"
          aria-label="打开项目文件"
          onChange={(e) => {
            if (e.target.files?.[0]) void openFile(e.target.files[0]);
            e.target.value = "";
          }}
        />
        <div className="editor-layout">
          <aside
            className={`left-panel ${mobile === "left" ? "mobile-open" : ""}`}
          >
            <div className="panel-mobile-heading">
              组件库
              <Tool label="关闭组件库" onClick={() => setMobile(null)}>
                <X size={16} />
              </Tool>
            </div>
            <Tabs value={leftTab} onValueChange={setLeftTab}>
              <TabsList variant="line" className="panel-tabs">
                <TabsTrigger value="library">
                  <Library size={14} />
                  组件库
                </TabsTrigger>
                <TabsTrigger value="layers">
                  <Layers size={14} />
                  图层
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div
              className="library-content"
              style={{ display: leftTab === "library" ? "flex" : "none" }}
            >
              <div className="library-search">
                <Search size={14} />
                <input
                  aria-label="搜索组件库"
                  placeholder="搜索组件"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <select
                className="library-category"
                aria-label="组件库分类"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {[
                  "基础组件",
                  "布局结构",
                  "数据与导航",
                  "常用界面组合",
                  "我的组件",
                ].map((c) => (
                  <option key={c} value={c}>
                    {c} · {blocks.filter((b) => categoryOf(b) === c).length}
                  </option>
                ))}
              </select>
              <div className="library-blocks">
                {visibleBlocks.map((block) => (
                  <div className="library-block-item" key={block.id}>
                    <button
                      className="library-block"
                      aria-label={`添加 ${block.getLabel()}`}
                      draggable
                      onDragStart={(e) =>
                        editor.current!.BlockManager.startDrag(
                          block,
                          e.nativeEvent,
                        )
                      }
                      onDragEnd={() => editor.current!.BlockManager.endDrag()}
                      onClick={() => addBlock(block)}
                    >
                      <span className="block-preview">
                        <BlockIcon id={String(block.id)} />
                      </span>
                      <span>{String(block.getLabel())}</span>
                    </button>
                    {category === "我的组件" && (
                      <button
                        className="remove-library"
                        aria-label={`移出组件库 ${block.getLabel()}`}
                        onClick={() => void removeLibrary(String(block.id))}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {!visibleBlocks.length && (
                <div className="empty-layers">
                  {category === "我的组件"
                    ? "暂无已保存的组件"
                    : "没有匹配的组件"}
                </div>
              )}
            </div>
            <div
              ref={layerHost}
              className="native-layers"
              style={{ display: leftTab === "layers" ? "block" : "none" }}
            />
            <button
              className="library-save-bottom"
              disabled={!selection}
              onClick={() => {
                setLibraryName(selection?.getName() || "");
                setSaveLibraryOpen(true);
              }}
            >
              <BookmarkPlus size={16} />
              保存选中项到组件库
            </button>
            <div className="left-footer">
              <span>编辑内核</span>
              <strong>GrapesJS</strong>
            </div>
          </aside>
          <section className="canvas-section">
            <div className="canvas-toolbar">
              <div className="toolbar-group">
                <Tool
                  label="选择工具"
                  active={!pan}
                  onClick={() => setPan(false)}
                >
                  <MousePointer2 size={17} />
                </Tool>
                <Tool
                  label="平移画布"
                  active={pan}
                  onClick={() => setPan(true)}
                >
                  <Hand size={17} />
                </Tool>
              </div>
              <div className="toolbar-group">
                <Tool
                  label="撤销"
                  disabled={!instance?.UndoManager.hasUndo()}
                  onClick={() => editor.current?.UndoManager.undo()}
                >
                  <Undo2 size={17} />
                </Tool>
                <Tool
                  label="重做"
                  disabled={!instance?.UndoManager.hasRedo()}
                  onClick={() => editor.current?.UndoManager.redo()}
                >
                  <Redo2 size={17} />
                </Tool>
              </div>
              <span className="canvas-device">
                {meta.width < 600 ? "移动端" : "桌面端"}
                <span>
                  {meta.width} × {meta.height}
                </span>
              </span>
              <div className="toolbar-group toolbar-right">
                <Tool label="适应画布" onClick={fit}>
                  <Maximize size={16} />
                </Tool>
                <div className="mobile-tools">
                  <Tool
                    label="组件和图层"
                    onClick={() => setMobile(mobile === "left" ? null : "left")}
                  >
                    <Layers size={17} />
                  </Tool>
                  <Tool
                    label="属性面板"
                    onClick={() =>
                      setMobile(mobile === "right" ? null : "right")
                    }
                  >
                    <SlidersHorizontal size={17} />
                  </Tool>
                </div>
              </div>
            </div>
            <div className="grapes-canvas-host">
              <div ref={host} className="grapes-mount" />
              {initError && (
                <div className="editor-error" role="alert">
                  编辑器加载失败：{initError}
                </div>
              )}
              {pan && (
                <div
                  className="pan-overlay"
                  onPointerDown={(e) => {
                    const coords = editor.current!.Canvas.getCoords();
                    panning.current = {
                      x: e.clientX,
                      y: e.clientY,
                      cx: coords.x,
                      cy: coords.y,
                    };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    const p = panning.current;
                    if (p)
                      editor.current!.Canvas.setCoords(
                        p.cx + e.clientX - p.x,
                        p.cy + e.clientY - p.y,
                      );
                  }}
                  onPointerUp={() => {
                    panning.current = null;
                  }}
                />
              )}
            </div>
            <footer className="canvas-footer">
              <span>
                {selection
                  ? selection.getName()
                  : `${instance?.getWrapper()?.components().length || 0} 个顶层组件`}
              </span>
              <span className="engine-status">本机 Codex 视觉识别</span>
              <div className="zoom-controls">
                <Tool
                  label="缩小"
                  onClick={() =>
                    editor.current?.Canvas.setZoom(Math.max(10, zoom - 10))
                  }
                >
                  <ZoomOut size={14} />
                </Tool>
                <button aria-label="缩放比例" onClick={fit}>
                  {Math.round(zoom)}%
                </button>
                <Tool
                  label="放大"
                  onClick={() =>
                    editor.current?.Canvas.setZoom(Math.min(200, zoom + 10))
                  }
                >
                  <ZoomIn size={14} />
                </Tool>
              </div>
            </footer>
          </section>
          <aside
            className={`right-panel ${mobile === "right" ? "mobile-open" : ""}`}
          >
            <div className="panel-mobile-heading">
              属性
              <Tool label="关闭属性面板" onClick={() => setMobile(null)}>
                <X size={16} />
              </Tool>
            </div>
            <Tabs value={rightTab} onValueChange={setRightTab}>
              <TabsList variant="line" className="panel-tabs">
                <TabsTrigger value="spec">设计规范</TabsTrigger>
                <TabsTrigger value="style">样式</TabsTrigger>
              </TabsList>
            </Tabs>
            <div
              ref={styleHost}
              className="native-styles"
              style={{ display: rightTab === "style" ? "block" : "none" }}
            />
            <div style={{ display: rightTab === "spec" ? "block" : "none" }}>
              {selection ? (
                <>
                  <div className="inspector-heading">
                    <h2>
                      {attrs["data-kind"] || selection.get("type") || "组件"}
                    </h2>
                    <div className="inline-tools">
                      <Tool
                        label="复制组件"
                        onClick={() => {
                          const c = selection.clone();
                          selection
                            .parent()
                            ?.append(c, { at: selection.index() + 1 });
                          editor.current?.select(c);
                        }}
                      >
                        <Copy size={15} />
                      </Tool>
                      <Tool label="删除组件" onClick={() => selection.remove()}>
                        <Trash2 size={15} />
                      </Tool>
                    </div>
                  </div>
                  <section className="inspector-section">
                    <label>组件名称</label>
                    <input
                      aria-label="组件名称"
                      value={selection.getName()}
                      onChange={(e) => {
                        selection.setName(e.target.value);
                        tick((v) => v + 1);
                      }}
                    />
                    <div className="field-pair spaced">
                      <Numeric
                        label="X"
                        value={parseFloat(String(style.left || 0)) || 0}
                        min={-6000}
                        onCommit={(v) => setSize("left", v)}
                      />
                      <Numeric
                        label="Y"
                        value={parseFloat(String(style.top || 0)) || 0}
                        min={-6000}
                        onCommit={(v) => setSize("top", v)}
                      />
                      <Numeric
                        label="W"
                        value={parseFloat(
                          String(
                            style.width ||
                              selection.getEl()?.clientWidth ||
                              100,
                          ),
                        )}
                        min={4}
                        onCommit={(v) => setSize("width", v)}
                      />
                      <Numeric
                        label="H"
                        value={parseFloat(
                          String(
                            style.height ||
                              selection.getEl()?.clientHeight ||
                              40,
                          ),
                        )}
                        min={4}
                        onCommit={(v) => setSize("height", v)}
                      />
                    </div>
                    <div className="align-tools">
                      <Tool label="左对齐" onClick={() => align("left")}>
                        <AlignHorizontalJustifyStart size={16} />
                      </Tool>
                      <Tool label="水平居中" onClick={() => align("center")}>
                        <AlignHorizontalJustifyCenter size={16} />
                      </Tool>
                      <Tool label="右对齐" onClick={() => align("right")}>
                        <AlignHorizontalJustifyEnd size={16} />
                      </Tool>
                      <Tool
                        label="上移一层"
                        onClick={() =>
                          selection.move(selection.parent()!, {
                            at: selection.index() + 2,
                          })
                        }
                      >
                        <ChevronUp size={16} />
                      </Tool>
                      <Tool
                        label="下移一层"
                        onClick={() =>
                          selection.move(selection.parent()!, {
                            at: Math.max(0, selection.index() - 1),
                          })
                        }
                      >
                        <ChevronDown size={16} />
                      </Tool>
                    </div>
                  </section>
                  {attrs["data-kind"] === "icon" && <IconInspector key={selection.getId()} component={selection} />}
                  <section className="inspector-section">
                    <h3>信息层级</h3>
                    <select
                      aria-label="信息层级"
                      value={attrs["data-priority"] || "secondary"}
                      onChange={(e) => attr("data-priority", e.target.value)}
                    >
                      <option value="primary">一级 · 主要信息</option>
                      <option value="secondary">二级 · 次要信息</option>
                      <option value="tertiary">三级 · 辅助信息</option>
                    </select>
                    <div className="toggle-row spaced">
                      <label>设计已确认</label>
                      <Switch
                        aria-label="设计已确认"
                        checked={attrs["data-reviewed"] !== "false"}
                        onCheckedChange={(v) =>
                          attr("data-reviewed", String(v))
                        }
                      />
                    </div>
                  </section>
                  <section className="inspector-section">
                    <h3>给 Codex 的备注</h3>
                    <textarea
                      aria-label="组件备注"
                      rows={5}
                      value={attrs["data-note"] || ""}
                      onChange={(e) => attr("data-note", e.target.value)}
                    />
                  </section>
                  <section className="inspector-section">
                    <button
                      className="command"
                      onClick={() => setRightTab("style")}
                    >
                      <SlidersHorizontal size={15} />
                      文字与布局样式
                    </button>
                  </section>
                </>
              ) : (
                <>
                  <div className="inspector-heading">
                    <h2>画布规范</h2>
                    <span className="tiny-label">DESIGN</span>
                  </div>
                  <section className="inspector-section">
                    <h3>画布</h3>
                    <select
                      aria-label="画布预设"
                      value="custom"
                      onChange={(e) => {
                        const [w, h] = e.target.value.split("x").map(Number);
                        if (w) dimensions(w, h);
                      }}
                    >
                      <option value="custom">自定义尺寸</option>
                      <option value="1120x760">桌面 · 1120 × 760</option>
                      <option value="390x844">手机 · 390 × 844</option>
                      <option value="768x1024">平板 · 768 × 1024</option>
                    </select>
                    <div className="field-pair spaced">
                      <Numeric
                        label="宽度"
                        value={meta.width}
                        min={240}
                        onCommit={(w) => dimensions(w, meta.height)}
                      />
                      <Numeric
                        label="高度"
                        value={meta.height}
                        min={240}
                        onCommit={(h) => dimensions(meta.width, h)}
                      />
                    </div>
                  </section>
                  <section className="inspector-section">
                    <h3>全局规范</h3>
                    <textarea
                      aria-label="全局规范"
                      rows={8}
                      value={meta.notes}
                      onChange={(e) => changeMeta({ notes: e.target.value })}
                    />
                  </section>
                  <section className="inspector-section">
                    <h3>组件库</h3>
                    <div className="library-summary">
                      <span>内置组件与组合</span>
                      <strong>{blocks.length - custom.length}</strong>
                    </div>
                    <div className="library-summary">
                      <span>我的组件</span>
                      <strong>{custom.length}</strong>
                    </div>
                  </section>
                </>
              )}
            </div>
            <section
              className="inspector-section native-traits"
              style={{
                display: selection && rightTab === "spec" ? "block" : "none",
              }}
            >
              <h3>组件属性</h3>
              <div ref={traitHost} />
            </section>
          </aside>
        </div>
        {importOpen && (
          <ImportDialog
            initialImage={meta.reference}
            open={importOpen}
            onOpenChange={setImportOpen}
            onImport={async (p) => {
              if (!(await replaceProject(p))) return false;
              setImportOpen(false);
              toast.success(`已导入 ${p.nodes.length} 个可编辑组件`);
              return true;
            }}
          />
        )}
        <Dialog open={newOpen} onOpenChange={setNewOpen}>
          <DialogContent className="studio-dialog">
            <DialogTitle>新建画布</DialogTitle>
            <DialogDescription>
              新建前请导出当前项目，组件库会保留。
            </DialogDescription>
            <div className="new-presets">
              {[
                ["桌面", 1120, 760],
                ["手机", 390, 844],
                ["平板", 768, 1024],
              ].map(([name, w, h]) => (
                <button
                  className="command"
                  key={name}
                  onClick={async () => {
                    const changed = await replaceProject({
                      ...blankProject(),
                      name: `${name}界面`,
                      width: Number(w),
                      height: Number(h),
                    });
                    if (changed) setNewOpen(false);
                  }}
                >
                  <Frame size={18} />
                  {name}
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={saveLibraryOpen} onOpenChange={setSaveLibraryOpen}>
          <DialogContent className="studio-dialog">
            <DialogTitle>保存到我的组件</DialogTitle>
            <DialogDescription>
              保留选中组件、子组件及其样式。新实例可以独立编辑。
            </DialogDescription>
            <input
              aria-label="组件库名称"
              autoFocus
              value={libraryName}
              maxLength={80}
              onChange={(e) => setLibraryName(e.target.value)}
            />
            <button
              className="command primary"
              disabled={!libraryName.trim()}
              onClick={() => void saveToLibrary()}
            >
              <BookmarkPlus size={16} />
              保存组件
            </button>
          </DialogContent>
        </Dialog>
        <Dialog
          open={exportOpen}
          onOpenChange={(v) => {
            if (!exportBusy) setExportOpen(v);
          }}
        >
          <DialogContent className="studio-dialog export-dialog">
            <div className="dialog-eyebrow">
              <Code2 size={16} />
              设计交付
            </div>
            <DialogTitle>导出给 Codex</DialogTitle>
            <DialogDescription>
              {meta.name} · {meta.width} × {meta.height}
            </DialogDescription>
            <Tabs
              value={exportTab}
              onValueChange={setExportTab}
              className="export-tabs"
            >
              <div className="code-toolbar">
                <TabsList>
                  <TabsTrigger value="handoff">交付规范</TabsTrigger>
                  <TabsTrigger value="html">HTML</TabsTrigger>
                  <TabsTrigger value="react">React</TabsTrigger>
                  <TabsTrigger value="json">JSON</TabsTrigger>
                </TabsList>
                <Tool
                  label="复制当前代码"
                  onClick={() =>
                    copyText(previewCode).then(
                      () => toast.success("已复制"),
                      () => toast.error("剪贴板不可用"),
                    )
                  }
                >
                  <Copy size={15} />
                </Tool>
              </div>
              <pre className="code-preview" aria-label="代码预览" tabIndex={0}>
                {previewCode}
              </pre>
            </Tabs>
            <div className="export-format">
              <label htmlFor="engine-export-format">导出格式</label>
              <select
                id="engine-export-format"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value);
                  setExportResult(null);
                }}
              >
                <option value="bundle">完整交付包 · ZIP</option>
                <option value="png">线框图 · PNG</option>
                <option value="svg">线框图 · SVG</option>
                <option value="html">可运行代码 · HTML</option>
                <option value="json">可编辑工程 · JSON</option>
              </select>
            </div>
            <div className="bundle-manifest">
              <span>
                <Check size={12} />
                PNG + SVG
              </span>
              <span>
                <Check size={12} />
                HTML + React
              </span>
              <span>
                <Check size={12} />
                组件树 + 设计规范
              </span>
            </div>
            {exportResult && (
              <div className="export-saved" role="status">
                <Check size={16} />
                <span>已保存：{exportResult.path}</span>
                {desktop ? (
                  <button
                    className="command"
                    onClick={() => void desktop!.revealFile(exportResult.path)}
                  >
                    <FolderOpen size={16} />
                    在文件夹中显示
                  </button>
                ) : (
                  <a className="command" href={exportResult.url} download>
                    下载文件
                  </a>
                )}
              </div>
            )}
            <div className="dialog-footer-row">
              <span className="privacy-note">接收者：Codex</span>
              <button
                className="command primary"
                disabled={exportBusy}
                onClick={() => void download()}
              >
                {exportBusy ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <Download size={16} />
                )}
                {exportBusy ? "正在生成" : "导出到本机"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
        {desktop && (
          <DesktopSettings
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            beforeApply={flushProject}
          />
        )}
        <Toaster position="bottom-center" richColors closeButton />
      </main>
    </TooltipProvider>
  );
}
