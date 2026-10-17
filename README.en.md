# GitCue — Smart Git Command Hints for Your Terminal

English | [简体中文](README.md)

GitCue is a **live hint and input-assist tool for git commands** running in your terminal. While you type a git command it provides:

1. **Live syntax skeleton**: shows the full syntax structure of the current command following git's official documentation conventions — typed parts are highlighted, the cursor position is marked, and the skeleton shrinks as you type;
2. **Context-aware candidates**: lists the syntactically legal continuations at the cursor — subcommands, long/short options, combined short options, option enum values, parameter placeholders, plus branches/tags/remotes/stashes/paths fetched live from the local repository;
3. **Candidates with descriptions**: every candidate carries a one-line description; `F1` expands it into a detailed explanation, typical examples, and notes;
4. **Press Enter to run**: the command line is handed to your local git as-is; output and exit code are passed through faithfully.

In one sentence: **a git command learning and productivity tool — "hints as you type, candidates with explanations, Enter to run"**.

- Fully offline & local: all hints come from the built-in knowledge base and read-only queries against the local git repository; no network access whatsoever;
- Minimal dependencies: only `ink` and `react` at runtime (TUI rendering layer); the one-shot mode loads neither;
- Graceful degradation: unknown commands, non-git directories, old git versions, and terminals without ANSI support never error out or block your input.

Ships with a built-in knowledge base of 25 high-frequency commands (full list in [Knowledge Base Coverage](#knowledge-base-coverage-25-built-in-commands)), in two modes: interactive (REPL) and one-shot.

## Quick Start

### Requirements

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 22 | The TUI layer uses Ink 8 (which itself requires `engines.node >= 22`). npm only warns on lower versions instead of blocking the install, but the interactive REPL mode has not been tested on Node < 22 and is not guaranteed to work (`import('ink')` may fail or misbehave on version ranges it does not declare); the one-shot mode loads no react/ink and is theoretically insensitive to the Node version, likewise untested below 22 |
| git | ≥ 2.30 | Older versions do not crash; only hint coverage degrades. The highest `since` annotation in the knowledge base is 2.35 (`-S`/`--staged` of `stash`): below the annotated version, the affected option candidates show `(requires git >= x.y)` |
| Terminal | ANSI support | Targets: Windows Terminal, mintty (Git Bash default), macOS Terminal / iTerm2, common Linux terminals; environments without ANSI such as conhost automatically fall back to plain-text mode |

### Install & Uninstall

```bash
npm install -g gitcue    # install as a global command
gitcue                   # type gitcue in any terminal to start
npm uninstall -g gitcue  # uninstall the global command (user data in ~/.gitcue/ can be deleted manually if desired)
```

### Interactive Mode (REPL)

```bash
gitcue
```

After entering the REPL, keystrokes are captured character by character and the UI — execution history / input line / syntax / candidates / detail / status bar — is rendered live (the history zone appears at the top of the window after the first command runs). Screenshot with `--lang en-US` (knowledge-base descriptions are Chinese in this release):

```
┌ GitCue ─ D:\Code\demo (branch: main) ────────────────────────────┐
│  git> rebase -i origin/ma█                                       │
├ Syntax ───────────────────────────────────────────────────────────┤
│  git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]      │
│  ───┬─────            ▏                                         │
├ Candidates (5) ──────────────────────────────────────────────────┤
│  ► --onto <newbase>    在指定新基点之上重放提交                   │
│    --keep-base         以当前分支与上游共同祖先为基点             │
├ Detail --onto <newbase> ──────────────────────────────────────────┤
│  把提交重放到 <newbase> 指定的提交之上。例：git rebase --onto main topicA topicB │
├────────────────────────────────────────────────────────────────────┤
│  Tab complete │ ↑↓ select │ F1 detail │ Enter run │ Esc clear │ Ctrl+Q quit │
└────────────────────────────────────────────────────────────────────┘
```

Common keys: `Tab` complete (longest common prefix / highlighted candidate / placeholder expansion / correction acceptance) | `↑↓` select a candidate; on an empty line (no candidates) `↑` recalls history, `↑↓` keeps browsing while recalling, and **editing the line immediately leaves recall so `↑↓` go back to candidate selection** | `Enter` run (see output modes below) | `F1` or `Ctrl+?` expand detail | `F2` expand/collapse the history zone | `Esc` close candidates / clear the line | `Ctrl+C` twice or `Ctrl+Q` quit | `Ctrl+U/W/A/E` line editing | `PgUp/PgDn` page candidates. Commands that do not start with `git` are also hinted, executed, and recorded (see boundaries below). **Input-line cursor**: on ANSI terminals it blinks about every 530ms between a prominent block `█` and a thin bar `▏` (both rendered in reverse video to mark the insertion point) — you can tell at a glance whether a trailing space has been typed and which character the cursor sits on; in plain-text fallback mode `▏` is always shown.

On first launch a 5-line key guide is shown; press any key to continue and it never appears again. The bottom status bar always shows one line of core key hints (`hint_bar = true` by default, configurable); for the full key table run `gitcue --help` in another terminal at any time, or refer to this document.

#### Running Commands Inside the REPL (Output Modes and Capabilities)

On Enter the whole line is handed to the system shell as-is (`src/exec/runner.mjs`: `spawn(commandLine, { shell: true })`, no implicit rewriting). **Default passthrough mode (`exec_output = "passthrough"`)**: while running, the window is wiped in whole frames (Ink `suspendTerminal`, no leftover frames), a native `$ <command line>` echo is written in place (plus one warning line if a dangerous-command rule matches), and the child process's stdio writes directly to the terminal with inherited handles (colors and full interactivity preserved); afterwards the single active window is redrawn below the output. The scrollback therefore only contains native history like "`$ command` + output" — exactly as if you had typed the git command directly — scroll up to review it, and there is never more than one gitcue window on screen. In both modes: pipes/redirections follow system shell semantics; each command runs in its own child process (`cd` does not persist); Enter on an empty line is ignored; `GIT_PAGER`/`PAGER` (default `cat`) and `GIT_TERMINAL_PROMPT=0` are injected into the environment.

**Inline mode (`exec_output = "inline"`, a persistent single-window mode, selectable via config)**:

- **Persistent single window**: the UI stays mounted while a command runs; executed commands and their output accumulate in the **history zone at the top of the window** (`$ git status` + output lines, non-zero exit codes suffixed with `✘ exit N`) instead of redrawing a new window further down the terminal each time;
- **The input line clears automatically after execution**, ready for the next command; the history zone shows the most recent lines by default (`log_height = 10`), older lines are tail-kept with "…（N earlier lines omitted, F2 expands）", and `F2` toggles between 1×/3×; **the history zone shrinks to the actual terminal height** (budget = terminal rows − other zones' overhead, keeping at least the latest line) so the top of the window is never scrolled off on short terminals;
- **Output capture**: the child's stdout/stderr are merged and captured into the history zone (throttled redraw for long output, tail-truncation for single overly long outputs; output is displayed as text — the child detects the pipe and disables colors; use passthrough mode when you need original colors); byte-for-byte equality with direct execution is asserted by an acceptance scenario;
- **Interactive commands (line-style prompts work)**: keystrokes typed while a command runs — printable keys, Enter, Backspace, arrows — are forwarded to the child's stdin, so y/n/q-style prompts such as `git add -p` work; the child's stdin is a pipe without terminal echo, so the tool echoes your input as lines in the history zone; full-screen interactive programs (vim and the like) and prompts that read console credentials directly on Windows are not supported — use passthrough mode or authenticate outside the tool for those;
- **Ctrl+C interrupts the child** and returns to input mode (on Windows via `taskkill /T /F` tree kill); interrupted commands report exit code 130.

You can therefore treat it as a **directory-amnesiac mini-shell**: great for one-shot commands like `git …`, `node -v`, `ls | head`; not suitable for workflows that depend on directory state (`cd`) or multi-line scripts.

### One-shot Mode

Parses a complete command once, prints suggestions, and exits (without executing) — handy for previewing, debugging, and scripting:

```bash
$ gitcue "git log --on" --plain --lang en-US
Syntax: git log [-n | --max-count <num>] [--oneline] [--graph] [--all] [-p | --patch] [--stat] [--decorate] [--author <pattern>] [--since | --after <date>] [--until | --before <date>] [--pretty | --format <format>] [--name-only] [--follow] [--reverse] [<revision-range>] [<path>...]
Match: git ✓  log ✓  --on ▶
Position: option name (--on*)
Candidates(1):
  --oneline  每条提交压成一行显示
Hint: (none)
```

- `--exec`: after printing suggestions, execute the command as well; the exit code is passed through (e.g. `gitcue "git status" --exec`);
- `--strict`: exit code 2 when unrecognized tokens are present (default 0);
- `--plain`: force ANSI off (automatically off when stdout is not a terminal);
- `--lang en-US`: switch the UI framework text to English (knowledge-base descriptions remain Chinese).

### Other Commands

| Command | Purpose |
| --- | --- |
| `gitcue --help` / `--version` | standard help / version |
| `gitcue validate-data` | validate the built-in knowledge base + custom entries (contributor tool) |
| `gitcue config` | show config file paths and the effective configuration |
| `gitcue --reset-usage` | clear the usage-frequency statistics file |
| `--debug` (appended to any mode) | print parse traces and per-stage timings to stderr; also via the `GITCUE_LOG=debug` environment variable |

### Configuration

User-level `<GITCUE_HOME>/config.toml` (default `~/.gitcue/config.toml`, relocatable via the `GITCUE_HOME` environment variable; `%USERPROFILE%\.gitcue\` on Windows), overridden by project-level `.gitcue.toml`, with the `--lang` CLI flag taking precedence. **Supported syntax (mini-TOML — do not write full standard TOML)**: the parser only accepts `key = scalar` lines and `#` comments (`#` only takes effect outside double-quoted strings); there are exactly four scalar types — double-quoted strings (only `\"` and `\\` escapes), `true` / `false`, and decimal integers (`src/config.mjs`). **Not supported**: arrays, floats, multi-line strings, nested tables, inline tables, or other standard TOML syntax — writing those fails parsing and lands in the "invalid config item: warn on stderr at startup and fall back to the default" path (usage is not blocked, but that item does not take effect). All of this project's default configuration uses only the four scalar types above. **Project-level file lookup**: only the `.gitcue.toml` in the process's working directory (where you started gitcue) is checked — no upward traversal of parent directories and no git-repository-root resolution; start gitcue in the repository root, or put the file in the actual working directory. Available options:

| Option | Default | Description |
| --- | --- | --- |
| `lang` | `"zh-CN"` | UI language (`zh-CN` / `en-US`) |
| `candidate_limit` | `8` | number of candidates visible at once |
| `theme` | `"default"` | theme (`default` / `contrast` / `none`; `none` forces plain text) |
| `enter_action` | `"exec"` | Enter behavior (`exec` to run / `complete` to complete first) |
| `history_enabled` | `true` | enable persisted history |
| `history_limit` | `1000` | maximum number of history entries |
| `danger_warning` | `true` | status-bar warning switch for dangerous commands (warn only, never blocks). **The warning rules are fixed at 4** (`push --force`/`-f`, `reset --hard`, `clean -f`+`-d`, `branch -D`), hardcoded in `src/exec/danger.mjs`, **not customizable or extensible**; this switch can only turn them all off — adding or removing rules requires editing the source |
| `dynamic_cache_seconds` | `30` | dynamic-data cache duration (seconds) |
| `custom_command_dir` | `""` | custom command directory (empty = `<GITCUE_HOME>/commands`) |
| `pager` | `"cat"` | `GIT_PAGER`/`PAGER` injected into executed commands so git paging passes through and displays in the UI. **Windows note**: cmd/PowerShell have no `cat` command, but this default still works — git resolves and launches the pager through its own bundled environment (`GIT_PAGER=cat git --paginate log` still passes through with a PATH containing only the git directory); if you prefer an interactive pager inside the REPL, set `less` etc., but full-screen pagers take over the screen and interfere with UI redraws — not recommended |
| `hint_bar` | `true` | bottom key-hint bar |
| `exec_output` | `"passthrough"` | execution output mode: `passthrough` yields the terminal and passes output through as-is (default; colors and full interactivity preserved, output stays in the terminal scrollback); `inline` captures output into the window's top history zone (persistent single-window mode) |
| `log_height` | `10` | default visible lines of the history zone (`F2` expands to 3×, range 1–50) |

Invalid config items warn on stderr at startup and fall back to defaults; usage is never blocked.

## Knowledge Base & Custom Extensions

### Knowledge Base Coverage (25 Built-in Commands)

`data/commands/` holds one file per command — currently 25:

`add` `branch` `checkout` `cherry-pick` `clone` `commit` `config` `diff` `fetch` `init` `log` `merge` `mv` `pull` `push` `rebase` `remote` `reset` `restore` `revert` `show` `stash` `status` `switch` `tag`

Frequently asked: **`worktree` is not in the built-in knowledge base**; unknown commands never error — the tool degrades to plain execution (the syntax zone shows "not covered, will run directly"). Commands with sub-actions such as `stash` / `remote` are modeled with literal branches (e.g. `git stash push`, `git remote add`).

### Entry Structure

The knowledge base is structured JSON, one file per command, located at `data/commands/<command>.json` (built-in) or `<GITCUE_HOME>/commands/*.json` (custom). Example entry (excerpted from the built-in `data/commands/rebase.json`):

```json
{
  "schemaVersion": "1.0",
  "command": "rebase",
  "category": "porcelain",
  "popularity": 4,
  "summary": "在另一个基线之上重放提交",
  "grammar": [
    {
      "type": "option",
      "key": "-i",
      "aliases": ["--interactive"],
      "optional": true,
      "popularity": 5,
      "summary": "交互式变基：编辑/压缩/重排提交",
      "detail": "启动编辑器列出待重放的提交，可修改顺序、合并或丢弃。……",
      "example": "git rebase -i HEAD~5"
    },
    {
      "type": "option",
      "key": "--onto",
      "param": { "kind": "commit", "name": "newbase" },
      "optional": true,
      "popularity": 3,
      "summary": "把提交重放到指定新基点上"
    },
    { "type": "positional", "param": { "kind": "commit", "name": "upstream" }, "optional": true, "popularity": 3, "summary": "上游基点（默认取分支配置）" }
  ],
  "examples": [{ "cmd": "git rebase -i HEAD~3", "note": "交互式整理最近 3 个提交" }],
  "notes": ["变基会改写提交历史，已推送的分支慎用"]
}
```

(`summary` / `detail` / `example` / `notes` texts are Chinese in this release.)

Key points:

- **Top-level fields**: `schemaVersion` (currently `"1.0"`; the program is forward-compatible with one minor version), `command`, `category` (`porcelain`/`plumbing`/`custom`), `popularity` (1–5 frequency, participates in candidate ordering), `summary` (≤ 40 code points), `grammar`, `examples`, `notes`;
- **Four grammar node types**: `option` (supports `aliases`/`param`/`mutex` groups/`repeatable`/`since` version annotations), `positional` (positional placeholder), `literal` (literal subcommand such as `stash push`, with `then` branch grammar), `group` (`mutex`/`repeat` groups);
- **Six dynamic `param.kind` sources**: `branch` / `tag` / `remote` / `stash` / `pathspec` (live queries against the local repository) and `commit` (derived from HEAD, branches, tags); plus `enum` (static enumeration) and `text` (free text);
- **The syntax skeleton is generated from grammar** (data files store no handwritten skeleton strings), guaranteeing consistency with the official syntax at the source and avoiding dual-source drift;
- **`since` version annotation**: e.g. `"since": "2.23"` — when the local git version is lower, the candidate line is suffixed with `(requires git >= 2.23)`.

### Custom Commands

Put JSON entries into `<GITCUE_HOME>/commands/` (default `~/.gitcue/commands/`; point it elsewhere via `custom_command_dir` in config.toml):

- **Same-name override**: an entry whose `command` field matches a built-in command overrides the built-in entry;
- **New names are added**: a new command name enters the subcommand candidates directly — you can author syntax and Chinese descriptions for your company's custom subcommands (e.g. `git-deploy`);
- the file name does not have to equal the command name; the entry's `command` field is authoritative;
- custom entries missing `schemaVersion` are accepted as `"1.0"` with a warning; entries that fail to parse are skipped with a warning and do not affect other commands.

### Data Validation

```bash
gitcue validate-data   # validates built-in + custom entries: 0 errors → exit 0; errors → printed one per line, exit 2
```

Validation covers: JSON parseability, schemaVersion compatibility, field types and formats (option keys, non-empty enums, `popularity` 1–5, `summary` ≤ 40 code points, `detail` ≤ 3 sentences, `since` format), plus conflict detection ensuring that mutex/alias/implicit-negation (`--no-x`) expansion sets are pairwise disjoint.

### Consistency Checking Against Official git

Consistency between the knowledge base and official git is safeguarded by two layers:

1. **Manual comparison at authoring time** (performed for every data batch on intake): entries are compared item by item — option sets and usage lines — against the local `git <cmd> -h` (a read-only help command).
2. **Automated assertions** (run with `npm test`; the comparison result is simply the test pass/fail — no separate report file). Three data batches claim 8 commands each (the lists below are read directly from each test file's `COMMANDS` array):
   - `test/data-1.test.mjs` (`add` `branch` `checkout` `cherry-pick` `clone` `commit` `config` `diff`): the first 6 commands get automated `-h` text comparison (`--[no-]x` form normalization + `--no-x` base-name fallback + token boundary matching); `diff` and `config`, due to local `-h` output quirks (diff's `-h` lacks `--staged` etc.; config 2.46+ no longer lists legacy flags), use parse-style validation instead (every declared option is accepted by real git) — all 8 commands covered;
   - `test/data-2.test.mjs` (`fetch` `init` `log` `merge` `mv` `pull` `push` `remote`): normalized `-h` comparison for all 8 entries, plus sandbox repository functional verification — every form of every option is actually invoked against git and asserted not to report unknown option (with a negative control using a fabricated option, guarding against false greens);
   - `test/data-3.test.mjs` (`reset` `restore` `revert` `show` `stash` `status` `switch` `tag`): 7 of the 8 entries get name-by-name `-h` comparison; `show`, whose `-h` output is truncated on git 2.55, gets sandbox functional verification instead (exit code 0 for every option + unknown-option negative control);
   - **Coverage gap (registered as-is)**: 8 + 8 + 8 = 24 — the 25th command, **`rebase`, is not in any data batch's consistency comparison**. Its entry is structurally validated by the full load in `test/m2-loader-validate.test.mjs` and heavily exercised as the parsing engine's core sample command by `m3-skeleton` / `m3-suggest` functional assertions, but there is **no** `-h` text comparison or sandbox option verification for it; its consistency with the official documentation rests on the manual comparison procedure above (layer 1). To close the gap: add the same assertions for rebase in any data batch (see the existing patterns in the batch test files);
   - `test/m2-loader-validate.test.mjs` does not duplicate the `-h` comparison (its header comment states this explicitly: offline comparison is gated by the data batch tests).

**How to reuse when extending the base**: after adding a new command entry to `data/commands/`, add the same assertions for it in the matching batch test file (or create a new one following `test/`'s existing prefix convention) — `-h` text comparison (when the output parses cleanly) or sandbox functional verification (when `-h` is incomplete/truncated) — then run `npm test` and `gitcue validate-data` to confirm.

### Local Data & Privacy

All user-level data GitCue produces lives inside `<GITCUE_HOME>` (default `~/.gitcue/`) with no network upload whatsoever:

| File | Content | Privacy notes | Clear / disable |
| --- | --- | --- | --- |
| `usage.json` | usage-frequency counters, format `{"version":1,"counts":{...}}`; keys come in three kinds: `cmd:<command>`, `opt:<option rule ID>`, `dyn:<data type>:<value>` (e.g. branch names) | **records only counts and candidate values, never full command text**; cannot be disabled (feeds candidate ordering) but can be cleared at any time | `gitcue --reset-usage`; writes are debounced by 2s |
| `history.jsonl` | execution history, one JSON object per line: `{"t":<ms timestamp>,"cmd":"<full command text>"}` (no output) | **records full command text** — including commit messages, paths, and possibly sensitive arguments; mind the access control of the machine it lives on | `history_enabled = false` to disable (session-only memory); `history_limit` caps the count |
| `guide-shown` | empty marker file recording that the first-launch guide has been shown | none | delete it to see the guide again on next launch |
| `config.toml`, `commands/` | user configuration and custom command entries | user-created content | delete manually |

## Testing

All tests run offline and build (and clean up) their own git fixtures inside `.sandbox/` (global config disabled, environment variables isolated); the real user home and paths outside the workspace are never touched:

```bash
# 1) Unit tests (npm test ≡ node --test "test/*.test.mjs")
npm test

# 2) Acceptance tests (node scripts/acceptance.mjs): 13 scenarios
#    functional scenarios (completion/candidates/detail/mutex/execution passthrough/
#    corrections/history recall/one-shot output/non-repo degradation/unknown-command degradation)
#    + knowledge-base integrity (25 commands + validate-data)
#    + performance (100k random keystroke replay P95/P99, production-mode render sampling, cold start)
#    + repository integrity check (product file set free of legacy residue, react/ink import whitelist)
npm run acceptance

# 3) Manual smoke test
gitcue "git rebase -i" --plain --debug
```

The acceptance script self-checks at startup that `GITCUE_HOME` lies inside `.sandbox/` and refuses to run otherwise (safety boundary); any failing scenario exits with code 1 and prints details. Performance measurement scope: keystroke replay counts only the synchronous chain of line editing + parsing + candidate computation (asynchronous exec callbacks excluded); rendering goes through the production-mode sampler (`createRenderSampler`); one-shot cold start is measured from spawn to first-screen suggestion output, median of 20 runs.

Reference measurements (Node 22 / Windows dev machine): unit tests ~23s, all 13 acceptance scenarios pass in ~20s; keystroke replay P95≈0.01ms, P99≈0.02ms, render sampling max<21ms, one-shot cold start median ~100ms, REPL first frame median ~0.5s (caused by Ink dependency-import cost, no output meanwhile). Performance figures are sensitive to machine and Node version (render sampling max ranges from ≈15ms to ≈60ms across environments) — treat actual runs as authoritative.

## Repository Layout

```
GitCue/
├── README.md                    # this project's README (Chinese, default)
├── README.en.md                 # English README
├── LICENSE                      # MIT
├── package.json                 # dependencies: ink/react; devDeps: ink-testing-library;
│                                #   scripts: test (node --test glob, full suite) / acceptance / start
├── package-lock.json            # dependencies pinned exactly, reproducible installs
├── bin/
│   └── gitcue.mjs               # CLI entry: argument dispatch, dependency assembly, top-level error handling
├── src/
│   ├── cli/args.mjs             # argument parsing + VERSION
│   ├── config.mjs               # configuration loading (mini-TOML, three-level merge)
│   ├── i18n.mjs                 # UI texts (zh-CN / en-US)
│   ├── log.mjs                  # logging (GITCUE_LOG / --debug)
│   ├── usage.mjs                # usage-frequency statistics (candidate-ordering weight)
│   ├── history.mjs              # session and persisted history
│   ├── kb/
│   │   ├── loader.mjs           # knowledge-base loading/merging/compilation
│   │   └── validate.mjs         # validate-data checks
│   ├── parser/
│   │   ├── lexer.mjs            # lexing (quotes/escapes/active word)
│   │   ├── machine.mjs          # grammar compilation + matching state machine
│   │   ├── skeleton.mjs         # skeleton rendering
│   │   ├── distance.mjs         # Levenshtein edit distance
│   │   └── suggest.mjs          # suggestion pipeline (assembly)
│   ├── providers/
│   │   ├── gitQuery.mjs         # read-only git subprocess wrapper
│   │   ├── kinds.mjs            # collection mapping for the six dynamic data kinds
│   │   └── hub.mjs              # snapshot/cache/invalidation/event hub
│   ├── ui/
│   │   ├── keys.mjs             # ANSI/C0 key decoder
│   │   ├── reducer.mjs          # keystroke reducer (pure function)
│   │   ├── controller.mjs       # REPL controller
│   │   ├── appView.mjs          # five-zone view: pure zone functions + Ink components
│   │   ├── repl.mjs             # REPL terminal assembly: Ink instance/key-listener bridge/raw-mode management
│   │   └── testHarness.mjs      # headless render assertion contract (renderAppLines/samplers, test-path only)
│   └── exec/
│       ├── runner.mjs           # subprocess execution/cancellation/passthrough
│       ├── danger.mjs           # dangerous-command detection
│       └── gitVersion.mjs       # git version probing and comparison
├── data/
│   └── commands/                # 25 built-in command knowledge-base *.json files
├── test/                        # unit tests (module prefixes m1–m6 + data-1/2/3 batches + tui-*)
│   ├── package.json             # test-directory entry shim: since Node v24, node --test <dir> runs the
│   │                            #   directory as a subprocess entry instead of collecting recursively; this file
│   │                            #   (main: index.mjs) makes the directory form run the full suite
│   └── index.mjs                # collection entry of the shim above
├── scripts/
│   └── acceptance.mjs           # acceptance script (13 scenarios: functional / KB integrity / performance / integrity check)
└── .sandbox/                    # test sandbox (auto-created, test artifacts, safe to delete)
```

## Technology Choices

This project is built with **Node.js (≥ 22) + Ink 8** (runtime dependencies are exactly `ink` and `react`, both pinned; devDependencies add `ink-testing-library` as the headless test contract). Reasons:

1. **Declarative TUI**: the five-zone UI is a component tree (bordered layout, inline multi-segment coloring, theme-to-style mapping); differential redraws and terminal-state restoration (cursor, raw-mode handover) are handled by Ink's mature implementation; the keystroke reducer, parsing engine, knowledge base, and providers are decoupled from the rendering layer and independently testable;
2. **Only ink + react as direct runtime dependencies, both needed for local rendering, no network behavior whatsoever** — in line with the fully-offline, local-only principle; the parsing engine, knowledge base, and execution layer are built entirely on Node built-ins, with no third-party libraries beyond the rendering layer; react/ink are dynamically imported only on the REPL path — **the one-shot mode loads neither** (protecting its cold start);
3. **Ample performance headroom**: the knowledge base is just 25 JSON files (millisecond-level loading) and the keystroke pipeline is pure synchronous in-memory computation — 100k random keystroke replays yield P95≈0.01ms, P99≈0.03ms (thresholds 50/100ms) and production-mode render sampling max<21ms (threshold 50ms); one-shot cold start median ~100ms (threshold 300ms); the REPL first frame is bounded by Ink dependency-import cost (median ~0.5s, no output meanwhile).

Conventions: all source and test code uses ESM `.mjs` with **no JSX** (components are built with `React.createElement`; no build chain); the test framework is the built-in `node:test` + `node:assert`; LF line endings, UTF-8 encoding without BOM.

---

License: MIT (see [LICENSE](LICENSE)).
