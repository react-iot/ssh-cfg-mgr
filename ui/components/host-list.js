// <host-list>: the sidebar. Filter, sort, the + menu, and the list of hosts
// in groups and included files, with drag and drop. Its tools are in
// index.html, inside the element.
//
// Reads and changes `store`. Emits `host-count` ({ text }) for the status
// bar each time it draws.
import { make, button, iconButton, emit, svg, plural, value, FOLDER, FILE_ICON, TRASH, EYE } from "../dom.js";
import { store, connectTarget, GLOBAL_ID } from "../store.js";

// The sort button steps through these, then starts again. CSS shows the
// icon for the current one.
const SORTS = [
  { value: "file", label: "File order (not sorted)" },
  { value: "asc", label: "Name A–Z" },
  { value: "desc", label: "Name Z–A" },
];

class HostList extends HTMLElement {
  // Whether the name field for "New group" is open.
  #namingGroup = false;

  connectedCallback() {
    const $ = (selector) => this.querySelector(selector);
    this.search = $("#search");
    this.list = $("#list");
    this.sortButton = $("#sort");
    this.addButton = $("#add");
    this.menu = $("#add-menu");

    this.search.addEventListener("input", () => this.render());
    this.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.search.value) {
        this.search.value = "";
        this.render();
      }
    });

    this.#showSort();
    this.sortButton.addEventListener("click", () => {
      const prefs = store.prefs;
      const next = (SORTS.findIndex((s) => s.value === prefs.sort) + 1) % SORTS.length;
      prefs.sort = SORTS[next].value;
      this.#showSort();
      store.savePrefs();
      // A selected block can change group, but it stays selected.
      if (store.config) store.emit();
    });

    // The + button opens a menu: New host or New group.
    this.addButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.#showAddMenu(this.menu.hidden);
    });
    this.menu.addEventListener("click", (event) => {
      const item = event.target.closest("[data-add]");
      if (!item) return;
      this.#showAddMenu(false);
      if (store.editing) return;
      if (item.dataset.add === "group") {
        // A new group is an empty section in the list; hosts are dragged into it.
        this.#namingGroup = true;
        this.render();
      } else {
        store.startNew();
      }
    });
    this.menu.addEventListener("keydown", (event) => {
      const items = [...this.menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (event.key === "Escape") {
        this.#showAddMenu(false);
        this.addButton.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        items[(i + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
      }
    });
    document.addEventListener("click", () => this.#showAddMenu(false));
  }

  #showSort() {
    const prefs = store.prefs;
    const sort = SORTS.find((s) => s.value === prefs.sort) ?? SORTS[0];
    prefs.sort = sort.value;
    this.sortButton.dataset.sort = sort.value;
    this.sortButton.title = `Sort: ${sort.label}. Click to change.`;
    this.sortButton.setAttribute("aria-label", this.sortButton.title);
  }

  #showAddMenu(show) {
    this.menu.hidden = !show;
    this.addButton.setAttribute("aria-expanded", String(show));
    if (show) this.menu.querySelector("button").focus();
  }

  render() {
    const { config, prefs, editing, newGroups } = store;
    const filter = this.search.value.trim().toLowerCase();
    const list = this.list;
    list.replaceChildren();
    this.classList.toggle("locked", editing !== null);

    const all = store.entries();
    const shown = all.filter((entry) => {
      if (!filter) return true;
      const text = [entry.name, entry.group, value(entry.settings, "HostName"), value(entry.settings, "User")];
      return text.join(" ").toLowerCase().includes(filter);
    });

    const global = shown.filter((e) => e.id === GLOBAL_ID);
    const sections = store.grouped(shown.filter((e) => e.id !== GLOBAL_ID && !e.included));
    const hasGroups = sections.some(([group]) => group);
    if (this.#namingGroup) list.append(this.#groupNameRow());
    for (const entry of global) list.append(this.#listItem(entry));
    for (const [group, members] of sections) {
      // While filtering, show only groups that have matches.
      if (filter && !members.length) continue;
      // A filter shows matches in closed groups too, so nothing is hidden.
      const closed = hasGroups && !filter && prefs.collapsed.includes(group);
      if (hasGroups) {
        // A folder icon for real groups; "No group" is not one.
        const head = this.#sectionHead(group || "No group", group, members.length, closed, group ? FOLDER : null);
        // An empty group exists only here (the file has no hosts in it), so
        // removing it changes nothing on disk.
        if (!members.length && newGroups.includes(group)) {
          const remove = iconButton(TRASH, `Delete the empty group ${group}`, () => {
            store.setNewGroups(store.newGroups.filter((g) => g !== group));
            this.render();
          });
          remove.classList.add("group-remove");
          head.append(remove);
        }
        dropTarget(head, group);
        list.append(head);
        if (closed) continue;
        if (!members.length) {
          const hint = make("li", "drop-hint", group ? "Drag hosts here" : "Drag a host here to take it out of its group");
          hint.setAttribute("role", "presentation");
          dropTarget(hint, group);
          list.append(hint);
        }
      }
      for (const entry of members) list.append(this.#listItem(entry));
    }

    // One section per included file, after the config's own hosts.
    (config.included ?? []).forEach((file, fileIndex) => {
      const members = shown.filter((e) => e.fileIndex === fileIndex);
      if (filter && !members.length) return;
      const key = `file:${file.path}`;
      const closed = !filter && prefs.collapsed.includes(key);
      // Files in ~/.ssh are shown by their name there; others by full path.
      const short = file.path.startsWith("~/.ssh/") ? file.path.slice("~/.ssh/".length) : file.path;
      const head = this.#sectionHead(short, key, members.length, closed, FILE_ICON);
      head.classList.add("include-head");
      head.title = `${file.path}: from "Include ${file.pattern}" in ${file.from}${file.condition ? `, only for ${file.condition}` : ""}. Read-only.`;
      list.append(head);
      if (file.line !== null && !editing) includeDrag(head, file.line);
      if (closed) return;
      const note = file.error ?? (members.length ? "" : "No hosts in this file.");
      if (note) {
        const li = make("li", "include-note", note);
        li.setAttribute("role", "presentation");
        list.append(li);
      }
      for (const entry of members) list.append(this.#listItem(entry));
    });

    const hosts = config.blocks.filter((b) => b.kind === "Host").length;
    const matches = config.blocks.length - hosts;
    const included = all.filter((e) => e.included).length;
    emit(this, "host-count", {
      text: filter
        ? `${shown.length} of ${all.length} shown`
        : `${plural(hosts, "host")}, ${plural(matches, "match block")}${included ? `, ${included} included` : ""}`,
    });
  }

  // A section header that opens and closes; `key` is remembered when closed.
  // `icon` (an SVG path) goes before the label.
  #sectionHead(label, key, count, closed, icon = null) {
    const head = make("li", "group-head");
    head.setAttribute("role", "presentation");
    // A div with role=button, not a <button>: a drag that starts on a
    // <button> inside a draggable row may not start in every engine, and
    // include headers are dragged.
    const toggle = make("div", "group-toggle");
    toggle.setAttribute("role", "button");
    toggle.tabIndex = 0;
    const flip = () => {
      const prefs = store.prefs;
      prefs.collapsed = closed ? prefs.collapsed.filter((g) => g !== key) : [...prefs.collapsed, key];
      store.savePrefs();
      this.render();
    };
    toggle.addEventListener("click", flip);
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        flip();
      }
    });
    toggle.setAttribute("aria-expanded", String(!closed));
    // A right-pointing chevron; CSS turns it down when the group is open.
    toggle.append(
      svg("svg", { class: "chevron", viewBox: "0 0 16 16", width: "12", height: "12", "aria-hidden": "true" }, [
        svg("path", { d: "M6 3.5 10.5 8 6 12.5", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" }),
      ]),
    );
    if (icon) {
      toggle.append(
        svg("svg", { class: "section-icon", viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": "true" }, [
          svg("path", { d: icon, fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linejoin": "round" }),
        ]),
      );
    }
    toggle.append(make("span", "section-label", label), make("span", "group-count", String(count)));
    head.append(toggle);
    return head;
  }

  #listItem(entry) {
    const item = make("li");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(entry.id === store.selected));
    // Host is the default block kind, so only Match blocks get a label.
    if (entry.kind === "Match") item.append(make("span", "kind", entry.kind));
    const text = make("span", "text");
    text.append(make("span", "name", entry.name));
    const target = connectTarget(entry);
    if (target) text.append(make("span", "sub", target));
    item.append(text);
    if (entry.id !== GLOBAL_ID && !entry.readOnly) {
      item.classList.toggle("off", !entry.enabled);
      item.append(visibilityButton(entry));
    }
    item.addEventListener("click", () => store.select(entry.id));
    // Moving hosts between or inside included files is not supported yet.
    if (entry.id !== GLOBAL_ID && !entry.included && !store.editing) {
      // Drag a host onto a group (or a host in it) to move it there.
      item.draggable = true;
      item.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", entry.id);
        event.dataTransfer.effectAllowed = "move";
      });
      // In file order a host can also be dropped before or after another.
      if (store.prefs.sort === "file") reorderTarget(item, entry);
      else dropTarget(item, entry.group);
    }
    return item;
  }

  // The name field at the top of the list for "New group".
  #groupNameRow() {
    const row = make("li", "group-new");
    row.setAttribute("role", "presentation");
    const input = make("input");
    input.placeholder = "Group name, then Enter";
    input.setAttribute("aria-label", "New group name");
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const name = input.value.trim();
        if (name && !store.newGroups.includes(name)) store.setNewGroups([...store.newGroups, name]);
        this.#namingGroup = false;
        this.render();
      } else if (event.key === "Escape") {
        this.#namingGroup = false;
        this.render();
      }
    });
    row.append(input);
    queueMicrotask(() => input.focus());
    return row;
  }
}

// Top or bottom half of a row, for a drop before or after it.
// offsetY is relative to the child under the pointer, so use the row's box.
function isAfter(node, event) {
  const box = node.getBoundingClientRect();
  return event.clientY - box.top > box.height / 2;
}

// Include lines at the top of the config can be dragged to reorder them:
// OpenSSH reads them in order. All files from one line move together.
function includeDrag(head, line) {
  head.draggable = true;
  head.classList.add("movable");
  head.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", `line:${line}`);
    event.dataTransfer.effectAllowed = "move";
  });
  const clear = () => head.classList.remove("drop-before", "drop-after");
  head.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes("text/plain")) return;
    event.preventDefault();
    clear();
    head.classList.add(isAfter(head, event) ? "drop-after" : "drop-before");
  });
  head.addEventListener("dragleave", clear);
  head.addEventListener("drop", (event) => {
    event.preventDefault();
    clear();
    const data = event.dataTransfer.getData("text/plain");
    if (data.startsWith("line:")) store.moveInclude(Number(data.slice(5)), line, isAfter(head, event));
  });
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
    store.moveToGroup(event.dataTransfer.getData("text/plain"), group);
  });
}

// Drop on a host: the top half puts the dragged host before it, the bottom
// half after it. It also joins that host's group.
function reorderTarget(node, target) {
  const clear = () => node.classList.remove("drop-before", "drop-after");
  node.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clear();
    node.classList.add(isAfter(node, event) ? "drop-after" : "drop-before");
  });
  node.addEventListener("dragleave", clear);
  node.addEventListener("drop", (event) => {
    event.preventDefault();
    clear();
    store.reorder(event.dataTransfer.getData("text/plain"), target, isAfter(node, event));
  });
}

// A crossed-out eye: always shown on a hidden block (its state), and on
// hover over a visible block (the action "hide"). Click to switch.
function visibilityButton(entry) {
  const label = entry.enabled ? `Turn off ${entry.name}` : `Turn on ${entry.name}`;
  const node = button("", "visibility", (event) => {
    event.stopPropagation();
    store.setEnabled(entry, !entry.enabled);
  });
  node.title = entry.enabled ? "On. Click to comment it out." : "Off (commented out). Click to turn on.";
  node.setAttribute("aria-label", label);
  node.setAttribute("aria-pressed", String(entry.enabled));
  node.append(
    svg("svg", { viewBox: "0 0 16 16", width: "15", height: "15", "aria-hidden": "true" }, [
      svg("path", { d: EYE }),
      svg("circle", { cx: "8", cy: "8", r: "2" }),
      svg("path", { d: "M2.5 13.5 13.5 2.5" }),
    ]),
  );
  return node;
}

customElements.define("host-list", HostList);
