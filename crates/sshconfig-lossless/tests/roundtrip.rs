use sshconfig_lossless::SshConfig;

const SAMPLE: &str = "\
# Global settings
Include ~/.ssh/config.d/*
AddKeysToAgent yes

# ReactIoT gateways
Host gw-* !gw-test
\tUser root
\tIdentityFile \"~/.ssh/riot gw\"

Host edge
  HostName=10.0.0.5
  Port = 2222
  ProxyJump gw-01 \x20 

Match host *.internal exec \"test -f ~/.vpn\"
    ForwardAgent no
Host *
    ServerAliveInterval 30";

#[test]
fn roundtrip_is_exact() {
    assert_eq!(SshConfig::parse(SAMPLE).to_string(), SAMPLE);
}

#[test]
fn roundtrip_keeps_crlf() {
    let text = "Host a\r\n  User x\r\n\r\n# end\r\n";
    assert_eq!(SshConfig::parse(text).to_string(), text);
}

#[test]
fn roundtrip_empty_and_odd_input() {
    for text in ["", "\n", "   \n\t\n", "Host", "Host=", "  # only a comment"] {
        assert_eq!(SshConfig::parse(text).to_string(), text, "input: {text:?}");
    }
}

#[test]
fn reads_hosts_and_values() {
    let config = SshConfig::parse(SAMPLE);

    let patterns: Vec<_> = config.hosts().map(|b| b.pattern()).collect();
    assert_eq!(patterns, vec!["gw-* !gw-test", "edge", "*"]);
    assert_eq!(config.blocks().len(), 4, "Match block is also a block");

    let edge = config.host("edge").unwrap();
    assert_eq!(edge.get("hostname"), Some("10.0.0.5"));
    assert_eq!(edge.get("Port"), Some("2222"));
    assert_eq!(edge.get("ProxyJump"), Some("gw-01"));

    let gw = config.host("gw-* !gw-test").unwrap();
    assert_eq!(gw.patterns(), vec!["gw-*", "!gw-test"]);
    let key = gw.directives().find(|d| d.is("IdentityFile")).unwrap();
    assert_eq!(key.args(), vec!["~/.ssh/riot gw"]);

    let global: Vec<_> = config.global_directives().map(|d| d.keyword()).collect();
    assert_eq!(global, vec!["Include", "AddKeysToAgent"]);
}

#[test]
fn set_existing_changes_only_the_value() {
    let mut config = SshConfig::parse(SAMPLE);
    config.host_mut("edge").unwrap().set("port", "22");

    let expected = SAMPLE.replace("  Port = 2222\n", "  Port = 22\n");
    assert_eq!(config.to_string(), expected);
}

#[test]
fn set_new_uses_block_indent_and_goes_before_blank_line() {
    let mut config = SshConfig::parse(SAMPLE);
    config
        .host_mut("gw-* !gw-test")
        .unwrap()
        .set("Port", "8022");

    let expected = SAMPLE.replace(
        "\tIdentityFile \"~/.ssh/riot gw\"\n\n",
        "\tIdentityFile \"~/.ssh/riot gw\"\n\tPort 8022\n\n",
    );
    assert_eq!(config.to_string(), expected);
}

#[test]
fn set_new_on_last_line_without_newline() {
    let mut config = SshConfig::parse(SAMPLE);
    config.host_mut("*").unwrap().set("User", "steve");

    let expected = format!("{SAMPLE}\n    User steve");
    assert_eq!(config.to_string(), expected);
}

#[test]
fn remove_directive() {
    let mut config = SshConfig::parse(SAMPLE);
    assert_eq!(config.host_mut("edge").unwrap().remove("ProxyJump"), 1);

    let expected = SAMPLE.replace("  ProxyJump gw-01   \n", "");
    assert_ne!(expected, SAMPLE, "test data must contain the line");
    assert_eq!(config.to_string(), expected);
}

#[test]
fn add_and_remove_host() {
    let mut config = SshConfig::parse(SAMPLE);
    let block = config.add_host("lte-gw");
    block.set("HostName", "192.168.8.1");
    block.set("User", "admin");

    let expected = format!("{SAMPLE}\n\nHost lte-gw\n    HostName 192.168.8.1\n    User admin\n");
    assert_eq!(config.to_string(), expected);

    assert!(config.remove_host("edge"));
    assert!(config.host("edge").is_none());
    assert!(!config.remove_host("edge"));
}

#[test]
fn add_host_to_empty_file() {
    let mut config = SshConfig::parse("");
    config.add_host("a").set("User", "x");
    assert_eq!(config.to_string(), "Host a\n    User x\n");
}
