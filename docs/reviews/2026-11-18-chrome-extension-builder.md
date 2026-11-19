# Chrome Extension Builder fit review

Reviewed 2026-11-18 against Brauser source `ca68178f818f` and the existing development artifact whose manifest reports `0.1.0 (ca68178f818f)`.

## Recommendation

Use Chrome Extension Builder selectively for extension-specific reviews, acceptance planning, UX improvements and Web Store preparation. Keep Brauser's existing architecture, build, tests, work queue and release process authoritative. Its static checker should remain advisory: this review reproduced a false positive in its dynamic-code detector.

## Installed package

The inspected package is Khadin Akbar's Chrome Extension Builder v2.3.0, installed as the Claude edition from `khadinakbarlabs/chrome-extension-builder-plugin`. Its manifest, README and installed skills describe 23 skills, 12 specialist role contracts, five Claude commands, optional local Studio and scaffold/check/package helpers.

It is skills-only: it supplies no browser MCP, hooks, scheduler, cloud account or automatic startup. Browser tools available in a host are separate capabilities. The installed manifest is for Claude; its README describes a separate Codex edition. This review read the installed instructions and helpers directly and does not establish native Codex skill discovery or invocation.

## Best uses for Brauser

| Use | Concrete Brauser scope | Existing evidence and boundary |
| --- | --- | --- |
| MV3 reliability and security review | Worker termination/revival, navigation, capture lease refresh, sender validation and reconnect behavior | Start with `extension/worker.ts`, `extension/native.ts`, `extension/manifest.json` and the host's independent checks. The plugin cannot validate native authorization through a page preview. |
| Focused browser acceptance checks | Close/reopen the panel while a note save is pending; verify recovery durability and visibility | `TESTING.md`, "Panel notes" coverage, explicitly leaves real Chrome storage durability and panel teardown open. Recovered content must stay separate from the editor and must never replay automatically. |
| UX improvement | Narrow panel widths, long titles/reports, zoom, dark/light themes and readable error/recovery states across panel, Settings and Tasks | Existing Playwright axe and keyboard checks already cover substantial behavior. Use screenshots and focused interaction checks to add evidence where those checks leave gaps. |
| Extraction diagnosis | Compare actual rendered DOM/text with captured text on synthetic SPA and frame fixtures | Extractor fixtures do not run a full layout engine. Turn a reproduced defect into a regression in the existing suite. |
| Web Store preparation | Permission rationale, listing text, screenshots, privacy/data-flow disclosures, reviewer instructions and reviewed extension ZIP | This complements `packaging/macos/`; it does not build/sign/notarize the native app, submit a store listing, or prove store acceptance. |

The most relevant skills are `chrome-extension-builder-audit`, `-security`, `-testing`, `-ux-design`, `-performance`, `-debugging` and `-prepare-release`. In Claude Code, the installed entry points include `/chrome-extension-builder:audit-extension`, `/chrome-extension-builder:improve-extension` and `/chrome-extension-builder:release-extension`. Verify the installed host's discovery before relying on command availability elsewhere.

## Static-check experiment

After reading the helper and launcher help, ran the following with `PLUGIN_ROOT` resolved to the installed package directory:

```sh
PYTHONDONTWRITEBYTECODE=1 node "$PLUGIN_ROOT/skills/chrome-extension-builder/scripts/extension_builder.mjs" check ./extension/dist --json
```

The checker inspected the existing built output; no rebuild or browser run occurred. It exited 1 with:

- Error: `potential remote or dynamic code pattern found in vendor/readability.js`.
- Warning: `broad hosts need documented necessity; consider activeTab or exact optional hosts`.

The error is a false positive. `check_extension.py:27` compiles the following pattern with `re.I`:

```python
r'\b(?:eval|(?:new\s+)?Function)\s*\('
```

That makes it match ordinary lowercase `function (` expressions. The first match in `extension/dist/vendor/readability.js:61` is the serializer's ordinary `function (el)` callback. The other dynamic/remote-code patterns did not match that file. Both the built file and the installed Readability source have SHA-256 `34dcab3d0832d0019f02990eed6b6124e029e8c32b9f0c6f2550544ff8dff174`, the pin enforced by `extension/build.mjs` before copying it.

The host-access warning is expected: broad HTTP(S) access is a deliberate product contract in `DESIGN.md` sections 3.2 and 14. Review the rationale and disclosure rather than changing permissions merely to silence a heuristic.

The helper checks manifest/assets, selected executable-text patterns, inline scripts/handlers, symlinks and named sensitive files. It neither builds nor proves worker lifecycle, storage durability, native messaging, full security correctness or Chrome Web Store acceptance. Its package helper validates first, so the false positive also prevents packaging this artifact as-is.

## Adoption boundaries and first pilot

Use a focused request such as:

> Use Chrome Extension Builder testing and security guidance to review Brauser's note recovery during panel close/reopen. Preserve DESIGN.md and the existing test harness. Use a disposable profile, synthetic pages and fake harnesses. Report the exact build/browser, observed results, unrun cases and smallest justified follow-up. Review only; do not change source or publish anything.

Brauser already has Playwright accessibility/keyboard tests and a real extension/native-host CDP smoke in `scripts/smoke-macos.mjs`. Add cases there when appropriate instead of creating a parallel test stack. The smoke uses a DevTools pipe, isolated native registration and extension-specific loading; a generic browser connect tool is not automatically compatible. Ordinary page evaluation does not by itself establish a user gesture for side-panel opening.

Keep the plugin's scaffold, Studio and optional `.extension-builder` state out of normal adoption unless a specific task needs them. Brauser already has source-of-truth design, test and work-queue artifacts. Keep vendor files unchanged; review an upstream checker correction and normal-function/actual-dynamic-code regression fixtures before considering a CI gate. No source changes, plugin settings changes, browser exercise, store submission or deployment were performed by this review.
