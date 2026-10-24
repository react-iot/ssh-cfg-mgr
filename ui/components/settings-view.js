// <settings-view>: theme, how new groups are saved, and the backups folder.
// Preferences are store.prefs (local storage).
import { make, button, plural } from "../dom.js";
import { store, BACKUP_DIR, HISTORY_ID } from "../store.js";
import { clearHistoryButton } from "./history-view.js";

class SettingsView extends HTMLElement {
  render() {
    const prefs = store.prefs;
    this.replaceChildren(make("h1", "", "Settings"));

    // Appearance: follow the system, or force light or dark.
    const appearance = this.#section("Appearance");
    const themes = make("div", "toggle theme-toggle");
    themes.setAttribute("role", "radiogroup");
    themes.setAttribute("aria-label", "Theme");
    for (const [value, label] of [["system", "System"], ["light", "Light"], ["dark", "Dark"]]) {
      const option = button(label, "", () => {
        prefs.theme = value;
        store.savePrefs();
        store.applyTheme();
        store.emit();
      });
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", String(prefs.theme === value));
      themes.append(option);
    }
    appearance.append(themes, make("p", "hint", "System follows the light or dark setting of your computer."));

    // Groups: how a new group is written.
    const groups = this.#section("Groups");
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
        store.savePrefs();
      });
      const text = make("span", "text");
      text.append(make("span", "", label), make("span", "hint", hint));
      option.append(radio, text);
      field.append(option);
    }
    groups.append(field, make("p", "hint", "A block that already has a group keeps the way its group is stored."));

    // History: where backups are, and clearing them.
    const history = this.#section("History");
    const backups = store.history.backups;
    const count = backups === null ? "…" : plural(backups.length, "backup");
    const folder = store.config.path.replace(/[^/]*$/, BACKUP_DIR);
    history.append(make("p", "", `${count}. A backup is made before every save; the newest 50 are kept.`));
    history.append(make("code", "path-line", folder));
    const actions = make("div", "form-actions");
    actions.append(button("Open History", "", () => store.select(HISTORY_ID)), clearHistoryButton());
    history.append(actions);

    this.append(make("p", "hint", "Settings are kept on this computer, not in the config."));
  }

  // A titled settings section; returns its body.
  #section(title) {
    const box = make("section", "settings-section");
    box.append(make("h2", "", title));
    this.append(box);
    return box;
  }
}

customElements.define("settings-view", SettingsView);
