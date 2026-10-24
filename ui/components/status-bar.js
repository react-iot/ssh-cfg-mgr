// <status-bar>: host count, config path, round-trip badge and file-watch
// state. Its parts are in index.html, inside the element. Listens to
// `store` and to `host-count` from <host-list>.
import { store } from "../store.js";

class StatusBar extends HTMLElement {
  connectedCallback() {
    const $ = (selector) => this.querySelector(selector);
    document.addEventListener("host-count", (event) => ($(".count").textContent = event.detail.text));
    store.addEventListener("change", () => {
      const config = store.config;
      if (!config) return;
      $(".path").textContent = config.path;
      const badge = $(".badge");
      badge.hidden = false;
      badge.className = config.lossless ? "badge" : "badge warn";
      badge.textContent = config.lossless ? "Round-trip OK" : "Round-trip mismatch";
    });
    store.addEventListener("sync", ({ detail }) => {
      const sync = $(".sync");
      sync.textContent = detail.label;
      sync.title = detail.detail;
      sync.className = `sync ${detail.kind}`;
    });
  }
}

customElements.define("status-bar", StatusBar);
