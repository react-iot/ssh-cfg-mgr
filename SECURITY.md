# Security policy

SSH Config Manager reads and writes files in `~/.ssh`. We take security problems
seriously.

## Report a problem

Do **not** open a public GitHub issue for a security problem.

Use GitHub's private vulnerability reporting: open the **Security** tab of
this repository and click **Report a vulnerability**.

Tell us:
- What the problem is, and what an attacker can do with it.
- The steps to reproduce it.
- The version or commit you tested.

We will reply within 7 days.

## Design rules

- The app never sends private keys or config files over the network.
- The app uses the OpenSSH tools (`ssh`, `ssh-keygen`, `ssh-add`) for all
  cryptography. It does not implement cryptography itself.
- The app makes a backup before it writes to any file in `~/.ssh`.
