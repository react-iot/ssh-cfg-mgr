// <history-view>: backups made on each save, and what restoring one would
// change. State is store.history.
import { make, button, plural } from "../dom.js";
import { store } from "../store.js";

const CONTEXT_LINES = 3;

// Two clicks: the first asks, the second deletes every backup. Also in
// <settings-view>.
export function clearHistoryButton() {
  const confirming = store.confirmingClear;
  const node = button(confirming ? "Click again to delete all backups" : "Clear history", confirming ? "danger" : "", () => store.clearHistory());
  node.disabled = !store.history.backups?.length;
  return node;
}

class HistoryView extends HTMLElement {
  render() {
    const history = store.history;
    this.replaceChildren();
    const head = make("div", "detail-head");
    const actions = make("div", "actions");
    actions.append(clearHistoryButton());
    head.append(make("h1", "", "History"), actions);
    this.append(head);
    this.append(make("p", "lead", "A backup is made before every save. The newest 50 are kept. Choose one to see what restoring it would change."));
    if (history.backups === null) return this.append(make("p", "empty", "Loading…"));
    if (!history.backups.length) return this.append(make("p", "empty", "No backups yet. One is made the first time you save."));

    const layout = make("div", "history");
    const list = make("ul", "history-list");
    for (const backup of history.backups) {
      const item = button("", backup.name === history.name ? "selected" : "", () => store.showBackup(backup.name));
      item.append(make("span", "", new Date(backup.time * 1000).toLocaleString()), make("span", "sub", `${(backup.size / 1024).toFixed(1)} KB`));
      const li = make("li");
      li.append(item);
      list.append(li);
    }

    const pane = make("div", "history-pane");
    if (history.text !== null) {
      const diff = lineDiff(store.config.text, history.text);
      const changed = diff.filter((l) => l.op !== " ").length;
      const top = make("div", "history-head");
      top.append(make("span", "", changed ? `Restoring changes ${plural(changed, "line")}:` : "This backup is the same as the current file."));
      if (changed) {
        const restore = button(history.confirming ? "Click again to restore" : "Restore this version", history.confirming ? "danger" : "primary", () => {
          if (history.confirming) store.restoreBackup(history.name);
          else {
            history.confirming = true;
            this.render();
          }
        });
        top.append(restore);
      }
      pane.append(top);
      if (changed) pane.append(diffView(diff));
    }
    layout.append(list, pane);
    this.append(layout);
  }
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

customElements.define("history-view", HistoryView);
