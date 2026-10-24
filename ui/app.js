// UI for SSH Cfg Mgr.
//
// `invoke` calls a Rust function marked #[tauri::command] in
// src-tauri/src/lib.rs. Tauri gives it to us as a global, because
// "withGlobalTauri" is true in tauri.conf.json.
const { invoke } = window.__TAURI__.core;

const GLOBAL_ID = "global";
const NEW_ID = "new";
const SETTINGS_ID = "settings";
const HISTORY_ID = "history";

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
  // Not in the man page, but OpenSSH reads it as TCPKeepAlive (ssh -G).
  keepalive: { choices: YES_NO },
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

// An input for one value, of the right kind for the keyword, with a tick
// and a cross. Only the tick (or Enter) saves: onDone(value). The cross
// (or Escape) runs onCancel. Returns the line; .input is the field.
function valueEditor(keyword, current, onDone, onCancel) {
  const type = VALUE_TYPES[keyword.toLowerCase()] ?? {};
  // A few fixed choices are buttons; a longer list (LogLevel) is a select.
  // A value from the file that is not a choice keeps the select, so it shows.
  const toggle = type.choices?.length <= 5 && (!current || type.choices.includes(current));
  let input;
  let focusTarget;
  if (toggle) {
    // Joined buttons. input.value holds the choice, like a field.
    input = make("div", "toggle");
    input.setAttribute("role", "radiogroup");
    input.value = current;
    for (const choice of type.choices) {
      const option = button(choice, "", () => {
        input.value = choice;
        for (const b of input.children) b.setAttribute("aria-checked", String(b === option));
      });
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", String(choice === current));
      input.append(option);
    }
    focusTarget = [...input.children].find((b) => b.getAttribute("aria-checked") === "true") ?? input.firstChild;
  } else if (type.choices) {
    input = make("select");
    // Keep a value that is in the file but not in the list.
    const choices = type.choices.includes(current) || !current ? type.choices : [current, ...type.choices];
    if (!current) input.append(Object.assign(make("option", "", "Choose…"), { value: "" }));
    for (const choice of choices) input.append(Object.assign(make("option", "", choice), { value: choice }));
    input.value = current;
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

  const done = () => {
    if (input.reportValidity && !input.reportValidity()) return;
    if (input.value.trim()) onDone(input.value.trim());
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter") {
      event.preventDefault();
      done();
    }
  });

  // Tick and cross as one joined control, after a builder button if the
  // keyword's value has several parts.
  const pair = make("div", "segmented confirm");
  if (PATH_KEYWORDS.has(keyword.toLowerCase())) {
    pair.append(
      iconButton(FOLDER, `Choose a file for ${keyword}`, async () => {
        const picked = await pickFile(keyword, input.value);
        if (picked) {
          input.value = picked;
          input.focus();
        }
      }),
    );
  }
  const builder = BUILDERS[keyword.toLowerCase()];
  if (builder) {
    pair.append(
      iconButton(WRENCH, `Build the ${keyword} value`, () =>
        openBuilder(keyword, builder, input.value, (built) => {
          input.value = built;
          input.focus();
        }),
      ),
    );
  }
  const tick = iconButton(TICK, `Save ${keyword}`, done);
  tick.classList.add("primary");
  const cross = iconButton(CROSS, "Cancel", onCancel);
  pair.append(tick, cross);
  const line = make("div", "value-line");
  line.append(input, pair);
  line.input = focusTarget ?? input;
  return line;
}

const el = (id) => document.getElementById(id);

let config = null;
let selected = null;
// While the user edits a block, this holds the form state.
let editing = null;
let confirmingDelete = false;
// In the detail table: the row whose value is being edited, and the
// keyword chosen in the add row.
// A row number, or PATTERN_ROW for the block's name in the heading.
let inlineRow = null;
const PATTERN_ROW = "pattern";
let addKeyword = "";
// The settings row whose trash was clicked once, waiting for the second click.
let deleteRow = null;
// A value from a builder or file picker, shown in the open row editor.
let inlineValue = null;

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
      raw: block.raw,
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
  // Groups made with "New group" have no hosts yet, so they are not in the file.
  for (const name of newGroups) if (!groups.has(name)) groups.set(name, []);
  const named = [...groups.keys()].filter((g) => g);
  if (dir) named.sort((a, b) => dir * byName(a, b));
  // "No group" is always there when groups are, so a host can be dragged out.
  return [...named, ""].map((g) => [g, groups.get(g) ?? []]);
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
  if (namingGroup) list.append(groupNameRow());
  for (const entry of global) list.append(listItem(entry));
  for (const [group, members] of sections) {
    if (hasGroups) {
      const head = make("li", "group-head", group || "No group");
      head.setAttribute("role", "presentation");
      dropTarget(head, group);
      list.append(head);
      if (!members.length) {
        const hint = make("li", "drop-hint", group ? "Drag hosts here" : "Drag a host here to take it out of its group");
        hint.setAttribute("role", "presentation");
        dropTarget(hint, group);
        list.append(hint);
      }
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
  if (entry.id !== GLOBAL_ID && !editing) {
    // Drag a host onto a group (or a host in it) to move it there.
    item.draggable = true;
    item.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", entry.id);
      event.dataTransfer.effectAllowed = "move";
    });
    // In file order a host can also be dropped before or after another.
    if (prefs.sort === "file") reorderTarget(item, entry);
    else dropTarget(item, entry.group);
  }
  return item;
}

// Groups made with "New group" that have no hosts yet, and whether the
// name field for a new group is open.
let newGroups = [];
let namingGroup = false;

// The name field at the top of the list for "New group".
function groupNameRow() {
  const row = make("li", "group-new");
  row.setAttribute("role", "presentation");
  const input = make("input");
  input.placeholder = "Group name, then Enter";
  input.setAttribute("aria-label", "New group name");
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const name = input.value.trim();
      if (name && !newGroups.includes(name)) newGroups.push(name);
      namingGroup = false;
      renderList();
    } else if (event.key === "Escape") {
      namingGroup = false;
      renderList();
    }
  });
  row.append(input);
  queueMicrotask(() => input.focus());
  return row;
}

function dropTarget(node, group) {
  node.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    node.classList.add("drop-over");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-over"));
  node.addEventListener("drop", (event) => {
    event.preventDefault();
    node.classList.remove("drop-over");
    moveToGroup(event.dataTransfer.getData("text/plain"), group);
  });
}

// Save a host's group, stored the way the host already stores it.
// Drop on a host: the top half puts the dragged host before it, the bottom
// half after it. It also joins that host's group.
function reorderTarget(node, target) {
  // offsetY is relative to the child under the pointer, so use the row's box.
  const after = (event) => {
    const box = node.getBoundingClientRect();
    return event.clientY - box.top > box.height / 2;
  };
  const clear = () => node.classList.remove("drop-before", "drop-after");
  node.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clear();
    node.classList.add(after(event) ? "drop-after" : "drop-before");
  });
  node.addEventListener("dragleave", clear);
  node.addEventListener("drop", (event) => {
    event.preventDefault();
    clear();
    reorder(event.dataTransfer.getData("text/plain"), target, after(event));
  });
}

async function reorder(id, target, after) {
  const dragged = entries().find((e) => e.id === id);
  if (!dragged || dragged.id === target.id) return;
  const from = Number(dragged.id);
  // The index in the new order: the target moves up by one if the dragged
  // host was above it.
  let to = Number(target.id) + (after ? 1 : 0);
  if (from < to) to -= 1;
  const newGroup = dragged.group === target.group ? undefined : target.group;
  if (to === from) {
    if (newGroup !== undefined) moveToGroup(id, newGroup);
    return;
  }
  clearNotice();
  try {
    const result = await invoke("move_block", { revision: config.revision, from, to });
    if (newGroup === undefined) return applyResult(result, "Moved.");
    // Then join the target's group, as a second save.
    config = result.config;
    const moved = entries().find((e) => e.id === String(to));
    await saveSettings(moved, moved.settings, moved.name, newGroup);
  } catch (error) {
    showNotice(String(error), "error");
  }
}

function moveToGroup(id, group) {
  const entry = entries().find((e) => e.id === id);
  if (!entry || entry.group === group) return;
  saveSettings(entry, entry.settings, entry.name, group);
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

// ---- History: backups made on each save ----

// backups: the list (null while loading); name/text: the chosen backup.
let historyView = { backups: null, name: null, text: null, confirming: false };

async function loadHistory() {
  try {
    historyView.backups = await invoke("list_backups");
    if (historyView.backups.length) await showBackup(historyView.backups[0].name);
  } catch (error) {
    showNotice(String(error), "error");
    historyView.backups = [];
  }
  render();
}

async function showBackup(name) {
  try {
    historyView.text = await invoke("read_backup", { name });
    historyView.name = name;
    historyView.confirming = false;
  } catch (error) {
    showNotice(String(error), "error");
  }
  render();
}

async function restoreBackup(name) {
  clearNotice();
  try {
    const result = await invoke("restore_backup", { revision: config.revision, name });
    config = result.config;
    historyView = { backups: null, name: null, text: null, confirming: false };
    showNotice(result.backup ? `Restored. The file before the restore is in history too: ${result.backup}` : "Restored. The file was already the same.");
    setSync("Monitoring changes", `Restored at ${now()}. Watching the file for changes.`);
    render();
    loadHistory();
  } catch (error) {
    historyView.confirming = false;
    render();
    showNotice(String(error), "error");
  }
}

const CONTEXT_LINES = 3;

function renderHistory(detail) {
  const head = make("div", "detail-head");
  head.append(make("h1", "", "History"));
  detail.append(head);
  detail.append(make("p", "lead", "A backup is made before every save. The newest 50 are kept. Choose one to see what restoring it would change."));
  if (historyView.backups === null) return detail.append(make("p", "empty", "Loading…"));
  if (!historyView.backups.length) return detail.append(make("p", "empty", "No backups yet. One is made the first time you save."));

  const layout = make("div", "history");
  const list = make("ul", "history-list");
  for (const backup of historyView.backups) {
    const item = button("", backup.name === historyView.name ? "selected" : "", () => showBackup(backup.name));
    item.append(make("span", "", new Date(backup.time * 1000).toLocaleString()), make("span", "sub", `${(backup.size / 1024).toFixed(1)} KB`));
    const li = make("li");
    li.append(item);
    list.append(li);
  }

  const pane = make("div", "history-pane");
  if (historyView.text !== null) {
    const diff = lineDiff(config.text, historyView.text);
    const changed = diff.filter((l) => l.op !== " ").length;
    const top = make("div", "history-head");
    top.append(make("span", "", changed ? `Restoring changes ${plural(changed, "line")}:` : "This backup is the same as the current file."));
    if (changed) {
      const restore = button(historyView.confirming ? "Click again to restore" : "Restore this version", historyView.confirming ? "danger" : "primary", () => {
        if (historyView.confirming) restoreBackup(historyView.name);
        else {
          historyView.confirming = true;
          render();
        }
      });
      top.append(restore);
    }
    pane.append(top);
    if (changed) pane.append(diffView(diff));
  }
  layout.append(list, pane);
  detail.append(layout);
}

// Changed lines with a few lines around them; long same parts are folded.
function diffView(diff) {
  const near = diff.map(() => false);
  diff.forEach((l, i) => {
    if (l.op === " ") return;
    for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(diff.length - 1, i + CONTEXT_LINES); k++) near[k] = true;
  });
  const pre = make("pre", "diff");
  let folded = 0;
  const fold = () => {
    if (folded) pre.append(make("div", "fold", `⋯ ${plural(folded, "line")} the same`));
    folded = 0;
  };
  diff.forEach((l, i) => {
    if (!near[i]) return folded++;
    fold();
    pre.append(make("div", { "-": "del", "+": "add", " ": "same" }[l.op], `${l.op} ${l.text}`));
  });
  fold();
  return pre;
}

function renderView(detail) {
  if (selected === SETTINGS_ID) return renderSettings(detail);
  if (selected === HISTORY_ID) return renderHistory(detail);
  const entry = entries().find((e) => e.id === selected);
  if (!entry) {
    const text = config.exists
      ? "Select a host to see its settings."
      : "There is no SSH config file yet. Click New host to make one.";
    detail.append(make("p", "empty", text));
    return;
  }

  const head = make("div", "detail-head");
  const title = make("h1");
  if (entry.id === GLOBAL_ID) {
    title.textContent = entry.name;
  } else if (inlineRow === PATTERN_ROW) {
    // Edit the Host pattern or Match criteria in place.
    const editor = valueEditor(
      entry.kind,
      entry.name,
      (pattern) => saveSettings(entry, entry.settings, pattern),
      () => {
        inlineRow = null;
        render();
      },
    );
    editor.input.classList.add("pattern-editor");
    title.append(make("span", "kind-label", entry.kind), editor);
    queueMicrotask(() => editor.input.focus());
  } else {
    const name = button(entry.name, "value-button title-button", () => {
      inlineRow = PATTERN_ROW;
      render();
    });
    name.title = "Click to rename";
    title.append(make("span", "kind-label", entry.kind), name);
  }
  head.append(title);
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
      // Values are edited in the table; this opens the whole block as a form.
      actions.append(button("Edit Raw", "", () => startRaw(entry)));
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
  if (editable) headRow.append(make("th"));
  table.append(headRow);
  entry.settings.forEach((setting, i) => {
    const row = make("tr");
    const cell = make("td");
    if (!editable) {
      cell.textContent = setting.value;
    } else if (inlineRow === i) {
      const editor = valueEditor(
        setting.keyword,
        inlineValue ?? setting.value,
        (value) => saveSettings(entry, entry.settings.map((s, j) => (j === i ? { ...s, value } : s))),
        () => {
          inlineRow = null;
          inlineValue = null;
          render();
        },
      );
      cell.append(editor);
      queueMicrotask(() => editor.input.focus());
    } else {
      // Click the value to change it.
      const value = button(setting.value, "value-button", () => editRow(i));
      value.title = "Click to change";
      cell.append(value);
      // Few fixed choices: show them on hover. A click opens the editor with
      // that choice; the tick saves it.
      const choices = VALUE_TYPES[setting.keyword.toLowerCase()]?.choices;
      if (choices?.length <= 5 && choices.includes(setting.value)) {
        const options = make("div", "toggle hover-options");
        for (const choice of choices) {
          const option = button(choice, "", () => editRow(i, choice));
          option.setAttribute("aria-checked", String(choice === setting.value));
          option.tabIndex = -1;
          options.append(option);
        }
        cell.classList.add("has-options");
        cell.append(options);
      }
    }
    row.append(make("td", "", setting.keyword), cell);
    if (editable) {
      const actions = make("td", "row-actions");
      // Shortcuts on hover: build the value, or pick a file. The result opens
      // in the field's editor; the tick saves it.
      const key = setting.keyword.toLowerCase();
      // The row being edited has these in its field already.
      const editingRow = inlineRow === i;
      if (BUILDERS[key] && !editingRow) {
        actions.append(
          iconButton(WRENCH, `Build the ${setting.keyword} value`, () =>
            openBuilder(setting.keyword, BUILDERS[key], setting.value, (built) => editRow(i, built)),
          ),
        );
      }
      if (PATH_KEYWORDS.has(key) && !editingRow) {
        actions.append(
          iconButton(FOLDER, `Choose a file for ${setting.keyword}`, async () => {
            const picked = await pickFile(setting.keyword, setting.value);
            if (picked) editRow(i, picked);
          }),
        );
      }
      // Delete the row: the first click asks, the second deletes.
      const confirming = deleteRow === i;
      const trash = iconButton(TRASH, confirming ? `Click again to delete ${setting.keyword}` : `Delete ${setting.keyword}`, () => {
        if (confirming) {
          saveSettings(entry, entry.settings.filter((_, j) => j !== i));
        } else {
          deleteRow = i;
          render();
        }
      });
      trash.classList.toggle("confirming", confirming);
      actions.append(trash);
      row.append(actions);
    }
    table.append(row);
  });
  if (editable) table.append(addRow(entry));
  detail.append(table);
}

// Open the editor for settings row i, optionally with a new value in it.
function editRow(i, value = null) {
  inlineRow = i;
  inlineValue = value;
  deleteRow = null;
  render();
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
    valueCell.append(
      valueEditor(addKeyword, "", add, () => {
        addKeyword = "";
        render();
      }),
    );
  }
  const keywordCell = make("td");
  keywordCell.append(pick);
  valueCell.colSpan = 2;
  row.append(keywordCell, valueCell);
  return row;
}

// Save a block with new settings, from the detail table. The group stays.
// newGroup: move the block to this group ("" for none); otherwise it stays.
async function saveSettings(entry, settings, pattern = entry.name, newGroup = undefined) {
  clearNotice();
  const groupMode = entry.groupMode ?? prefs.newGroupMode;
  let group = entry.group;
  if (groupMode === "tag") {
    // In Tag mode the Tag is the group: send it as the group, not a setting.
    group = value(settings, "Tag");
    settings = settings.filter((s) => s.keyword.toLowerCase() !== "tag");
  }
  if (newGroup !== undefined) group = newGroup;
  try {
    const result = await invoke("save_block", {
      revision: config.revision,
      index: Number(entry.id),
      pattern,
      settings,
      group,
      groupMode,
    });
    inlineRow = null;
    addKeyword = "";
    deleteRow = null;
    inlineValue = null;
    // A new group that now has a host is in the file.
    newGroups = newGroups.filter((g) => !result.config.blocks.some((b) => groupOf(b).group === g));
    applyResult(result, "Saved.");
  } catch (error) {
    showNotice(String(error), "error");
  }
}

const TICK = "M3 8.5l3.2 3.2L13 4.8";
const FOLDER = "M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z";

// Keywords whose value is a file. A socket or a path with %tokens is
// typed by hand.
const PATH_KEYWORDS = new Set(["identityfile", "certificatefile", "userknownhostsfile", "globalknownhostsfile"]);

// The native file picker (Tauri dialog plugin). The plugin's JS package is
// not loaded (no build step), so call its command directly. Returns a path
// with the home folder written as ~, or null if cancelled.
async function pickFile(keyword, current) {
  const home = config.home;
  const expand = (p) => (home && p.startsWith("~/") ? home + p.slice(1) : p);
  const folder = current ? expand(current).replace(/\/[^/]*$/, "") : `${home}/.ssh`;
  try {
    const path = await invoke("plugin:dialog|open", {
      options: { title: `Choose a file for ${keyword}`, defaultPath: folder || undefined },
    });
    if (typeof path !== "string") return null;
    return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  } catch (error) {
    showNotice(String(error), "error");
    return null;
  }
}
const WRENCH = "M10.5 2.2a3.3 3.3 0 0 0-3.9 4.2L2.4 10.6a1.4 1.4 0 0 0 2 2l4.2-4.2a3.3 3.3 0 0 0 4.2-3.9l-2 2-1.8-.5-.5-1.8z";

// A dialog that builds a value from its parts (see builders.js). "Use"
// puts the value in the field; the field's tick still saves it.
function openBuilder(keyword, builder, current, onUse) {
  const items = current.trim() ? builder.parse(current) : [];
  const blank = () => Object.fromEntries(builder.fields.map((f) => [f.key, f.choices ? f.choices[0] : ""]));
  if (!items.length) items.push(blank());

  const dialog = make("dialog", "builder");
  const form = make("form");
  form.method = "dialog";
  const preview = make("code", "preview");
  const useButton = make("button", "primary", "Use");
  useButton.value = "use";

  const update = () => {
    const built = builder.build(items);
    preview.textContent = built ?? "Fill in the required fields.";
    preview.classList.toggle("invalid", built === null);
    useButton.disabled = built === null;
  };

  const rows = make("div", "builder-rows");
  const drawRows = () => {
    rows.replaceChildren();
    items.forEach((item, i) => {
      const row = make("div", "builder-row");
      for (const field of builder.fields) {
        const label = make("label", "field");
        label.append(make("span", "", field.optional ? `${field.label} (optional)` : field.label));
        let input;
        if (field.choices) {
          input = make("select");
          for (const c of field.choices) input.append(Object.assign(make("option", "", c), { value: c }));
        } else {
          input = make("input", "mono");
          input.placeholder = field.placeholder ?? "";
          input.spellcheck = false;
          if (field.number) input.inputMode = "numeric";
        }
        input.value = item[field.key] ?? "";
        input.addEventListener("input", () => {
          item[field.key] = input.value.trim();
          update();
        });
        label.append(input);
        row.append(label);
      }
      if (builder.list) {
        const up = iconButton("M8 12V4M4.5 7.5 8 4l3.5 3.5", "Move up", () => {
          [items[i - 1], items[i]] = [items[i], items[i - 1]];
          drawRows();
          update();
        });
        up.disabled = i === 0;
        const remove = iconButton(CROSS, "Remove", () => {
          items.splice(i, 1);
          drawRows();
          update();
        });
        row.append(up, remove);
      }
      rows.append(row);
    });
  };
  drawRows();

  form.append(make("h2", "", `${builder.title} · ${keyword}`), make("p", "hint", builder.help), rows);
  if (builder.list) {
    form.append(
      button("Add another", "", () => {
        items.push(blank());
        drawRows();
        update();
        rows.lastChild.querySelector("input, select").focus();
      }),
    );
  }
  const actions = make("div", "form-actions");
  const cancel = make("button", "", "Cancel");
  cancel.value = "cancel";
  // Cancel on the left, Use on the right, both at the right edge.
  actions.append(cancel, useButton);
  form.append(make("span", "col-head", "Value"), preview, actions);
  dialog.append(form);
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "use") onUse(builder.build(items));
    dialog.remove();
  });
  document.body.append(dialog);
  update();
  dialog.showModal();
  dialog.querySelector("input, select")?.focus();
}
const CROSS = "M4 4l8 8M12 4l-8 8";
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

function startEdit(entry) {
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
      };
  if (editing.index === null) selected = NEW_ID;
  render();
  const first = document.querySelector("#detail input");
  if (first) first.focus();
}

// Edit the block's lines as plain text.
function startRaw(entry) {
  clearNotice();
  confirmingDelete = false;
  editing = { raw: true, index: Number(entry.id), kind: entry.kind, name: entry.name, text: entry.raw };
  render();
  el("detail").querySelector("textarea").focus();
}

function renderRaw(detail) {
  const form = make("form", "edit-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancelEdit();
    // Cmd+Enter or Ctrl+Enter saves; Enter alone is a new line.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  });
  // Heading with Save and Cancel on the right, as in the host view.
  const head = make("div", "detail-head");
  const actions = make("div", "actions");
  const saveButton = make("button", "primary", "Save");
  saveButton.type = "submit";
  actions.append(button("Cancel", "", cancelEdit), saveButton);
  head.append(make("h1", "", `Edit ${editing.kind} ${editing.name}`), actions);
  form.append(head);

  const text = make("textarea", "raw");
  text.value = editing.text;
  text.spellcheck = false;
  text.setAttribute("aria-label", "Block text");
  text.rows = Math.min(30, Math.max(6, editing.text.split("\n").length + 1));
  text.addEventListener("input", () => (editing.text = text.value));
  form.append(text);
  form.append(
    make("p", "hint", "The block's lines as they are in the file. Blank lines and comments after the block are not shown, and stay as they are. ⌘↩ saves. OpenSSH checks the whole file before it is saved, and a backup of the old file is kept."),
  );
  detail.append(form);
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

  const title = editing.duplicate ? "Duplicate host" : editing.index === null ? "New host" : `Edit ${editing.kind}`;
  form.append(make("h1", "", title));

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
  const groupHint = make(
    "p",
    "hint",
    editing.groupMode === "tag"
      ? "Saved as a Tag line in this block. One word. Needs OpenSSH 9.4 or later."
      : "Saved as a \"# group:\" comment above this block. OpenSSH ignores it.",
  );
  form.append(groupLabel, groupHint);

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
  setSync("Monitoring changes", `Saved at ${now()}. Watching the file for changes.`);
}

async function save() {
  clearNotice();
  try {
    const result = editing.raw
      ? await invoke("save_block_raw", { revision: config.revision, index: editing.index, text: editing.text })
      : await invoke("save_block", {
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
  if (editing?.raw) renderRaw(detail);
  else if (editing) renderEdit(detail);
  else renderView(detail);
}

function select(id) {
  if (editing) return;
  if (id !== selected) {
    inlineRow = null;
    addKeyword = "";
    deleteRow = null;
    inlineValue = null;
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
    setSync("Cannot read file", `${now()}: the file could not be read.`, "error");
    return;
  }

  editing = null;
  confirmingDelete = false;
  showConfig();
  setSync("Monitoring changes", `Loaded at ${now()}. Watching the file for changes.`);
}

function showConfig() {
  el("path").textContent = config.path;
  const badge = el("badge");
  badge.hidden = false;
  badge.className = config.lossless ? "badge" : "badge warn";
  badge.textContent = config.lossless ? "Round-trip OK" : "Round-trip mismatch";

  const ids = entries().map((e) => e.id);
  if (selected !== SETTINGS_ID && selected !== HISTORY_ID && !ids.includes(selected)) {
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
    if (config !== before) return;
    if (fresh.revision === config.revision) {
      setSync("Monitoring changes", `Last checked at ${now()}. No changes.`);
      return;
    }
    if (editing) {
      // Keep the form. A save now would fail, so say so once.
      setSync("Changed on disk", `Changed on disk at ${now()}. Not reloaded while you edit.`, "changed");
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
    deleteRow = null;
    inlineValue = null;
    showConfig();
    setSync("Reloaded", `Changed on disk; reloaded at ${now()}.`, "changed");
    showNotice("The file changed on disk. The list was reloaded.");
  } catch {
    // The next check tries again. Reload shows the error.
    setSync("Cannot read file", `${now()}: the file could not be read. Trying again.`, "error");
  } finally {
    checking = false;
  }
}

const now = () => new Date().toLocaleTimeString();

// The file-watch state, in the status bar.
// A short label; the time and details are in the tooltip.
function setSync(label, detail, kind = "") {
  const sync = el("sync");
  sync.textContent = label;
  sync.title = detail;
  sync.className = `sync ${kind}`;
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
el("history").addEventListener("click", () => {
  historyView = { backups: null, name: null, text: null, confirming: false };
  select(HISTORY_ID);
  loadHistory();
});

// The About dialog, opened from the app menu ("show-about" from Rust).
// Links with target="_blank" open in the browser (opener plugin).
const ABOUT_LINKS = [
  ["Website", "https://reactiot.com.au"],
  ["Source code", "https://github.com/react-iot/ssh-cfg-mgr"],
  ["Report an issue", "https://github.com/react-iot/ssh-cfg-mgr/issues"],
  ["License (Apache-2.0)", "https://github.com/react-iot/ssh-cfg-mgr/blob/main/LICENSE"],
];

async function showAbout() {
  if (document.querySelector("dialog.about")) return;
  const version = (await window.__TAURI__.app?.getVersion().catch(() => "")) ?? "";
  const dialog = make("dialog", "about");
  const logo = Object.assign(make("img"), { src: "assets/app-icon.svg", alt: "" });
  const links = make("ul", "about-links");
  for (const [label, href] of ABOUT_LINKS) {
    const item = make("li");
    item.append(Object.assign(make("a", "", label), { href, target: "_blank", rel: "noopener" }));
    links.append(item);
  }
  const form = make("form");
  form.method = "dialog";
  const close = make("button", "primary", "Close");
  form.append(close);
  dialog.append(
    logo,
    make("h2", "", "SSH Config Manager"),
    make("p", "about-version", version ? `Version ${version}` : ""),
    make("p", "about-text", "Manage ~/.ssh/config without losing comments or formatting. Every save is checked with ssh -G, and a backup is kept."),
    links,
    make("p", "about-copy", "© 2026 ReactIoT"),
    form,
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}
window.__TAURI__.event?.listen("show-about", showAbout);
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
  if (editing) return;
  if (item.dataset.add === "group") {
    // A new group is an empty section in the list; hosts are dragged into it.
    namingGroup = true;
    renderList();
  } else {
    startEdit(null);
  }
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
