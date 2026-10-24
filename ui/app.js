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
  "TCPKeepAlive", "ConnectionAttempts", "ForwardX11", "BatchMode", "CheckHostIP",
  "HashKnownHosts", "PasswordAuthentication", "ExitOnForwardFailure", "VisualHostKey",
  "UpdateHostKeys",
];

// The values each keyword takes, from man ssh_config (OpenSSH 10.3).
// choices: only these. suggest: these, or any other text (a time or a path).
// Keywords not listed take any text.
const YES_NO = ["yes", "no"];
const VALUE_TYPES = {
  compression: { choices: YES_NO },
  identitiesonly: { choices: YES_NO },
  forwardx11: { choices: YES_NO },
  batchmode: { choices: YES_NO },
  checkhostip: { choices: YES_NO },
  hashknownhosts: { choices: YES_NO },
  passwordauthentication: { choices: YES_NO },
  exitonforwardfailure: { choices: YES_NO },
  tcpkeepalive: { choices: YES_NO },
  usekeychain: { choices: YES_NO },
  visualhostkey: { choices: YES_NO },
  updatehostkeys: { choices: ["yes", "no", "ask"] },
  controlmaster: { choices: ["yes", "no", "ask", "auto", "autoask"] },
  loglevel: { choices: ["QUIET", "FATAL", "ERROR", "INFO", "VERBOSE", "DEBUG", "DEBUG1", "DEBUG2", "DEBUG3"] },
  pubkeyauthentication: { choices: ["yes", "no", "unbound", "host-bound"] },
  requesttty: { choices: ["no", "yes", "force", "auto"] },
  stricthostkeychecking: { choices: ["yes", "accept-new", "no", "off", "ask"] },
  addkeystoagent: { suggest: ["no", "yes", "confirm", "ask"] },
  forwardagent: { suggest: YES_NO },
  controlpersist: { suggest: YES_NO },
  port: { min: 1, max: 65535 },
  serveraliveinterval: { min: 0 },
  serveralivecountmax: { min: 0 },
  connecttimeout: { min: 0 },
  connectionattempts: { min: 1 },
};

// An input for one value, of the right kind for the keyword. onDone(value)
// runs on Enter or on a choice; onCancel on Escape.
function valueEditor(keyword, current, onDone, onCancel) {
  const type = VALUE_TYPES[keyword.toLowerCase()] ?? {};
  let input;
  if (type.choices) {
    input = make("select");
    // Keep a value that is in the file but not in the list.
    const choices = type.choices.includes(current) || !current ? type.choices : [current, ...type.choices];
    if (!current) input.append(Object.assign(make("option", "", "Choose…"), { value: "" }));
    for (const choice of choices) input.append(Object.assign(make("option", "", choice), { value: choice }));
    input.value = current;
    input.addEventListener("change", () => input.value && onDone(input.value));
  } else {
    input = make("input", "mono");
    input.value = current;
    input.spellcheck = false;
    if ("min" in type) {
      input.type = "number";
      input.min = type.min;
      if (type.max) input.max = type.max;
    }
    if (type.suggest) {
      const id = `suggest-${keyword.toLowerCase()}`;
      if (!el(id)) {
        const list = make("datalist");
        list.id = id;
        for (const s of type.suggest) list.append(Object.assign(make("option"), { value: s }));
        document.body.append(list);
      }
      input.setAttribute("list", id);
    }
  }
  input.classList.add("value-editor");
  input.setAttribute("aria-label", `Value for ${keyword || "new keyword"}`);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && input.tagName === "INPUT") {
      event.preventDefault();
      if (input.reportValidity() && input.value.trim()) onDone(input.value.trim());
    }
  });
  return input;
}

const el = (id) => document.getElementById(id);

let config = null;
let selected = null;
// While the user edits a block, this holds the form state.
let editing = null;
let confirmingDelete = false;
// In the detail table: the row whose value is being edited, and the
// keyword chosen in the add row.
let inlineRow = null;
let addKeyword = "";

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
      enabled: block.enabled,
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
  const nameClass = "name";
  // Host is the default block kind, so only Match blocks get a label.
  if (entry.kind === "Match") item.append(make("span", "kind", entry.kind));
  const text = make("span", "text");
  text.append(make("span", nameClass, entry.name));
  const target = connectTarget(entry);
  if (target) text.append(make("span", "sub", target));
  item.append(text);
  if (entry.id !== GLOBAL_ID) {
    item.classList.toggle("off", !entry.enabled);
    item.append(visibilityButton(entry));
  }
  item.addEventListener("click", () => select(entry.id));
  return item;
}

const EYE = "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z";
const SVG_NS = "http://www.w3.org/2000/svg";

// A crossed-out eye: always shown on a hidden block (its state), and on
// hover over a visible block (the action "hide"). Click to switch.
function visibilityButton(entry) {
  const label = entry.enabled ? `Turn off ${entry.name}` : `Turn on ${entry.name}`;
  const node = button("", "visibility", (event) => {
    event.stopPropagation();
    setEnabled(Number(entry.id), !entry.enabled);
  });
  node.title = entry.enabled ? "On. Click to comment it out." : "Off (commented out). Click to turn on.";
  node.setAttribute("aria-label", label);
  node.setAttribute("aria-pressed", String(entry.enabled));
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("aria-hidden", "true");
  const shapes = [
    ["path", { d: EYE }],
    ["circle", { cx: "8", cy: "8", r: "2" }],
    ["path", { d: "M2.5 13.5 13.5 2.5" }],
  ];
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  node.append(svg);
  return node;
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
      actions.append(button("Edit", "primary", () => startEdit(entry)));
      // Only a Host can be copied: a new block is always a Host.
      if (entry.kind === "Host") {
        actions.append(button("Duplicate", "", () => startEdit({ ...entry, id: null, name: `${entry.name}-copy`, enabled: true })));
      }
      const trash = iconButton(TRASH, "Delete this block", () => {
        confirmingDelete = true;
        render();
      });
      trash.classList.add("trash");
      actions.append(trash);
    }
    head.append(actions);
  }
  detail.append(head);

  const lead =
    entry.id === GLOBAL_ID
      ? "These settings are before the first Host or Match line. They apply to all hosts. This version cannot edit them."
      : `${entry.enabled ? "" : "Off: commented out with #~, so OpenSSH ignores it. "}${entry.group ? `Group: ${entry.group}. ` : ""}${plural(entry.settings.length, "setting")}. The first value of each keyword is the one OpenSSH uses.`;
  detail.append(make("p", "lead", lead));

  const editable = entry.id !== GLOBAL_ID;
  if (entry.settings.length === 0 && !editable) {
    detail.append(make("p", "empty", "This block has no settings."));
    return;
  }

  const table = make("table");
  const headRow = make("tr");
  headRow.append(make("th", "", "Keyword"), make("th", "", "Value"));
  table.append(headRow);
  entry.settings.forEach((setting, i) => {
    const row = make("tr");
    const cell = make("td");
    if (!editable) {
      cell.textContent = setting.value;
    } else if (inlineRow === i) {
      const editor = valueEditor(
        setting.keyword,
        setting.value,
        (value) => saveSettings(entry, entry.settings.map((s, j) => (j === i ? { ...s, value } : s))),
        () => {
          inlineRow = null;
          render();
        },
      );
      cell.append(editor);
      queueMicrotask(() => editor.focus());
    } else {
      // Click the value to change it.
      const value = button(setting.value, "value-button", () => {
        inlineRow = i;
        render();
      });
      value.title = "Click to change";
      cell.append(value);
    }
    row.append(make("td", "", setting.keyword), cell);
    table.append(row);
  });
  if (editable) table.append(addRow(entry));
  detail.append(table);
}

// The last table row: choose a keyword, then enter its value.
function addRow(entry) {
  const row = make("tr", "add-row");
  const pick = make("select");
  pick.setAttribute("aria-label", "Keyword to add");
  pick.append(Object.assign(make("option", "", "Add a setting…"), { value: "" }));
  for (const keyword of [...KEYWORDS].sort(byName)) {
    pick.append(Object.assign(make("option", "", keyword), { value: keyword }));
  }
  pick.value = addKeyword;
  pick.addEventListener("change", () => {
    addKeyword = pick.value;
    render();
    el("detail").querySelector(".add-row .value-editor")?.focus();
  });
  const valueCell = make("td");
  if (addKeyword) {
    const add = (value) => saveSettings(entry, [...entry.settings, { keyword: addKeyword, value }]);
    const editor = valueEditor(addKeyword, "", add, () => {
      addKeyword = "";
      render();
    });
    const line = make("div", "add-value");
    line.append(editor);
    if (editor.tagName === "INPUT") {
      const tick = iconButton(TICK, `Add ${addKeyword}`, () => {
        if (editor.reportValidity() && editor.value.trim()) add(editor.value.trim());
      });
      tick.classList.add("primary");
      line.append(tick);
    }
    valueCell.append(line);
  }
  const keywordCell = make("td");
  keywordCell.append(pick);
  row.append(keywordCell, valueCell);
  return row;
}

// Save a block with new settings, from the detail table. The group stays.
async function saveSettings(entry, settings) {
  clearNotice();
  const groupMode = entry.groupMode ?? prefs.newGroupMode;
  let group = entry.group;
  if (groupMode === "tag") {
    // In Tag mode the Tag is the group: send it as the group, not a setting.
    group = value(settings, "Tag");
    settings = settings.filter((s) => s.keyword.toLowerCase() !== "tag");
  }
  try {
    const result = await invoke("save_block", {
      revision: config.revision,
      index: Number(entry.id),
      pattern: entry.name,
      settings,
      group,
      groupMode,
    });
    inlineRow = null;
    addKeyword = "";
    applyResult(result, "Saved.");
  } catch (error) {
    showNotice(String(error), "error");
  }
}

const TICK = "M3 8.5l3.2 3.2L13 4.8";
const TRASH ="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5";

function iconButton(path, label, onClick) {
  const node = button("", "icon-only", onClick);
  node.title = label;
  node.setAttribute("aria-label", label);
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "15", height: "15", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const shape = document.createElementNS(SVG_NS, "path");
  for (const [k, v] of Object.entries({ d: path, fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round" })) shape.setAttribute(k, v);
  svg.append(shape);
  node.append(svg);
  return node;
}

// ---- Detail: edit form ----

// newGroup: the user chose "New group". A group is stored with its hosts,
// so a new group starts as a new host with the Group field first.
function startEdit(entry, newGroup = false) {
  clearNotice();
  confirmingDelete = false;
  // A block keeps the way its group is stored. One with no group uses the
  // setting for new groups.
  const groupMode = entry?.groupMode ?? prefs.newGroupMode;
  editing = entry
    ? {
        // id null: a copy of a block, saved as a new host.
        index: entry.id === null ? null : Number(entry.id),
        duplicate: entry.id === null,
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
        newGroup,
      };
  if (editing.index === null) selected = NEW_ID;
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

  const title = editing.newGroup
    ? "New group"
    : editing.duplicate
      ? "Duplicate host"
      : editing.index === null
        ? "New host"
        : `Edit ${editing.kind}`;
  form.append(make("h1", "", title));
  if (editing.newGroup) {
    form.append(make("p", "hint", "A group is saved with its hosts. Enter the group name and its first host. You can add more hosts to it later."));
  }

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
  group.placeholder = editing.newGroup ? "Work" : "Optional";
  group.required = Boolean(editing.newGroup);
  group.setAttribute("list", "groups");
  group.spellcheck = false;
  group.addEventListener("input", () => (editing.group = group.value));
  groupLabel.append(group);
  const groupHint = make(
    "p",
    "hint",
    editing.groupMode === "tag"
      ? "Saved as a Tag line in this block. One word. Needs OpenSSH 9.4 or later."
      : "Saved as a \"# group:\" comment above this block. OpenSSH ignores it.",
  );
  // For a new group the name comes first, before the host fields.
  if (editing.newGroup) patternLabel.before(groupLabel, groupHint);
  else form.append(groupLabel, groupHint);

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

// Unlike a save, this keeps the current selection: the user clicked a row's
// button, not the row.
async function setEnabled(index, enabled) {
  clearNotice();
  try {
    const result = await invoke("set_block_enabled", { revision: config.revision, index, enabled });
    config = result.config;
    render();
    const message = enabled ? "Turned on." : "Turned off (commented out).";
    showNotice(result.backup ? `${message} Backup: ${result.backup}` : message);
  } catch (error) {
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
  if (id !== selected) {
    inlineRow = null;
    addKeyword = "";
  }
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

  editing = null;
  confirmingDelete = false;
  showConfig();
}

function showConfig() {
  el("path").textContent = config.path;
  const badge = el("badge");
  badge.hidden = false;
  badge.className = config.lossless ? "badge" : "badge warn";
  badge.textContent = config.lossless ? "Round-trip OK" : "Round-trip mismatch";

  const ids = entries().map((e) => e.id);
  if (selected !== SETTINGS_ID && !ids.includes(selected)) {
    selected = ids.find((id) => id !== GLOBAL_ID) ?? ids[0] ?? null;
  }
  render();
}

// Another program (an editor, a dotfiles sync) can change the file. Read it
// again every few seconds and when the window gets focus.
// ponytail: polling, not a file watcher; reading one small file is cheap.
const WATCH_MS = 2000;
let checking = false;
let warnedRevision = null;

async function checkForChanges() {
  if (!config || checking || document.hidden) return;
  checking = true;
  const before = config;
  try {
    const fresh = await invoke("load_config");
    // A save finished while we read: its result is newer than ours.
    if (config !== before || fresh.revision === config.revision) return;
    if (editing) {
      // Keep the form. A save now would fail, so say so once.
      if (warnedRevision !== fresh.revision) {
        warnedRevision = fresh.revision;
        showNotice("The file changed on disk. Your changes cannot be saved. Copy what you need, click Cancel, and edit again.", "error");
      }
      return;
    }
    // Block ids are positions, which can move. Keep the same block selected.
    const name = entries().find((e) => e.id === selected)?.name;
    config = fresh;
    const same = entries().find((e) => e.name === name);
    if (same) selected = same.id;
    confirmingDelete = false;
    // Row numbers may have moved; close the value editor.
    inlineRow = null;
    showConfig();
    showNotice("The file changed on disk. The list was reloaded.");
  } catch {
    // The next check tries again. Reload shows the error.
  } finally {
    checking = false;
  }
}

setInterval(checkForChanges, WATCH_MS);
window.addEventListener("focus", checkForChanges);

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

// The sidebar + button opens a menu: New host or New group.
function showAddMenu(show) {
  el("add-menu").hidden = !show;
  el("add").setAttribute("aria-expanded", String(show));
  if (show) el("add-menu").querySelector("button").focus();
}
el("add").addEventListener("click", (event) => {
  event.stopPropagation();
  showAddMenu(el("add-menu").hidden);
});
el("add-menu").addEventListener("click", (event) => {
  const item = event.target.closest("[data-add]");
  if (!item) return;
  showAddMenu(false);
  if (!editing) startEdit(null, item.dataset.add === "group");
});
el("add-menu").addEventListener("keydown", (event) => {
  const items = [...el("add-menu").querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    showAddMenu(false);
    el("add").focus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    items[(i + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }
});
document.addEventListener("click", () => showAddMenu(false));
load();
