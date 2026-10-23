// UI for SSH Cfg Mgr. This version only reads the config.
//
// `invoke` calls a Rust function marked #[tauri::command] in
// src-tauri/src/lib.rs. Tauri gives it to us as a global, because
// "withGlobalTauri" is true in tauri.conf.json.
const { invoke } = window.__TAURI__.core;

const GLOBAL_ID = "global";

const el = (id) => document.getElementById(id);

let config = null;
let selected = null;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, not innerHTML: config values must never become HTML.
  if (text !== undefined) node.textContent = text;
  return node;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function value(settings, keyword) {
  const lower = keyword.toLowerCase();
  const found = settings.find((s) => s.keyword.toLowerCase() === lower);
  return found ? found.value : "";
}

// All entries in the sidebar: global settings first, then each block.
function entries() {
  const list = [];
  if (config.global.length > 0) {
    list.push({ id: GLOBAL_ID, kind: "", name: "Global settings", settings: config.global });
  }
  config.blocks.forEach((block, index) => {
    list.push({ id: String(index), kind: block.kind, name: block.pattern, settings: block.settings });
  });
  return list;
}

function renderList() {
  const filter = el("search").value.trim().toLowerCase();
  const list = el("list");
  list.replaceChildren();

  const all = entries();
  const shown = all.filter((entry) => {
    if (!filter) return true;
    const text = [entry.name, value(entry.settings, "HostName"), value(entry.settings, "User")];
    return text.join(" ").toLowerCase().includes(filter);
  });

  for (const entry of shown) {
    const item = make("li");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(entry.id === selected));
    const nameClass = entry.id === GLOBAL_ID ? "name plain" : "name";
    item.append(make("span", "kind", entry.kind), make("span", nameClass, entry.name));
    const hostName = value(entry.settings, "HostName");
    if (hostName) item.append(make("span", "sub", hostName));
    item.addEventListener("click", () => select(entry.id));
    list.append(item);
  }

  const hosts = config.blocks.filter((b) => b.kind === "Host").length;
  const matches = config.blocks.length - hosts;
  el("count").textContent = filter
    ? `${shown.length} of ${all.length} shown`
    : `${plural(hosts, "host")}, ${plural(matches, "match block")}`;
}

function renderDetail() {
  const detail = el("detail");
  detail.replaceChildren();

  const entry = entries().find((e) => e.id === selected);
  if (!entry) {
    const text = config.exists
      ? "Select a host to see its settings."
      : "There is no SSH config file yet. A later version will let you make one.";
    detail.append(make("p", "empty", text));
    return;
  }

  detail.append(make("h1", "", entry.kind ? `${entry.kind} ${entry.name}` : entry.name));
  const lead =
    entry.id === GLOBAL_ID
      ? "These settings are before the first Host or Match line. They apply to all hosts."
      : `${entry.settings.length} settings. The first value of each keyword is the one OpenSSH uses.`;
  detail.append(make("p", "lead", lead));

  if (entry.settings.length === 0) {
    detail.append(make("p", "empty", "This block has no settings."));
    return;
  }

  const table = make("table");
  const head = make("tr");
  head.append(make("th", "", "Keyword"), make("th", "", "Value"));
  table.append(head);
  for (const setting of entry.settings) {
    const row = make("tr");
    row.append(make("td", "", setting.keyword), make("td", "", setting.value));
    table.append(row);
  }
  detail.append(table);
}

function select(id) {
  selected = id;
  renderList();
  renderDetail();
}

async function load() {
  try {
    config = await invoke("load_config");
  } catch (error) {
    el("detail").replaceChildren(make("p", "error", String(error)));
    return;
  }

  el("path").textContent = config.path;
  const badge = el("badge");
  badge.hidden = false;
  badge.className = config.lossless ? "badge" : "badge warn";
  badge.textContent = config.lossless ? "Read-only · round-trip OK" : "Round-trip mismatch";

  const ids = entries().map((e) => e.id);
  if (!ids.includes(selected)) selected = ids.find((id) => id !== GLOBAL_ID) ?? ids[0] ?? null;
  renderList();
  renderDetail();
}

el("search").addEventListener("input", renderList);
el("reload").addEventListener("click", load);
load();
