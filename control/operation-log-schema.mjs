import { z } from "zod";

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_:-]+$/);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const dimension = z.number().finite().min(0).max(1_000_000);
const version = z.string().max(64).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/);

export const operationLogRuntimeSchema = z.object({
  appVersion: version,
  rendererVersion: version,
}).strict();

export const operationLogGeometrySchema = z.object({
  x: coordinate.nullable(),
  y: coordinate.nullable(),
  width: dimension.nullable(),
  height: dimension.nullable(),
}).strict().describe("Parent-local geometry in CSS px, independent of canvas zoom. Null explicitly means unavailable or layout-managed.");

export const operationLogEventSchema = z.object({
  event: z.enum([
    "session.start", "session.end", "renderer.ready",
    "component.drag.start", "component.drag.end", "component.drag.cancel",
    "component.resize.start", "component.resize.end", "component.resize.cancel",
    "component.add", "component.remove", "component.style", "component.update",
    "selection", "viewport", "project.load.start", "project.load", "project.save.start",
    "project.save", "project.failed", "history.undo", "history.redo", "control.outcome",
  ]),
  source: z.enum(["editor", "desktop", "control"]),
  operationId: identifier.optional(),
  componentId: identifier.optional(),
  parentId: identifier.nullable().optional(),
  kind: z.enum([
    "text", "richtext", "frame", "image", "icon", "button", "input", "select",
    "checkbox", "radio", "switch", "tag", "avatar", "progress", "tabs", "table",
    "list", "unknown", "wrapper", "textnode",
  ]).optional(),
  handle: z.enum(["tl", "tc", "tr", "cl", "cr", "bl", "bc", "br"]).optional(),
  runtime: operationLogRuntimeSchema.optional(),
  before: operationLogGeometrySchema.optional(),
  after: operationLogGeometrySchema.optional(),
  viewport: z.object({
    zoom: z.number().finite().min(1).max(1000).describe("Canvas zoom percentage, not a ratio."),
    scrollX: coordinate,
    scrollY: coordinate,
    canvasX: coordinate.optional(),
    canvasY: coordinate.optional(),
    pointerX: coordinate.optional(),
    pointerY: coordinate.optional(),
    devicePixelRatio: z.number().finite().min(0.1).max(10).optional(),
  }).strict().describe("All coordinates use CSS px. Pointer coordinates are iframe client coordinates; canvasX/Y are GrapesJS canvas model pan coordinates; scrollX/Y are iframe scroll offsets. devicePixelRatio is the renderer window ratio, not canvas zoom.").optional(),
  code: z.enum([
    "OK", "MOVED", "CHANGED", "UNCHANGED", "ESCAPE", "INTERRUPTED", "SAVE_FAILED", "LOAD_FAILED",
    "CONTROL_FAILED", "UNSUPPORTED_GEOMETRY", "CANCELLED", "FAILED", "STARTED",
    "APPLIED", "REJECTED", "STALE_REVISION", "BUSY", "PERSIST_FAILED",
  ]).optional(),
  count: z.number().int().min(0).max(1_000_000).optional(),
  durationMs: z.number().finite().min(0).max(86_400_000).optional(),
  changedProperties: z.array(z.enum([
    "position", "left", "top", "right", "bottom", "width", "height", "transform",
    "padding", "margin", "font-size", "color", "background-color", "opacity",
    "content", "attributes", "components", "other",
  ])).max(30).optional(),
}).strict();

export const operationLogRecordSchema = operationLogEventSchema.extend({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  time: z.string().datetime(),
}).strict();
