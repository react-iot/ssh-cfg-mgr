// App state and every call to the Rust side.
//
// `invoke` calls a Rust function marked #[tauri::command] in
// src-tauri/src/lib.rs. Tauri gives it to us as a global, because
// "withGlobalTauri" is true in tauri.conf.json.
//
// Events (on `store`):
//   change  the state changed; draw again. detail.reason says why:
//           "select" (another entry), "saved" (a value was saved from the
//           table), "reloaded" (changed on disk), or "".
//   notice  detail: { text, kind }, or { text: null } to hide it.
//   sync    detail: { label, detail, kind }: the file-watch state.
import { value, byName, plural } from "./dom.js";

const { invoke } = window.__TAURI__.core;

export const GLOBAL_ID = "global";
export const NEW_ID = "new";
export const SETTINGS_ID = "settings";
export const HISTORY_ID = "history";
export const KEYS_ID = "keys";
export const BACKUP_DIR = "ssh-cfg-mgr-backups";

// View preferences, kept per user in this app's local storage. Storage can
// fail (private mode, cleared data); the defaults work without it.
// newGroupMode: how a group is saved on a block that has none yet.
// collapsed: names of closed groups in the list ("" is No group).
// theme: "system", "light" or "dark".
const prefs = { newGroupMode: "comment", sort: "file", collapsed: [], theme: "system" };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem("prefs") || "{}"));
} catch {}
if (!Array.isArray(prefs.collapsed)) prefs.collapsed = [];
if (!["system", "light", "dark"].includes(prefs.theme)) prefs.theme = "system";

// The group of a block, from the file: a "# group: <name>" comment above
// it, else its Tag. groupMode is how it is stored, or null for no group.
export function groupOf(block) {
  if (block.group_comment) return { group: block.group_comment, groupMode: "comment" };
  const tag = value(block.settings, "Tag");
  return tag ? { group: tag, groupMode: "tag" } : { group: "", groupMode: null };
}

// "user@host" that ssh connects to. Without HostName, ssh uses the alias,
// which is only a real host name for a single Host pattern with no wildcards.
export function connectTarget(entry) {
  const user = value(entry.settings, "User");
  const plainAlias = entry.kind === "Host" && !/[\s*?!,]/.test(entry.name);
  const host = value(entry.settings, "HostName") || (user && plainAlias ? entry.name : "");
  return host && user ? `${user}@${host}` : host;
}

const now = () => new Date().toLocaleTimeString();

// The main config and every included file: a change to any of them counts.
const fingerprint = (c) => [c.revision, ...(c.included ?? []).map((f) => `${f.file}:${f.revision}`)].join("|");

const emptyHistory = () => ({ backups: null, name: null, text: null, confirming: false });

// Key names ssh tries when a host has no IdentityFile (ssh_config(5)).
const DEFAULT_KEYS = ["id_rsa", "id_ecdsa", "id_ecdsa_sk", "id_ed25519", "id_ed25519_sk", "id_xmss", "id_dsa"];

// An IdentityFile value as a full path: no quotes, ~ and %d are the home
// folder, and a .pub path means its private key.
// ponytail: other % tokens (%h, %r, ...) are left as written, so such a
// path matches no key.
function keyPath(value, home) {
  let path = value.replace(/^"(.*)"$/, "$1").replaceAll("%d", home);
  if (path.startsWith("~/")) path = home + path.slice(1);
  return path.replace(/\.pub$/, "");
}

class Store extends EventTarget {
  prefs = prefs;
  config = null;
  selected = null;
  // While the user edits a block (raw text or a new host), the form state.
  editing = null;
  confirmingDelete = false;
  // Groups made with "New group" that have no hosts yet. Kept in local
  // storage, so they survive a restart; the file cannot hold a group
  // without hosts.
  newGroups = Array.isArray(prefs.emptyGroups) ? prefs.emptyGroups : [];
  // backups: the list (null while loading); name/text: the chosen backup.
  history = emptyHistory();
  // The keys in ~/.ssh (null while loading).
  keys = null;
  // The New key form's fields, or null when it is closed.
  keyForm = null;
  // "Clear history" was clicked once, waiting for the second click.
  confirmingClear = false;
  #checking = false;
  #warnedRevision = null;

  emit(reason = "") {
    this.dispatchEvent(new CustomEvent("change", { detail: { reason } }));
  }

  notice(text, kind = "ok") {
    this.dispatchEvent(new CustomEvent("notice", { detail: { text, kind } }));
  }

  clearNotice() {
    this.notice(null);
  }

  // The file-watch state, in the status bar.
  // A short label; the time and details are in the tooltip.
  sync(label, detail, kind = "") {
    this.dispatchEvent(new CustomEvent("sync", { detail: { label, detail, kind } }));
  }

  savePrefs() {
    try {
      localStorage.setItem("prefs", JSON.stringify(prefs));
    } catch {}
  }

  setNewGroups(list) {
    this.newGroups = list;
    prefs.emptyGroups = list;
    this.savePrefs();
  }

  // All entries in the sidebar: global settings first, then each block.
  // A block's id is its index in config.blocks, as a string; a block of an
  // included file has id "inc:<file>:<block>". `index` is the block's index
  // in its own file, and `file`/`revision` say which file to save (null: the
  // main config).
  entries() {
    const config = this.config;
    const list = [];
    list.push({ id: GLOBAL_ID, kind: "", name: "Global settings", settings: config.global, raw: config.global_raw, revision: config.revision, group: "" });
    config.blocks.forEach((block, index) => {
      list.push({
        id: String(index),
        index,
        file: null,
        revision: config.revision,
        kind: block.kind,
        name: block.pattern,
        settings: block.settings,
        enabled: block.enabled,
        raw: block.raw,
        ...groupOf(block),
      });
    });
    // Hosts from included files, with the file they come from. Files in
    // ~/.ssh can be edited; others are read-only.
    (config.included ?? []).forEach((source, fileIndex) => {
      source.blocks.forEach((block, index) => {
        list.push({
          id: `inc:${fileIndex}:${index}`,
          index,
          file: source.file,
          revision: source.revision,
          kind: block.kind,
          name: block.pattern,
          settings: block.settings,
          enabled: block.enabled,
          raw: block.raw,
          // Kept so a save does not drop a group comment; shown by file.
          ...groupOf(block),
          included: true,
          readOnly: !source.editable,
          source,
          fileIndex,
        });
      });
    });
    return list;
  }

  // Blocks in display order, as [group name, entries] pairs. Global settings
  // come first with no group, blocks with no group come last.
  grouped(blocks) {
    const dir = { asc: 1, desc: -1 }[prefs.sort];
    if (dir) blocks = [...blocks].sort((a, b) => dir * byName(a.name, b.name));
    const groups = new Map();
    for (const entry of blocks) {
      if (!groups.has(entry.group)) groups.set(entry.group, []);
      groups.get(entry.group).push(entry);
    }
    // Groups made with "New group" have no hosts yet, so they are not in the file.
    for (const name of this.newGroups) if (!groups.has(name)) groups.set(name, []);
    const named = [...groups.keys()].filter((g) => g);
    if (dir) named.sort((a, b) => dir * byName(a, b));
    // "No group" is always there when groups are, so a host can be dragged out.
    return [...named, ""].map((g) => [g, groups.get(g) ?? []]);
  }

  select(id) {
    if (this.editing) return;
    const changed = id !== this.selected;
    this.selected = id;
    this.confirmingDelete = false;
    this.clearNotice();
    this.emit(changed ? "select" : "");
  }

  openSettings() {
    this.confirmingClear = false;
    this.select(SETTINGS_ID);
    this.loadHistory();
  }

  openHistory() {
    this.history = emptyHistory();
    this.confirmingClear = false;
    this.select(HISTORY_ID);
    this.loadHistory();
  }

  openKeys() {
    this.keys = null;
    this.keyForm = null;
    this.select(KEYS_ID);
    this.loadKeys();
  }

  async loadKeys() {
    try {
      this.keys = await invoke("list_keys");
    } catch (error) {
      this.notice(String(error), "error");
      this.keys = [];
    }
    this.emit();
  }

  openKeyForm() {
    const taken = new Set((this.keys ?? []).map((k) => k.path.split("/").pop()));
    let name = "id_ed25519";
    for (let n = 2; taken.has(name); n++) name = `id_ed25519_${n}`;
    this.keyForm = { name, comment: "", passphrase: "", confirm: "" };
    this.emit();
  }

  closeKeyForm() {
    this.keyForm = null;
    this.emit();
  }

  async generateKey() {
    const form = this.keyForm;
    if (form.passphrase !== form.confirm) return this.notice("The two passphrases are not the same.", "error");
    this.clearNotice();
    try {
      const key = await invoke("generate_key", { name: form.name, comment: form.comment, passphrase: form.passphrase });
      this.keyForm = null;
      this.notice(`Made ${key.path} and its .pub file. Copy the public key to a server or to GitHub.`);
      await this.loadKeys();
    } catch (error) {
      this.notice(String(error), "error");
    }
  }

  // Each key with the entries whose IdentityFile names it.
  keysWithUsers() {
    const entries = this.entries().filter((e) => e.id === GLOBAL_ID || e.enabled !== false);
    return (this.keys ?? []).map((key) => ({
      ...key,
      name: key.path.split("/").pop(),
      isDefault: DEFAULT_KEYS.includes(key.path.split("/").pop()),
      users: entries.filter((e) =>
        e.settings.some((s) => s.keyword.toLowerCase() === "identityfile" && keyPath(s.value, this.config.home) === key.path),
      ),
    }));
  }

  // ---- Load and watch ----

  async load() {
    try {
      this.config = await invoke("load_config");
    } catch (error) {
      this.notice(String(error), "error");
      this.sync("Cannot read file", `${now()}: the file could not be read.`, "error");
      return;
    }
    this.editing = null;
    this.confirmingDelete = false;
    this.#showConfig();
    this.sync("Monitoring changes", `Loaded at ${now()}. Watching the file for changes.`);
  }

  #showConfig(reason = "") {
    const ids = this.entries().map((e) => e.id);
    if (![SETTINGS_ID, HISTORY_ID, KEYS_ID].includes(this.selected) && !ids.includes(this.selected)) {
      this.selected = ids.find((id) => id !== GLOBAL_ID) ?? ids[0] ?? null;
    }
    this.emit(reason);
  }

  // Another program (an editor, a dotfiles sync) can change the file. Read
  // it again every few seconds and when the window gets focus.
  // ponytail: polling, not a file watcher; reading one small file is cheap.
  async checkForChanges() {
    if (!this.config || this.#checking || document.hidden) return;
    this.#checking = true;
    const before = this.config;
    try {
      const fresh = await invoke("load_config");
      // A save finished while we read: its result is newer than ours.
      if (this.config !== before) return;
      if (fingerprint(fresh) === fingerprint(this.config)) {
        this.sync("Monitoring changes", `Last checked at ${now()}. No changes.`);
        return;
      }
      if (this.editing) {
        // Keep the form. A save now would fail, so say so once.
        this.sync("Changed on disk", `Changed on disk at ${now()}. Not reloaded while you edit.`, "changed");
        if (this.#warnedRevision !== fingerprint(fresh)) {
          this.#warnedRevision = fingerprint(fresh);
          this.notice("The file changed on disk. Your changes cannot be saved. Copy what you need, click Cancel, and edit again.", "error");
        }
        return;
      }
      // Block ids are positions, which can move. Keep the same block selected.
      const name = this.entries().find((e) => e.id === this.selected)?.name;
      this.config = fresh;
      const same = this.entries().find((e) => e.name === name);
      if (same) this.selected = same.id;
      this.confirmingDelete = false;
      // Row numbers may have moved; the detail closes its value editor.
      this.#showConfig("reloaded");
      this.sync("Reloaded", `Changed on disk; reloaded at ${now()}.`, "changed");
      this.notice("The file changed on disk. The list was reloaded.");
    } catch {
      // The next check tries again. Reload shows the error.
      this.sync("Cannot read file", `${now()}: the file could not be read. Trying again.`, "error");
    } finally {
      this.#checking = false;
    }
  }

  // ---- Save and delete ----

  // `file`: the included file that was saved (null: the main config), so the
  // saved block of that file is selected.
  #applyResult(result, message, file = null, reason = "") {
    this.config = result.config;
    this.editing = null;
    this.confirmingDelete = false;
    // Global settings stay selected after their own save.
    if (result.selected === null) this.selected = this.selected === GLOBAL_ID ? GLOBAL_ID : null;
    else if (file === null) this.selected = String(result.selected);
    else {
      const fileIndex = this.config.included.findIndex((f) => f.file === file);
      this.selected = fileIndex < 0 ? null : `inc:${fileIndex}:${result.selected}`;
    }
    this.emit(reason);
    this.notice(result.backup ? `${message} Backup: ${result.backup}` : message);
    this.sync("Monitoring changes", `Saved at ${now()}. Watching the file for changes.`);
  }

  // Save a block with new settings, from the detail table. The group stays.
  // newGroup: move the block to this group ("" for none); otherwise it stays.
  async saveSettings(entry, settings, pattern = entry.name, newGroup = undefined) {
    this.clearNotice();
    if (entry.id === GLOBAL_ID) {
      try {
        this.#applyResult(await invoke("save_global", { revision: this.config.revision, settings }), "Saved.", null, "saved");
      } catch (error) {
        this.notice(String(error), "error");
      }
      return;
    }
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
        revision: entry.revision,
        index: entry.index,
        file: entry.file,
        pattern,
        settings,
        group,
        groupMode,
      });
      // A new group that now has a host is in the file.
      this.setNewGroups(this.newGroups.filter((g) => !result.config.blocks.some((b) => groupOf(b).group === g)));
      this.#applyResult(result, "Saved.", entry.file, "saved");
    } catch (error) {
      this.notice(String(error), "error");
    }
  }

  // Save the raw text or the new host being edited.
  async save() {
    this.clearNotice();
    const editing = this.editing;
    try {
      const result = editing.global
        ? await invoke("save_global_raw", { revision: editing.revision, text: editing.text })
        : editing.raw
        ? await invoke("save_block_raw", { revision: editing.revision, file: editing.file, index: editing.index, text: editing.text })
        : await invoke("save_block", {
            revision: this.config.revision,
            index: editing.index,
            pattern: editing.pattern,
            settings: editing.settings,
            group: editing.group,
            groupMode: editing.groupMode,
          });
      this.#applyResult(result, "Saved.", editing.file ?? null);
    } catch (error) {
      // Keep the editor open, so the user can fix the problem.
      this.notice(String(error), "error");
    }
  }

  async remove(entry) {
    this.clearNotice();
    try {
      const result = await invoke("delete_block", { revision: entry.revision, file: entry.file, index: entry.index });
      this.#applyResult(result, "Deleted.", entry.file);
    } catch (error) {
      this.confirmingDelete = false;
      this.emit();
      this.notice(String(error), "error");
    }
  }

  // Unlike a save, this keeps the current selection: the user clicked a
  // row's button, not the row.
  async setEnabled(entry, enabled) {
    this.clearNotice();
    try {
      const result = await invoke("set_block_enabled", { revision: entry.revision, file: entry.file, index: entry.index, enabled });
      this.config = result.config;
      this.emit();
      const message = enabled ? "Turned on." : "Turned off (commented out).";
      this.notice(result.backup ? `${message} Backup: ${result.backup}` : message);
    } catch (error) {
      this.notice(String(error), "error");
    }
  }

  // Move a host before or after `target`; it also joins the target's group.
  async reorder(id, target, after) {
    const dragged = this.entries().find((e) => e.id === id);
    if (!dragged || dragged.id === target.id) return;
    const from = dragged.index;
    // The index in the new order: the target moves up by one if the dragged
    // host was above it.
    let to = target.index + (after ? 1 : 0);
    if (from < to) to -= 1;
    const newGroup = dragged.group === target.group ? undefined : target.group;
    if (to === from) {
      if (newGroup !== undefined) this.moveToGroup(id, newGroup);
      return;
    }
    this.clearNotice();
    try {
      const result = await invoke("move_block", { revision: this.config.revision, from, to });
      if (newGroup === undefined) return this.#applyResult(result, "Moved.");
      // Then join the target's group, as a second save.
      this.config = result.config;
      const moved = this.entries().find((e) => e.id === String(to));
      await this.saveSettings(moved, moved.settings, moved.name, newGroup);
    } catch (error) {
      this.notice(String(error), "error");
    }
  }

  // Save a host's group, stored the way the host already stores it.
  moveToGroup(id, group) {
    const entry = this.entries().find((e) => e.id === id);
    if (!entry || entry.group === group) return;
    this.saveSettings(entry, entry.settings, entry.name, group);
  }

  // Include lines at the top of the config can be reordered: OpenSSH reads
  // them in order. All files from one line move together.
  async moveInclude(from, target, after) {
    // The index in the new order, as for hosts.
    let to = target + (after ? 1 : 0);
    if (from < to) to -= 1;
    if (from === to) return;
    this.clearNotice();
    try {
      const result = await invoke("move_global_line", { revision: this.config.revision, from, to });
      const keep = this.selected;
      this.#applyResult(result, "Moved the Include line.");
      // applyResult selects nothing for this; keep the current host.
      this.selected = keep;
      this.emit();
    } catch (error) {
      this.notice(String(error), "error");
    }
  }

  // ---- Editing ----

  // A new host, or a copy of `from`. Only its name is asked for, with the
  // same editor as renaming; the tick saves it, and its settings are then
  // edited in the table like any other host.
  startNew(from = null) {
    this.clearNotice();
    this.confirmingDelete = false;
    // A block keeps the way its group is stored. One with no group uses the
    // setting for new groups.
    const groupMode = from?.groupMode ?? prefs.newGroupMode;
    this.editing = {
      draft: true,
      index: null,
      from,
      pattern: from ? `${from.name}-copy` : "",
      // In Tag mode the group is the Tag, so it is sent as the group.
      settings: (from?.settings ?? [])
        .filter((s) => groupMode !== "tag" || s.keyword.toLowerCase() !== "tag")
        .map((s) => ({ ...s })),
      group: from?.group ?? "",
      groupMode,
    };
    this.selected = NEW_ID;
    this.emit();
  }

  // Edit the block's lines as plain text.
  startRaw(entry) {
    this.clearNotice();
    this.confirmingDelete = false;
    this.editing = { raw: true, global: entry.id === GLOBAL_ID, index: entry.index, file: entry.file, revision: entry.revision, kind: entry.kind, name: entry.name, text: entry.raw };
    this.emit();
  }

  cancelEdit() {
    this.editing = null;
    if (this.selected === NEW_ID) this.selected = null;
    this.emit();
  }

  // ---- History: backups made on each save ----

  async loadHistory() {
    try {
      this.history.backups = await invoke("list_backups");
      if (this.history.backups.length) await this.showBackup(this.history.backups[0].name);
    } catch (error) {
      this.notice(String(error), "error");
      this.history.backups = [];
    }
    this.emit();
  }

  async showBackup(name) {
    try {
      this.history.text = await invoke("read_backup", { name });
      this.history.name = name;
      this.history.confirming = false;
    } catch (error) {
      this.notice(String(error), "error");
    }
    this.emit();
  }

  async restoreBackup(name) {
    this.clearNotice();
    try {
      const result = await invoke("restore_backup", { revision: this.config.revision, name });
      this.config = result.config;
      this.history = emptyHistory();
      this.notice(result.backup ? `Restored. The file before the restore is in history too: ${result.backup}` : "Restored. The file was already the same.");
      this.sync("Monitoring changes", `Restored at ${now()}. Watching the file for changes.`);
      this.emit();
      this.loadHistory();
    } catch (error) {
      this.history.confirming = false;
      this.emit();
      this.notice(String(error), "error");
    }
  }

  // Two clicks: the first asks, the second deletes every backup.
  async clearHistory() {
    if (!this.confirmingClear) {
      this.confirmingClear = true;
      return this.emit();
    }
    this.confirmingClear = false;
    try {
      const deleted = await invoke("clear_backups");
      this.notice(`Deleted ${plural(deleted, "backup")}. The config was not changed.`);
    } catch (error) {
      this.notice(String(error), "error");
    }
    this.history = emptyHistory();
    this.emit();
    this.loadHistory();
  }

  // ---- Other ----

  // The native file picker (Tauri dialog plugin). The plugin's JS package is
  // not loaded (no build step), so call its command directly. Returns a path
  // with the home folder written as ~, or null if cancelled.
  async pickFile(keyword, current) {
    const home = this.config.home;
    const expand = (p) => (home && p.startsWith("~/") ? home + p.slice(1) : p);
    const folder = current ? expand(current).replace(/\/[^/]*$/, "") : `${home}/.ssh`;
    try {
      const path = await invoke("plugin:dialog|open", {
        options: { title: `Choose a file for ${keyword}`, defaultPath: folder || undefined },
      });
      if (typeof path !== "string") return null;
      return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
    } catch (error) {
      this.notice(String(error), "error");
      return null;
    }
  }

  // The window theme decides prefers-color-scheme and the system colors, so
  // one call themes everything. null follows the system.
  applyTheme() {
    const theme = prefs.theme === "system" ? null : prefs.theme;
    window.__TAURI__.window?.getCurrentWindow().setTheme(theme).catch((error) => this.notice(String(error), "error"));
  }
}

export const store = new Store();

setInterval(() => store.checkForChanges(), 2000);
window.addEventListener("focus", () => store.checkForChanges());
