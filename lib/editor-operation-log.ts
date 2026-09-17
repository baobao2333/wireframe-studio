import type { Component, Editor } from "grapesjs";
import type { OperationEvent } from "./operation-log";
import { operationLogEventSchema } from "../control/operation-log-schema.mjs";

type Geometry = NonNullable<OperationEvent["before"]>;
type Recorder = { record(event: OperationEvent): void };
type Gesture = { component: Component; type: "drag" | "resize"; id: string; before: Geometry; started: number; sampled: number; cancelled: boolean; handle?: OperationEvent["handle"] };
const kinds = new Set<string>(operationLogEventSchema.shape.kind.unwrap().options);
const properties = new Set<string>(operationLogEventSchema.shape.changedProperties.unwrap().element.options);
const handles = new Set<string>(operationLogEventSchema.shape.handle.unwrap().options);
const numeric = (value: string | undefined) => value && /^-?[\d.]+px$/.test(value) && Number.isFinite(parseFloat(value)) ? parseFloat(value) : null;

export function operationGeometry(component: Component): Geometry {
  const element = component.getEl();
  const css = element?.ownerDocument.defaultView?.getComputedStyle(element);
  return { x: numeric(css?.left), y: numeric(css?.top), width: numeric(css?.width), height: numeric(css?.height) };
}

// Passive observer: editor models remain the only geometry and undo authority.
export function observeEditorOperations(editor: Editor, recorder: Recorder, enabled: () => boolean) {
  let gesture: Gesture | null = null;
  let lastViewport = 0;
  const cached = new WeakMap<Component, Geometry>();
  const subscriptions: (() => void)[] = [];
  const on = <Args extends unknown[]>(name: string, handler: (...args: Args) => void) => { editor.on(name, handler); subscriptions.push(() => editor.off(name, handler)); };
  const viewport = (): NonNullable<OperationEvent["viewport"]> => {
    const coords = editor.Canvas.getCoords();
    const win = editor.Canvas.getWindow();
    return { zoom: editor.Canvas.getZoom(), canvasX: coords.x, canvasY: coords.y, scrollX: win?.scrollX || 0, scrollY: win?.scrollY || 0, devicePixelRatio: window.devicePixelRatio };
  };
  const identity = (component: Component) => ({
    componentId: component.getId(), parentId: component.parent()?.getId() || null,
    kind: (kinds.has(component.getAttributes()["data-kind"] || component.get("type")) ? component.getAttributes()["data-kind"] || component.get("type") : "unknown") as OperationEvent["kind"],
  });
  const emit = (event: OperationEvent) => { if (enabled()) recorder.record(event); };
  const finish = (cancelled = false, interrupted = false) => {
    if (!gesture) return;
    const active = gesture;
    gesture = null;
    const after = operationGeometry(active.component);
    cached.set(active.component, after);
    emit({ event: `component.${active.type}.${cancelled ? "cancel" : "end"}`, source: "editor", operationId: active.id,
      ...identity(active.component), handle: active.handle, before: active.before, after, viewport: viewport(), durationMs: Date.now() - active.started,
      code: interrupted ? "INTERRUPTED" : cancelled ? "CANCELLED" : JSON.stringify(after) === JSON.stringify(active.before) ? "UNCHANGED" : "CHANGED" });
  };
  const begin = (component: Component, type: Gesture["type"], handle?: OperationEvent["handle"]) => {
    if (!enabled() || !component) return;
    if (gesture) finish(true, true);
    const before = operationGeometry(component), now = Date.now();
    gesture = { component, type, id: crypto.randomUUID(), before, started: now, sampled: now, cancelled: false, handle };
    cached.set(component, before);
    emit({ event: `component.${type}.start`, source: "editor", ...identity(component), operationId: gesture.id, handle, before, viewport: viewport() });
  };
  on("component:drag:start", (data: { target?: Component }) => { const target = data.target || editor.getSelected(); if (target) begin(target, "drag"); });
  on("component:drag:end", (data?: { cancelled?: boolean }) => finish(Boolean(data?.cancelled)));
  // 0.23.6 emits resize:start on move too; only the generic event distinguishes phases.
  on("component:resize", (data: { type: string; component: Component; event?: Event }) => {
    if (data.type === "start") {
      const handle = (data.event?.target as HTMLElement | null)?.getAttribute(`data-${editor.getConfig().stylePrefix}handler`);
      begin(data.component, "resize", handle && handles.has(handle) ? handle as OperationEvent["handle"] : undefined);
    }
    if (data.type === "end") finish(gesture?.cancelled);
  });
  on("component:resize:update", (data: { event?: KeyboardEvent }) => {
    if (gesture && data.event?.type === "keydown" && (data.event.key === "Escape" || data.event.keyCode === 27)) gesture.cancelled = true;
  });
  on("component:selected", (component: Component) => {
    const after = operationGeometry(component); cached.set(component, after);
    emit({ event: "selection", source: "editor", ...identity(component), after, viewport: viewport() });
  });
  const update = (event: "component.update" | "component.style", component: Component, changed: Record<string, unknown> = {}) => {
    if (!enabled() || component.get("type") === "textnode") return;
    const after = operationGeometry(component), before = cached.get(component);
    cached.set(component, after);
    if (gesture && Date.now() - gesture.sampled < 250) return;
    if (gesture) gesture.sampled = Date.now();
    const raw = Object.keys(changed.style && typeof changed.style === "object" ? changed.style : changed);
    const changedProperties = [...new Set(raw.map(key => properties.has(key) ? key : "other"))].slice(0, 30) as OperationEvent["changedProperties"];
    emit({ event, source: "editor", ...identity(component), before, after, changedProperties,
      ...(gesture ? { operationId: gesture.id } : {}), viewport: viewport() });
  };
  on("component:update", (component: Component, changed?: Record<string, unknown>) => update("component.update", component, changed));
  on("component:styleUpdate", (component: Component, changed?: Record<string, unknown>) => update("component.style", component, changed));
  for (const action of ["add", "remove"] as const) on(`component:${action}`, (component: Component) => {
    if (component.get("type") !== "textnode") emit({ event: `component.${action}`, source: "editor", ...identity(component), after: operationGeometry(component) });
  });
  on("canvas:zoom canvas:coords", () => {
    if (Date.now() - lastViewport < 250) return;
    lastViewport = Date.now(); emit({ event: "viewport", source: "editor", viewport: viewport() });
  });
  on("undo", () => emit({ event: "history.undo", source: "editor", viewport: viewport() }));
  on("redo", () => emit({ event: "history.redo", source: "editor", viewport: viewport() }));
  return {
    dispose() { finish(true, true); subscriptions.forEach(unsubscribe => unsubscribe()); },
  };
}
