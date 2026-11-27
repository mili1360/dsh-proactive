# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-27

这个版本把「守夜人」从"只会盯文件"升级成"能盯对话"，并新增一条**不打扰对话**的注入通道。
背景：它原来只有 `time` / `file-*` / `process-exit` / `port-open` 这几档"看文件看端口"的触发，
而实际最想要的是"聊到某个话题时提醒我一句"——那种提醒既不该吵，也不该等文件变大。

### Added

- **`type: 'session-match'`** — 最近 N 条**用户**消息里命中 `keywords` 任意一个就触发。
  - 只看用户消息；插件自己注入的消息（`source.kind === 'plugin'`）不计入，防止自己触发自己。
  - `window`（默认 3）控制看几条。
  - 命中后按 `repeatSeconds`（默认 600 秒）冷却，不会每 15 秒 tick 一次就一直响。
- **`type: 'session-semantic'`** — 把一小段最近对话丢给模型，由它回答"是/否"，决定要不要提醒。
  - 走 DSH 自己的 `ctx.llm.stream()`（和 compaction 摘要同一条路径），不用另配 API key / provider。
  - 三条成本纪律：`cooldownSeconds`（默认 900）、**没有新用户消息直接跳过**、`timeoutMs`（默认 8000）硬超时 + `maxTokens`（默认 8）。
  - 模型不回答 / 抛错 / 超时，一律当"否"——提醒不能因为 AI 挂了而误触发。
  - 首次看到监听项时只把消息基线对齐到当前版本，不判（否则装完插件会拿历史消息误触发一次）。
- **`via: 'system-prompt'`** — 触发后不 `steer`、不插对话、不唤醒新回合，而是挂到一条短期标记上，
  由 `ctx.systemPrompt.variable()` 在每轮提示装配时读走；`rounds`（默认 3）轮后自动消失。
  - 没命中时返回空串，`systemPrompt` 会把空 section 过滤掉，**一行 token 都不多花**。
  - 拿不到 `systemPrompt` 服务时自动退化成原来的 `steer`（绝不静默丢掉提醒）。

### Fixed

- **运行时状态不再挂在 watch 对象上。** `tick()` 每次都 `readWatches()` 重新 parse 一遍文件，
  拿到的是全新对象——所以挂在 `w.__cooldownUntil` / `w.__lastMsgVersion` 上的冷却和消息基线
  **下一次 tick 就没了**，表现为"冷却永不生效、语义判断要么永远不判要么每轮都判"。
  现在改用模块级 `runtimeState`（key = 监听项 id），并且从不写回 `watch.json`。这条由新增的
  C10/C11 用例逮到（C10 先跑出 `calls=1`，说明它把历史消息当成了新消息）。

### Changed

- `watch.json` 里可以同时挂多种类型；老类型（`time` / `file-*` / `process-exit` / `port-open`）行为不变。
- 测试从 68 例扩到 **83 例**，新增 C 节覆盖 `session-match` / `session-semantic` /
  `system-prompt` 注入（含"没有新消息不调 llm""返回否不注入""插件来源消息不计入窗口"）。

## [Unreleased]

### Added

- **`session-match` 支持 `scope`：`user`（默认）/ `tool` / `thinking` / `both` / `all`（也可给数组）。**
  `scope: 'tool'` 看的是**工具调用的名字 + 参数**（`write` / `edit` / `pwsh` … 的 arguments），
  用来做"我准备动某个东西时就提醒我"，而不是等用户嘴里提到关键词。
  动机：光看用户消息不准——"我准备动手改 X"这个意图往往只体现在工具调用的参数里。
  `scope: 'thinking'` 更进一步：旁听 `llm/stream` 的 `reasoning-delta`（只读透传、不改流、不吞 chunk），
  收模型自己的思考。决定要动某个东西的念头通常比工具调用早一步出现，那时候提醒才来得及。
  `both` = user+tool，`all` = 三者都看。
  只收工具名和参数，**不收工具结果**（回执里出现关键词不算"要动手"）。
  工具/用户/思考三个窗口各自独立（各最近 6 条，思考窗口再按 `window` 截到最多 3 条），互不污染。
  测试：C16~C24（工具窗口为空不命中 / `scope:tool` 不看用户消息 / 参数命中触发 /
  `scope:user` 不被工具触发 / `scope:both` 两边都看 / 思考命中 / `scope:all` 看思考 /
  思考窗口滑出后不命中）。

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
