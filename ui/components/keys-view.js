// <keys-view>: the keys in ~/.ssh, the hosts whose IdentityFile names
// them, and a form to make a new key. State is store.keys and
// store.keyForm (null when the form is closed).
import { make, button, plural } from "../dom.js";
import { store } from "../store.js";

// Copy text. navigator.clipboard can be missing or refused in a webview;
// then a selected textarea and the copy command do it.
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(make("textarea"), { value: text });
    document.body.append(area);
    area.select();
    const done = document.execCommand("copy");
    area.remove();
    return done;
  }
}

class KeysView extends HTMLElement {
  render() {
    const head = make("div", "detail-head");
    const actions = make("div", "actions");
    if (!store.keyForm) actions.append(button("New key", "primary", () => store.openKeyForm()));
    head.append(make("h1", "", "SSH keys"), actions);
    this.replaceChildren(head);
    this.append(make("p", "lead", "Keys in ~/.ssh, and the hosts whose IdentityFile names them. Choose a host to open it."));
    if (store.keyForm) this.append(this.#form());
    if (store.keys === null) return this.append(make("p", "empty", "Loading…"));
    const keys = store.keysWithUsers();
    if (!keys.length) return this.append(make("p", "empty", "No keys found in ~/.ssh."));

    const unused = keys.filter((k) => !k.users.length && !k.isDefault).length;
    if (unused) this.append(make("p", "hint", `${plural(unused, "key")} not named by any host.`));

    const table = make("table", "keys");
    const headRow = make("tr");
    for (const title of ["Key", "Fingerprint", "Used by", ""]) headRow.append(make("th", "", title));
    table.append(headRow);
    for (const key of keys) {
      const name = make("td");
      const type = key.kind ? `${key.kind} ${key.bits}` : "Cannot read";
      name.append(make("div", "", key.name), make("div", "sub", [type, key.comment].filter(Boolean).join(" · ")));
      const fingerprint = make("td", "fingerprint", key.fingerprint);
      const users = make("td");
      const list = make("div", "users");
      for (const entry of key.users) list.append(button(entry.name, "", () => store.select(entry.id)));
      if (!key.users.length) {
        list.append(
          key.isDefault
            ? Object.assign(make("span", "badge", "Default"), { title: "ssh tries this key for hosts with no IdentityFile." })
            : make("span", "badge warn", "Not used"),
        );
      }
      if (!key.has_private) list.append(Object.assign(make("span", "badge warn", "No private key"), { title: "Only the .pub file is in ~/.ssh." }));
      if (key.has_private && !key.public) list.append(Object.assign(make("span", "badge", "No .pub file"), { title: "Read from the private key. Make the .pub file with: ssh-keygen -y -f <key>" }));
      users.append(list);
      const tools = make("td", "key-tools");
      if (key.public) {
        const copyButton = button("Copy public key", "", async () => {
          const done = await copy(key.public);
          store.notice(done ? `Copied the public key of ${key.name}. Paste it into the server's ~/.ssh/authorized_keys, or into GitHub.` : "Cannot copy here. Open the .pub file instead.", done ? "ok" : "error");
        });
        copyButton.title = key.public;
        tools.append(copyButton);
      }
      const row = make("tr");
      row.append(name, fingerprint, users, tools);
      table.append(row);
    }
    this.append(table);
  }

  // Name, comment and passphrase of a new Ed25519 key.
  #form() {
    const draft = store.keyForm;
    const form = make("form", "settings-section key-form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      store.generateKey();
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") store.closeKeyForm();
    });
    form.append(make("h2", "", "New Ed25519 key"));
    const field = (label, key, attrs, hint) => {
      const wrap = make("label", "field", label);
      const input = Object.assign(make("input"), { value: draft[key], spellcheck: false, autocomplete: "off" }, attrs);
      input.addEventListener("input", () => (draft[key] = input.value));
      wrap.append(input);
      if (hint) wrap.append(make("span", "hint", hint));
      return wrap;
    };
    form.append(
      field("File name", "name", { required: true, pattern: "[A-Za-z0-9_\\-][A-Za-z0-9._\\-]*" }, "In ~/.ssh. The public key goes in the same name with .pub."),
      field("Comment", "comment", { placeholder: "you@computer" }, "Shown next to the key, for example in GitHub. Optional."),
      field("Passphrase", "passphrase", { type: "password", autocomplete: "new-password" }, "Protects the key file. Empty means no passphrase."),
      field("Passphrase again", "confirm", { type: "password", autocomplete: "new-password" }),
    );
    const actions = make("div", "form-actions");
    const submit = make("button", "primary", "Make key");
    submit.type = "submit";
    actions.append(button("Cancel", "", () => store.closeKeyForm()), submit);
    form.append(actions);
    // Focus the name once, when the form opens, not on each redraw.
    if (!draft.focused) {
      draft.focused = true;
      queueMicrotask(() => form.querySelector("input")?.focus());
    }
    return form;
  }
}

customElements.define("keys-view", KeysView);
