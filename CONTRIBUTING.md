# Contributing to SSH Cfg Mgr

Thank you for your help.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
It is a short statement that you have the right to submit your contribution
under the project licence (Apache-2.0). There is no CLA to sign.

To agree, add a `Signed-off-by` line to each commit. Git adds it for you:

```sh
git commit -s -m "Fix parsing of tabs after keyword"
```

The line must use your real name and an email address that you can be
contacted at:

```
Signed-off-by: Your Name <you@example.com>
```

If you forgot to sign off, fix the last commit with `git commit --amend -s`,
or all commits on your branch with `git rebase --signoff main`.

## Before you open a pull request

```sh
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
```

## Rules for the config parser

The most important rule: **the parser must never lose data.**
`SshConfig::parse(text).to_string()` must be equal to `text` for every input.
Every change to the parser needs a round-trip test in
`crates/sshconfig-lossless/tests/roundtrip.rs`.

## Security problems

Do not open a public issue. See [SECURITY.md](SECURITY.md).
