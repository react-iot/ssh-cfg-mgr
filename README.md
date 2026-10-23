# SSH Cfg Mgr

A free, open-source desktop app for macOS and Linux that manages your
`~/.ssh/config` file and SSH keys. Made by ReactIoT.

**Status:** early development. Only the config parser exists now.

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
| `src-tauri/`, `ui/` | Tauri 2 desktop app (not started) |

## Build and test

You need Rust (install it with [rustup](https://rustup.rs)).

```sh
cargo test                     # run all tests
cargo clippy --all-targets     # lint
cargo run --example list_hosts # list the hosts in your ~/.ssh/config
```

The `list_hosts` example only reads your file. It does not write to it.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Every commit needs a DCO sign-off
(`git commit -s`).
