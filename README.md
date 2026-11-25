# Brauser

Brauser is a local-first browser assistant for Chrome. Use its sidebar to take notes on a page, track activity on sites you choose, and save links for later. The native host stores your notes, summaries, and activity in a folder you choose. You can connect Codex or Claude Code on macOS for summaries and tasks.

[Quick start](#quick-start) · [Using Brauser](#using-brauser) · [Agent setup](#agent-setup) · [Development](#development) · [Diagnostics](#diagnostics)

## Quick start

These steps install the unpacked development build on Google Chrome Stable for macOS 15 or later, on Intel or Apple silicon. For platform and release details, see [Status](#status).

1. Install Python 3, Node.js 24.14.0, and Rust via rustup. The repository pins Rust in [rust-toolchain.toml](rust-toolchain.toml). From the repository root, build both components.

   ```sh
   cargo build --locked -p brauser
   npm ci --ignore-scripts
   npm run build:extension
   ```

2. Open `chrome://extensions`, enable **Developer mode**, then choose **Load unpacked** and select `extension/dist/`. Copy the extension ID.
3. Register the native host for that ID. Replace `YOUR_EXTENSION_ID` with the ID you copied. On macOS, this also registers the per-user service that starts when Brauser needs it.

   ```sh
   node scripts/register-dev-host.mjs YOUR_EXTENSION_ID "$(pwd)/target/debug/brauser"
   ```

4. Click the Brauser toolbar icon to open the sidebar. In **Settings**, choose a **Home folder**. Brauser creates `notes/`, `logs/`, `artifacts/`, `summaries/`, and `later/` as needed. App settings and recovery files live in the OS application folders. [Folder layout and migration](DESIGN.md#61-folder-layout)
5. Open an HTTP(S) page and type a note in **This page**. The note autosaves. To start tracking activity, choose **Capture Site**, review the proposed page rules and account scope, then save. Starter adapters cover tools such as Jira, Confluence, GitHub, and SharePoint. [Starter adapters and certification status](docs/adapters/README.md)

## Using Brauser

| To | In Brauser |
| --- | --- |
| Take a note or keep a passage | Type in **This page** on any HTTP(S) page. To save a selected passage with its source, right-click the selection and choose **Keep passage with Brauser**. |
| Track activity on a site | Use **Capture Site** on a page from that site. Review and save the rules for the pages and accounts you want to track. On unfamiliar sites, Brauser drafts rules from local URL patterns without an agent. Pause capture from the sidebar or manage site rules in **Settings**. |
| Review activity or share a worklog | Open **Recent** to see captured artifacts across tools. Choose a period, review any capture gaps, and copy the worklog. You can also choose specific entries or one recorded focus session to share. |
| Find a previously captured artifact | Open **Artifact Explorer** from the sidebar. Search titles and saved context, filter by source or saved metadata, then open the original or its summary. |
| Save a page to read later | Click **Stash** on the page, then choose **Open Brauser Stash** from the sidebar. Search saved pages and their available notes and summaries, pin an entry, or mark it done. |
| Summarize a page or ask an agent to do something | Set up a harness, then choose **Summarize & log** or enter an instruction in the task bar. |

Notes work on HTTP(S) pages regardless of capture rules. Automatic activity capture is opt-in by site and applies to pages that match the site's saved rules. Notes, manual capture setup, Artifact Explorer, and saving a link to Stash work without an agent. [Permissions](DESIGN.md#8-extension-permissions) · [Feature details](DESIGN.md#5-features)

## Agent setup

Summaries and tasks run Codex or Claude Code with full access to your files under your normal login. Page content is untrusted input, and the selected working folder does not restrict what the agent can access. Use these features on pages you trust. [Agent invocation rules](DESIGN.md#45-agent-invocation-rules)

1. Install and sign in to Codex or Claude Code on macOS. The Brauser service looks for the executable on its own `PATH`.
2. Open **Settings → Summary harness** and click **Detect harnesses**. Select a harness and click **Test and use**. Brauser saves the choice after a successful test.
3. Choose a **Knowledge base folder** if the agent should start in a folder other than your Brauser home. For optional harness-specific environment settings, use **Reveal agent.env in Finder**. Keep the file at mode `0600`. [Harness configuration](DESIGN.md#71-agent-harnesses)

### Summarize a page

On an HTTP(S) page, click **Summarize & log** or use **Summarize with Brauser** from the page's context menu. The run card shows progress and the result. Brauser writes the summary as Markdown under `summaries/`. Once the save succeeds, use **Open summary** to read it.

In **Settings → Summary harness**, you can edit the summary vocabulary or enable **Automatic summaries** for recognized artifacts that have no summary. To personalize the language or emphasis, put a regular UTF-8 `SUMMARY_STYLE.md` file of up to 8,192 bytes in the Brauser home folder. [Summary behavior and storage](DESIGN.md#52-summaries)

### Run a task

Type an instruction in the task bar at the bottom of **This page** or **Recent**, then click **Run** or press Enter. In **Options**, use **Include this page** to control whether the active page and selection are passed as context. Use **Working folder** to choose among folders added in **Settings → Task working folders**.

Open **Tasks** to follow progress, cancel a run, copy the report, or reuse the instruction. Brauser retains the report in task history. To append it to the source page's note, choose **Save to note** on a completed task that included a page.

To reuse an instruction regularly, add it under **Settings → Saved task commands**. Enter `/name` in the task bar, optionally followed by extra instructions, then run it. [Task bar](DESIGN.md#57-side-panel-layout) · [Saved commands](DESIGN.md#56-omnibar)

## Status

The macOS development build includes Capture Site with **Improve with AI**, the task bar, and a filtered cross-tool Recent view. Brauser records hourly artifact activity, delivers day-bounded batches, and maintains a disposable SQLite artifact index that can be rebuilt from the log.

Windows has CI coverage and is awaiting product acceptance. Public distribution is planned through the Chrome Web Store and a signed companion app. [Current state](docs/agents/current-state.md) · [Distribution](DESIGN.md#11-distribution)

## Development

Use Node.js 24.14.0 and the pinned Rust toolchain. Rebuild the host and extension from the same revision, rerun development host registration after rebuilding the host, and reload the unpacked extension. Add `--no-service` to the registration command to register only the host. Use `node scripts/register-dev-host.mjs --unregister-service` to remove the development service. [Contributor workflow](docs/agents/contributing.md)

### Local checks

For documentation-only edits, run the contributor documentation and privacy checks.

```sh
python3 scripts/check_current_state.py
node scripts/privacy-scan.mjs
git diff --check
```

The full local gate for application changes is below. Check the machine load first and use the contributor workflow to choose the checks that apply. [Validation and review](docs/agents/contributing.md#validate-and-review) · [Testing strategy](TESTING.md)

```sh
python3 protocol/generate.py --check
python3 scripts/check_current_state.py
cargo build --locked --workspace --all-targets
cargo test --locked --workspace
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
npm run lint:windows
cargo check --locked --manifest-path adapter-templates/fuzz/Cargo.toml --bins
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run build:extension
npm run test:extension
npm run test:a11y
npm run test:markdown-neutralizer
npm run test:scripts
npm run test:queue
npm run test:dev-tools:changed
```

- For adapter or starter changes only, use `npm run gate:adapter`. Its `--dry-run` flag shows the scope and planned checks. Use the full gate if it rejects the scope.
- `npm run lint:windows` applies to Rust changes and needs the `x86_64-pc-windows-gnu` Rust target and MinGW-w64. It reports a skip if the toolchain is missing.
- `npm run test:queue` needs a bootstrapped local queue. The changed dev-tool tests run on macOS and Linux when the change affects them. [Queue setup](docs/agents/contributing.md#work-queue)
- For adapter identity changes, see the read-only preview, impact plan, and decision journal commands. [Capture re-learning interfaces](docs/superpowers/plans/2026-10-28-capture-relearning.md#offline-command)

### macOS smoke test

With the extension built, run the headless smoke test in a disposable Chrome profile. It uses scripted folder-picker responses and fake agent harnesses.

```sh
cargo build --locked -p brauser --features scripted-dialogs --target-dir target/scripted-dialogs
npm run smoke:macos:headless
```

Real-dialog acceptance uses `npm run smoke:macos` and takes keyboard focus. Read the test procedure before running it. For headless Chrome API probes without a build, use `npm run probe:m15a`. [Real-UI acceptance](TESTING.md#real-ui-acceptance)

### Deploy the live development build

Run from the main checkout with Node.js 24.14.0. Replace `REVISION` with the exact CI-green commit from `origin/main`.

```sh
scripts/dev/deploy-live --dry-run --expected-sha REVISION
scripts/dev/deploy-live --expected-sha REVISION
```

Use `--drain` when queued or running tasks and summaries need to finish before publication. It pauses new admissions after the builds and waits up to 600 seconds by default. See `scripts/dev/deploy-live --help` for the timeout and recovery details.

When prompted, click **Reload Brauser** in the sidebar and reopen the panel. If the sidebar cannot reload, use `chrome://extensions`. Run `scripts/dev/deploy-live --loaded` to check what Chrome is running. Exit codes are 0 for loaded, 3 for pending reload, and 4 when Chrome has not confirmed its loaded build since publication. [Publish and hand off](docs/agents/contributing.md#publish-watch-and-hand-off)

## Diagnostics

- If Settings reports **Native host unavailable**, confirm that the registered extension ID matches the one in `chrome://extensions` and that the binary exists at the registered path. Repeat the [registration step](#quick-start) and reopen the settings tab and sidebar.
- If the extension and host build IDs differ, rebuild both from the same revision. After registering the host, reload the extension.
- If your selected home folder was moved or replaced, choose it again in **Settings**. If Settings reports a problem with capture rules, use **Repair adapter document…** to inspect the preserved rules and review a replacement. [Folder identity](DESIGN.md#61-folder-layout) · [Adapter configuration](DESIGN.md#72-artifact-adapters)

Diagnostic logs live in `~/Library/Logs/Brauser/` on macOS and `%LOCALAPPDATA%\Brauser\data\logs\` on Windows. Settings can export extension diagnostics for the same reader.

```sh
npm run logs -- --errors --since 1h
npm run logs -- --request 0f8e7d6c
npm run logs -- --run a1b2c3d4
npm run logs -- --proc service --follow
npm run logs -- --extension diagnostics.jsonl
```

See the design for log locations, redaction, and environment options. [Diagnostics contract](DESIGN.md#15-diagnostics)

## License

[Apache License 2.0](LICENSE).
