// <about-dialog>: opened from the app menu ("show-about" from Rust).
// Links with target="_blank" open in the browser (opener plugin).
import { make } from "../dom.js";

const ABOUT_LINKS = [
  ["Website", "https://reactiot.com.au"],
  ["Source code", "https://github.com/react-iot/ssh-cfg-mgr"],
  ["Report an issue", "https://github.com/react-iot/ssh-cfg-mgr/issues"],
  ["License (Apache-2.0)", "https://github.com/react-iot/ssh-cfg-mgr/blob/main/LICENSE"],
];

export async function showAbout() {
  if (document.querySelector("dialog.about")) return;
  const version = (await window.__TAURI__.app?.getVersion().catch(() => "")) ?? "";
  const node = document.createElement("about-dialog");
  document.body.append(node);
  node.open(version);
}

class AboutDialog extends HTMLElement {
  open(version) {
    const dialog = make("dialog", "about");
    const logo = Object.assign(make("img"), { src: "assets/app-icon.svg", alt: "" });
    const links = make("ul", "about-links");
    for (const [label, href] of ABOUT_LINKS) {
      const item = make("li");
      item.append(Object.assign(make("a", "", label), { href, target: "_blank", rel: "noopener" }));
      links.append(item);
    }
    const form = make("form");
    form.method = "dialog";
    const close = make("button", "primary", "Close");
    form.append(close);
    dialog.append(
      logo,
      make("h2", "", "SSH Config Manager"),
      make("p", "about-version", version ? `Version ${version}` : ""),
      make("p", "about-text", "Manage ~/.ssh/config without losing comments or formatting. Every save is checked with ssh -G, and a backup is kept."),
      links,
      make("p", "about-copy", "© 2026 ReactIoT"),
      form,
    );
    dialog.addEventListener("close", () => this.remove());
    this.append(dialog);
    dialog.showModal();
    close.focus();
  }
}

customElements.define("about-dialog", AboutDialog);
