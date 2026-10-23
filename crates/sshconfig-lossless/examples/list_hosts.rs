//! Print the hosts in an ssh_config file.
//!
//! cargo run --example list_hosts              # reads ~/.ssh/config
//! cargo run --example list_hosts -- my_config # reads another file

use sshconfig_lossless::SshConfig;
use std::{env, fs, path::PathBuf};

fn main() -> std::io::Result<()> {
    let path = match env::args().nth(1) {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(env::var("HOME").unwrap_or_default()).join(".ssh/config"),
    };
    let text = fs::read_to_string(&path)?;
    let config = SshConfig::parse(&text);

    println!("{:<28} {:<24} {:<10} KEY", "HOST", "HOSTNAME", "USER");
    for host in config.hosts() {
        println!(
            "{:<28} {:<24} {:<10} {}",
            host.pattern(),
            host.get("HostName").unwrap_or("-"),
            host.get("User").unwrap_or("-"),
            host.get("IdentityFile").unwrap_or("-"),
        );
    }

    let lossless = config.to_string() == text;
    println!("\nRound-trip exact: {lossless}");
    Ok(())
}
