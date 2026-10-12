# dsh-proactive · the night watchman

> A DSH plugin that lets the agent **speak up on its own** when a long job finishes
> after its turn has already ended — no more coming back to ask "is it done yet?".

[![tests](https://img.shields.io/badge/tests-63%20passing-brightgreen)](#test-suite)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[中文说明 →](README.zh-CN.md)

---

## What it does

You ask the agent to do something that takes hours — pull down a 40 GB model, wait for a
compile, sit through an installer. The agent starts the job, the turn ends, and it goes to
sleep. The job is still running. **Nothing tells the agent when it finishes**, so nothing
tells you either: you have to wander back and ask.

This plugin makes DSH watch the condition for you. When it is met, the plugin injects one
message into the session and wakes the agent — so the agent reports to you by itself.

```
you:      fetch that 20 GB thing and tell me when it's done
agent:    (starts the download → turn ends → asleep)
            ...hours later...
plugin:   *sees the file size stop changing* → *injects a message* → *wakes the agent*
agent:    "Done — 20.3 GB, and I verified the checksum against the published one."
```

## Why it exists

An agent is a request/response process. Once a turn is over it has no clock, no timer and no
way to learn that a `curl` it launched has exited or that a file has appeared on disk. Under
DSH the only thing that can hand it that fact is a message arriving in its inbox — which is
exactly what a session looks like when *you* type something. If nothing sends one, the agent
stays asleep until a human pokes it.

So the missing piece is not the waiting, it is the *waking*. This plugin is the thing that
wakes it.

## Mechanics

The wake-up uses the same call DSH itself uses when a subagent reports back to its parent
agent (see `dsh-subagent/lib/continuation.js`):

```js
agent.steer(createUserMessage({
    content: [{ type: 'text', text: message }],
    source: { kind: 'plugin', plugin: 'dsh-proactive' },
}))
```

`agent.steer(...)` is the door into a session that is not currently running a turn;
`createUserMessage(...)` builds the message object that door expects. This is DSH's own API
surface, not a private back channel.

`source.kind = 'plugin'` is the default, and it matters: a plugin-originated message **is not
rendered in the UI**. You do not see a fake bubble pretending to be something you typed —
you only see the agent's reply, which is the whole point. `source.kind = 'user'` is available
per-entry if you deliberately want the message rendered as a user bubble, and it is used by
the test suite to prove the difference is real.

## Trigger types

| `type` | Fires when | Required fields |
|---|---|---|
| `file-stable` | The file size is unchanged across `rounds` consecutive checks — **the standard "download finished" test** | `path`, `rounds` (default `stableRounds`, 3) |
| `file-exists` | The path exists **as a file** (a directory does not count) | `path` |
| `file-size` | The file exists and its size is ≥ `bytes` | `path`, `bytes` (default 0) |
| `process-exit` | The named process is gone — **the job it was doing is over** | `process` (e.g. `curl.exe`) |
| `port-open` | A TCP connection to `host:port` succeeds — **the service came up** | `port`, `host` (default `127.0.0.1`) |
| `time` | The clock passes `at` — an alarm | `at` (ISO date-time; bare = local, `Z` = UTC) |

Unknown types never fire; they are skipped silently rather than guessed at.

### Common fields

| Field | Meaning |
|---|---|
| `id` | Identifies the entry in `boot.log` and in the default message. Any string. |
| `message` | What the agent reads when it wakes. Write it as an instruction to the agent, not as a note to yourself. |
| `sessionId` | Optional. Wake only this session. If it is not open, the entry is skipped for that tick and stays armed — it is **never** redirected to another session. Omit to wake the most recently active one. |
| `sourceKind` | Optional. `plugin` (default, not rendered) or `user` (rendered as a user bubble). |
| `form` | Optional, with `sourceKind: 'plugin'`. Free-form tag on the source; `notice` also carries a `summary` (first 120 chars of `message`). |
| `repeatSeconds` | Optional. Re-arm instead of firing once — see below. |

### Which session gets woken

When several DSH sessions are open, exactly one is chosen:

1. **`sessionId` set** → only that session. If it does not exist the entry is skipped, logged,
   and left armed. Refusing to fire is deliberate: a reminder delivered to the wrong session
   is worse than no reminder.
2. **`sessionId` absent** → the **most recently active** session. Activity means a message
   arrived in its inbox, its status turned `running`, or the session started. Not "the last
   one registered" — that older rule woke the wrong session when two were open, and it is
   pinned by five tests (`C. session selection`).

### One-shot versus repeating

A fired entry is stamped `fired: true` and never fires again. With `repeatSeconds` the entry
is **re-armed** instead, and `firedCount` / `lastFiredAt` record the history:

- `time` → `at` moves to now + `repeatSeconds`.
- `file-size` → `bytes` is raised to the current file size + 1, so the next byte appended
  fires it again.
- Any other type → `repeatSeconds` is meaningless and the entry silently degrades to one-shot.

Entries whose files are actually a moving target (a growing log, a progress file) are what
`repeatSeconds` is for.

## Install

The plugin imports `@deepseek-ai/dsh-llm`, so it has to sit somewhere Node can resolve that
package from — a normal place for that is inside the profile's module tree.

```bash
# 1. put the plugin next to (or inside) your DSH profile
git clone https://github.com/mili1360/dsh-proactive.git ./dsh-proactive

# 2. register it in <profile>/package.json
#    dependencies:        "dsh-proactive": "link:<absolute path to the plugin>"
#    dsh.profile.bundles: [ "dsh-proactive" ]      <- add to the array
```

Then verify the import resolves from the plugin directory:

```bash
node -e "import('@deepseek-ai/dsh-llm').then(m => console.log('createUserMessage =', typeof m.createUserMessage))"
# createUserMessage = function
```

If that fails, link the package the way DSH exposes it — for example a `node_modules/@deepseek-ai`
junction inside the plugin directory pointing at `<profile>/node_modules/@deepseek-ai`.

**Restart DSH.** `dsh.marketplace.requiresRestart` is `true`, and a newly registered bundle is
not picked up without one. Afterwards the plugin directory contains `boot.log`, and three
lines mean it loaded:

```
apply() 被调用  enabled=true  intervalMs=15000
定时器已挂载
守夜人就绪
```

No `boot.log` means the bundle never loaded — check the profile registration again.

## Configuration

Set through the bundle patch (`cordis.patch.yml`) or the profile's own plugin config:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` skips loading entirely — no timer is even created |
| `intervalMs` | `15000` | How often `watch.json` is re-read and evaluated. Floored at `3000`. |
| `stableRounds` | `3` | Default `rounds` for `file-stable` |
| `maxRetries` | `5` | Failed wake-ups tolerated before the entry is abandoned |
| `sourceKind` | `'plugin'` | Default source kind for injected messages |
| `watchFile` | `<plugin dir>/watch.json` | Override the watch list path (used by the test suite for isolation) |
| `logFile` | `<plugin dir>/boot.log` | Override the log path (same) |

There is **no built-in default watch, no default path and no bundled reminder**: with an empty
`watches` array the plugin does nothing at all. `watch.example.json` is a template with every
type filled in — copy it to `watch.json` and edit.

Watch lists are read from disk on every tick, so editing `watch.json` takes effect within one
interval. No restart. When the plugin writes the file back it **preserves every other
top-level key**, so your own `_note` / `_README` comment keys survive.

## Safety model

| Situation | What happens |
|---|---|
| A condition is met while the agent is mid-turn | `agent.steer(...)` is called anyway. The message lands in the session; it does not interrupt or abort the running turn. The agent sees it when it next looks at its inbox. |
| DSH restarts | The timer is gone but `watch.json` is not: entries that had not fired are re-read on the next boot and keep watching. Entries already marked `fired` stay fired. There is no separate state database. |
| A watch fires repeatedly | Only with an explicit `repeatSeconds`, and only on `time` / `file-size`, which re-arm by moving their own threshold forward. Everything else fires exactly once and is stamped `fired: true`. |
| No session is available (all closed, or the pinned `sessionId` is gone) | The wake-up is refused, `retries` is incremented, and the entry stays armed. It is retried on later ticks up to `maxRetries`, then marked fired and abandoned with a line in `boot.log`. It is never delivered to a different session. |
| `agent.steer` throws | Caught, logged, counted as a retry. Nothing propagates. |
| `watch.json` is missing, empty, a bare array, or corrupt JSON | A missing file is created; a bare array is accepted as the watch list; corrupt JSON reads as "no watches this tick" and is retried next tick. None of these throw. |
| Anything else fails | `apply()` is wrapped end to end in `try/catch`, and even a failing `ctx.effect` falls back to a bare `setInterval`. **A failure in this plugin cannot stop DSH from booting** — the worst case is a line in `boot.log`. |

Two more properties worth stating plainly:

- **It cannot fake your input by default.** Injected messages are tagged `plugin`, which the
  UI does not render as something you said.
- **It does not touch anything but its own two files.** The plugin reads `watch.json`, writes
  `watch.json` and appends to `boot.log`. It does not read, write or delete session logs,
  credentials, or any other DSH state.

## Test suite

```bash
npm test          # node test/test.mjs
```

**63 cases, all green**, in two layers plus a session-selection group:

- **A. `checkCondition` unit tests** — every type at its boundaries: file present / absent /
  a directory, size at and below the threshold, size stable / growing / vanishing mid-watch,
  process present and absent, port listening and closed, time in the past, in the future and
  unparseable, unknown type, missing fields.
- **B. `apply()` integration tests** — a fake `ctx` and fake agents driving the real code
  path: fire and delivery, `fired` de-duplication, retry counting without a session, a
  throwing `steer`, giving up past `maxRetries`, corrupt JSON, the bare-array format, the
  auto-created watch file, `enabled: false`, the bare-timer fallback, `sourceKind` overrides,
  the default message, delivery after `dispose`, an empty list, and preservation of non-watch
  keys on write-back.
- **C. Session selection** — pinned session honoured, pinned-but-absent session *not*
  misdelivered, most-recently-active chosen over most-recently-registered, `status: running`
  counting as activity, and a disposed session never being woken.

Everything runs in a temp directory; the real `watch.json` and `boot.log` are never touched.
The suite takes about 90 seconds, because proving that something does **not** fire means
waiting out a full timer window.

Bugs the suite caught and that are fixed in this tree: the `file-stable` counter counted the
first observation as a baseline, so `rounds: 3` actually needed four checks; the write-back
threw when the watch file's directory did not exist; and session selection used registration
order rather than activity, which woke the wrong session when two were open.

## Distribution helper

```bash
npm run dist        # writes dist/
npm run verify:dist # 25 checks against dist/
npm run check       # dist + test + verify:dist
```

`npm run dist` produces a **single self-contained Markdown file** — all source embedded, plus
installation instructions written for *another agent* to follow — and a zip of the same
sources. Because the packager reads the live source files, the package cannot go stale
relative to the code.

`npm run verify:dist` plays the recipient's agent: it pulls every fenced block back out of the
Markdown, compares each one byte-for-byte (SHA-256) against its source file, restores the whole
plugin into a temp directory, runs `node --check` and the full test suite on the restored copy,
and asserts that the instructions still contain the sections an installing agent needs.

## Known limitations

- **The bare-timer fallback cannot be cleaned up.** If `ctx.effect` throws, the plugin falls
  back to a plain `setInterval` that lives until the process exits. That is the intended
  last-resort path (better a leaked timer than a dead plugin), but it means a plugin instance
  cannot be fully unloaded once it has gone down that road.
- **`watch.json` is module-level state.** The path is shared across `apply()` calls in one
  process, so two loaded instances would fight over it. Fine for one plugin per DSH process —
  which is the supported shape — but the test suite has to run its fallback-timer case last
  for exactly this reason (there is a comment in `test/test.mjs`).
- **`file-exists` ignores directories** on purpose: "the directory exists" is not the same
  claim as "the download finished".
- **`process-exit` relies on `tasklist` on Windows.** Where the process lookup fails, the
  condition reports "unknown" and the entry is skipped for that tick instead of firing — a
  missing `tasklist` cannot cause a false positive.
- **`file-stable` detects "size stopped changing", not "transfer completed"** — a stalled
  download looks identical to a finished one. Use `file-size` with a known expected size when
  it matters.
- **Watching is poll-based.** With `intervalMs: 15000` a condition can be met up to one
  interval before the agent is woken. Shorter intervals cost CPU; the floor is 3000 ms.

## License

MIT — see [LICENSE](LICENSE).
