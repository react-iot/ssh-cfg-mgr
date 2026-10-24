// <host-detail>: the selected block (name, settings table with inline
// <value-editor>s, add row, row tools), or the name field of a new host.
//
// Holds only the state of its table; everything else is in `store`.
// render(reason) closes the open editors after a select, a save or a
// reload (see store.js).
import { make, button, iconButton, byName, TRASH, WRENCH, FOLDER } from "../dom.js";
import { store, GLOBAL_ID } from "../store.js";
import { ValueEditor, KEYWORDS, VALUE_TYPES, PATH_KEYWORDS } from "./value-editor.js";
import { openBuilder } from "./builder-dialog.js";

// The row whose value is being edited: a row number, or PATTERN_ROW for
// the block's name in the heading.
const PATTERN_ROW = "pattern";

class HostDetail extends HTMLElement {
  #inlineRow = null;
  // A value from a builder or file picker, shown in the open row editor.
  #inlineValue = null;
  // The keyword chosen in the add row.
  #addKeyword = "";
  // The settings row whose trash was clicked once, waiting for the second click.
  #deleteRow = null;

  render(reason = "") {
    if (reason === "select" || reason === "saved") this.#addKeyword = "";
    if (reason) {
      this.#inlineRow = null;
      this.#deleteRow = null;
      this.#inlineValue = null;
    }
    this.replaceChildren();
    if (store.editing?.draft) this.#renderNew();
    else this.#renderView();
  }

  // Open the editor for settings row i, optionally with a new value in it.
  #editRow(i, value = null) {
    this.#inlineRow = i;
    this.#inlineValue = value;
    this.#deleteRow = null;
    this.render();
  }

  // The editor for a value; `save` gets the new value.
  #editor(keyword, current, save, cancel) {
    const editor = ValueEditor.create(keyword, current);
    editor.addEventListener("value-save", (event) => save(event.detail.value));
    editor.addEventListener("value-cancel", cancel);
    return editor;
  }

  #renderView() {
    const entry = store.entries().find((e) => e.id === store.selected);
    if (!entry) {
      const text = store.config.exists
        ? "Select a host to see its settings."
        : "There is no SSH config file yet. Click New host to make one.";
      this.append(make("p", "empty", text));
      return;
    }

    const head = make("div", "detail-head");
    const title = make("h1");
    if (entry.id === GLOBAL_ID) {
      title.textContent = entry.name;
    } else if (entry.readOnly) {
      title.append(make("span", "kind-label", entry.kind), make("span", "", entry.name));
    } else if (this.#inlineRow === PATTERN_ROW) {
      // Edit the Host pattern or Match criteria in place.
      const editor = this.#editor(
        entry.kind,
        entry.name,
        (pattern) => store.saveSettings(entry, entry.settings, pattern),
        () => {
          this.#inlineRow = null;
          this.render();
        },
      );
      editor.input.classList.add("pattern-editor");
      title.append(make("span", "kind-label", entry.kind), editor);
      queueMicrotask(() => editor.input.focus());
    } else {
      const name = button(entry.name, "value-button title-button", () => {
        this.#inlineRow = PATTERN_ROW;
        this.render();
      });
      name.title = "Click to rename";
      title.append(make("span", "kind-label", entry.kind), name);
    }
    head.append(title);
    if (entry.id === GLOBAL_ID) {
      const actions = make("div", "actions");
      actions.append(button("Edit Raw", "", () => store.startRaw(entry)));
      head.append(actions);
    } else if (!entry.readOnly) {
      const actions = make("div", "actions");
      if (store.confirmingDelete) {
        actions.append(
          make("span", "confirm-text", "Delete this block?"),
          button("Delete", "danger", () => store.remove(entry)),
          button("Cancel", "", () => {
            store.confirmingDelete = false;
            this.render();
          }),
        );
      } else {
        // Values are edited in the table; this opens the whole block as a form.
        actions.append(button("Edit Raw", "", () => store.startRaw(entry)));
        // Only a Host can be copied: a new block is always a Host.
        if (entry.kind === "Host") {
          actions.append(button("Duplicate", "", () => store.startNew(entry)));
        }
        const trash = iconButton(TRASH, "Delete this block", () => {
          store.confirmingDelete = true;
          this.render();
        });
        trash.classList.add("trash");
        actions.append(trash);
      }
      head.append(actions);
    }
    this.append(head);

    // Only what the table does not show: what global settings are, where an
    // included block comes from, and that a block is turned off.
    const lead =
      entry.id === GLOBAL_ID
        ? "Lines before the first Host or Match. They apply to every host. OpenSSH uses the first value it finds, so a setting here wins over the same keyword in a block."
        : entry.included
          ? `${entry.readOnly ? "Read-only: outside ~/.ssh. " : ""}From ${entry.source.path}, included by "Include ${entry.source.pattern}" in ${entry.source.from}${entry.source.condition ? `, only for ${entry.source.condition}` : ""}.`
          : entry.enabled
          ? ""
          : "Off: commented out with #~, so OpenSSH ignores it.";
    if (lead) this.append(make("p", "lead", lead));

    const editable = !entry.readOnly;
    if (entry.settings.length === 0 && !editable) {
      this.append(make("p", "empty", "This block has no settings."));
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
      } else if (this.#inlineRow === i) {
        const editor = this.#editor(
          setting.keyword,
          this.#inlineValue ?? setting.value,
          (value) => store.saveSettings(entry, entry.settings.map((s, j) => (j === i ? { ...s, value } : s))),
          () => {
            this.#inlineRow = null;
            this.#inlineValue = null;
            this.render();
          },
        );
        cell.append(editor);
        queueMicrotask(() => editor.input.focus());
      } else {
        // Click the value to change it.
        const value = button(setting.value, "value-button", () => this.#editRow(i));
        value.title = "Click to change";
        cell.append(value);
        // Few fixed choices: show them on hover. A click opens the editor with
        // that choice; the tick saves it.
        const choices = VALUE_TYPES[setting.keyword.toLowerCase()]?.choices;
        if (choices?.length <= 5 && choices.includes(setting.value)) {
          const options = make("div", "toggle hover-options");
          for (const choice of choices) {
            const option = button(choice, "", () => this.#editRow(i, choice));
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
        const editingRow = this.#inlineRow === i;
        if (BUILDERS[key] && !editingRow) {
          actions.append(
            iconButton(WRENCH, `Build the ${setting.keyword} value`, () =>
              openBuilder(setting.keyword, BUILDERS[key], setting.value, (built) => this.#editRow(i, built)),
            ),
          );
        }
        if (PATH_KEYWORDS.has(key) && !editingRow) {
          actions.append(
            iconButton(FOLDER, `Choose a file for ${setting.keyword}`, async () => {
              const picked = await store.pickFile(setting.keyword, setting.value);
              if (picked) this.#editRow(i, picked);
            }),
          );
        }
        // Delete the row: the first click asks, the second deletes.
        const confirming = this.#deleteRow === i;
        const trash = iconButton(TRASH, confirming ? `Click again to delete ${setting.keyword}` : `Delete ${setting.keyword}`, () => {
          if (confirming) {
            store.saveSettings(entry, entry.settings.filter((_, j) => j !== i));
          } else {
            this.#deleteRow = i;
            this.render();
          }
        });
        trash.classList.toggle("confirming", confirming);
        actions.append(trash);
        row.append(actions);
      }
      table.append(row);
    });
    if (editable) table.append(this.#addRow(entry));
    this.append(table);
  }

  // The last table row: choose a keyword, then enter its value.
  #addRow(entry) {
    const row = make("tr", "add-row");
    const pick = make("select");
    pick.setAttribute("aria-label", "Keyword to add");
    pick.append(Object.assign(make("option", "", "Add a setting…"), { value: "" }));
    for (const keyword of [...KEYWORDS].sort(byName)) {
      pick.append(Object.assign(make("option", "", keyword), { value: keyword }));
    }
    pick.value = this.#addKeyword;
    pick.addEventListener("change", () => {
      this.#addKeyword = pick.value;
      this.render();
      this.querySelector(".add-row .value-editor")?.focus();
    });
    const valueCell = make("td");
    if (this.#addKeyword) {
      const keyword = this.#addKeyword;
      valueCell.append(
        this.#editor(
          keyword,
          "",
          (value) => store.saveSettings(entry, [...entry.settings, { keyword, value }]),
          () => {
            this.#addKeyword = "";
            this.render();
          },
        ),
      );
    }
    const keywordCell = make("td");
    keywordCell.append(pick);
    valueCell.colSpan = 2;
    row.append(keywordCell, valueCell);
    return row;
  }

  // A new host, or a copy: only its name, with the same editor as renaming.
  #renderNew() {
    const editing = store.editing;
    const head = make("div", "detail-head");
    const title = make("h1");
    const editor = this.#editor(
      "Host",
      editing.pattern,
      (pattern) => {
        editing.pattern = pattern;
        store.save();
      },
      () => store.cancelEdit(),
    );
    editor.input.classList.add("pattern-editor");
    editor.input.placeholder = "my-server  or  gw-* !gw-test";
    // Keep what is typed if the view is drawn again (e.g. a sort click).
    editor.input.addEventListener("input", () => (editing.pattern = editor.input.value));
    title.append(make("span", "kind-label", "Host"), editor);
    head.append(title);
    this.append(head);
    this.append(
      make("p", "lead", "The name you type after ssh. Use * as a wildcard and ! to exclude; separate patterns with spaces. The tick saves the host; then add its settings in the table."),
    );

    // A copy shows what it will copy.
    if (editing.from?.settings.length) {
      this.append(make("p", "hint", `Copied from ${editing.from.name}${editing.group ? `, in group ${editing.group}` : ""}:`));
      const table = make("table");
      const headRow = make("tr");
      headRow.append(make("th", "", "Keyword"), make("th", "", "Value"));
      table.append(headRow);
      for (const setting of editing.from.settings) {
        const row = make("tr");
        row.append(make("td", "", setting.keyword), make("td", "", setting.value));
        table.append(row);
      }
      this.append(table);
    }
    queueMicrotask(() => editor.input.focus());
  }
}

customElements.define("host-detail", HostDetail);
