// Value builders for keywords whose value has several parts. Each builder
// turns a value into fields (parse) and fields back into a value (build).
// Syntax is from man ssh_config (OpenSSH 10.3). build returns null while a
// required field is empty or wrong.
//
// A builder is { title, help, fields, list?, parse(value), build(items) }.
// list: the value is a list of items, each with the same fields.
// ponytail: TCP ports only; a Unix socket path (with "/") is typed in the
// field directly, add a socket mode here if people ask for it.

// IPv6 addresses go in square brackets.
const bracket = (host) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);
const unbracket = (host) => host.replace(/^\[(.*)\]$/, "$1");
const isPort = (p) => /^\d+$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;

// "host:port" or "[v6]:port" -> { host, port }. port may be missing.
function splitHostPort(text) {
  const v6 = text.match(/^\[([^\]]*)\](?::(\d*))?$/);
  if (v6) return { host: v6[1], port: v6[2] ?? "" };
  const i = text.lastIndexOf(":");
  return i < 0 ? { host: text, port: "" } : { host: text.slice(0, i), port: text.slice(i + 1) };
}

// "[bind_address:]port" -> { bind, port }
function splitListen(text = "") {
  const { host, port } = splitHostPort(text);
  return port || text.includes(":") ? { bind: host, port } : { bind: "", port: host };
}

const listen = (bind, port) => (bind ? `${bracket(bind)}:${port}` : port);

const BIND = { key: "bind", label: "Bind address", placeholder: "localhost (optional)", optional: true };

const BUILDERS = {
  localforward: {
    title: "Local forward",
    help: "A port on this computer that goes to a host and port reached from the server.",
    fields: [
      BIND,
      { key: "port", label: "Local port", placeholder: "9443", number: true },
      { key: "host", label: "Remote host", placeholder: "127.0.0.1" },
      { key: "hostport", label: "Remote port", placeholder: "9443", number: true },
    ],
    parse(value) {
      const [from = "", to = ""] = value.trim().split(/\s+/);
      const dest = splitHostPort(to);
      return [{ ...splitListen(from), host: unbracket(dest.host), hostport: dest.port }];
    },
    build([f]) {
      if (!isPort(f.port) || !f.host || !isPort(f.hostport)) return null;
      return `${listen(f.bind, f.port)} ${bracket(f.host)}:${f.hostport}`;
    },
  },

  remoteforward: {
    title: "Remote forward",
    help: "A port on the server that comes back to a host and port reached from this computer. With no destination, the port is a SOCKS proxy.",
    fields: [
      BIND,
      { key: "port", label: "Remote port", placeholder: "8080", number: true },
      { key: "host", label: "Destination host", placeholder: "localhost (empty: SOCKS proxy)", optional: true },
      { key: "hostport", label: "Destination port", placeholder: "80", number: true, optional: true },
    ],
    parse(value) {
      const [from = "", to = ""] = value.trim().split(/\s+/);
      const dest = to ? splitHostPort(to) : { host: "", port: "" };
      return [{ ...splitListen(from), host: unbracket(dest.host), hostport: dest.port }];
    },
    build([f]) {
      if (!isPort(f.port)) return null;
      if (!f.host && !f.hostport) return listen(f.bind, f.port);
      if (!f.host || !isPort(f.hostport)) return null;
      return `${listen(f.bind, f.port)} ${bracket(f.host)}:${f.hostport}`;
    },
  },

  dynamicforward: {
    title: "Dynamic forward (SOCKS)",
    help: "A SOCKS proxy on this computer. Programs that use it connect out from the server.",
    fields: [BIND, { key: "port", label: "Local port", placeholder: "1080", number: true }],
    parse: (value) => [splitListen(value.trim())],
    build: ([f]) => (isPort(f.port) ? listen(f.bind, f.port) : null),
  },

  proxyjump: {
    title: "Jump hosts",
    help: "ssh connects through these hosts, in this order.",
    list: true,
    fields: [
      { key: "user", label: "User", placeholder: "optional", optional: true },
      { key: "host", label: "Host", placeholder: "bastion.example.com" },
      { key: "port", label: "Port", placeholder: "22", number: true, optional: true },
    ],
    parse(value) {
      return value
        .split(",")
        .map((hop) => hop.trim())
        .filter(Boolean)
        .map((hop) => {
          const at = hop.lastIndexOf("@");
          const { host, port } = splitHostPort(hop.slice(at + 1));
          return { user: at < 0 ? "" : hop.slice(0, at), host: unbracket(host), port };
        });
    },
    build(hops) {
      if (!hops.length || hops.some((h) => !h.host || (h.port && !isPort(h.port)))) return null;
      return hops
        .map((h) => `${h.user ? `${h.user}@` : ""}${bracket(h.host)}${h.port ? `:${h.port}` : ""}`)
        .join(",");
    },
  },

  preferredauthentications: {
    title: "Authentication order",
    help: "ssh tries these methods in this order.",
    list: true,
    fields: [
      {
        key: "method",
        label: "Method",
        choices: ["publickey", "keyboard-interactive", "password", "hostbased", "gssapi-with-mic"],
      },
    ],
    parse: (value) => value.split(",").map((m) => m.trim()).filter(Boolean).map((method) => ({ method })),
    build: (items) => (items.length && items.every((i) => i.method) ? items.map((i) => i.method).join(",") : null),
  },

  setenv: {
    title: "Environment variables",
    help: "Sent to the server as NAME=VALUE. The server must accept them.",
    list: true,
    fields: [
      { key: "name", label: "Name", placeholder: "LANG" },
      { key: "value", label: "Value", placeholder: "en_US.UTF-8", optional: true },
    ],
    parse(value) {
      const words = [...value.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
      return words.map((word) => {
        const i = word.indexOf("=");
        return i < 0 ? { name: word, value: "" } : { name: word.slice(0, i), value: word.slice(i + 1) };
      });
    },
    build(vars) {
      if (!vars.length || vars.some((v) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name))) return null;
      // A value with a space must be quoted, or ssh splits it.
      return vars.map((v) => (/[\s"]/.test(v.value) ? `"${v.name}=${v.value}"` : `${v.name}=${v.value}`)).join(" ");
    },
  },
};

// For the Node check script; the browser just uses the global.
if (typeof module !== "undefined") module.exports = BUILDERS;
