# SSH Cfg Mgr

A free, open-source desktop app for macOS and Linux that manages your
`~/.ssh/config` file and SSH keys. Made by ReactIoT.

**Status:** early development. The app shows your hosts. It cannot edit them yet.

![SSH Cfg Mgr showing a list of hosts](docs/screenshot.png)

## Goals

- Edit `~/.ssh/config` with a GUI **without changing anything you did not
  edit**: comments, order, indentation and line endings stay.
- Show all SSH keys, which hosts use them, and keys that no host uses.
- Check the config with OpenSSH (`ssh -G`) before every save, and keep a
  backup of every version.
- Keep everything on your computer. No account, no cloud, no telemetry.

## Project layout

| Path | Contents |
|---|---|
| `crates/sshconfig-lossless` | Rust library: reads and writes ssh_config files without loss |
| `src-tauri/` | Tauri 2 app: Rust commands that the UI calls |
| `ui/` | The UI: plain HTML, CSS and JavaScript, no build step |

## Build and test

You need:

- Rust (install it with [rustup](https://rustup.rs))
- Node.js, only for the Tauri command-line tool
- On Linux, the WebKitGTK libraries. On Ubuntu/Debian:
  ```sh
  sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
  ```
- On macOS, the Xcode command-line tools (`xcode-select --install`)

```sh
npm install                    # installs the Tauri CLI
npm run dev                    # start the app
npm run build                  # make an installer (.dmg, .deb, .AppImage, ...)

cargo test                     # run all tests
cargo clippy --all-targets     # lint
cargo run --example list_hosts # list the hosts in your ~/.ssh/config
```

The app and the `list_hosts` example only read your file. They do not
write to it. To open another file, set `SSH_CFG_MGR_CONFIG`:

```sh
SSH_CFG_MGR_CONFIG="$PWD/my_test_config" npm run dev
```

## Licence

Apache License 2.0. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Every commit needs a DCO sign-off
(`git commit -s`).
