// <key-dialog>: a modal to make a new Ed25519 key: file name, comment and
// passphrase. It stays open on an error, so the input can be fixed, and
// removes itself when closed.
import { make } from "../dom.js";
import { store } from "../store.js";

export function openKeyDialog(name) {
  document.createElement("key-dialog").open(name);
}

class KeyDialog extends HTMLElement {
  open(name) {
    const draft = { name, comment: "", passphrase: "", confirm: "" };
    const dialog = make("dialog", "builder key-dialog");
    const form = make("form");
    const error = make("p", "hint error");
    error.hidden = true;
    const showError = (text) => {
      error.textContent = text;
      error.hidden = false;
    };

    const field = (label, key, attrs, hint) => {
      const wrap = make("label", "field", label);
      const input = Object.assign(make("input", "mono"), { value: draft[key], spellcheck: false, autocomplete: "off" }, attrs);
      input.addEventListener("input", () => (draft[key] = input.value));
      wrap.append(input);
      if (hint) wrap.append(make("span", "hint", hint));
      return wrap;
    };

    const submit = make("button", "primary", "Make key");
    submit.type = "submit";
    const cancel = make("button", "", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => dialog.close());
    const actions = make("div", "form-actions");
    // Cancel on the left, Make key on the right, both at the right edge.
    actions.append(cancel, submit);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (draft.passphrase !== draft.confirm) return showError("The two passphrases are not the same.");
      submit.disabled = true;
      const failed = await store.generateKey(draft.name, draft.comment, draft.passphrase);
      submit.disabled = false;
      if (failed) showError(failed);
      else dialog.close();
    });

    form.append(
      make("h2", "", "New SSH key"),
      make("p", "hint", "An Ed25519 key in ~/.ssh: the private key, and the public key in the same name with .pub."),
      field("File name", "name", { required: true, pattern: "[A-Za-z0-9_\\-][A-Za-z0-9._\\-]*" }),
      field("Comment", "comment", { placeholder: "you@computer" }, "Shown next to the key, for example in GitHub. Optional."),
      field("Passphrase", "passphrase", { type: "password", autocomplete: "new-password" }, "Protects the key file. Empty means no passphrase."),
      field("Passphrase again", "confirm", { type: "password", autocomplete: "new-password" }),
      error,
      actions,
    );
    dialog.append(form);
    dialog.addEventListener("close", () => this.remove());
    this.append(dialog);
    document.body.append(this);
    dialog.showModal();
    dialog.querySelector("input").focus();
  }
}

customElements.define("key-dialog", KeyDialog);
