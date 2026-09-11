import { autoUpdate, computePosition, flip, hide, offset, shift } from "@floating-ui/dom";
import type { EditorConfig } from "grapesjs";

type SpectrumQuery = (element: HTMLElement) => {
  spectrum(method: "container"): { 0: HTMLElement };
  spectrum(method: "hide"): unknown;
};

export function createColorPickerPositioning(host: HTMLElement, query: SpectrumQuery) {
  let active: {
    anchor: HTMLElement;
    picker: HTMLElement;
    cleanup: () => void;
    update: () => void;
  } | null = null;
  const stop = () => {
    active?.cleanup();
    active?.picker.removeAttribute("data-positioned");
    active = null;
  };
  const isColorControl = (target: EventTarget | null): target is HTMLElement =>
    target instanceof HTMLElement && target.matches(".gjs-field-color-picker");
  const show = (event: Event) => {
    if (!isColorControl(event.target)) return;
    stop();
    const anchor = event.target;
    const picker = query(anchor).spectrum("container")[0];
    let revision = 0;
    const state = { anchor, picker, cleanup: () => {}, update: () => {} };
    active = state;
    state.update = () => {
      const current = ++revision;
      void computePosition(anchor, picker, {
        strategy: "fixed",
        placement: "bottom-end",
        middleware: [offset(4), flip({ padding: 8, fallbackAxisSideDirection: "start" }), shift({ padding: 8 }), hide()],
      }).then(({ x, y, placement, middlewareData }) => {
        if (active !== state || revision !== current) return;
        if (middlewareData.hide?.referenceHidden) {
          query(anchor).spectrum("hide");
          return;
        }
        Object.assign(picker.style, { left: `${x}px`, top: `${y}px` });
        picker.setAttribute("data-placement", placement);
        picker.setAttribute("data-positioned", "true");
      });
    };
    state.cleanup = autoUpdate(anchor, picker, state.update);
  };
  const hidePicker = (event: Event) => {
    if (event.target === active?.anchor) stop();
  };
  const reflow = (event: Event) => {
    if (event.target === active?.anchor) active.update();
  };
  // Spectrum emits bubbling DOM events after its internal callbacks and reflow.
  host.addEventListener("show", show);
  host.addEventListener("hide", hidePicker);
  host.addEventListener("reflow", reflow);
  return {
    options: {
      appendTo: host.ownerDocument.body,
      containerClassName: "gjs-one-bg gjs-two-color gjs-editor-sp wireframe-color-picker",
    } satisfies NonNullable<EditorConfig["colorPicker"]>,
    destroy() {
      if (active) query(active.anchor).spectrum("hide");
      stop();
      host.removeEventListener("show", show);
      host.removeEventListener("hide", hidePicker);
      host.removeEventListener("reflow", reflow);
    },
  };
}
