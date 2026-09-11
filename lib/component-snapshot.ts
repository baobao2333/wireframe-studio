import type { Component, ComponentDefinition } from "grapesjs";

export function normalizeToolbarPointer(event: {clientX: number; clientY: number}, zoom: number) {
  const scale = zoom / 100;
  event.clientX /= scale;
  event.clientY /= scale;
}

const snapshotProperties =
  `position left top width height min-width min-height max-width max-height box-sizing display visibility overflow z-index
  margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left
  color background-color background-image background-size background-position background-repeat opacity box-shadow
  border-top-width border-top-style border-top-color border-right-width border-right-style border-right-color
  border-bottom-width border-bottom-style border-bottom-color border-left-width border-left-style border-left-color
  border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius
  font-family font-size font-weight font-style line-height text-align text-decoration text-transform text-indent
  white-space overflow-wrap word-break letter-spacing word-spacing vertical-align
  flex-grow flex-shrink flex-basis flex-direction flex-wrap order align-items align-self align-content justify-content
  gap grid-template-columns grid-template-rows grid-auto-flow grid-auto-columns grid-auto-rows grid-column grid-row
  object-fit object-position border-collapse border-spacing table-layout list-style-type transform transform-origin`.split(
    /\s+/,
  );
const logicalAlias =
  /^(inset|(?:min-|max-)?(?:block-size|inline-size)|(?:border|padding|margin|overflow)-(?:block|inline))/;

export function freshDefinition(raw: ComponentDefinition): ComponentDefinition {
  // GrapesJS collections serialize through toJSON; structuredClone copies live models.
  const def = JSON.parse(JSON.stringify(raw)) as ComponentDefinition;
  const clean = (value: ComponentDefinition) => {
    if (value.attributes) {
      delete value.attributes.id;
      delete value.attributes["data-spec-id"];
    }
    if (Array.isArray(value.components)) {
      value.components.forEach((child) => {
        if (typeof child === "object") clean(child);
      });
    }
  };
  clean(def);
  return def;
}

export function captureLibraryComponent(
  component: Component,
): ComponentDefinition {
  const capture = (node: Component): ComponentDefinition => {
    const def = node.toJSON(),
      el = node.getEl();
    const style = { ...node.getStyle() };
    if (el?.nodeType === 1) {
      // Resolve class rules, media rules and inline styles using the browser cascade.
      const css = el.ownerDocument.defaultView!.getComputedStyle(el);
      for (const property of snapshotProperties) {
        const value = css.getPropertyValue(property);
        if (value) style[property] = value;
      }
    }
    for (const property of Object.keys(style))
      if (logicalAlias.test(property)) delete style[property];
    const attributes = { ...def.attributes };
    delete attributes.style;
    return {
      ...def,
      attributes,
      classes: [],
      style,
      components: node.components().map(capture),
    };
  };
  return freshDefinition(capture(component));
}

export function normalizeComponentStyle(component: Component) {
  const el = component.getEl();
  const style = { ...component.getStyle() };
  let changed = false;
  if (component.getAttributes().style && el?.style) {
    Object.assign(
      style,
      Object.fromEntries(
        [...el.style].map((key) => [key, el.style.getPropertyValue(key)]),
      ),
    );
    component.removeAttributes("style");
    changed = true;
  }
  for (const property of Object.keys(style))
    if (logicalAlias.test(property)) {
      delete style[property];
      changed = true;
    }
  if (changed) component.setStyle(style);
}
