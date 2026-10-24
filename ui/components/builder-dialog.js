// <builder-dialog>: a modal that builds a value from its parts (see
// builders.js). "Use" emits `builder-use` with { value }; the field's tick
// still saves it. The element removes itself when closed.
import { make, button, iconButton, emit, CROSS } from "../dom.js";

export function openBuilder(keyword, builder, current, onUse) {
  const node = document.createElement("builder-dialog");
  node.addEventListener("builder-use", (event) => onUse(event.detail.value));
  node.open(keyword, builder, current);
}

class BuilderDialog extends HTMLElement {
  open(keyword, builder, current) {
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
      if (dialog.returnValue === "use") emit(this, "builder-use", { value: builder.build(items) });
      this.remove();
    });
    this.append(dialog);
    document.body.append(this);
    update();
    dialog.showModal();
    dialog.querySelector("input, select")?.focus();
  }
}

customElements.define("builder-dialog", BuilderDialog);
