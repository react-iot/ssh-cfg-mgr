// Small DOM helpers and icons shared by the components.

export const SVG_NS = "http://www.w3.org/2000/svg";

// Icon paths, 16x16.
export const TICK = "M3 8.5l3.2 3.2L13 4.8";
export const CROSS = "M4 4l8 8M12 4l-8 8";
export const TRASH = "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5";
export const FOLDER = "M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z";
export const WRENCH = "M10.5 2.2a3.3 3.3 0 0 0-3.9 4.2L2.4 10.6a1.4 1.4 0 0 0 2 2l4.2-4.2a3.3 3.3 0 0 0 4.2-3.9l-2 2-1.8-.5-.5-1.8z";
export const FILE_ICON = "M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5zM9 1.5V5h3.5";
export const EYE = "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z";

export function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, not innerHTML: config values must never become HTML.
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(text, className, onClick) {
  const node = make("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

// An SVG element with attributes, and children made the same way.
export function svg(tag, attrs, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export function iconButton(path, label, onClick) {
  const node = button("", "icon-only", onClick);
  node.title = label;
  node.setAttribute("aria-label", label);
  node.append(
    svg("svg", { viewBox: "0 0 16 16", width: "15", height: "15", "aria-hidden": "true" }, [
      svg("path", { d: path, fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round" }),
    ]),
  );
  return node;
}

// A child-to-parent message: bubbles out of the component.
export function emit(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function value(settings, keyword) {
  const lower = keyword.toLowerCase();
  const found = settings.find((s) => s.keyword.toLowerCase() === lower);
  return found ? found.value : "";
}

export const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
