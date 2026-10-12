# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Hardening: `apply()` can no longer take a profile down, and can no longer half-activate.**
  Every registration now goes through a guard: a build that has no `ctx.on`, or that refuses
  one of the five event registrations, gets ONE line in `boot.log`
  (`注册失败，插件停用: ...`), any listener already registered is handed back, and the plugin
  deactivates instead of throwing out of `apply()` into the loader. The trigger was a real
  third-party plugin (`cancanqiqi/dsh-human-subagent`) whose `apply()` threw
  `Cannot read properties of undefined (reading 'register')` and stopped a whole DSH profile
  from booting.
- **Behaviour change on one failure path: the bare-`setInterval` fallback is gone.** When
  `ctx.effect` was missing or threw, this plugin used to fall back to a raw `setInterval` that
  nothing could ever clear — so a "deactivated" plugin kept reading `watch.json` and waking
  agents after an unload or reload. It now logs one line and deactivates. Everything else on
  the success path is byte for byte unchanged. The test that pinned the old fallback (B10) was
  rewritten to pin the new behaviour, and `README.md` / `README.zh-CN.md` now carry a
  *Requirements / compatibility* section.
- **A regression test for it** (B15: a hostile `ctx` — `on` throwing, `on` absent, `ctx` null —
  must not throw, must log exactly one deactivation line per failure, and must leave no timer
  running). Proven by hand: running the new suite against the pre-hardening `index.js` gives
  `64 passed, 4 failed`; removing the guard inside `reg()` gives `67 passed, 1 failed`;
  reinstating the old bare-timer fallback gives `65 passed, 3 failed`; restored, the suite is
  `68 passed, 0 failed`.

## [0.2.1] - 2026-10-08

dsh-proactive ("the night watchman") watches conditions that only become true *after* a DSH
agent's turn has ended — a finished download, an exited process, a service that started
listening, a wall-clock time — and, when one is met, injects a message into the session and
wakes the agent so it reports to the user on its own.

This is the first public release. It is a single-file plugin: `index.js` plus a bundle patch
and a runtime watch list.

### Added

- **Six condition types**, evaluated by `checkCondition()`: `file-stable` (size unchanged for
  N consecutive checks — the finished-download test), `file-exists` (file only, never a
  directory), `file-size` (size ≥ threshold), `process-exit` (process gone, via `tasklist` on
  Windows), `port-open` (TCP connect to `host:port`), and `time` (clock passes an ISO
  date-time). Unknown types never fire — they are skipped silently.
- **Wake-up through DSH's own API.** Firing calls
  `agent.steer(createUserMessage({ content, source }))`, the same pair DSH uses when a
  subagent reports back to its parent agent. No private back channel, no UI automation.
- **Non-rendering injection by default.** `source.kind = 'plugin'` is the default, and the UI
  does not render plugin-originated messages — so a wake-up never appears as a fake user
  bubble. `sourceKind: 'user'` is available per entry where that rendering is wanted.
- **Most-recently-active session selection.** With no `sessionId` the plugin wakes the session
  that was last *active* (inbox message, `status: running`, or session start), not the last
  one registered.
- **Refusal to misdeliver.** A pinned `sessionId` that is not currently open causes the entry
  to be skipped, logged and left armed. It is never redirected to a different session.
- **Repeatable entries.** `repeatSeconds` re-arms instead of firing once: on `time` the
  deadline moves to now + the interval, on `file-size` the byte threshold is raised to the
  current size + 1. History is kept in `firedCount` / `lastFiredAt`. On any other type it
  degrades silently to a one-shot entry.
- **Watch list hot-reload.** `watch.json` is re-read on every tick, so edits take effect within
  one interval and no DSH restart is needed to add or change a watch. Non-`watches` top-level
  keys are preserved on write-back, so hand-written comment keys survive.
- **Offline test suite** (`test/test.mjs`, 63 cases) that never touches the real `watch.json`
  or `boot.log`: `checkCondition` boundaries for every type, `apply()` integration through a
  fake `ctx` and fake agents, and a session-selection group.
- **Single-file distribution packager and verifier** (`tools/make-dist.mjs`,
  `tools/verify-dist.mjs`): the packager embeds the live sources into one Markdown file aimed
  at an installing agent, and the verifier pulls every block back out, compares it byte-for-byte
  by SHA-256 against the source, restores the plugin into a temp directory, and runs
  `node --check` plus the full test suite on the restored copy.

### Safety

- **`apply()` cannot stop DSH from booting.** The whole entry point is wrapped in `try/catch`
  and a failure only appends a line to `boot.log`. Even a throwing `ctx.effect` falls back to a
  bare `setInterval` rather than leaving the plugin dead.
- **Bounded failure handling.** A wake-up that cannot be delivered counts a retry and leaves
  the entry armed; after `maxRetries` the entry is marked fired and abandoned with a log line.
  A throwing `agent.steer` is caught and counted the same way.
- **Tolerant input.** A missing watch file is created, a bare array is accepted as the list,
  and corrupt JSON reads as "no watches this tick" — retried on the next tick. None of these
  throw.
- **Touches nothing else.** The plugin reads and writes its own `watch.json` and appends to its
  own `boot.log`. It does not read, write or delete session logs, credentials, or any other DSH
  state.
- **Fires once by default.** Every entry is stamped `fired: true` after a successful wake-up and
  is ignored thereafter; repetition requires an explicit `repeatSeconds`.

### Fixed

- **`file-stable` counted the first observation as a baseline**, so `rounds: 3` needed four
  checks instead of three. The first observation now counts as 1, and `rounds: 3` fires on the
  third check.
- **Write-back threw when the watch file's directory did not exist.** The parent directory is
  now created before writing.
- **Session selection used registration order, not activity**, so with two sessions open the
  wake-up could land in the wrong one. Selection is now by most-recent activity, and five tests
  in the `C. session selection` group pin the behaviour.
- **The packager truncated files containing fenced code blocks** (embeds are now wrapped in
  four-backtick fences when the body contains three), and **the verifier misread its own
  ANSI-coloured summary line** (colour codes are stripped before parsing).

### Known issues

- **The bare-timer fallback cannot be cleaned up.** If `ctx.effect` throws, the plugin's
  fallback `setInterval` lives until the process exits. A plugin instance that has taken that
  path therefore cannot be fully unloaded. This is the intended last resort, not an oversight.
  (**Removed in Unreleased** — the plugin now deactivates instead, so this limitation no longer
  applies.)
- **`watch.json` is module-level state**, shared across `apply()` calls in one process, so two
  loaded instances would contend for it. One plugin per DSH process is the supported shape; the
  test suite consequently runs its fallback-timer case last. (**The ordering constraint is gone
  in Unreleased**, because there is no longer an uncleared fallback timer.)
- **Watching is poll-based.** With the default `intervalMs: 15000` a met condition can wait up
  to one interval before the agent is woken.
- **`file-stable` cannot distinguish a stalled download from a finished one** — both look like
  "the size stopped changing". Use `file-size` with a known expected size when that matters.
- **`process-exit` depends on `tasklist` on Windows.** Where the lookup fails the condition
  reports "unknown" and the entry is skipped for that tick rather than fired, so a missing
  `tasklist` cannot produce a false positive — but it also cannot detect the exit.
