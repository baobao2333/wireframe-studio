import type { Component, ComponentDefinition, Editor } from "grapesjs";
import type { z } from "zod";
import { controlOperationSchema, controlStyleSchema, controlTools } from "../control/schema.mjs";
import { captureLibraryComponent, freshDefinition } from "./component-snapshot";
import { componentDefinition } from "./editor-library";
import { iconAssets } from "./icon-assets";
import { buildExport, validateStudioFile, type Meta } from "./grapes-export";
import { makeNode } from "./wireframe";

type Operation = z.infer<typeof controlOperationSchema>;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Options = {
  getMeta: () => Meta;
  setMeta: (meta: Meta) => void;
  persist: () => Promise<void>;
  canExecute: () => boolean;
  onTransaction?: (summary: string) => void;
};
type NativeAction = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  undo: () => void;
  redo: () => void;
};
type NativeStack = {
  models: NativeAction[];
  pointer: number;
  maximumStackLength: number;
  isCurrentlyUndoRedoing: boolean;
  reset: (models: NativeAction[]) => void;
};
type Batch = { actions: NativeAction[]; targets: Component[]; summary: string; undo: () => void; redo: () => void };
type NativeUndo = {
  stack: NativeStack;
  isTracking: () => boolean;
  addUndoType: (name: string, handlers: {
    on: (batch: Batch) => { object: Batch; before: null; after: null; options: { action: string } };
    undo: (batch: Batch) => void;
    redo: (batch: Batch) => void;
  }) => void;
  _addToStack: (name: string, batch: Batch) => void;
};
type VirtualNode = { component: Component; parentId: string | null; children: string[]; alive: boolean };
type Plan = { run: () => Component[] | void; targets: Component[] };

const MAX_COMPONENTS = 5000;
const MAX_NEW_COMPONENTS = 500;
const styleKeys = Object.keys(controlStyleSchema.shape);
const librarySvg = new Set(Object.values(iconAssets));
const pixelStyles = new Set(["border-width", "border-radius", "font-size", "-webkit-text-stroke-width", "padding-top", "padding-right", "padding-bottom", "padding-left", "gap"]);
const events = "component:add component:remove component:update component:styleUpdate styleable:change style:add style:remove project:load page:select component:selected component:deselected undo redo";

class ControlError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function fail(code: string, message: string): never { throw new ControlError(code, message); }
const copyJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const isComponent = (value: unknown): value is Component => !!value && typeof (value as Component).components === "function" && typeof (value as Component).getId === "function";
const kind = (component: Component) => String(component.getAttributes()["data-kind"] || component.get("type") || component.get("tagName"));
const decorative = (component: Component) => component.get("selectable") === false && component.get("layerable") === false;
const richRun = (component: Component) => component.get("tagName") === "span" && kind(component.parent()!) === "richtext" && component.get("resizable") === false;
const locked = (component: Component) => component.get("locked") === true || component.getAttributes()["data-locked"] === "true" || (component.get("draggable") === false && !decorative(component) && !(component.parent() && richRun(component)));
const plainChildren = (component: Component) => component.components().every((child: Component) => child.is("textnode"));
const plainText = (component: Component): string => {
  if (component.is("textnode")) return String(component.get("content") || "");
  if (component.get("tagName") === "input") return String(component.getAttributes().placeholder || "");
  if (!component.components().length) {
    const content = String(component.get("content") || "");
    return component.getEl()?.textContent || (!/[<&]/.test(content) ? content : "");
  }
  return component.components().map(plainText).join("");
};
const canSetText = (component: Component) => component.get("tagName") === "input" || (component.is("text") && plainChildren(component) && !/[<&]/.test(String(component.get("content") || "")));
const canSetRich = (component: Component): boolean => {
  if (!component.is("text") || component.get("content")) return false;
  const inline = (node: Component): boolean => node.is("textnode") || (["span", "b", "strong", "i", "em", "u", "s", "br"].includes(String(node.get("tagName"))) && !node.get("content") && node.components().every(inline));
  return component.components().every(inline);
};
const convertStyles = (style: Record<string, string | number | undefined>) => Object.fromEntries(Object.entries(style).map(([key, value]) => [key, pixelStyles.has(key) ? `${value}px` : value === "none" && key.includes("color") ? "transparent" : String(value)]));
const geometryStyle = (geometry: { x?: number; y?: number; width?: number; height?: number }) => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(geometry)) result[key === "x" ? "left" : key === "y" ? "top" : key] = `${value}px`;
  return result;
};
function completeNativeActions(actions: NativeAction[]) {
  for (const action of actions) {
    if (action.get("type") !== "change") continue;
    const before = action.get("before"), after = action.get("after");
    if (!before || !after || typeof before !== "object" || typeof after !== "object") continue;
    const added = Object.keys(after).filter(key => !Object.hasOwn(before, key));
    if (!added.length) continue;
    // GrapesJS replaces Backbone's change capture and omits its newly-added-key cleanup.
    const previous = (action.get("options") || {}) as { unsetData?: { before?: string[]; after?: string[] } };
    action.set("options", { ...previous, unsetData: { ...previous.unsetData, before: [...new Set([...(previous.unsetData?.before || []), ...added])] } });
  }
  return actions;
}

export function createCodexController(editor: Editor, options: Options) {
  const epoch = crypto.randomUUID();
  const undoType = `codex:batch:${epoch}`;
  const native = editor.UndoManager.getInstance() as NativeUndo;
  let counter = 0, disposed = false, executing = false, compromised = false, interacting = false;
  let lastMeta = options.getMeta();
  let lastWrapper = editor.getWrapper();
  const bump = () => { counter++; };
  const startInteraction = () => { interacting = true; bump(); };
  const endInteraction = () => { interacting = false; bump(); };
  const sync = () => {
    if (disposed) return `${epoch}:${counter}`;
    const meta = options.getMeta(), wrapper = editor.getWrapper();
    if (meta !== lastMeta || wrapper !== lastWrapper) { lastMeta = meta; lastWrapper = wrapper; bump(); }
    return `${epoch}:${counter}`;
  };
  const requireReady = () => {
    if (disposed) fail("DISPOSED", "The editor controller has been disposed.");
    if (!editor.getWrapper()) fail("NOT_READY", "The current document is not ready.");
  };
  const requireWritable = () => {
    requireReady();
    const active = typeof document === "undefined" ? null : document.activeElement as HTMLElement | null;
    const typing = active && (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
    if (compromised) fail("RELOAD_REQUIRED", "A previous editor rollback failed; reload the document before writing.");
    if (!options.canExecute() || interacting || typing || editor.getModel().isEditing()) fail("EDITOR_BUSY", "The user is editing, dragging, or switching documents. Read the state again when the editor is idle.");
    if (editor.UndoManager.isDisabled || !native.isTracking() || native.stack.isCurrentlyUndoRedoing) fail("HISTORY_UNAVAILABLE", "Native editor history is not ready.");
  };
  const tree = () => {
    const map = new Map<string, VirtualNode>();
    const walk = (component: Component, parentId: string | null, depth: number) => {
      if (depth > 80 || map.size >= MAX_COMPONENTS) fail("DOCUMENT_LIMIT", "The document exceeds the control limit of 5000 components or 80 levels.");
      const id = component.getId();
      if (map.has(id)) fail("DUPLICATE_ID", "The document contains duplicate component IDs.");
      map.set(id, { component, parentId, children: component.components().map((child: Component) => child.getId()), alive: true });
      component.components().forEach((child: Component) => walk(child, id, depth + 1));
    };
    walk(editor.getWrapper()!, null, 0);
    return map;
  };
  const assertUnlocked = (component: Component, deep = true) => {
    for (let current: Component | undefined = component; current; current = current.parent()) {
      if (current !== editor.getWrapper() && locked(current)) fail("LOCKED", `Component ${current.getId()} is locked.`);
    }
    if (deep) component.forEachChild(child => { if (locked(child)) fail("LOCKED", `Component ${child.getId()} is locked.`); });
  };
  const isLayerLocked = (component: Component) => [component, ...component.parents()].some(node => node !== editor.getWrapper() && locked(node));
  const readStyle = (component: Component) => {
    const element = component.getEl();
    const computed = element?.isConnected ? element.ownerDocument.defaultView?.getComputedStyle(element) : null;
    const own = component.getStyle();
    return Object.fromEntries(styleKeys.map(key => [key, computed?.getPropertyValue(key) || own[key]]).filter(([, value]) => value !== undefined && value !== ""));
  };
  const readGeometry = (component: Component) => {
    const element = component.getEl();
    const computed = element?.isConnected ? element.ownerDocument.defaultView?.getComputedStyle(element) : null;
    const style = component.getStyle();
    const values = Object.fromEntries(["left", "top", "width", "height", "position"].map(key => [key, computed?.getPropertyValue(key) || style[key] || null]));
    const numeric = (key: string) => typeof values[key] === "string" && /^-?\d+(\.\d+)?px$/.test(values[key]) ? parseFloat(values[key]) : null;
    return { coordinateSpace: "parent-local-css-px", x: numeric("left"), y: numeric("top"), width: numeric("width"), height: numeric("height"), css: values };
  };
  const details = (component: Component) => {
    const attrs = component.getAttributes();
    const runs: Record<string, unknown>[] = [];
    if (kind(component) === "richtext" && canSetRich(component)) {
      const walk = (node: Component) => {
        if (node.is("textnode")) {
          const style = readStyle(node.parent()!);
          runs.push({ text: plainText(node), fontSize: style["font-size"] || null, fontWeight: style["font-weight"] || null, color: style.color || null, italic: style["font-style"] === "italic", underline: String(style["text-decoration"] || "").includes("underline") });
        } else node.components().forEach(walk);
      };
      walk(component);
      if (runs.length > 200) fail("OUTPUT_LIMIT", "The component has more than 200 text runs.");
    }
    const text = plainText(component);
    if (text.length > 20000) fail("OUTPUT_LIMIT", "The selected component text exceeds the response limit; read its children instead.");
    return {
      id: component.getId(), parentId: component.parent() === editor.getWrapper() ? null : component.parent()?.getId() || null,
      name: component.getName(), kind: kind(component), tag: component.get("tagName"), locked: isLayerLocked(component),
      text, textEditable: canSetText(component), richTextEditable: canSetRich(component), runs,
      style: readStyle(component), geometry: readGeometry(component),
      properties: { priority: attrs["data-priority"] || "secondary", note: String(attrs["data-note"] || "").slice(0, 10000), reviewed: attrs["data-reviewed"] !== "false", origin: attrs["data-origin"] || "manual" },
      children: component.components().filter((child: Component) => !child.is("textnode") && !decorative(child)).map(child => child.getId()),
    };
  };
  const prepare = (operations: Operation[]): Plan[] => {
    const map = tree(), wrapper = editor.getWrapper()!, rootId = wrapper.getId();
    let newCount = 0;
    const resolve = (id: string, allowRoot = false) => {
      const value = map.get(id);
      if (!value?.alive) fail("COMPONENT_NOT_FOUND", `Component ${id} does not exist in this batch state.`);
      if ((!allowRoot && id === rootId) || value.component.is("textnode") || decorative(value.component)) fail("PROTECTED_COMPONENT", `Component ${id} is a protected structural component.`);
      return value;
    };
    const parent = (id: string | null) => {
      const value = resolve(id === null ? rootId : id, true);
      if (value.component !== wrapper && (kind(value.component) !== "frame" || value.component.get("droppable") === false)) fail("INVALID_PARENT", "Only an unlocked frame or the canvas root can receive components.");
      assertUnlocked(value.component, false);
      return value;
    };
    const removeVirtual = (id: string) => {
      const value = map.get(id);
      if (!value) return;
      value.alive = false;
      [...value.children].forEach(removeVirtual);
      if (value.parentId) { const siblings = map.get(value.parentId)!.children; siblings.splice(siblings.indexOf(id), 1); }
    };
    const validateDefinition = (definition: ComponentDefinition) => {
      const raw = JSON.stringify(definition);
      if (raw.length > 500000) fail("BLOCK_LIMIT", "The selected library component is too large.");
      validateStudioFile({ format: "wireframe-studio", version: 2, meta: options.getMeta(), editor: { pages: [{ component: definition }] } });
      const count = (value: ComponentDefinition, depth = 0): number => {
        if (depth > 40) fail("BLOCK_LIMIT", "The selected library component is too deep.");
        if (["style", "link", "meta", "base"].includes(String(value.tagName).toLowerCase()) || value.styles) fail("UNSAFE_BLOCK", "Library blocks may not inject document-wide styles or metadata.");
        if (typeof value.components === "string" && !librarySvg.has(value.components)) fail("UNSAFE_BLOCK", "Library blocks must use structured children, not raw HTML.");
        if (value.type !== "textnode" && typeof value.content === "string" && value.content.includes("<")) fail("UNSAFE_BLOCK", "Library blocks may not contain raw HTML content.");
        if (typeof value.style === "string" && value.style) fail("UNSAFE_BLOCK", "Library blocks must use structured styles.");
        if (Array.isArray(value.components) && value.components.some(child => typeof child === "string")) fail("UNSAFE_BLOCK", "Library blocks must use structured children, not raw HTML.");
        return 1 + (Array.isArray(value.components) ? value.components.reduce((sum: number, child) => sum + (typeof child === "object" ? count(child as ComponentDefinition, depth + 1) : 1), 0) : 0);
      };
      newCount += count(definition);
      if (newCount > MAX_NEW_COMPONENTS || newCount + map.size > MAX_COMPONENTS) fail("BLOCK_LIMIT", "A batch may add at most 500 components, within the 5000-component document limit.");
    };
    const plans: Plan[] = [];
    for (const operation of operations) {
      if (operation.op === "set_document") {
        plans.push({ targets: [], run: () => options.setMeta({ ...options.getMeta(), ...operation.document }) });
        continue;
      }
      if (operation.op === "select") {
        const selected = operation.ids.map(id => resolve(id).component);
        plans.push({ targets: [], run: () => { editor.select(selected); } });
        continue;
      }
      if (operation.op === "add_block") {
        const destination = parent(operation.parentId);
        const block = editor.BlockManager.get(operation.blockId);
        if (!block) fail("BLOCK_NOT_FOUND", `Library block ${operation.blockId} does not exist.`);
        const content = block.getContent();
        if (!content || typeof content !== "object" || Array.isArray(content)) fail("UNSAFE_BLOCK", "Only existing structured library definitions can be added.");
        const definition = freshDefinition(content as ComponentDefinition);
        validateDefinition(definition);
        const index = operation.index ?? destination.children.length;
        if (index > destination.children.length) fail("INVALID_INDEX", "The insertion index exceeds the parent child count.");
        destination.children.splice(index, 0, `new:${plans.length}`);
        if (operation.geometry) definition.style = { ...(definition.style as Record<string, string>), ...geometryStyle(operation.geometry) };
        plans.push({ targets: destination.component === wrapper ? [] : [destination.component], run: () => destination.component.append(definition, { at: index }) });
        continue;
      }
      if (operation.op === "delete") {
        const selected = operation.ids.map(id => resolve(id));
        if (new Set(operation.ids).size !== operation.ids.length) fail("DUPLICATE_TARGET", "Delete IDs must be unique.");
        for (const value of selected) {
          assertUnlocked(value.component);
          let ancestor = value.parentId;
          while (ancestor) { if (operation.ids.includes(ancestor)) fail("OVERLAPPING_TARGETS", "Do not delete both a parent and its child in one operation."); ancestor = map.get(ancestor)!.parentId; }
        }
        selected.forEach(value => removeVirtual(value.component.getId()));
        plans.push({ targets: selected.flatMap(value => [value.component, ...(value.parentId && value.parentId !== rootId ? [map.get(value.parentId)!.component] : [])]), run: () => {
          selected.forEach(value => { value.component.remove(); if (value.component.parent()) fail("EDITOR_REJECTED", "The editor rejected a component removal."); });
        } });
        continue;
      }
      const value = resolve(operation.id), component = value.component;
      assertUnlocked(component);
      if (operation.op === "set_text") {
        if (!canSetText(component)) fail("COMPLEX_TEXT", "Plain text replacement would erase structured children. Use set_rich_text on a supported text block or edit a child instead.");
        [...value.children].forEach(removeVirtual);
        plans.push({ targets: [component], run: () => {
          if (component.get("tagName") === "input") component.addAttributes({ placeholder: operation.text });
          else { component.set("content", ""); component.components([{ type: "textnode", content: operation.text }]); }
        } });
      } else if (operation.op === "set_rich_text") {
        if (!canSetRich(component)) fail("COMPLEX_TEXT", "Rich text replacement is restricted to text blocks with inline text children.");
        [...value.children].forEach(removeVirtual);
        const runs = operation.runs.map(run => ({ ...run, color: run.color === "transparent" ? "none" : run.color }));
        const definition = componentDefinition(makeNode("richtext", { text: runs.map(run => run.text).join(""), runs }));
        plans.push({ targets: [component], run: () => { component.components(definition.components!); component.addAttributes({ "data-kind": "richtext" }); } });
      } else if (operation.op === "set_style") {
        const styles = convertStyles(operation.style);
        if (operation.style["-webkit-text-stroke-width"] !== undefined) styles["paint-order"] = "stroke fill";
        plans.push({ targets: [component], run: () => { component.addStyle(styles); } });
      } else if (operation.op === "set_geometry") {
        const position = readGeometry(component).css.position;
        if (position !== "absolute") fail("NON_ABSOLUTE_LAYOUT", "Geometry editing requires an absolute-positioned component; flex and flow children are not converted implicitly.");
        plans.push({ targets: [component], run: () => { component.addStyle(geometryStyle(operation.geometry)); } });
      } else if (operation.op === "set_properties") {
        plans.push({ targets: [component], run: () => {
          const properties = operation.properties;
          if (properties.name !== undefined) component.setName(properties.name);
          const attributes: Record<string, string> = {};
          if (properties.note !== undefined) attributes["data-note"] = properties.note;
          if (properties.priority !== undefined) attributes["data-priority"] = properties.priority;
          if (properties.reviewed !== undefined) attributes["data-reviewed"] = String(properties.reviewed);
          if (Object.keys(attributes).length) component.addAttributes(attributes);
        } });
      } else if (operation.op === "duplicate") {
        const definition = captureLibraryComponent(component);
        validateDefinition(definition);
        const layout = readGeometry(component);
        if (layout.x === null || layout.y === null || layout.css.position !== "absolute") fail("NON_ABSOLUTE_LAYOUT", "Duplication requires an absolute-positioned component with pixel coordinates.");
        const x = layout.x + operation.offsetX, y = layout.y + operation.offsetY;
        if (x < -10000 || x > 20000 || y < -10000 || y > 20000) fail("GEOMETRY_LIMIT", "The duplicate would exceed coordinate limits.");
        definition.style = { ...(definition.style as Record<string, string>), left: `${x}px`, top: `${y}px` };
        const destination = map.get(value.parentId!)!;
        const index = destination.children.indexOf(component.getId()) + 1;
        destination.children.splice(index, 0, `new:${plans.length}`);
        plans.push({ targets: [component], run: () => destination.component.append(definition, { at: index }) });
      } else if (operation.op === "move") {
        const destination = parent(operation.parentId), destinationId = destination.component.getId();
        let ancestor: string | null = destinationId;
        while (ancestor) { if (ancestor === component.getId()) fail("PARENT_CYCLE", "A component cannot move into itself or its descendants."); ancestor = map.get(ancestor)!.parentId; }
        const old = map.get(value.parentId!)!;
        old.children.splice(old.children.indexOf(component.getId()), 1);
        const index = operation.index ?? destination.children.length;
        if (index > destination.children.length) fail("INVALID_INDEX", "The insertion index exceeds the destination child count.");
        destination.children.splice(index, 0, component.getId());
        value.parentId = destinationId;
        plans.push({ targets: [component, ...(destination.component === wrapper ? [] : [destination.component])], run: () => {
          // GrapesJS move's at is relative to the pre-removal list for same-parent moves.
          const at = component.parent() === destination.component && component.index() < index ? index + 1 : index;
          component.move(destination.component, { at });
          if (component.parent() !== destination.component || component.index() !== index) fail("EDITOR_REJECTED", "The editor rejected the requested hierarchy move.");
        } });
      }
    }
    return plans;
  };

  // Reuse the installed backbone-undo actions, compacted into one native history item.
  // This avoids half-groups at the stack limit and never reloads or replaces the editor.
  native.addUndoType(undoType, {
    on: batch => ({ object: batch, before: null, after: null, options: { action: batch.summary } }),
    undo: batch => batch.undo(),
    redo: batch => batch.redo(),
  });
  editor.on(events, bump);
  editor.on("component:drag:start component:resize:start rte:enable", startInteraction);
  editor.on("component:drag:end component:resize:end rte:disable", endInteraction);

  function dispose() {
    if (disposed) return;
    disposed = true;
    bump();
    editor.off(events, bump);
    editor.off("component:drag:start component:resize:start rte:enable", startInteraction);
    editor.off("component:drag:end component:resize:end rte:disable", endInteraction);
    editor.off("destroy", dispose);
    // Existing native history items retain their undo type until the editor is destroyed.
  }
  editor.on("destroy", dispose);

  const apply = (operations: Operation[], summary: string) => {
    const plans = prepare(operations);
    const stack = native.stack, models = [...stack.models], pointer = stack.pointer, maximum = stack.maximumStackLength;
    const original = new Set(models), beforeMeta = options.getMeta(), beforeSelection = editor.getSelectedAll();
    const wrapper = editor.getWrapper();
    const changesMeta = operations.some(operation => operation.op === "set_document");
    const added: Component[] = [];
    const restoreStack = () => { stack.reset(models); stack.pointer = pointer; stack.maximumStackLength = maximum; stack.isCurrentlyUndoRedoing = false; };
    const selectExisting = (selection: Component[]) => editor.select(selection.filter(component => !!component.parent()));
    const actions = () => completeNativeActions(stack.models.filter(action => !original.has(action)));
    stack.maximumStackLength = Infinity;
    try {
      plans.forEach(plan => { const created = plan.run(); if (created) added.push(...created); });
      const recorded = actions(), afterMeta = options.getMeta(), afterSelection = editor.getSelectedAll();
      const batch: Batch = {
        actions: recorded, targets: [...new Set([...plans.flatMap(plan => plan.targets), ...added])], summary,
        undo: () => {
          if (editor.getWrapper() !== wrapper) fail("DOCUMENT_CHANGED", "The transaction belongs to a different document.");
          [...recorded].reverse().forEach(action => action.undo());
          if (changesMeta) options.setMeta({ ...beforeMeta });
          selectExisting(beforeSelection);
        },
        redo: () => {
          if (editor.getWrapper() !== wrapper) fail("DOCUMENT_CHANGED", "The transaction belongs to a different document.");
          recorded.forEach(action => action.redo());
          if (changesMeta) options.setMeta({ ...afterMeta });
          selectExisting(afterSelection);
        },
      };
      restoreStack();
      native._addToStack(undoType, batch);
      const entry = stack.models[stack.pointer];
      const lowestGroup = Math.min(0, ...models.map(action => Number(action.get("magicFusionIndex"))).filter(Number.isFinite));
      entry.set("magicFusionIndex", lowestGroup - 1);
      bump();
      return added.map(component => component.getId());
    } catch (error) {
      try {
        const recorded = actions();
        stack.isCurrentlyUndoRedoing = true;
        [...recorded].reverse().forEach(action => action.undo());
        if (changesMeta) options.setMeta(beforeMeta);
        selectExisting(beforeSelection);
        restoreStack();
      } catch {
        compromised = true;
        stack.isCurrentlyUndoRedoing = false;
        stack.maximumStackLength = maximum;
        fail("ROLLBACK_FAILED", "An editor extension prevented rollback; the document may be partially changed and was not confirmed saved. Reload before further control edits.");
      }
      throw error;
    }
  };
  const requireHistoryWritable = (redo: boolean) => {
    const stack = native.stack, action = stack.models[stack.pointer + (redo ? 1 : 0)];
    if (!action) fail("NO_HISTORY", redo ? "There is nothing to redo." : "There is nothing to undo.");
    const group = action.get("magicFusionIndex"), map = tree();
    const check = (item: NativeAction) => {
      const object = item.get("object");
      if (object && typeof object === "object" && "targets" in object) (object as Batch).targets.forEach(component => assertUnlocked(component));
      else if (isComponent(object)) assertUnlocked(object);
      else if (object && typeof object === "object" && "parent" in object && isComponent(object.parent)) assertUnlocked(object.parent);
      else if (object && typeof object === "object" && "get" in object) {
        const selectors = (object as { get: (key: string) => { models?: { get: (key: string) => unknown }[] } }).get("selectors");
        selectors?.models?.forEach(selector => { const component = map.get(String(selector.get("name")))?.component; if (component) assertUnlocked(component); });
      }
    };
    stack.models.filter(item => item.get("magicFusionIndex") === group).forEach(check);
  };

  async function execute(toolName: string, args: unknown): Promise<Json> {
    let applied = false, ownsExecution = false;
    try {
      requireReady();
      const tool = controlTools.find(value => value.name === toolName);
      if (!tool) fail("UNKNOWN_TOOL", "Unknown editor control tool.");
      let serialized: string;
      try { serialized = JSON.stringify(args); } catch { return fail("INVALID_ARGUMENTS", "Arguments must be JSON."); }
      if (!serialized || serialized.length > 256000) fail("ARGUMENT_LIMIT", "The request exceeds the 256000-character limit.");
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) fail("INVALID_ARGUMENTS", parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      const input = parsed.data;
      const revision = sync();
      if (!tool.readOnly) {
        if (executing) fail("EDITOR_BUSY", "Another control write is still being saved.");
        requireWritable();
        if (!("expectedRevision" in input) || input.expectedRevision !== revision) fail("REVISION_CONFLICT", "The document or selection changed. Read its state again before applying this request.");
        executing = ownsExecution = true;
        // Native magicFusionIndex resets on a deferred task, not a microtask.
        await new Promise(resolve => setTimeout(resolve, 1));
        requireWritable();
        if (input.expectedRevision !== sync()) fail("REVISION_CONFLICT", "The document changed before the transaction could start. Read its state again.");
      }
      if (toolName === "wireframe_get_state") {
        const { offset, limit } = input as { offset: number; limit: number };
        const nodes = [...tree().values()].filter(value => value.component !== editor.getWrapper() && !value.component.is("textnode") && !decorative(value.component));
        const meta = options.getMeta();
        return copyJson({ ok: true, revision, document: { name: meta.name, notes: meta.notes, width: meta.width, height: meta.height, reference: meta.reference ? { name: meta.reference.name, width: meta.reference.width, height: meta.reference.height } : null }, selection: editor.getSelectedAll().map(component => component.getId()), outline: nodes.slice(offset, offset + limit).map(({ component }) => ({ id: component.getId(), parentId: component.parent() === editor.getWrapper() ? null : component.parent()?.getId() || null, name: component.getName(), kind: kind(component), locked: isLayerLocked(component), reviewed: component.getAttributes()["data-reviewed"] !== "false", childCount: component.components().filter((child: Component) => !child.is("textnode") && !decorative(child)).length })), total: nodes.length, nextOffset: offset + limit < nodes.length ? offset + limit : null, canUndo: editor.UndoManager.hasUndo(), canRedo: editor.UndoManager.hasRedo() });
      }
      if (toolName === "wireframe_get_components") {
        const map = tree();
        const components = (input as { ids: string[] }).ids.map(id => {
          const component = map.get(id)?.component;
          if (!component || component === editor.getWrapper() || component.is("textnode") || decorative(component)) fail("COMPONENT_NOT_FOUND", `Component ${id} is not an editable layer.`);
          return details(component);
        });
        return copyJson({ ok: true, revision, components });
      }
      if (toolName === "wireframe_list_library") {
        const blocks = editor.BlockManager.getAll().models;
        if (blocks.length > 1000) fail("OUTPUT_LIMIT", "The component library exceeds 1000 blocks.");
        return copyJson({ ok: true, revision, blocks: blocks.map(block => ({ id: String(block.id), name: String(block.getLabel()).slice(0, 200), category: String(block.getCategoryLabel() || "").slice(0, 200), structured: !!block.getContent() && typeof block.getContent() === "object" && !Array.isArray(block.getContent()) })) });
      }
      if (toolName === "wireframe_get_preview") {
        const output = await buildExport(editor, options.getMeta(), "png");
        if (disposed || sync() !== revision) fail("REVISION_CONFLICT", "The document changed while the preview was rendering; request a new preview.");
        if (output.blob.size > 8 * 1024 * 1024) fail("OUTPUT_LIMIT", "The PNG preview exceeds 8 MiB.");
        const bytes = new Uint8Array(await output.blob.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        return { ok: true, revision, image: { mimeType: "image/png", data: btoa(binary) } };
      }
      let addedIds: string[] = [], summary: string;
      if (toolName === "wireframe_apply") {
        const request = input as { operations: Operation[]; summary: string };
        addedIds = apply(request.operations, request.summary);
        summary = request.summary;
      } else {
        const redo = toolName === "wireframe_redo";
        requireHistoryWritable(redo);
        try { editor.UndoManager[redo ? "redo" : "undo"](); }
        catch { compromised = true; native.stack.isCurrentlyUndoRedoing = false; fail("HISTORY_FAILED", "Native history failed; the document may be partially changed. Reload before further control edits."); }
        summary = redo ? "Redo editor history" : "Undo editor history";
        bump();
      }
      applied = true;
      const appliedRevision = sync();
      try { await options.persist(); }
      catch { return { ok: false, revision: sync(), appliedRevision, applied: true, saved: false, error: { code: "PERSIST_FAILED", message: "The change is applied in the editor, but saving failed. Do not repeat it with a new request ID; inspect the document and retry saving." } }; }
      await new Promise(resolve => setTimeout(resolve, 1));
      let warning: string | null = null;
      try { options.onTransaction?.(summary); } catch { warning = "The editor change was saved, but its notification callback failed."; }
      return { ok: true, revision: sync(), appliedRevision, applied: true, saved: true, summary, addedIds, warning };
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "EDITOR_ERROR";
      return { ok: false, revision: sync(), applied: applied || code === "ROLLBACK_FAILED" || code === "HISTORY_FAILED", saved: false, error: { code, message: error instanceof ControlError ? error.message : "The editor rejected the request. No successful save was reported." } };
    } finally { if (ownsExecution) executing = false; }
  }
  return { execute, dispose };
}
