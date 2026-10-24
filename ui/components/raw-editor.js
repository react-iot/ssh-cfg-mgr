// <raw-editor>: the block's lines as plain text (store.editing.raw).
import { make, button } from "../dom.js";
import { store } from "../store.js";

class RawEditor extends HTMLElement {
  render() {
    const editing = store.editing;
    const cancel = () => store.cancelEdit();
    const form = make("form", "edit-form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      store.save();
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") cancel();
      // Cmd+Enter or Ctrl+Enter saves; Enter alone is a new line.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        store.save();
      }
    });
    // Heading with Save and Cancel on the right, as in the host view.
    const head = make("div", "detail-head");
    const actions = make("div", "actions");
    const saveButton = make("button", "primary", "Save");
    saveButton.type = "submit";
    actions.append(button("Cancel", "", cancel), saveButton);
    head.append(make("h1", "", ["Edit", editing.kind, editing.name].filter(Boolean).join(" ")), actions);
    form.append(head);

    const text = make("textarea", "raw");
    text.value = editing.text;
    text.spellcheck = false;
    text.setAttribute("aria-label", "Block text");
    text.rows = Math.min(30, Math.max(6, editing.text.split("\n").length + 1));
    text.addEventListener("input", () => (editing.text = text.value));
    form.append(text);
    const what = editing.global
      ? "The lines before the first Host or Match, as they are in the file. A Host or Match line is not allowed here."
      : "The block's lines as they are in the file.";
    form.append(
      make("p", "hint", `${what} Blank lines and comments after them are not shown, and stay as they are. ⌘↩ saves. OpenSSH checks the whole file before it is saved, and a backup of the old file is kept.`),
    );
    this.replaceChildren(form);
  }

  // Focus the text when the editor opens, not on each redraw.
  connectedCallback() {
    this.querySelector("textarea")?.focus();
  }
}

customElements.define("raw-editor", RawEditor);
