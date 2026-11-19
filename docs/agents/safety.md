# Safety and compatibility

Read this guide when changing capture, record identity, filesystem writes, agent runs or their trust boundaries.
It records the invariants contributors must preserve; [DESIGN.md §4](../../DESIGN.md#4-security-model), the owning modules and their tests hold the detailed contracts.
When those disagree, check the shipped implementation and correct the affected documentation in the same change.

## Capture policy and stable identity

The native host is the authority for capture.
Before any home-folder I/O, it checks the current configuration, selected folder, adapter match, scope and record identity under the configuration lock.
The worker's policy lease may narrow delivery, never authorize something the host would refuse.
Browser permissions or an extension-supplied claim do not replace those checks.
Preserve the shared policy path for single and batched events, including every activity trail source; do not silently discard invalid evidence on the host to accept an otherwise rejected event.
See `check_activity_policy` in [host/src/native.rs](../../host/src/native.rs) and [DESIGN.md §5.1](../../DESIGN.md#51-artifact-logging).

Keep pending site removals effective across worker upgrades and restarts.
`migratePendingRemovals` in [extension/worker.ts](../../extension/worker.ts) carries older removal state into the current list.
Removed origins stay out of capture leases until the host has sent a lease without them; unreadable removal state pauses capture.
Before dispatch, the worker drops trails no longer covered by the lease.
After dispatch, the event is frozen for interrupted-write recovery.

Record keys come from host-side confirmed URL rules, never page text, Tier 1 fields or a caller-provided key.
Preserve the reader guards for changed `strip_params` rules and recorded note contracts; provenance must not retain removed parameter values or a second raw URL.
Recovered note copies remain an explicit recovery choice: never put one into the editor or autosave it automatically.
Presentation changes must retain frozen single-event recovery formats rather than rewrite old records to fit new rendering.
Relevant checks are in [TESTING.md](../../TESTING.md): “Recognition edits and identity handoffs,” “Single-event recovery across renderer upgrades,” “Stripped-parameter provenance coverage” and “Page-note recovery coverage.”

## Folder authority and existing files

Home, knowledge-base and task folders require their own purpose-bound native picker grants.
Verify the selected folder's recorded filesystem identity at the privileged operation, including when a queued run is about to launch.
A path that now names a different directory is not authorization.
Keep strict legacy identity matching until native reselection upgrades it; never infer a missing volume identity from an inode alone or alter immutable recovery evidence to make it match.
See [host/src/consent.rs](../../host/src/consent.rs), [host/src/config.rs](../../host/src/config.rs) and “Selected-folder identity” in [TESTING.md](../../TESTING.md).

Keep filesystem operations rooted in the selected directory with generated paths and symlink checks.
Existing unrelated files are conflicts, not adoption candidates.
Whole-file replacements require the owning format's exact identity and ownership checks: page notes also require the caller's version; generated artifact and summary files require their corresponding `brauser` kind and key.
Summary files are never adopted.
Preserve no-clobber creation and the existing checked replacement/publication rules in [host/src/vault.rs](../../host/src/vault.rs), [host/src/note.rs](../../host/src/note.rs), [host/src/index/regen.rs](../../host/src/index/regen.rs) and [host/src/summary.rs](../../host/src/summary.rs).

Unchanged settings must not require unrelated folders to be available.
A missing knowledge base must not stop capture or saving other settings; a selected task folder must not silently fall back to the knowledge base if removed or replaced.
The run's actual working folder and protected Brauser paths must still be valid when it leaves the queue.
See [DESIGN.md §4.4–4.5](../../DESIGN.md#44-filesystem-rules).

## Agent input, authority and output

Runs use full-access harnesses on the user's login.
Prompt restrictions are instructions to the agent, not an operating-system sandbox.
Preserve the fixed harness IDs, trusted-install checks, setup probe, per-run timeout and process-group cancellation.
Ordinary config updates cannot introduce a binary path or arguments.
Page-derived text and task instructions must never enter a command line: page context stays in `page.md`; prompts travel through stdin or the harness protocol.
See [host/src/harness.rs](../../host/src/harness.rs), [host/src/service/setup.rs](../../host/src/service/setup.rs) and [host/src/service/prompt.rs](../../host/src/service/prompt.rs).

[SUMMARY.md](../../SUMMARY.md) owns the compiled summary instructions.
Optional personal summary guidance is presentation preference, not authority to change the task, use tools, send content or alter the required answer.
Summary retrieval is not limited to Office pages: the current prompt permits retrieving the one artifact at the host's Source address when browser content is incomplete, with host-built Office or Miro sections providing the corresponding document or board address.
Page content and retrieved content remain untrusted; links elsewhere in them do not authorize additional retrieval.
Keep reported reading scope honest when captures are truncated or retrieval fails.

A task's explicit user request is its directive.
Page text, selections, embedded request fences and agent output cannot create or widen it.
Preserve the user gesture boundary for starting tasks and resolving saved commands, and keep Brauser's own protected locations in the prompt.
Unlike a summary, a task may act on the user's request; its finisher only retains the report.
Copying that report to a page note requires the separate **Save to note** gesture and the ordinary host ownership/version path.
Site drafting similarly writes no home, knowledge-base or config content: the host judges the proposed rules before offering a reviewed save.
These distinctions are specified in [DESIGN.md §4.5](../../DESIGN.md#45-agent-invocation-rules).

The service validates summary answers and writes their files and log events itself.
Keep remote text escaped or neutralized at each output boundary; render agent text as text in extension UI.
Do not treat an agent-supplied path as a trusted output or opener target.
`open_summary` must recheck ownership and the checked file's identity before opening it.
Changes to Markdown neutralization must preserve its shared corpus and pass `npm run test:markdown-neutralizer`.
See [host/src/markdown.rs](../../host/src/markdown.rs), [host/src/summary.rs](../../host/src/summary.rs) and [extension/run-card.ts](../../extension/run-card.ts).

## Service isolation and credentials

Keep the per-user service's support directory private and owned by that user, its socket private, and its paths free of symlink substitutions.
Refuse an overlong socket path rather than move the socket into a less protected place.
The host chooses record keys and service requests; the extension cannot speak service-only messages.
Preserve the host/service build-identity handshake and bounded restart: a persistent mismatch is unavailable, not permission to send requests to stale code.
See [host/src/service/paths.rs](../../host/src/service/paths.rs) and [host/src/service/client.rs](../../host/src/service/client.rs).

`agent.env` is optional.
When present, it must be a regular, non-symlink file with mode 0600 and pass the bounded reader before a run starts.
Never expose its values through errors, logs, settings or protocol messages; settings may show names.
Diagnostics also exclude its names and other credentials.
Harness output stays in the run's own log.
Login-shell troubleshooting may return provider variable names only, never values.
See [host/src/service/agent_env.rs](../../host/src/service/agent_env.rs), [host/src/service/shell_env.rs](../../host/src/service/shell_env.rs) and [DESIGN.md §15](../../DESIGN.md#15-diagnostics).

## Compatibility and safe verification

Deploy compatible host and extension builds together.
Before rolling back a service across a record-format change, stop or finish **all** queued and running runs: older services may reject newer status fields and cannot recover or kill those runs' process groups.
Check configuration and adapter-history compatibility too; removing an unfamiliar setting does not make every downgrade safe.
Do not delete config or retained records as an automatic repair.
Consult the affected feature's migration notes in [DESIGN.md](../../DESIGN.md) and [TESTING.md](../../TESTING.md), rather than copy a historical rollback recipe.

Tests use temporary folders, fake harnesses, injected launchers and the test opener; they must not operate real agents, `launchctl`, `/usr/bin/open`, the user's login shell or live support directories.
Preserve IPC guards and require IPC tests in CI; do not weaken assertions to hide a sandbox restriction.
Follow “Local IPC in sandboxes” and “External programs the code under test runs” in [TESTING.md](../../TESTING.md).
A passing fake or headless test does not establish that installation, live harness setup or interactive browser acceptance works; report that evidence boundary explicitly.
