import { z } from "zod";

const id = z.string().min(1).max(200);
const color = z.string().regex(/^(#[0-9a-fA-F]{6}|transparent|none)$/);
const px = (min, max) => z.number().finite().min(min).max(max);
const nonempty = schema => schema.refine(value => Object.keys(value).length > 0, "At least one field is required");

export const controlStyleSchema = z.object({
  color: color.optional(),
  "background-color": color.optional(),
  "border-color": color.optional(),
  "border-width": px(0, 12).optional(),
  "border-style": z.enum(["none", "solid", "dashed", "dotted"]).optional(),
  "border-radius": px(0, 3000).optional(),
  "font-size": px(8, 160).optional(),
  "font-weight": z.enum(["400", "500", "600", "700"]).optional(),
  "font-family": z.enum(["Arial, Microsoft YaHei, sans-serif", "Arial", "Microsoft YaHei", "sans-serif", "serif", "monospace"]).optional(),
  "font-style": z.enum(["normal", "italic"]).optional(),
  "line-height": px(1, 3).optional(),
  "text-align": z.enum(["left", "center", "right"]).optional(),
  "text-decoration": z.enum(["none", "underline", "line-through"]).optional(),
  "-webkit-text-stroke-color": color.optional(),
  "-webkit-text-stroke-width": px(0, 12).optional(),
  "white-space": z.enum(["normal", "pre", "pre-wrap"]).optional(),
  "overflow-wrap": z.enum(["normal", "break-word", "anywhere"]).optional(),
  display: z.enum(["block", "flex", "none"]).optional(),
  opacity: px(0, 1).optional(),
  "padding-top": px(0, 500).optional(),
  "padding-right": px(0, 500).optional(),
  "padding-bottom": px(0, 500).optional(),
  "padding-left": px(0, 500).optional(),
  gap: px(0, 500).optional(),
  "flex-direction": z.enum(["row", "column"]).optional(),
  "align-items": z.enum(["flex-start", "center", "flex-end", "stretch"]).optional(),
  "justify-content": z.enum(["flex-start", "center", "flex-end", "space-between", "space-around"]).optional(),
}).strict();

const geometry = z.object({
  x: px(-10000, 20000).optional(),
  y: px(-10000, 20000).optional(),
  width: px(4, 6000).optional(),
  height: px(2, 6000).optional(),
}).strict().describe("Parent-local CSS pixels; x/y never refer to screen or canvas zoom coordinates.");
const properties = z.object({
  name: z.string().min(1).max(200).optional(),
  note: z.string().max(10000).optional(),
  priority: z.enum(["primary", "secondary", "tertiary"]).optional(),
  reviewed: z.boolean().optional(),
}).strict();
const runs = z.array(z.object({
  text: z.string().max(10000),
  fontSize: px(8, 160),
  fontWeight: z.enum(["400", "500", "600", "700"]),
  color,
  italic: z.boolean(),
  underline: z.boolean(),
}).strict()).min(1).max(100).refine(value => value.reduce((length, run) => length + run.text.length, 0) <= 10000, "Total text exceeds 10000 characters");

export const controlOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_text"), id, text: z.string().max(10000) }).strict(),
  z.object({ op: z.literal("set_rich_text"), id, runs }).strict(),
  z.object({ op: z.literal("set_style"), id, style: nonempty(controlStyleSchema) }).strict(),
  z.object({ op: z.literal("set_geometry"), id, geometry: nonempty(geometry) }).strict(),
  z.object({ op: z.literal("set_properties"), id, properties: nonempty(properties) }).strict(),
  z.object({ op: z.literal("set_document"), document: nonempty(z.object({ name: z.string().min(1).max(200).optional(), notes: z.string().max(20000).optional() }).strict()) }).strict(),
  z.object({ op: z.literal("add_block"), blockId: id, parentId: id.nullable(), index: z.number().int().min(0).max(5000).optional(), geometry: geometry.optional() }).strict(),
  z.object({ op: z.literal("duplicate"), id, offsetX: px(-10000, 10000).default(24), offsetY: px(-10000, 10000).default(24) }).strict(),
  z.object({ op: z.literal("delete"), ids: z.array(id).min(1).max(50) }).strict(),
  z.object({ op: z.literal("move"), id, parentId: id.nullable(), index: z.number().int().min(0).max(5000).optional() }).strict(),
  z.object({ op: z.literal("select"), ids: z.array(id).max(50) }).strict(),
]);

const write = {
  expectedRevision: z.string().min(1).max(100).describe("Exact opaque revision returned by the latest state or successful write; changes after reload."),
  requestId: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/).describe("Unique ID for this logical write; keep it unchanged when retrying."),
};

export const controlTools = [
  {
    name: "wireframe_get_state",
    description: "Read the current document, selected IDs, opaque revision and a compact paginated layer outline. No raw HTML or reference image data is returned. Component IDs are GrapesJS IDs, not data-spec-id.",
    inputSchema: z.object({ offset: z.number().int().min(0).max(5000).default(0), limit: z.number().int().min(1).max(200).default(100) }).strict(),
    readOnly: true,
  },
  {
    name: "wireframe_get_components",
    description: "Read text, rich-text runs, safe editable styles, parent-local layout and specifications for explicit component IDs. Read state first to obtain IDs.",
    inputSchema: z.object({ ids: z.array(id).min(1).max(50) }).strict(),
    readOnly: true,
  },
  {
    name: "wireframe_list_library",
    description: "List existing component-library block IDs that can be added. This does not return executable definitions or HTML.",
    inputSchema: z.object({}).strict(),
    readOnly: true,
  },
  {
    name: "wireframe_apply",
    description: "Apply one atomic, undoable batch of at most 50 structured edits, with a human-readable summary. Rejects stale revisions, editing conflicts, locked elements and unsafe/complex text replacement. Styles are allowlisted; numeric sizes use CSS pixels. Added/copied IDs are returned; reference them in a later request. move keeps local coordinates unless a following set_geometry changes them. No JavaScript, HTML or arbitrary CSS is accepted.",
    inputSchema: z.object({ ...write, summary: z.string().trim().min(1).max(300), operations: z.array(controlOperationSchema).min(1).max(50) }).strict(),
    readOnly: false,
  },
  {
    name: "wireframe_undo",
    description: "Undo one native editor history group, including manual edits; a successful control batch is one group. Requires the current revision.",
    inputSchema: z.object(write).strict(),
    readOnly: false,
  },
  {
    name: "wireframe_redo",
    description: "Redo one native editor history group. Requires the current revision.",
    inputSchema: z.object(write).strict(),
    readOnly: false,
  },
  {
    name: "wireframe_get_preview",
    description: "Render the current editable document as a PNG preview, without selection handles or the reference-image overlay. Returns image.mimeType and image.data (base64). Does not edit the document.",
    inputSchema: z.object({}).strict(),
    readOnly: true,
  },
];
