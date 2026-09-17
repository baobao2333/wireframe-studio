import type { Component, ComponentResizeEventUpdateProps, Editor } from "grapesjs";

type Box = { x: number; y: number; width: number; height: number };
type ResizeRect = { l: number; t: number; w: number; h: number };
type ResizeEvent = {
  type?: "start" | "move" | "end";
  component: Component;
  el: HTMLElement;
  event?: Event;
  rect?: ResizeRect;
};
type ResizeUpdate = Omit<ComponentResizeEventUpdateProps, "event"> & { event: Event };
type PointerInput = {
  clientX: number;
  clientY: number;
  target?: EventTarget | null;
  _parentEvent?: PointerInput;
  originalEvent?: PointerInput;
  touches?: ArrayLike<{ clientX: number; clientY: number }>;
};

export function normalizeToolbarPointer(event: { clientX: number; clientY: number }, zoom: number) {
  const scale = zoom / 100;
  event.clientX /= scale;
  event.clientY /= scale;
}

export type GeometryOperation = {
  phase: "start" | "end";
  componentId: string;
  parentId: string | null;
  handle: string;
  zoom: number;
  before: Box;
  after: Box;
  changed: boolean;
  cancelled: boolean;
};

/** Adapt native drag/resize pointers and preserve parent-local resize anchors. */
export function registerEditorGeometry(
  editor: Editor,
  observe?: (operation: GeometryOperation) => void,
) {
  const toolbarPointers = new WeakSet<PointerInput>();
  let active: {
    component: Component;
    operation: GeometryOperation;
  } | null = null;

  const toolbar = ({ event }: { event: PointerInput }) => {
    // GrapesJS already subtracts the frame viewport origin for toolbar starts,
    // but leaves their screen zoom in place. The cloned event is writable.
    normalizeToolbarPointer(event, editor.Canvas.getZoom());
    toolbarPointers.add(event);
  };
  const framePointer = () => {
    const frame = editor.Canvas.getFrameEl();
    const frameDocument = frame.contentDocument;
    return (event: PointerInput) => {
      if (toolbarPointers.has(event)) return { x: event.clientX, y: event.clientY };
      // FrameView forwards native iframe events with _parentEvent. Their client
      // coordinates are already unscaled frame CSS pixels; never divide twice.
      const original = event._parentEvent || event.originalEvent || event;
      const pointer = original.touches?.[0] || original;
      const owner = (original.target as Node | null)?.ownerDocument;
      if (owner === frameDocument) return { x: pointer.clientX, y: pointer.clientY };
      const rect = frame.getBoundingClientRect();
      const scale = editor.Canvas.getZoom() / 100;
      // Both DOM client coordinates and rects are CSS pixels. DPR is not a scale
      // factor here. The native dragger handles frame scrolling independently.
      return { x: (pointer.clientX - rect.left) / scale, y: (pointer.clientY - rect.top) / scale };
    };
  };
  const prepareDrag = ({ options }: { options: { dragger?: Record<string, unknown> } }) => {
    options.dragger = { ...options.dragger, getPointerPosition: framePointer() };
  };
  const prepareResize = ({ options }: { options: { mousePosFetcher?: ReturnType<typeof framePointer> } }) => {
    options.mousePosFetcher = framePointer();
  };

  const lifecycle = (event: ResizeEvent) => {
    if (event.type === "start") {
      active = null;
      const { component, el, rect } = event;
      const css = el.ownerDocument.defaultView?.getComputedStyle(el);
      const target = event.event?.target as HTMLElement | null;
      const handle = target?.getAttribute(`data-${editor.getConfig().stylePrefix}handler`);
      const x = parseFloat(css?.left || ""), y = parseFloat(css?.top || "");
      if (css?.position !== "absolute" || !rect || !handle ||
          !Number.isFinite(x) || !Number.isFinite(y)) return;
      const before = { x, y, width: rect.w, height: rect.h };
      active = { component, operation: {
        phase: "start", componentId: component.getId(), parentId: component.parent()?.getId() || null,
        handle, zoom: editor.Canvas.getZoom(), before, after: { ...before }, changed: false, cancelled: false,
      } };
      observe?.(structuredClone(active.operation));
    } else if (event.type === "end" && active?.component === event.component) {
      const operation = active.operation;
      active = null;
      observe?.({ ...operation, phase: "end" });
    }
  };

  const update = (event: ResizeUpdate) => {
    if (active?.component !== event.component) return;
    const operation = active.operation;
    const { before, handle } = operation;
    // GrapesJS 0.23 mixes unscaled child and zoomed/panned parent rects. Sizes
    // remain valid; anchor the opposite edge from the initial local position.
    const width = ["tc", "bc"].includes(handle) ? before.width
      : Math.min(event.rect.w, editor.Canvas.getBody()?.offsetWidth || event.rect.w);
    const height = ["cl", "cr"].includes(handle) ? before.height : event.rect.h;
    const x = before.x + (handle.includes("l") ? before.width - width : 0);
    const y = before.y + (handle.includes("t") ? before.height - height : 0);
    operation.after = { x, y, width, height };
    operation.cancelled = event.event?.type === "keydown" && (event.event as KeyboardEvent).keyCode === 27;
    operation.changed = Object.keys(before).some(key => before[key as keyof Box] !== operation.after[key as keyof Box]);
    // Use the engine's write callback so partial updates and a single native undo
    // entry stay authoritative. Do not append a second corrective model write.
    event.updateStyle({ ...event.style, left: `${x}px`, top: `${y}px` });
  };

  // The version in use also emits resize:start on movement; the typed umbrella
  // event is the only reliable place to take a once-per-gesture snapshot.
  editor.on("component:resize", lifecycle);
  editor.on("component:resize:update", update);
  editor.on("toolbar:run:before", toolbar);
  editor.on("command:run:before:core:component-drag", prepareDrag);
  editor.on("command:run:before:resize command:run:before:core:resize", prepareResize);
  return {
    destroy() {
      editor.off("component:resize", lifecycle);
      editor.off("component:resize:update", update);
      editor.off("toolbar:run:before", toolbar);
      editor.off("command:run:before:core:component-drag", prepareDrag);
      editor.off("command:run:before:resize command:run:before:core:resize", prepareResize);
      active = null;
    },
  };
}
