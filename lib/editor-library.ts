import type { Component, ComponentDefinition, Editor } from "grapesjs";
import {
  makeNode,
  kindNames,
  kinds,
  type Project,
  type WNode,
  type Kind,
} from "./wireframe";
import { iconAssets, iconChoices, symbolFontFamily, symbolPresets, type IconName } from "./icon-assets";

const txt = (text: string): ComponentDefinition => ({
  type: "textnode",
  content: text,
});
const label = (
  text: string,
  style: Record<string, string | number> = {},
): ComponentDefinition => ({
  type: "text",
  tagName: "div",
  components: [txt(text)],
  style,
});
export function readIcon(component: Component): { text: string; icon: IconName } {
  const textOf = (c: Component): string => c.is("textnode")
    ? String(c.get("content") || "")
    : c.components().map(textOf).join("");
  const stored = component.getAttributes()["data-icon"];
  const oldSvg = component.findType("svg")[0];
  const classes = String(oldSvg?.getAttributes().class || "").split(/\s+/);
  const icon = iconChoices.find((choice) => choice.id === stored)?.id
    || iconChoices.find((choice) => classes.includes(`lucide-${choice.id === "home" ? "house" : choice.id === "close" ? "x" : choice.id}`))?.id
    || "search";
  return { text: textOf(component), icon };
}
const iconStyle = (text: string) => text
  ? { display: "block", "align-content": "center", "font-family": symbolFontFamily, "white-space": "pre", "overflow-wrap": "normal" }
  : { display: "flex", "align-content": "normal", "font-family": "Arial, Microsoft YaHei, sans-serif", "white-space": "pre-wrap", "overflow-wrap": "anywhere" };
export function updateIcon(component: Component, text: string, icon: IconName) {
  if (component.getAttributes()["data-kind"] !== "icon") return;
  component.addAttributes({ "data-icon": icon });
  component.components(text ? [txt(text)] : iconAssets[icon]);
  component.addStyle({
    ...iconStyle(text),
    ...(component.getStyle().display === "none" ? { display: "none" } : {}),
  });
}
type SymbolRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
export type IconSymbolMeasurement = {
  fontSize: number;
  box: SymbolRect;
  text: SymbolRect;
  overflow: boolean;
};
export function measureIconSymbol(component: Component): IconSymbolMeasurement | null {
  if (component.getAttributes()["data-kind"] !== "icon" || !readIcon(component).text) return null;
  const element = component.getEl();
  if (!element?.isConnected) return null;
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  const outer = element.getBoundingClientRect();
  const px = (value: string) => parseFloat(value) || 0;
  const insetX = px(style.borderLeftWidth) + px(style.paddingLeft) + px(style.paddingRight) + px(style.borderRightWidth);
  const insetY = px(style.borderTopWidth) + px(style.paddingTop) + px(style.paddingBottom) + px(style.borderBottomWidth);
  const cssWidth = px(style.width) + (style.boxSizing === "border-box" ? 0 : insetX);
  const cssHeight = px(style.height) + (style.boxSizing === "border-box" ? 0 : insetY);
  if (!outer.width || !outer.height || !cssWidth || !cssHeight) return null;
  const scaleX = outer.width / cssWidth, scaleY = outer.height / cssHeight;
  const left = outer.left + (px(style.borderLeftWidth) + px(style.paddingLeft)) * scaleX;
  const top = outer.top + (px(style.borderTopWidth) + px(style.paddingTop)) * scaleY;
  const width = outer.width - insetX * scaleX, height = outer.height - insetY * scaleY;
  const box = { left, top, width, height, right: left + width, bottom: top + height };
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  if (!range.getClientRects().length) return null;
  const bounds = range.getBoundingClientRect();
  const text = { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
  return {
    fontSize: px(style.fontSize), box, text,
    overflow: text.left < box.left || text.top < box.top || text.right > box.right || text.bottom > box.bottom,
  };
}
export function fitIconSymbol(component: Component):
  | { status: "fitted"; fontSize: number }
  | { status: "unchanged" | "too-small" | "unavailable" } {
  const before = measureIconSymbol(component);
  if (!before || !before.fontSize) return { status: "unavailable" };
  if (!before.overflow) return { status: "unchanged" };
  if (before.fontSize <= 8) return { status: "too-small" };
  const element = component.getEl()!;
  const original = element.style.getPropertyValue("font-size");
  const priority = element.style.getPropertyPriority("font-size");
  let fontSize = 8;
  try {
    // Probe the rendered font without writing a component or an undo entry.
    const probe = (size: number) => {
      element.style.setProperty("font-size", `${size}px`, "important");
      return measureIconSymbol(component);
    };
    const minimum = probe(8);
    if (!minimum) return { status: "unavailable" };
    if (minimum.overflow) return { status: "too-small" };
    const ratio = Math.min(before.box.width / before.text.width, before.box.height / before.text.height, 1);
    const candidate = Math.max(8, Math.floor(before.fontSize * ratio * 100) / 100);
    const measured = probe(candidate);
    if (!measured) return { status: "unavailable" };
    if (!measured.overflow) fontSize = candidate;
    else {
      let lower = 8, upper = candidate;
      for (let i = 0; i < 14 && upper - lower > 0.01; i++) {
        const middle = Math.floor((lower + upper) * 50) / 100;
        if (middle <= lower) break;
        const next = probe(middle);
        if (!next) return { status: "unavailable" };
        if (next.overflow) upper = middle;
        else lower = middle;
      }
      fontSize = lower;
    }
  } finally {
    if (original) element.style.setProperty("font-size", original, priority);
    else element.style.removeProperty("font-size");
  }
  component.addStyle({ "font-size": `${fontSize}px` });
  return { status: "fitted", fontSize };
}
export function componentDefinition(
  n: WNode,
  parent?: WNode,
): ComponentDefinition {
  const css: Record<string, string | number> = {
    position: "absolute",
    left: `${n.x - (parent?.x || 0)}px`,
    top: `${n.y - (parent?.y || 0)}px`,
    width: `${n.w}px`,
    height: `${n.h}px`,
    "font-size": `${n.fontSize}px`,
    "font-weight": n.fontWeight,
    "line-height": String(n.lineHeight),
    "text-align": n.align,
    color: n.color === "none" ? "transparent" : n.color,
    background: n.fill === "none" ? "transparent" : n.fill,
    border:
      n.stroke === "none" ? "none" : `${n.strokeWidth}px solid ${n.stroke}`,
    "border-radius": `${n.radius}px`,
    "white-space": "pre-wrap",
    "overflow-wrap": "anywhere",
    "box-sizing": "border-box",
    margin: "0",
    padding: "0",
    "font-family": "Arial, Microsoft YaHei, sans-serif",
    display: n.hidden ? "none" : "block",
  };
  const def: ComponentDefinition = {
    tagName: "div",
    type: ["text", "richtext", "button", "tag", "avatar"].includes(n.type)
      ? "text"
      : "default",
    name: n.name,
    resizable: true,
    draggable: !n.locked,
    droppable: n.type === "frame",
    attributes: {
      "data-spec-id": n.id,
      "data-kind": n.type,
      "data-priority": n.priority,
      "data-note": n.note,
      "data-reviewed": n.reviewed ? "true" : "false",
      "data-origin": n.origin,
    },
    style: css,
    components: [txt(n.text)],
  };
  if (n.type === "frame") {
    def.tagName = "section";
    def.components = [];
  }
  if (n.type === "richtext")
    def.components = (n.runs || []).map((r) => ({
      type: "text",
      tagName: "span",
      name: "文字片段",
      draggable: false,
      resizable: false,
      components: [txt(r.text)],
      style: {
        "font-size": `${r.fontSize}px`,
        "font-weight": r.fontWeight,
        color: r.color,
        "font-style": r.italic ? "italic" : "normal",
        "text-decoration": r.underline ? "underline" : "none",
      },
    }));
  if (["button", "tag", "avatar"].includes(n.type)) {
    Object.assign(css, {
      display: n.hidden ? "none" : "flex",
      "align-items": "center",
      "justify-content":
        n.align === "center"
          ? "center"
          : n.align === "right"
            ? "flex-end"
            : "flex-start",
      padding: "0 12px",
    });
    if (n.type === "button") def.tagName = "button";
    if (n.type === "avatar") css["border-radius"] = "50%";
  }
  if (n.type === "input") {
    def.tagName = "input";
    def.type = "input";
    def.attributes = { ...def.attributes, type: "text", placeholder: n.text };
    def.components = [];
    css.padding = "0 12px";
  }
  if (n.type === "select") {
    def.tagName = "select";
    def.type = "select";
    def.components = [
      {
        type: "option",
        tagName: "option",
        components: [txt(n.text || "请选择")],
      },
    ];
    css.padding = "0 12px";
  }
  if (n.type === "image") {
    def.components = [
      {
        tagName: "div",
        attributes: { "data-gjs-selectable": "false" },
        style: {
          display: "flex",
          width: "100%",
          height: "100%",
          "align-items": "center",
          "justify-content": "center",
          color: "#a0a5ac",
        },
        components: [
          {
            tagName: "span",
            content: iconAssets.image.replace(
              /<svg /,
              '<svg width="24" height="24" ',
            ),
            selectable: false,
            draggable: false,
          },
          txt(n.text ? " " + n.text : ""),
        ],
      },
    ];
  }
  if (n.type === "icon") {
    def.attributes = { ...def.attributes, "data-icon": n.icon || "search" };
    def.components = n.text ? [txt(n.text)] : iconAssets[n.icon || "search"];
    Object.assign(css, iconStyle(n.text));
    if (n.hidden) css.display = "none";
  }
  if (n.type === "line") {
    def.components = [];
    css["border-width"] = `${Math.max(1, n.strokeWidth)}px 0 0`;
  }
  if (["checkbox", "radio"].includes(n.type)) {
    def.tagName = "label";
    Object.assign(css, {
      display: "flex",
      "align-items": "center",
      gap: "10px",
    });
    def.components = [
      {
        tagName: "input",
        type: n.type,
        attributes: {
          type: n.type,
          checked: n.value! > 0.5 ? true : undefined,
        },
        style: { width: "18px", height: "18px", margin: "0" },
      },
      label(n.text),
    ];
  }
  if (n.type === "switch") {
    Object.assign(css, {
      background: n.value! > 0.5 ? n.color : "#c9cdd3",
      "border-radius": `${n.h / 2}px`,
      padding: "3px",
      display: "flex",
      "justify-content": n.value! > 0.5 ? "flex-end" : "flex-start",
    });
    def.components = [
      {
        tagName: "span",
        style: {
          width: `${n.h - 6}px`,
          height: `${n.h - 6}px`,
          background: "#fff",
          "border-radius": "50%",
        },
        draggable: false,
      },
    ];
  }
  if (n.type === "progress") {
    css.background = "#e5e8ec";
    def.components = [
      {
        tagName: "div",
        style: {
          width: `${(n.value || 0) * 100}%`,
          height: "100%",
          background: n.color,
          "border-radius": `${n.radius}px`,
        },
      },
    ];
  }
  if (n.type === "tabs") {
    Object.assign(css, {
      display: "flex",
      "align-items": "stretch",
      border: "none",
      "border-bottom": `1px solid ${n.stroke}`,
    });
    def.components = (n.items || []).map((s, i) =>
      label(s, {
        flex: "1",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        "border-bottom": i === 0 ? `2px solid ${n.color}` : "none",
      }),
    );
  }
  if (n.type === "list") {
    Object.assign(css, {
      display: "flex",
      "flex-direction": "column",
      border: "none",
    });
    def.components = (n.items || []).map((s) =>
      label(s, {
        flex: "1",
        display: "flex",
        "align-items": "center",
        "border-bottom": `1px solid ${n.stroke}`,
        padding: "0 12px",
      }),
    );
  }
  if (n.type === "table") {
    def.tagName = "table";
    css["border-collapse"] = "collapse";
    css["table-layout"] = "fixed";
    def.components = [
      {
        tagName: "tbody",
        droppable: true,
        components: (n.rows || []).map((row, i) => ({
          tagName: "tr",
          components: row.map((s) => ({
            type: "text",
            tagName: i === 0 ? "th" : "td",
            components: [txt(s)],
            style: {
              border: `1px solid ${n.stroke}`,
              padding: "8px 10px",
              "font-weight": i === 0 ? "600" : "400",
              background: i === 0 ? "#f3f4f6" : "transparent",
            },
          })),
        })),
      },
    ];
  }
  return def;
}
export function projectComponents(p: Project): ComponentDefinition[] {
  const walk = (parent: WNode | null): ComponentDefinition[] =>
    p.nodes
      .filter((n) => n.parentId === (parent?.id || null))
      .map((n) => {
        const def = componentDefinition(n, parent || undefined);
        if (n.type === "frame") def.components = walk(n);
        return def;
      });
  return walk(null);
}
export const baseCanvasCss = `*{box-sizing:border-box}body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;color:#34363c;background:#fff}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}p,h1,h2,h3{margin:0}img,svg{max-width:100%}input::placeholder{color:inherit;opacity:.65}`;
const category = (type: Kind) =>
  ["frame", "line"].includes(type)
    ? "布局结构"
    : ["tabs", "table", "list"].includes(type)
      ? "数据与导航"
      : "基础组件";
function content(type: Kind, patch: Partial<WNode> = {}): ComponentDefinition {
  const def = componentDefinition(makeNode(type, patch));
  if (def.attributes) delete def.attributes["data-spec-id"];
  return def;
}
export function registerLibrary(editor: Editor) {
  kinds.forEach((type) =>
    editor.BlockManager.add(`base-${type}`, {
      label: kindNames[type],
      category: category(type),
      content: content(type),
      attributes: { title: kindNames[type] },
      media:
        iconAssets[
          type === "icon"
            ? "star"
            : type === "frame"
              ? "menu"
              : type === "avatar"
                ? "user"
                : "plus"
        ],
    }),
  );
  symbolPresets.slice(0, 3).forEach((symbol) =>
    editor.BlockManager.add(`symbol-${symbol.id}`, {
      label: `${symbol.label}符号`,
      category: "基础组件",
      content: content("icon", {
        name: `${symbol.label}符号`, text: symbol.text,
        w: 40, h: 40, fontSize: 28, lineHeight: 1, align: "center",
      }),
      attributes: { title: `${symbol.label}符号` },
    }),
  );
  const group = (
    name: string,
    w: number,
    h: number,
    children: ComponentDefinition[],
  ) => ({
    ...content("frame", { name, w, h, fill: "#ffffff", stroke: "#d7dbe0" }),
    components: children,
  });
  const defs: [string, string, ComponentDefinition][] = [
    [
      "nav",
      "顶部导航",
      group("顶部导航", 800, 64, [
        content("text", {
          text: "品牌名称",
          name: "品牌",
          x: 24,
          y: 18,
          w: 200,
          h: 30,
          fontSize: 20,
          fontWeight: "700",
        }),
        content("tabs", {
          name: "主导航",
          x: 360,
          y: 10,
          w: 416,
          h: 44,
          items: ["首页", "项目", "关于"],
        }),
      ]),
    ],
    [
      "form",
      "登录表单",
      group("登录表单", 352, 290, [
        content("text", {
          text: "欢迎回来",
          x: 24,
          y: 24,
          w: 300,
          h: 40,
          fontSize: 26,
          fontWeight: "700",
        }),
        content("input", { text: "邮箱", x: 24, y: 88, w: 304, h: 44 }),
        content("input", { text: "密码", x: 24, y: 148, w: 304, h: 44 }),
        content("button", { text: "登录", x: 24, y: 216, w: 304, h: 44 }),
      ]),
    ],
    [
      "card",
      "内容卡片",
      group("内容卡片", 304, 324, [
        content("image", { x: 16, y: 16, w: 272, h: 160, text: "" }),
        content("text", {
          text: "卡片标题",
          x: 16,
          y: 194,
          w: 272,
          h: 30,
          fontSize: 20,
          fontWeight: "600",
        }),
        content("text", {
          text: "这里是简短的内容摘要。",
          x: 16,
          y: 234,
          w: 272,
          h: 32,
          fontSize: 14,
          color: "#7a818a",
        }),
        content("button", {
          text: "查看详情",
          x: 16,
          y: 276,
          w: 120,
          h: 32,
          fontSize: 14,
        }),
      ]),
    ],
    [
      "toolbar",
      "搜索工具栏",
      group("搜索工具栏", 700, 68, [
        content("input", { text: "搜索内容", x: 16, y: 12, w: 360, h: 44 }),
        content("select", { text: "所有状态", x: 390, y: 12, w: 150, h: 44 }),
        content("button", { text: "新建", x: 554, y: 12, w: 130, h: 44 }),
      ]),
    ],
    [
      "metric",
      "数据指标",
      group("数据指标", 280, 130, [
        content("text", {
          text: "本周新增",
          x: 20,
          y: 18,
          w: 240,
          h: 24,
          fontSize: 14,
          color: "#77808b",
        }),
        content("richtext", {
          x: 20,
          y: 56,
          w: 240,
          h: 48,
          text: "2,480 +12%",
          runs: [
            {
              text: "2,480 ",
              fontSize: 34,
              fontWeight: "700",
              color: "#282d34",
              italic: false,
              underline: false,
            },
            {
              text: "+12%",
              fontSize: 14,
              fontWeight: "500",
              color: "#147d67",
              italic: false,
              underline: false,
            },
          ],
        }),
      ]),
    ],
    [
      "row",
      "资料列表项",
      group("资料列表项", 520, 88, [
        content("avatar", { x: 16, y: 20, w: 48, h: 48, text: "AB" }),
        content("text", {
          text: "用户名称",
          x: 82,
          y: 20,
          w: 300,
          h: 26,
          fontSize: 16,
          fontWeight: "600",
        }),
        content("text", {
          text: "备注信息",
          x: 82,
          y: 49,
          w: 300,
          h: 22,
          fontSize: 13,
          color: "#858c94",
        }),
        content("icon", { x: 476, y: 32, w: 24, h: 24, icon: "chevron-right" }),
      ]),
    ],
  ];
  defs.forEach(([id, label, def]) =>
    editor.BlockManager.add(`combo-${id}`, {
      label,
      category: "常用界面组合",
      content: def,
      media: iconAssets.menu,
    }),
  );
}
