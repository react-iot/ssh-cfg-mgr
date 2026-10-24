// UI for SSH Cfg Mgr.
//
// `invoke` calls a Rust function marked #[tauri::command] in
// src-tauri/src/lib.rs. Tauri gives it to us as a global, because
// "withGlobalTauri" is true in tauri.conf.json.
const { invoke } = window.__TAURI__.core;

const GLOBAL_ID = "global";
const NEW_ID = "new";

// Suggestions for the keyword field. Any keyword that OpenSSH knows works.
const KEYWORDS = [
  "HostName", "User", "Port", "IdentityFile", "IdentitiesOnly", "IdentityAgent",
  "ProxyJump", "ProxyCommand", "ForwardAgent", "AddKeysToAgent", "UseKeychain",
  "LocalForward", "RemoteForward", "DynamicForward", "ServerAliveInterval",
  "ServerAliveCountMax", "ConnectTimeout", "StrictHostKeyChecking",
  "UserKnownHostsFile", "HostKeyAlias", "CertificateFile", "ControlMaster",
  "ControlPath", "ControlPersist", "Compression", "RequestTTY", "RemoteCommand",
  "SetEnv", "SendEnv", "LogLevel", "PreferredAuthentications", "PubkeyAuthentication",
];

const el = (id) => document.getElementById(id);

let config = null;
let selected = null;
// While the user edits a block, this holds the form state.
let editing = null;
let confirmingDelete = false;

// "user@host" that ssh connects to. Without HostName, ssh uses the alias,
// which is only a real host name for a single Host pattern with no wildcards.
function connectTarget(entry) {
  const user = value(entry.settings, "User");
  const plainAlias = entry.kind === "Host" && !/[\s*?!,]/.test(entry.name);
  const host = value(entry.settings, "HostName") || (user && plainAlias ? entry.name : "");
  return host && user ? `${user}@${host}` : host;
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, not innerHTML: config values must never become HTML.
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const node = make("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
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
// A block's id is its index in config.blocks, as a string.
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

// ---- Notices ----

function showNotice(text, kind = "ok") {
  const notice = el("notice");
  notice.textContent = text;
  notice.className = `notice ${kind}`;
  notice.hidden = false;
}

function clearNotice() {
  el("notice").hidden = true;
}

// ---- Sidebar ----

function renderList() {
  const filter = el("search").value.trim().toLowerCase();
  const list = el("list");
  list.replaceChildren();
  el("sidebar").classList.toggle("locked", editing !== null);

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
    // Host is the default block kind, so only Match blocks get a label.
    if (entry.kind === "Match") item.append(make("span", "kind", entry.kind));
    const text = make("span", "text");
    text.append(make("span", nameClass, entry.name));
    const target = connectTarget(entry);
    if (target) text.append(make("span", "sub", target));
    item.append(text);
    item.addEventListener("click", () => select(entry.id));
    list.append(item);
  }

  const hosts = config.blocks.filter((b) => b.kind === "Host").length;
  const matches = config.blocks.length - hosts;
  el("count").textContent = filter
    ? `${shown.length} of ${all.length} shown`
    : `${plural(hosts, "host")}, ${plural(matches, "match block")}`;
}

// ---- Detail: view ----

function renderView(detail) {
  const entry = entries().find((e) => e.id === selected);
  if (!entry) {
    const text = config.exists
      ? "Select a host to see its settings."
      : "There is no SSH config file yet. Click New host to make one.";
    detail.append(make("p", "empty", text));
    return;
  }

  const head = make("div", "detail-head");
  head.append(make("h1", "", entry.kind ? `${entry.kind} ${entry.name}` : entry.name));
  if (entry.id !== GLOBAL_ID) {
    const actions = make("div", "actions");
    if (confirmingDelete) {
      actions.append(
        make("span", "confirm-text", "Delete this block?"),
        button("Delete", "danger", () => remove(Number(entry.id))),
        button("Cancel", "", () => {
          confirmingDelete = false;
          render();
        }),
      );
    } else {
      actions.append(
        button("Edit", "primary", () => startEdit(entry)),
        button("Delete", "", () => {
          confirmingDelete = true;
          render();
        }),
      );
    }
    head.append(actions);
  }
  detail.append(head);

  const lead =
    entry.id === GLOBAL_ID
      ? "These settings are before the first Host or Match line. They apply to all hosts. This version cannot edit them."
      : `${plural(entry.settings.length, "setting")}. The first value of each keyword is the one OpenSSH uses.`;
  detail.append(make("p", "lead", lead));

  if (entry.settings.length === 0) {
    detail.append(make("p", "empty", "This block has no settings."));
    return;
  }

  const table = make("table");
  const headRow = make("tr");
  headRow.append(make("th", "", "Keyword"), make("th", "", "Value"));
  table.append(headRow);
  for (const setting of entry.settings) {
    const row = make("tr");
    row.append(make("td", "", setting.keyword), make("td", "", setting.value));
    table.append(row);
  }
  detail.append(table);
}

// ---- Detail: edit form ----

function startEdit(entry) {
  clearNotice();
  confirmingDelete = false;
  editing = entry
    ? {
        index: Number(entry.id),
        kind: entry.kind,
        pattern: entry.name,
        settings: entry.settings.map((s) => ({ ...s })),
      }
    : {
        index: null,
        kind: "Host",
        pattern: "",
        settings: [
          { keyword: "HostName", value: "" },
          { keyword: "User", value: "" },
        ],
      };
  if (!entry) selected = NEW_ID;
  render();
  const first = document.querySelector("#detail input");
  if (first) first.focus();
}

function cancelEdit() {
  editing = null;
  if (selected === NEW_ID) selected = null;
  render();
}

function renderEdit(detail) {
  const form = make("form", "edit-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancelEdit();
  });

  form.append(make("h1", "", editing.index === null ? "New host" : `Edit ${editing.kind}`));

  const patternLabel = make("label", "field");
  patternLabel.append(
    make("span", "", editing.kind === "Match" ? "Match criteria" : "Host pattern"),
  );
  const pattern = make("input");
  pattern.value = editing.pattern;
  pattern.placeholder = editing.kind === "Match" ? "host *.internal" : "my-server  or  gw-* !gw-test";
  pattern.spellcheck = false;
  pattern.required = true;
  pattern.addEventListener("input", () => (editing.pattern = pattern.value));
  patternLabel.append(pattern);
  form.append(patternLabel);
  if (editing.kind === "Host") {
    form.append(
      make("p", "hint", "The name you type after ssh. Use * as a wildcard and ! to exclude. Separate patterns with spaces."),
    );
  }

  const rows = make("div", "settings");
  rows.append(make("span", "col-head", "Keyword"), make("span", "col-head", "Value"), make("span"));
  editing.settings.forEach((setting, i) => {
    const keyword = make("input");
    keyword.value = setting.keyword;
    keyword.setAttribute("list", "keywords");
    keyword.setAttribute("aria-label", "Keyword");
    keyword.spellcheck = false;
    keyword.addEventListener("input", () => (setting.keyword = keyword.value));

    const val = make("input", "mono");
    val.value = setting.value;
    val.setAttribute("aria-label", `Value for ${setting.keyword || "new keyword"}`);
    val.spellcheck = false;
    val.addEventListener("input", () => (setting.value = val.value));

    const removeRow = button("×", "icon", () => {
      editing.settings.splice(i, 1);
      render();
    });
    removeRow.setAttribute("aria-label", "Remove this setting");
    rows.append(keyword, val, removeRow);
  });
  form.append(rows);

  form.append(
    button("Add setting", "", () => {
      editing.settings.push({ keyword: "", value: "" });
      render();
      const inputs = document.querySelectorAll(".settings input[list]");
      inputs[inputs.length - 1].focus();
    }),
  );

  const actions = make("div", "form-actions");
  const saveButton = make("button", "primary", "Save");
  saveButton.type = "submit";
  actions.append(saveButton, button("Cancel", "", cancelEdit));
  actions.append(make("span", "hint", "OpenSSH checks the file before it is saved. A backup of the old file is kept."));
  form.append(actions);

  detail.append(form);
}

// ---- Save and delete ----

function applyResult(result, message) {
  config = result.config;
  editing = null;
  confirmingDelete = false;
  selected = result.selected === null ? null : String(result.selected);
  render();
  showNotice(result.backup ? `${message} Backup: ${result.backup}` : message);
}

async function save() {
  clearNotice();
  try {
    const result = await invoke("save_block", {
      revision: config.revision,
      index: editing.index,
      pattern: editing.pattern,
      settings: editing.settings,
    });
    applyResult(result, "Saved.");
  } catch (error) {
    // Keep the form open, so the user can fix the problem.
    showNotice(String(error), "error");
  }
}

async function remove(index) {
  clearNotice();
  try {
    const result = await invoke("delete_block", { revision: config.revision, index });
    applyResult(result, "Deleted.");
  } catch (error) {
    confirmingDelete = false;
    render();
    showNotice(String(error), "error");
  }
}

// ---- Main ----

function render() {
  renderList();
  const detail = el("detail");
  detail.replaceChildren();
  if (editing) renderEdit(detail);
  else renderView(detail);
}

function select(id) {
  if (editing) return;
  selected = id;
  confirmingDelete = false;
  clearNotice();
  render();
}

async function load() {
  try {
    config = await invoke("load_config");
  } catch (error) {
    showNotice(String(error), "error");
    return;
  }

  el("path").textContent = config.path;
  const badge = el("badge");
  badge.hidden = false;
  badge.className = config.lossless ? "badge" : "badge warn";
  badge.textContent = config.lossless ? "Round-trip OK" : "Round-trip mismatch";

  editing = null;
  confirmingDelete = false;
  const ids = entries().map((e) => e.id);
  if (!ids.includes(selected)) selected = ids.find((id) => id !== GLOBAL_ID) ?? ids[0] ?? null;
  render();
}

for (const keyword of KEYWORDS) {
  const option = document.createElement("option");
  option.value = keyword;
  el("keywords").append(option);
}

el("search").addEventListener("input", renderList);
el("reload").addEventListener("click", () => {
  clearNotice();
  load();
});
el("new-host").addEventListener("click", () => {
  if (!editing) startEdit(null);
});
load();
