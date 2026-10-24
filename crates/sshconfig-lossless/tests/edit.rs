use sshconfig_lossless::SshConfig;

const SAMPLE: &str = "\
AddKeysToAgent yes

# Gateways
Host gw
    User root
    IdentityFile ~/.ssh/a
    IdentityFile ~/.ssh/b

Host edge
    HostName 10.0.0.5

# Defaults for all hosts
Host *
    ServerAliveInterval 30
";

fn parse() -> SshConfig {
    SshConfig::parse(SAMPLE)
}

#[test]
fn set_pattern_changes_only_the_header_value() {
    let mut config = parse();
    config.block_mut(1).unwrap().set_pattern("edge edge.local");
    assert_eq!(
        config.to_string(),
        SAMPLE.replace("Host edge\n", "Host edge edge.local\n")
    );
}

#[test]
fn set_all_changes_in_place() {
    let mut config = parse();
    config
        .host_mut("gw")
        .unwrap()
        .set_all("identityfile", &["~/.ssh/x", "~/.ssh/y"]);
    let expected = SAMPLE
        .replace("~/.ssh/a", "~/.ssh/x")
        .replace("~/.ssh/b", "~/.ssh/y");
    assert_eq!(config.to_string(), expected);
}

#[test]
fn set_all_removes_extra_lines() {
    let mut config = parse();
    config
        .host_mut("gw")
        .unwrap()
        .set_all("IdentityFile", &["~/.ssh/a"]);
    assert_eq!(
        config.to_string(),
        SAMPLE.replace("    IdentityFile ~/.ssh/b\n", "")
    );
}

#[test]
fn set_all_adds_after_last_line_with_same_keyword() {
    let mut config = parse();
    let gw = config.host_mut("gw").unwrap();
    gw.set_all("IdentityFile", &["~/.ssh/a", "~/.ssh/b", "~/.ssh/c"]);
    assert_eq!(
        config.to_string(),
        SAMPLE.replace(
            "    IdentityFile ~/.ssh/b\n",
            "    IdentityFile ~/.ssh/b\n    IdentityFile ~/.ssh/c\n"
        )
    );
}

#[test]
fn set_all_empty_removes_keyword() {
    let mut config = parse();
    config.host_mut("gw").unwrap().set_all("IdentityFile", &[]);
    assert_eq!(
        config.to_string(),
        SAMPLE.replace("    IdentityFile ~/.ssh/a\n    IdentityFile ~/.ssh/b\n", "")
    );
}

#[test]
fn remove_last_line_keeps_missing_final_newline() {
    let text = "Host a\n    User x\n    Port 22";
    let mut config = SshConfig::parse(text);
    config.host_mut("a").unwrap().remove("Port");
    assert_eq!(config.to_string(), "Host a\n    User x");
}

#[test]
fn insert_host_before_catch_all_keeps_its_comment() {
    let mut config = parse();
    let star = config
        .blocks()
        .iter()
        .position(|b| b.pattern() == "*")
        .unwrap();
    let block = config.insert_host(star, "lte-gw");
    block.set("HostName", "192.168.8.1");

    let expected = SAMPLE.replace(
        "# Defaults for all hosts\n",
        "Host lte-gw\n    HostName 192.168.8.1\n\n# Defaults for all hosts\n",
    );
    assert_eq!(config.to_string(), expected);
}

#[test]
fn insert_host_first() {
    let mut config = SshConfig::parse("Host a\n    User x\n");
    config.insert_host(0, "b").set("User", "y");
    assert_eq!(
        config.to_string(),
        "Host b\n    User y\n\nHost a\n    User x\n"
    );
}

#[test]
fn insert_host_uses_crlf_if_the_file_does() {
    let mut config = SshConfig::parse("Host a\r\n    User x\r\n");
    config.add_host("b").set("User", "y");
    assert_eq!(
        config.to_string(),
        "Host a\r\n    User x\r\n\r\nHost b\r\n    User y\r\n"
    );
}

#[test]
fn remove_block_takes_its_comment_and_keeps_the_next_one() {
    let mut config = parse();
    config.remove_block(0).unwrap();
    let expected = SAMPLE.replace(
        "# Gateways\nHost gw\n    User root\n    IdentityFile ~/.ssh/a\n    IdentityFile ~/.ssh/b\n\n",
        "",
    );
    assert_eq!(config.to_string(), expected);

    // `edge` is now block 0. Its body ends with the comment for `Host *`.
    config.remove_block(0).unwrap();
    assert_eq!(
        config.to_string(),
        "AddKeysToAgent yes\n\n# Defaults for all hosts\nHost *\n    ServerAliveInterval 30\n"
    );
}

#[test]
fn remove_last_block_keeps_missing_final_newline() {
    let mut config = SshConfig::parse("Host a\n    User x\n\nHost b\n    User y");
    config.remove_block(1).unwrap();
    assert_eq!(config.to_string(), "Host a\n    User x\n");
    // The blank line was the end of block a. It had a newline before, so
    // the file still ends with one.

    let mut config = SshConfig::parse("Host a\n    User x\nHost b\n    User y");
    config.remove_block(1).unwrap();
    assert_eq!(config.to_string(), "Host a\n    User x");
}

#[test]
fn remove_block_out_of_range() {
    assert!(parse().remove_block(9).is_none());
}

fn is_group(text: &str) -> bool {
    text.starts_with("# group:")
}

#[test]
fn comments_above_are_the_comments_that_move_with_the_block() {
    let config = parse();
    assert_eq!(config.comments_above(0), ["# Gateways"]);
    assert!(config.comments_above(1).is_empty());
    assert_eq!(config.comments_above(2), ["# Defaults for all hosts"]);
    assert!(config.comments_above(3).is_empty());
}

#[test]
fn set_comment_above_adds_replaces_and_removes() {
    let mut config = parse();

    assert!(config.set_comment_above(1, is_group, Some("# group: Edge")));
    let added = SAMPLE.replace("\nHost edge\n", "\n# group: Edge\nHost edge\n");
    assert_eq!(config.to_string(), added);
    assert_eq!(config.comments_above(1), ["# group: Edge"]);

    config.set_comment_above(1, is_group, Some("# group: Prod"));
    assert_eq!(config.to_string(), added.replace("Edge", "Prod"));

    config.set_comment_above(1, is_group, None);
    assert_eq!(config.to_string(), SAMPLE);

    // Other comments above the block stay.
    config.set_comment_above(0, is_group, Some("# group: Gw"));
    assert_eq!(config.comments_above(0), ["# Gateways", "# group: Gw"]);
    config.set_comment_above(0, is_group, None);
    assert_eq!(config.to_string(), SAMPLE);

    assert!(!config.set_comment_above(9, is_group, Some("# group: X")));
}

#[test]
fn comment_above_goes_with_insert_and_delete() {
    let mut config = parse();
    config.set_comment_above(2, is_group, Some("# group: Base"));
    config.insert_host(2, "new");
    assert!(config.comments_above(2).is_empty());
    assert_eq!(
        config.comments_above(3),
        ["# Defaults for all hosts", "# group: Base"]
    );

    config.remove_block(3);
    assert!(!config.to_string().contains("# group: Base"));
}

#[test]
#[should_panic(expected = "not one comment line")]
fn set_comment_above_rejects_non_comments() {
    parse().set_comment_above(0, is_group, Some("Host evil"));
}
