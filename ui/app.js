// UI for SSH Cfg Mgr.
//
// `invoke` calls a Rust function marked #[tauri::command] in
// src-tauri/src/lib.rs. Tauri gives it to us as a global, because
// "withGlobalTauri" is true in tauri.conf.json.
const { invoke } = window.__TAURI__.core;

const GLOBAL_ID = "global";
const NEW_ID = "new";
const SETTINGS_ID = "settings";

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

// View preferences, kept per user in this app's local storage. Storage can
// fail (private mode, cleared data); the defaults work without it.
// newGroupMode: how a group is saved on a block that has none yet.
const prefs = { newGroupMode: "comment", sort: "file" };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem("prefs") || "{}"));
} catch {}

function savePrefs() {
  try {
    localStorage.setItem("prefs", JSON.stringify(prefs));
  } catch {}
}

// The group of a block, from the file: a "# group: <name>" comment above
// it, else its Tag. groupMode is how it is stored, or null for no group.
function groupOf(block) {
  if (block.group_comment) return { group: block.group_comment, groupMode: "comment" };
  const tag = value(block.settings, "Tag");
  return tag ? { group: tag, groupMode: "tag" } : { group: "", groupMode: null };
}

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
    list.push({ id: GLOBAL_ID, kind: "", name: "Global settings", settings: config.global, group: "" });
  }
  config.blocks.forEach((block, index) => {
    list.push({
      id: String(index),
      kind: block.kind,
      name: block.pattern,
      settings: block.settings,
      ...groupOf(block),
    });
  });
  return list;
}

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

// Blocks in display order, as [group name, entries] pairs. Global settings
// come first with no group, blocks with no group come last.
function grouped(blocks) {
  const dir = { asc: 1, desc: -1 }[prefs.sort];
  if (dir) blocks = [...blocks].sort((a, b) => dir * byName(a.name, b.name));
  const groups = new Map();
  for (const entry of blocks) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  const named = [...groups.keys()].filter((g) => g);
  if (dir) named.sort((a, b) => dir * byName(a, b));
  return [...named, ""].filter((g) => groups.has(g)).map((g) => [g, groups.get(g)]);
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
    const text = [entry.name, entry.group, value(entry.settings, "HostName"), value(entry.settings, "User")];
    return text.join(" ").toLowerCase().includes(filter);
  });

  const global = shown.filter((e) => e.id === GLOBAL_ID);
  const sections = grouped(shown.filter((e) => e.id !== GLOBAL_ID));
  const hasGroups = sections.some(([group]) => group);
  for (const entry of global) list.append(listItem(entry));
  for (const [group, members] of sections) {
    if (hasGroups) {
      const head = make("li", "group-head", group || "No group");
      head.setAttribute("role", "presentation");
      list.append(head);
    }
    for (const entry of members) list.append(listItem(entry));
  }

  const hosts = config.blocks.filter((b) => b.kind === "Host").length;
  const matches = config.blocks.length - hosts;
  el("count").textContent = filter
    ? `${shown.length} of ${all.length} shown`
    : `${plural(hosts, "host")}, ${plural(matches, "match block")}`;
}

function listItem(entry) {
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
  return item;
}

// ---- Detail: view ----

function renderSettings(detail) {
  detail.append(make("h1", "", "Settings"));
  const field = make("fieldset", "options");
  field.append(make("legend", "", "Save a new group as"));
  const choices = [
    ["comment", "A \"# group: <name>\" comment above the block", "OpenSSH ignores it. Works with every OpenSSH version."],
    ["tag", "A \"Tag <name>\" line in the block", "One word. Needs OpenSSH 9.4 or later. Lets \"Match tagged <name>\" add settings for the whole group."],
  ];
  for (const [mode, label, hint] of choices) {
    const option = make("label", "option");
    const radio = make("input");
    radio.type = "radio";
    radio.name = "new-group-mode";
    radio.checked = prefs.newGroupMode === mode;
    radio.addEventListener("change", () => {
      prefs.newGroupMode = mode;
      savePrefs();
    });
    const text = make("span", "text");
    text.append(make("span", "", label), make("span", "hint", hint));
    option.append(radio, text);
    field.append(option);
  }
  detail.append(field);
  detail.append(
    make("p", "hint", "A block that already has a group keeps the way its group is stored. These settings are kept on this computer, not in the config."),
  );
}

function renderView(detail) {
  if (selected === SETTINGS_ID) return renderSettings(detail);
  const entry = entries().find((e) => e.id === selected);
  if (!entry) {
    const text = config.exists
      ? "Select a host to see its settings."
      : "There is no SSH config file yet. Click + to add a host.";
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
      : `${entry.group ? `Group: ${entry.group}. ` : ""}${plural(entry.settings.length, "setting")}. The first value of each keyword is the one OpenSSH uses.`;
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
  // A block keeps the way its group is stored. One with no group uses the
  // setting for new groups.
  const groupMode = entry?.groupMode ?? prefs.newGroupMode;
  editing = entry
    ? {
        index: Number(entry.id),
        kind: entry.kind,
        pattern: entry.name,
        // In Tag mode the Group field is the Tag, so it is not a setting row.
        settings: entry.settings
          .filter((s) => groupMode !== "tag" || s.keyword.toLowerCase() !== "tag")
          .map((s) => ({ ...s })),
        group: entry.group,
        groupMode,
      }
    : {
        index: null,
        kind: "Host",
        pattern: "",
        settings: [
          { keyword: "HostName", value: "" },
          { keyword: "User", value: "" },
        ],
        group: "",
        groupMode,
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

  const groupLabel = make("label", "field");
  groupLabel.append(make("span", "", "Group"));
  const group = make("input");
  group.value = editing.group;
  group.placeholder = "Optional";
  group.setAttribute("list", "groups");
  group.spellcheck = false;
  group.addEventListener("input", () => (editing.group = group.value));
  groupLabel.append(group);
  form.append(groupLabel);
  form.append(
    make(
      "p",
      "hint",
      editing.groupMode === "tag"
        ? "Saved as a Tag line in this block. One word. Needs OpenSSH 9.4 or later."
        : "Saved as a \"# group:\" comment above this block. OpenSSH ignores it.",
    ),
  );

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
      group: editing.group,
      groupMode: editing.groupMode,
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
  const names = [...new Set(entries().map((e) => e.group).filter(Boolean))].sort(byName);
  el("groups").replaceChildren(...names.map((name) => Object.assign(make("option"), { value: name })));
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
el("search").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && el("search").value) {
    el("search").value = "";
    renderList();
  }
});

// The sort button steps through these, then starts again. CSS shows the
// icon for the current one.
const SORTS = [
  { value: "file", label: "File order (not sorted)" },
  { value: "asc", label: "Name A–Z" },
  { value: "desc", label: "Name Z–A" },
];

function showSort() {
  const sort = SORTS.find((s) => s.value === prefs.sort) ?? SORTS[0];
  prefs.sort = sort.value;
  el("sort").dataset.sort = sort.value;
  el("sort").title = `Sort: ${sort.label}. Click to change.`;
  el("sort").setAttribute("aria-label", el("sort").title);
}

function changed() {
  savePrefs();
  // A selected block can change group, but it stays selected.
  if (config) render();
}

showSort();
el("sort").addEventListener("click", () => {
  const next = (SORTS.findIndex((s) => s.value === prefs.sort) + 1) % SORTS.length;
  prefs.sort = SORTS[next].value;
  showSort();
  changed();
});

el("settings").addEventListener("click", () => select(SETTINGS_ID));
el("reload").addEventListener("click", () => {
  clearNotice();
  load();
});
el("new-host").addEventListener("click", () => {
  if (!editing) startEdit(null);
});
load();
