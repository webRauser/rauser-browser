//! Isolated native hosts and the scripted picker exercise the home-bound Stash guard.
#![cfg(feature = "scripted-dialogs")]

use std::fs;
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use brauser_host::brand::{SCRIPTED_DIALOGS_ENV, TEST_CONFIG_PATH_ENV};
use brauser_host::frame::{read_frame, write_request};
use brauser_protocol::{PROTOCOL_VERSION, Request};
use serde_json::{Value, json};

const HOST: &str = env!("CARGO_BIN_EXE_brauser");
const MARKER: &str = ".brauser-stash-format";
const REFUSAL: &str = "Stash is unavailable because this home's Stash format marker is unsupported or cannot be checked.";
const SOURCE: &str = "https://reading.example.test/guides/guard";
const OTHER_SOURCE: &str = "https://reading.example.test/notes/guard";

struct Host {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
    next_id: u32,
}

impl Host {
    fn start(config: &Path, picker: &Path) -> Self {
        let command = || {
            let mut command = Command::new(HOST);
            command
                .env_clear()
                .env(TEST_CONFIG_PATH_ENV, config)
                .env(SCRIPTED_DIALOGS_ENV, picker);
            command
        };
        let preflight = command().arg("--config-path").output().unwrap();
        assert!(preflight.status.success());
        assert_eq!(
            Path::new(String::from_utf8(preflight.stdout).unwrap().trim()),
            config
        );
        let mut child = command()
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        Self {
            input: child.stdin.take().unwrap(),
            output: child.stdout.take().unwrap(),
            child,
            next_id: 0,
        }
    }

    fn call(&mut self, mut request: Value, expected: &str) -> Value {
        self.next_id += 1;
        let id = format!("stash-{}", self.next_id);
        request["protocol_version"] = json!(PROTOCOL_VERSION);
        request["request_id"] = json!(id);
        let request: Request = serde_json::from_value(request).unwrap();
        write_request(&mut self.input, &request).unwrap();
        let body = read_frame(&mut self.output).unwrap().unwrap();
        let reply: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(reply["request_id"], id, "{reply}");
        assert_eq!(reply["type"], expected, "{reply}");
        reply
    }

    fn select_home(&mut self, home: &Path, picker: &Path) -> String {
        let current = self.call(json!({"type": "get_config"}), "config_result");
        fs::write(
            picker.join("answer"),
            serde_json::to_vec(&json!({
                "dialog": "pick-folder", "reply": format!("picked:{}", home.display()),
            }))
            .unwrap(),
        )
        .unwrap();
        let selected = self.call(
            json!({"type": "choose_folder", "purpose": "notes_folder"}),
            "folder_chosen",
        );
        assert_eq!(Path::new(selected["path"].as_str().unwrap()), home);
        let mut settings = current["config"].clone();
        settings["storage"] = json!({
            "root": selected["path"], "profile": "neutral", "log_dir": "logs",
            "pages_dir": "notes", "later_dir": "later", "artifacts_dir": "artifacts",
            "summaries_dir": "summaries", "knowledge_base_dir": null,
        });
        let reply = self.call(
            json!({
                "type": "update_config", "expected_revision": current["revision"],
                "config": settings, "picker_token": selected["picker_token"],
                "knowledge_base_token": null,
            }),
            "config_updated",
        );
        reply["revision"].as_str().unwrap().to_owned()
    }

    fn assert_format_refused(&mut self, revision: &str, entry: &Value) {
        for request in [
            list(revision),
            save(revision, SOURCE),
            save(revision, "https://reading.example.test/guides/new"),
            complete(revision, entry),
        ] {
            let reply = self.call(request, "error");
            assert_eq!(reply["code"], "conflict", "{reply}");
            assert_eq!(reply["message"], REFUSAL, "{reply}");
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn list(revision: &str) -> Value {
    json!({"type": "list_stash", "expected_revision": revision, "state": "all",
           "query": "", "after": null})
}

fn save(revision: &str, url: &str) -> Value {
    json!({"type": "stash_page", "expected_revision": revision, "url": url,
           "title": "Synthetic reading guide"})
}

fn complete(revision: &str, entry: &Value) -> Value {
    json!({"type": "complete_stash", "expected_revision": revision, "id": entry["id"],
           "version": entry["version"]})
}

fn make_dir(path: &Path) {
    fs::create_dir(path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

#[test]
fn format_marker_refuses_running_fresh_repaired_and_separately_configured_hosts() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let home = root.join("home");
    let picker = root.join("picker");
    let other_config = root.join("other").join("config.toml");
    for path in [
        home.as_path(),
        picker.as_path(),
        other_config.parent().unwrap(),
    ] {
        make_dir(path);
    }
    let config = root.join("config.toml");
    let mut running = Host::start(&config, &picker);
    let revision = running.select_home(&home, &picker);
    assert_eq!(
        running.call(list(&revision), "stash_listed")["items"],
        json!([])
    );
    let saved = running.call(save(&revision, SOURCE), "stash_page_result");
    assert_eq!(saved["already_saved"], false);
    let entry = running.call(list(&revision), "stash_listed")["items"][0].clone();
    assert_eq!(entry["done"], false);
    running.call(complete(&revision, &entry), "stash_completed");
    assert_eq!(
        running.call(list(&revision), "stash_listed")["items"][0]["done"],
        true
    );

    let later = home.join("later");
    let id = entry["id"].as_str().unwrap();
    let receipt = later.join(format!("{id}.md"));
    let done = later.join(format!("{id}.done.md"));
    let entry_bytes = fs::read(&receipt).unwrap();
    let completion_bytes = fs::read(&done).unwrap();
    let marker = home.join(MARKER);
    let marker_bytes = b"brauser_stash_format = 2\n";
    fs::write(&marker, marker_bytes).unwrap();

    running.assert_format_refused(&revision, &entry);
    let mut fresh = Host::start(&config, &picker);
    fresh.assert_format_refused(&revision, &entry);
    let missing = fresh.call(
        json!({"type": "load_note", "url": OTHER_SOURCE}),
        "note_loaded",
    );
    assert_eq!(missing["exists"], false);
    fresh.call(
        json!({"type": "save_note", "url": OTHER_SOURCE, "title": "Synthetic note",
               "body": "An unrelated note.", "expected_revision": missing["revision"],
               "expected_key": missing["key"]}),
        "note_saved",
    );

    let original_config = fs::read_to_string(&config).unwrap();
    fs::write(&config, format!("future_setting = 1\n{original_config}")).unwrap();
    let repaired = fresh.select_home(&home, &picker);
    assert!(
        !fs::read_to_string(&config)
            .unwrap()
            .contains("future_setting")
    );
    running.assert_format_refused(&repaired, &entry);
    fresh.assert_format_refused(&repaired, &entry);

    let mut separate = Host::start(&other_config, &picker);
    let separate_revision = separate.select_home(&home, &picker);
    separate.assert_format_refused(&separate_revision, &entry);
    let note = separate.call(
        json!({"type": "load_note", "url": OTHER_SOURCE}),
        "note_loaded",
    );
    assert_eq!(note["body"].as_str().unwrap().trim(), "An unrelated note.");
    assert_eq!(fs::read(marker).unwrap(), marker_bytes);
    assert_eq!(fs::read(receipt).unwrap(), entry_bytes);
    assert_eq!(fs::read(done).unwrap(), completion_bytes);
    assert_eq!(fs::read_dir(later).unwrap().count(), 2);
}

#[test]
fn any_marker_occupant_refuses_before_creating_stash_storage() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let home = root.join("home");
    let picker = root.join("picker");
    make_dir(&home);
    make_dir(&picker);
    let mut host = Host::start(&root.join("config.toml"), &picker);
    let revision = host.select_home(&home, &picker);
    let entry = json!({"id": "1".repeat(64), "version": "2".repeat(64)});
    let marker = home.join(MARKER);
    let later = home.join("later");

    fs::write(&marker, b"foreign, malformed marker").unwrap();
    host.assert_format_refused(&revision, &entry);
    assert!(!later.exists());
    assert_eq!(fs::read(&marker).unwrap(), b"foreign, malformed marker");
    fs::remove_file(&marker).unwrap();

    make_dir(&marker);
    let foreign_child = marker.join("keep.txt");
    fs::write(&foreign_child, b"unrelated child").unwrap();
    host.assert_format_refused(&revision, &entry);
    assert!(!later.exists());
    assert_eq!(fs::read(foreign_child).unwrap(), b"unrelated child");

    #[cfg(unix)]
    {
        fs::remove_dir_all(&marker).unwrap();
        let missing_target = root.join("dangling-marker-target");
        std::os::unix::fs::symlink(&missing_target, &marker).unwrap();
        host.assert_format_refused(&revision, &entry);
        assert!(!later.exists());
        assert_eq!(fs::read_link(marker).unwrap(), missing_target);
        assert!(!missing_target.exists());
    }
}
