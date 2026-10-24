// Run: node scripts/preview.js   then open http://localhost:1421
// Serves ui/ with a fake Tauri API (tauri-mock.js), to try the UI in a
// browser without building the app. Nothing here ships with the app.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const UI = path.join(__dirname, "..", "ui");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const PORT = Number(process.env.PORT) || 1421;

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x").pathname;
    if (url === "/tauri-mock.js") {
      res.writeHead(200, { "content-type": TYPES[".js"] });
      return res.end(fs.readFileSync(path.join(__dirname, "tauri-mock.js")));
    }
    const file = path.join(UI, url === "/" ? "index.html" : url);
    if (!file.startsWith(UI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    let body = fs.readFileSync(file);
    // The mock must exist before the app's scripts run.
    if (file.endsWith(".html")) body = String(body).replace("<head>", '<head>\n    <script src="tauri-mock.js"></script>');
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}`));
