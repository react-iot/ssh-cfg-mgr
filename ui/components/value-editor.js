// <value-editor>: an input for one value, of the right kind for the
// keyword, with a tick and a cross. Only the tick (or Enter) saves; the
// cross (or Escape) cancels.
//
//   const editor = ValueEditor.create(keyword, current);
//   editor.addEventListener("value-save", (e) => e.detail.value);
//   editor.addEventListener("value-cancel", ...);
//
// editor.input is the element to focus.
import { make, button, iconButton, emit, TICK, CROSS, FOLDER, WRENCH } from "../dom.js";
import { store } from "../store.js";
import { openBuilder } from "./builder-dialog.js";

// Suggestions for the keyword field. Any keyword that OpenSSH knows works.
export const KEYWORDS = [
  "HostName", "User", "Port", "IdentityFile", "IdentitiesOnly", "IdentityAgent",
  "ProxyJump", "ProxyCommand", "ForwardAgent", "AddKeysToAgent", "UseKeychain",
  "LocalForward", "RemoteForward", "DynamicForward", "ServerAliveInterval",
  "ServerAliveCountMax", "ConnectTimeout", "StrictHostKeyChecking",
  "UserKnownHostsFile", "HostKeyAlias", "CertificateFile", "ControlMaster",
  "ControlPath", "ControlPersist", "Compression", "RequestTTY", "RemoteCommand",
  "SetEnv", "SendEnv", "LogLevel", "PreferredAuthentications", "PubkeyAuthentication",
  "TCPKeepAlive", "ConnectionAttempts", "ForwardX11", "BatchMode", "CheckHostIP",
  "HashKnownHosts", "PasswordAuthentication", "ExitOnForwardFailure", "VisualHostKey",
  "UpdateHostKeys",
];

// The values each keyword takes, from man ssh_config (OpenSSH 10.3).
// choices: only these. suggest: these, or any other text (a time or a path).
// Keywords not listed take any text.
const YES_NO = ["yes", "no"];
export const VALUE_TYPES = {
  compression: { choices: YES_NO },
  identitiesonly: { choices: YES_NO },
  forwardx11: { choices: YES_NO },
  batchmode: { choices: YES_NO },
  checkhostip: { choices: YES_NO },
  hashknownhosts: { choices: YES_NO },
  passwordauthentication: { choices: YES_NO },
  exitonforwardfailure: { choices: YES_NO },
  tcpkeepalive: { choices: YES_NO },
  // Not in the man page, but OpenSSH reads it as TCPKeepAlive (ssh -G).
  keepalive: { choices: YES_NO },
  usekeychain: { choices: YES_NO },
  visualhostkey: { choices: YES_NO },
  updatehostkeys: { choices: ["yes", "no", "ask"] },
  controlmaster: { choices: ["yes", "no", "ask", "auto", "autoask"] },
  loglevel: { choices: ["QUIET", "FATAL", "ERROR", "INFO", "VERBOSE", "DEBUG", "DEBUG1", "DEBUG2", "DEBUG3"] },
  pubkeyauthentication: { choices: ["yes", "no", "unbound", "host-bound"] },
  requesttty: { choices: ["no", "yes", "force", "auto"] },
  stricthostkeychecking: { choices: ["yes", "accept-new", "no", "off", "ask"] },
  addkeystoagent: { suggest: ["no", "yes", "confirm", "ask"] },
  forwardagent: { suggest: YES_NO },
  controlpersist: { suggest: YES_NO },
  port: { min: 1, max: 65535 },
  serveraliveinterval: { min: 0 },
  serveralivecountmax: { min: 0 },
  connecttimeout: { min: 0 },
  connectionattempts: { min: 1 },
};

// Keywords whose value is a file. A socket or a path with %tokens is
// typed by hand.
export const PATH_KEYWORDS = new Set(["identityfile", "certificatefile", "userknownhostsfile", "globalknownhostsfile"]);

export class ValueEditor extends HTMLElement {
  static create(keyword, current) {
    const node = document.createElement("value-editor");
    node.#build(keyword, current);
    return node;
  }

  #build(keyword, current) {
    this.className = "value-line";
    const type = VALUE_TYPES[keyword.toLowerCase()] ?? {};
    // A few fixed choices are buttons; a longer list (LogLevel) is a select.
    // A value from the file that is not a choice keeps the select, so it shows.
    const toggle = type.choices?.length <= 5 && (!current || type.choices.includes(current));
    let input;
    let focusTarget;
    if (toggle) {
      // Joined buttons. input.value holds the choice, like a field.
      input = make("div", "toggle");
      input.setAttribute("role", "radiogroup");
      input.value = current;
      for (const choice of type.choices) {
        const option = button(choice, "", () => {
          input.value = choice;
          for (const b of input.children) b.setAttribute("aria-checked", String(b === option));
        });
        option.setAttribute("role", "radio");
        option.setAttribute("aria-checked", String(choice === current));
        input.append(option);
      }
      focusTarget = [...input.children].find((b) => b.getAttribute("aria-checked") === "true") ?? input.firstChild;
    } else if (type.choices) {
      input = make("select");
      // Keep a value that is in the file but not in the list.
      const choices = type.choices.includes(current) || !current ? type.choices : [current, ...type.choices];
      if (!current) input.append(Object.assign(make("option", "", "Choose…"), { value: "" }));
      for (const choice of choices) input.append(Object.assign(make("option", "", choice), { value: choice }));
      input.value = current;
    } else {
      input = make("input", "mono");
      input.value = current;
      input.spellcheck = false;
      if ("min" in type) {
        input.type = "number";
        input.min = type.min;
        if (type.max) input.max = type.max;
      }
      if (type.suggest) {
        const id = `suggest-${keyword.toLowerCase()}`;
        if (!document.getElementById(id)) {
          const list = make("datalist");
          list.id = id;
          for (const s of type.suggest) list.append(Object.assign(make("option"), { value: s }));
          document.body.append(list);
        }
        input.setAttribute("list", id);
      }
    }
    input.classList.add("value-editor");
    input.setAttribute("aria-label", `Value for ${keyword || "new keyword"}`);

    const cancel = () => emit(this, "value-cancel");
    const done = () => {
      if (input.reportValidity && !input.reportValidity()) return;
      if (input.value.trim()) emit(this, "value-save", { value: input.value.trim() });
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        cancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        done();
      }
    });

    // Tick and cross as one joined control, after a builder button if the
    // keyword's value has several parts.
    const pair = make("div", "segmented confirm");
    if (PATH_KEYWORDS.has(keyword.toLowerCase())) {
      pair.append(
        iconButton(FOLDER, `Choose a file for ${keyword}`, async () => {
          const picked = await store.pickFile(keyword, input.value);
          if (picked) {
            input.value = picked;
            input.focus();
          }
        }),
      );
    }
    const builder = BUILDERS[keyword.toLowerCase()];
    if (builder) {
      pair.append(
        iconButton(WRENCH, `Build the ${keyword} value`, () =>
          openBuilder(keyword, builder, input.value, (built) => {
            input.value = built;
            input.focus();
          }),
        ),
      );
    }
    const tick = iconButton(TICK, `Save ${keyword}`, done);
    tick.classList.add("primary");
    pair.append(tick, iconButton(CROSS, "Cancel", cancel));
    this.append(input, pair);
    this.input = focusTarget ?? input;
  }
}

customElements.define("value-editor", ValueEditor);
