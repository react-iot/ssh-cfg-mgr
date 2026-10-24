// UI for SSH Config Manager: wires the components to the store.
//
// Data flows down: store.js holds the state, calls Rust, and emits `change`;
// this draws the sidebar and the one detail view that fits the state.
// Components change the store by calling its methods; child-to-parent
// messages are bubbling CustomEvents (value-save, builder-use, host-count).
// All components use the light DOM, so style.css styles them as before.
import { store, SETTINGS_ID, HISTORY_ID } from "./store.js";
import "./components/status-bar.js";
import "./components/host-list.js";
import "./components/host-detail.js";
import "./components/raw-editor.js";
import "./components/settings-view.js";
import "./components/history-view.js";
import { showAbout } from "./components/about-dialog.js";

const el = (id) => document.getElementById(id);

// One of each, kept while hidden: <host-detail> keeps its open editor
// across a raw edit, as before.
const views = Object.fromEntries(
  ["host-detail", "raw-editor", "settings-view", "history-view"].map((tag) => [tag, document.createElement(tag)]),
);

function currentView() {
  if (store.editing?.raw) return views["raw-editor"];
  if (store.editing?.draft) return views["host-detail"];
  if (store.selected === SETTINGS_ID) return views["settings-view"];
  if (store.selected === HISTORY_ID) return views["history-view"];
  return views["host-detail"];
}

store.addEventListener("change", ({ detail }) => {
  el("sidebar").render();
  const view = currentView();
  view.render(detail.reason);
  if (el("detail").firstChild !== view) el("detail").replaceChildren(view);
});

store.addEventListener("notice", ({ detail }) => {
  const notice = el("notice");
  if (detail.text === null) {
    notice.hidden = true;
    return;
  }
  notice.textContent = detail.text;
  notice.className = `notice ${detail.kind}`;
  notice.hidden = false;
});

el("reload").addEventListener("click", () => {
  store.clearNotice();
  store.load();
});
el("new-host").addEventListener("click", () => {
  if (!store.editing) store.startNew();
});
el("settings").addEventListener("click", () => store.openSettings());
el("history").addEventListener("click", () => store.openHistory());

// The About dialog, opened from the app menu ("show-about" from Rust).
window.__TAURI__.event?.listen("show-about", showAbout);

store.applyTheme();
store.load();
