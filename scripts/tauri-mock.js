// A fake window.__TAURI__ for trying the UI in a browser (see preview.js).
// Keeps a small config in memory. Rules are rough copies of src-tauri:
// enough to click through the UI, not a test of the Rust side.
// window.__mock.externalEdit() changes the "file" as another program would.
(() => {
  const home = "/home/me";
  const block = (pattern, settings, extra = {}) => ({ kind: "Host", pattern, settings, group_comment: null, enabled: true, ...extra });
  const s = (keyword, value) => ({ keyword, value });
  const files = {
    main: {
      path: `${home}/.ssh/config`,
      global: [s("ServerAliveInterval", "30")],
      blocks: [
        block("web1", [s("HostName", "10.0.0.1"), s("User", "deploy"), s("Port", "22")], { group_comment: "Work" }),
        block("db1", [s("HostName", "10.0.0.2"), s("User", "admin"), s("LocalForward", "5432 localhost:5432")], { group_comment: "Work" }),
        block("pi", [s("HostName", "pi.local"), s("User", "pi"), s("IdentityFile", "~/.ssh/id_pi"), s("Compression", "yes")]),
        block("tagged", [s("HostName", "t.example.com"), s("Tag", "Lab")]),
        block("old", [s("HostName", "old.example.com")], { enabled: false }),
        { kind: "Match", pattern: "host *.internal", settings: [s("ProxyJump", "bastion")], group_comment: null, enabled: true },
      ],
      rev: 1,
    },
    inc: { path: "~/.ssh/config.d/extra", file: `${home}/.ssh/config.d/extra`, blocks: [block("extra1", [s("HostName", "e1"), s("User", "x")])], rev: 1, editable: true },
    ro: { path: "/etc/ssh/shared", file: "/etc/ssh/shared", blocks: [block("shared", [s("HostName", "shared.example.com")])], rev: 1, editable: false },
  };
  let includes = ["inc", "ro"];
  let backups = [];

  const raw = (b) => {
    const lines = [`${b.kind} ${b.pattern}`, ...b.settings.map((x) => `  ${x.keyword} ${x.value}`)];
    return (b.enabled ? lines : lines.map((l) => `#~${l}`)).join("\n");
  };
  const text = () =>
    [...includes.map((k) => `Include ${files[k].path}`), ...files.main.global.map((x) => `${x.keyword} ${x.value}`), "",
      ...files.main.blocks.map((b) => (b.group_comment ? `# group: ${b.group_comment}\n` : "") + raw(b) + "\n")].join("\n");
  const view = (b) => ({ ...b, raw: raw(b) });
  const config = () => ({
    path: files.main.path,
    exists: true,
    revision: `r${files.main.rev}`,
    global: files.main.global,
    blocks: files.main.blocks.map(view),
    lossless: true,
    home,
    text: text(),
    included: includes.map((k, line) => ({
      path: files[k].path, file: files[k].file, editable: files[k].editable, revision: `r${files[k].rev}`,
      pattern: files[k].path, from: "~/.ssh/config", condition: null, line, error: null, blocks: files[k].blocks.map(view),
    })),
  });
  const fileOf = (file) => (file ? files[includes.find((k) => files[k].file === file)] : files.main);
  const change = (file, revision, fn) => {
    const f = fileOf(file);
    if (revision !== `r${f.rev}`) throw "The file changed on disk after you opened it. Nothing was saved. Reload, then make your change again.";
    const name = `config.${Date.now()}`;
    backups.unshift({ name, time: Date.now() / 1000, size: text().length, text: text() });
    const selected = fn(f);
    f.rev++;
    return { config: config(), backup: name, selected: selected ?? null };
  };

  const commands = {
    load_config: () => config(),
    save_block: ({ revision, index, file, pattern, settings, group, groupMode }) =>
      change(file, revision, (f) => {
        settings = settings.filter((x) => x.keyword.toLowerCase() !== "tag" || groupMode !== "tag");
        if (groupMode === "tag" && group) settings.push(s("Tag", group));
        const old = index === null ? block(pattern, []) : f.blocks[index];
        const b = { ...old, pattern, settings, group_comment: groupMode === "comment" ? group || null : old.group_comment };
        if (index === null) return f.blocks.push(b) - 1;
        f.blocks[index] = b;
        return index;
      }),
    delete_block: ({ revision, file, index }) => change(file, revision, (f) => void f.blocks.splice(index, 1)),
    save_block_raw: ({ revision, file, index, text: t }) =>
      change(file, revision, (f) => {
        const [head, ...rest] = t.trim().split("\n");
        const [kind, ...pattern] = head.trim().split(/\s+/);
        f.blocks[index] = { ...f.blocks[index], kind, pattern: pattern.join(" "), settings: rest.map((l) => l.trim().split(/\s+/)).map(([k, ...v]) => s(k, v.join(" "))) };
        return index;
      }),
    move_global_line: ({ revision, from, to }) => change(null, revision, () => void includes.splice(to, 0, ...includes.splice(from, 1))),
    move_block: ({ revision, from, to }) => change(null, revision, (f) => (f.blocks.splice(to, 0, ...f.blocks.splice(from, 1)), to)),
    set_block_enabled: ({ revision, file, index, enabled }) => change(file, revision, (f) => void (f.blocks[index].enabled = enabled)),
    list_keys: () => [
      { path: `${home}/.ssh/id_ed25519`, has_private: true, kind: "ED25519", bits: 256, fingerprint: "SHA256:Qm9vdGhlZGVtb2tleWZvcnByZXZpZXdvbmx5", comment: "me@laptop" },
      { path: `${home}/.ssh/id_pi`, has_private: true, kind: "ED25519", bits: 256, fingerprint: "SHA256:cGlrZXlmb3JkZW1vb25seW5vdHJlYWw", comment: "pi" },
      { path: `${home}/.ssh/old_rsa`, has_private: true, kind: "RSA", bits: 2048, fingerprint: "SHA256:b2xkcnNha2V5bm90dXNlZGFueXdoZXJl", comment: "old work key" },
      { path: `${home}/.ssh/github`, has_private: false, kind: "ED25519", bits: 256, fingerprint: "SHA256:Z2l0aHVicHVibGljb25seWtleQ", comment: "" },
    ],
    list_backups: () => backups.map(({ name, time, size }) => ({ name, time, size })),
    read_backup: ({ name }) => backups.find((b) => b.name === name).text,
    clear_backups: () => backups.splice(0).length,
    restore_backup: () => ({ config: config(), backup: null, selected: null }),
    "plugin:dialog|open": () => `${home}/.ssh/id_picked`,
  };

  const listeners = {};
  window.__mock = {
    calls: [],
    theme: null,
    externalEdit() {
      files.main.blocks[0].settings[0].value = "10.9.9.9";
      files.main.rev++;
    },
    emit: (name) => listeners[name]?.forEach((fn) => fn({ payload: null })),
  };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        window.__mock.calls.push([cmd, args]);
        await new Promise((r) => setTimeout(r, 10));
        if (!commands[cmd]) throw `mock: no command ${cmd}`;
        return structuredClone(commands[cmd](structuredClone(args)));
      },
    },
    window: { getCurrentWindow: () => ({ setTheme: async (t) => void (window.__mock.theme = t) }) },
    app: { getVersion: async () => "0.0.0-mock" },
    event: { listen: async (name, fn) => (listeners[name] ??= []).push(fn) },
  };
})();
