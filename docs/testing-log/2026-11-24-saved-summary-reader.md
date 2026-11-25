## 2026-11-24 — Saved summary reader checks

The native regression reads an owned summary by its explicit path and by page URL.
It checks the saved source, title and body, and rejects a stale revision and an unrelated Markdown file.
The recorder confirms that reading the file does not call the desktop opener.

The browser fixtures exercise the drawer in a narrow sidebar, Artifact Explorer and Stash.
They check keyboard dismissal and focus return, including a run opened from the Activity popover, the original source link, delayed replies, and inert images and unsafe links.
The scripted macOS smoke checks the sidebar entry point against a file saved by the synthetic harness.
