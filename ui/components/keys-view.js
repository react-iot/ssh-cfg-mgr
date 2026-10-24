// <keys-view>: the keys in ~/.ssh and the hosts whose IdentityFile names
// them. Read-only. State is store.keys.
import { make, button, plural } from "../dom.js";
import { store } from "../store.js";

class KeysView extends HTMLElement {
  render() {
    this.replaceChildren(make("h1", "", "SSH keys"));
    this.append(make("p", "lead", "Keys in ~/.ssh with a .pub file, and the hosts whose IdentityFile names them. Choose a host to open it."));
    if (store.keys === null) return this.append(make("p", "empty", "Loading…"));
    const keys = store.keysWithUsers();
    if (!keys.length) return this.append(make("p", "empty", "No keys found in ~/.ssh."));

    const unused = keys.filter((k) => !k.users.length && !k.isDefault).length;
    if (unused) this.append(make("p", "hint", `${plural(unused, "key")} not named by any host.`));

    const table = make("table", "keys");
    const head = make("tr");
    for (const title of ["Key", "Type", "Fingerprint", "Used by"]) head.append(make("th", "", title));
    table.append(head);
    for (const key of keys) {
      const name = make("td");
      name.append(make("div", "", key.name), make("div", "sub", key.comment || key.path));
      const type = make("td", "", key.kind ? `${key.kind} ${key.bits}` : "Cannot read");
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
      users.append(list);
      const row = make("tr");
      row.append(name, type, fingerprint, users);
      table.append(row);
    }
    this.append(table);
  }
}

customElements.define("keys-view", KeysView);
