import assert from "node:assert/strict";
import grapesjs from "grapesjs";
import formsModule from "grapesjs-plugin-forms";
import {
  captureLibraryComponent,
  normalizeComponentStyle,
} from "../lib/component-snapshot.ts";
import {
  exportHtml,
  studioFile,
  validateStudioFile,
  fixedCanvasFile,
} from "../lib/grapes-export.ts";

const editor = grapesjs.init({
  headless: true,
  storageManager: false,
  avoidInlineStyle: true,
  plugins: [(e) => formsModule.default(e, { blocks: [] })],
});
const meta = {
  name: "Library regression",
  notes: "",
  width: 1120,
  height: 760,
};
try {
  editor.setStyle("body{margin:0}");
  editor.setComponents([
    {
      tagName: "section",
      name: "Metric",
      resizable: true,
      attributes: {
        "data-spec-id": "source-parent",
        "data-note": "Keep hierarchy",
      },
      style: {
        position: "absolute",
        left: "48px",
        top: "64px",
        width: "280px",
        height: "130px",
      },
      components: [
        {
          type: "text",
          tagName: "span",
          content: "2,480",
          attributes: { "data-spec-id": "source-text" },
          style: {
            "font-size": "34px",
            "font-weight": "700",
            color: "#147d67",
          },
        },
        {
          type: "input",
          attributes: { placeholder: "Email" },
          style: { width: "160px" },
        },
      ],
    },
  ]);
  const original = editor.getWrapper().components().at(0);
  const definition = captureLibraryComponent(original);
  assert.doesNotThrow(() => structuredClone(definition));
  assert.equal(definition.attributes.id, undefined);
  assert.equal(definition.attributes["data-spec-id"], undefined);
  const copy = editor.getWrapper().append(definition)[0];
  assert.notEqual(copy.getId(), original.getId());
  assert.deepEqual(copy.getStyle(), original.getStyle());
  assert.deepEqual(
    copy.components().at(0).getStyle(),
    original.components().at(0).getStyle(),
  );
  assert.equal(
    copy.components().at(1).getTrait("placeholder").getValue(),
    "Email",
  );
  copy.components().at(0).addStyle({ "font-size": "24px" });
  assert.equal(original.components().at(0).getStyle()["font-size"], "34px");
  const snapshot = JSON.parse(JSON.stringify(studioFile(editor, meta)));
  const oldCanvas = {
    ...snapshot,
    editor: {
      ...snapshot.editor,
      styles: [
        {
          selectors: ["metric"],
          style: { width: "280px" },
          atRuleType: "media",
          mediaText: "(max-width: 1120px)",
        },
      ],
    },
  };
  const repaired = fixedCanvasFile(oldCanvas);
  assert.equal(repaired.editor.styles[0].mediaText, "");
  assert.equal(oldCanvas.editor.styles[0].mediaText, "(max-width: 1120px)");
  assert.equal(repaired.meta.engineRevision, 2);
  validateStudioFile(snapshot);
  editor.loadProjectData(snapshot.editor);
  assert.equal(
    editor.getWrapper().components().at(1).components().at(0).getStyle()[
      "font-size"
    ],
    "24px",
  );
  editor.UndoManager.clear();
  const first = editor.getWrapper().components().at(0);
  first.addStyle({ left: "200px" });
  assert.ok(editor.UndoManager.hasUndo());
  editor.UndoManager.undo();
  assert.equal(first.getStyle().left, "48px");
  editor.UndoManager.redo();
  assert.equal(first.getStyle().left, "200px");
  const legacy = editor
    .getWrapper()
    .append({
      classes: ["shared-metric"],
      attributes: { style: "left:448px;top:48px;" },
    })[0];
  const computed = new Map(
    Object.entries({
      left: "448px",
      top: "48px",
      width: "280px",
      height: "130px",
      "inset-inline-start": "448px",
      "block-size": "130px",
      color: "rgb(20, 125, 103)",
    }),
  );
  const declaration = (values) => ({
    [Symbol.iterator]: () => values.keys(),
    getPropertyValue: (key) => values.get(key) || "",
  });
  legacy.getEl = () => ({
    nodeType: 1,
    style: declaration(
      new Map([
        ["left", "448px"],
        ["top", "48px"],
      ]),
    ),
    ownerDocument: {
      defaultView: { getComputedStyle: () => declaration(computed) },
    },
  });
  const captured = captureLibraryComponent(legacy);
  assert.equal(captured.style.width, "280px");
  assert.equal(captured.style.left, "448px");
  assert.equal(captured.attributes.style, undefined);
  assert.deepEqual(captured.classes, []);
  assert.equal(captured.style["inset-inline-start"], undefined);
  assert.equal(captured.style["block-size"], undefined);
  normalizeComponentStyle(legacy);
  assert.equal(legacy.getAttributes().style, undefined);
  assert.equal(legacy.getStyle().left, "448px");
  legacy.addStyle({ left: "48px", "inset-inline-start": "448px" });
  normalizeComponentStyle(legacy);
  assert.equal(legacy.getStyle().left, "48px");
  assert.equal(legacy.getStyle()["inset-inline-start"], undefined);
  const html = exportHtml(editor, meta);
  assert.equal((html.match(/<body\b/g) || []).length, 1);
  assert.equal((html.match(/<\/body>/g) || []).length, 1);
  console.log(
    "PASS: library serialization, nested and class/inline styles, independent instances, input traits, project reload, undo/redo, single HTML body.",
  );
} finally {
  editor.destroy();
}
