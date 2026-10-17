# GitCue —— Git 命令行智能提示工具

[English](README.en.md) | 简体中文

GitCue 是一款运行在终端中的 **Git 命令实时提示与辅助输入工具**。它在输入 git 命令的过程中：

1. **实时语法骨架**：按 git 官方文档书写惯例展示当前命令的完整语法结构，已输入部分高亮标注、当前位置醒目标记，并随输入动态收缩；
2. **上下文候选**：在当前位置自动列出语法上合法的后续关键字——子命令、长/短选项、组合短选项、选项枚举值、参数占位符，以及来自本地仓库实时数据的分支/标签/远程/stash/路径；
3. **候选带说明**：每条候选附一行中文说明，`F1` 展开作用详述、典型示例与注意事项；
4. **回车即执行**：命令原样交给本机 git 执行，输出与退出码忠实透传。

一句话定位：**"输入即提示、候选带说明、回车即执行"的 Git 命令学习与效率工具**。

- 零联网、纯本地：所有提示基于内置知识库与本地 git 仓库只读查询，无任何网络行为；
- 轻量依赖：运行时仅 ink 与 react 两项（TUI 渲染层），单次模式不加载；
- 优雅降级：未收录命令、非 git 目录、低版本 git、不支持 ANSI 的终端均不报错、不阻塞输入。

内置 25 个高频命令知识库（完整名单见[知识库覆盖](#知识库覆盖25-个内置命令)），交互（REPL）与单次两种运行模式。

## 快速开始

### 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22 | TUI 层依赖 Ink 8（其自身要求 `engines.node >= 22`）。npm 在低版本下仅警告不阻断安装，但 REPL 交互模式未在 Node < 22 上测试、不承诺可用（`import('ink')` 在未声明的版本区间上可能无法加载或行为异常）；单次模式不加载 react/ink，理论上对 Node 版本不敏感，同样未在 < 22 实测 |
| git | ≥ 2.30 | 低版本不崩溃，仅提示能力受限。知识库 `since` 标注最高到 2.35（`stash` 的 `-S`/`--staged`）：低于对应版本时，相关选项候选会显示「（需 git ≥ x.y）」 |
| 终端 | ANSI 支持 | 目标平台：Windows Terminal、mintty（Git Bash 默认）、macOS Terminal / iTerm2、Linux 常见终端；conhost 等不支持 ANSI 的环境会自动降级纯文本模式 |

### 安装与卸载

```bash
npm install -g @recursive-var/gitcue    # 安装为全局命令
gitcue                                  # 在任意终端输入 gitcue 即可启动
npm uninstall -g @recursive-var/gitcue  # 卸载全局命令（用户数据 ~/.gitcue/ 可按需手动删除）
```

### 交互模式（主模式）

```bash
gitcue
```

进入 REPL 后逐字符监听输入，实时渲染「执行历史 / 输入行 / 语法 / 候选 / 详情 / 状态条」界面（执行历史区在首条命令执行后出现于窗口顶部）：

```
┌ GitCue ─ D:\Code\demo (branch: main) ────────────────────────────┐
│  git> rebase -i origin/ma█                                       │
├ 语法 ──────────────────────────────────────────────────────────────┤
│  git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]      │
│  ───┬─────            ▏                                         │
├ 候选 (5) ─────────────────────────────────────────────────────────┤
│  ► --onto <newbase>    在指定新基点之上重放提交                   │
│    --keep-base         以当前分支与上游共同祖先为基点             │
├ 详情 --onto <newbase> ────────────────────────────────────────────┤
│  把提交重放到 <newbase> 指定的提交之上。例：git rebase --onto main topicA topicB │
├────────────────────────────────────────────────────────────────────┤
│  Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出│
└────────────────────────────────────────────────────────────────────┘
```

常用按键：`Tab` 补全（最长公共前缀 / 高亮候选 / 占位符展开 / 纠错采纳）｜`↑↓` 候选选择；空行（无候选）时 `↑` 回溯历史，回溯中可连续 `↑↓` 浏览，**一旦编辑行内容即退出回溯、`↑↓` 回归候选选择**｜`Enter` 执行（输出形态见下节）｜`F1` 或 `Ctrl+?` 展开详情｜`F2` 展开/收起历史区｜`Esc` 关闭候选 / 清空输入｜`Ctrl+C×2` 或 `Ctrl+Q` 退出｜`Ctrl+U/W/A/E` 行编辑｜`PgUp/PgDn` 候选翻页。非 `git` 开头的命令同样支持提示执行与历史记录（能力边界见下节）。**输入行光标**：ANSI 终端下以约 530ms 间隔在醒目块 `█` 与细条 `▏` 间闪烁（两种形态都反色标示插入位置）——行尾是否已敲空格、光标停在哪个字符上一目了然；纯文本降级模式下恒显 `▏`。

首次启动显示 5 行按键引导，任意键继续，此后不再出现。界面底部状态条常驻一行核心按键提示（`hint_bar = true` 默认显示，可配置隐藏），完整按键表可随时在另一终端运行 `gitcue --help` 或查阅本文。

#### REPL 内执行命令（输出形态与能力边界）

Enter 后整行原样交给系统 shell 执行（`src/exec/runner.mjs`：`spawn(commandLine, { shell: true })`，无隐式改写）。**默认透传形态（`exec_output = "passthrough"`）**：执行时窗口整块擦除（Ink `suspendTerminal`，精确按帧擦除、不留残帧），原地写出 `$ <命令行>` 原生回显（命中高危警示时附一行警示文案），子进程 stdio inherit 直写终端（保留颜色与完全交互）；结束后在输出下方重绘**唯一的活动窗口**。因此回滚缓冲里留下的只有「`$ 命令` + 输出」这样的原生历史（与不用 gitcue 直接在终端敲 git 完全一致），可随时向上滚动翻看，屏幕上任意时刻只有一个 gitcue 窗口。两种形态均支持：管道/重定向等 shell 语法按系统 shell 语义执行；每条命令独立子进程（`cd` 不延续）；空行 Enter 忽略；环境注入 `GIT_PAGER`/`PAGER`（默认 `cat`）与 `GIT_TERMINAL_PROMPT=0`。

**内联形态（`exec_output = "inline"`，单窗口常驻形态，可配置切换）**：

- **常驻单窗口**：执行期间界面不卸载，已执行的命令与输出按时间序累积显示在**窗口顶部历史区**（`$ git status` + 输出行，非零退出码缀 `✘ exit N`），不再在终端里逐次下移重画新窗口；
- **执行后输入行自动清空**，立即可输入下一条；历史区默认显示最近若干行（`log_height = 10`），超出的行保尾弃头并标记「…（更早 N 行已省略，F2 展开）」，`F2` 在 1×/3× 间切换；**历史区行数会按终端实际高度自动收缩**（预算 = 终端行数 − 其余区域开销，保底 1 行最新内容），防止窗口顶部内容在矮终端上被滚出视口；
- **输出捕获**：子进程 stdout/stderr 合并捕获进历史区（长输出节流重绘、单条超长保尾截断；输出以文本形态展示，子进程检测到管道后自动关闭颜色——需要原色输出时用透传形态）；执行结果与直接运行的一致性由验收场景逐字节断言保障；
- **交互式命令（行式提示可用）**：执行期间可打印按键、回车、退格、方向键等经转发写入子进程 stdin，`git add -p` 的 y/n/q 应答类提示可用——子进程 stdin 为管道、无终端回显，工具在历史区以回显行代为显示输入；全屏式交互程序（vim 类）与 Windows 下直接读控制台凭据的提示不适用，此类场景请用透传形态或先在终端外完成鉴权；
- **Ctrl+C 中断子进程**并返回输入态（Windows 经 `taskkill /T /F` 树杀），被中断命令退出码 130 上屏。

因此可以把它当**不记忆目录的 mini-shell** 用：适合 `git …`、`node -v`、`ls | head` 这类一次性命令；不适合依赖目录状态延续（`cd`）或多行脚本的场景。

### 单次模式

对整条命令做一次性解析，输出建议文本后退出（不执行），适合预览、调试与脚本集成：

```bash
$ gitcue "git log --on" --plain
语法: git log [-n | --max-count <num>] [--oneline] [--graph] [--all] [-p | --patch] [--stat] [--decorate] [--author <pattern>] [--since | --after <date>] [--until | --before <date>] [--pretty | --format <format>] [--name-only] [--follow] [--reverse] [<revision-range>] [<path>...]
匹配: git ✓  log ✓  --on ▶
位置: 选项名（--on*）
候选(1):
  --oneline  每条提交压成一行显示
提示: （无）
```

- `--exec`：输出建议后附带执行该命令，退出码透传（如 `gitcue "git status" --exec`）；
- `--strict`：存在未识别 Token 时退出码 2（默认 0）；
- `--plain`：强制关闭 ANSI（stdout 非终端时自动关闭）；
- `--lang en-US`：界面框架文案切换英文（知识库说明仍为中文）。

### 其他命令

| 命令 | 作用 |
| --- | --- |
| `gitcue --help` / `--version` | 标准帮助 / 版本号 |
| `gitcue validate-data` | 校验内置知识库 + 自定义条目（贡献者工具） |
| `gitcue config` | 显示配置文件路径与当前生效配置 |
| `gitcue --reset-usage` | 清除使用频率统计文件 |
| `--debug`（任意模式附加） | stderr 输出解析轨迹与各阶段耗时；也可用环境变量 `GITCUE_LOG=debug` |

### 配置文件

用户级 `<GITCUE_HOME>/config.toml`（默认 `~/.gitcue/config.toml`，可用环境变量 `GITCUE_HOME` 重定位，Windows 为 `%USERPROFILE%\.gitcue\`），项目级 `.gitcue.toml` 覆盖用户级，命令行 `--lang` 优先级最高。**语法范围（mini-TOML，勿照标准 TOML 全集写）**：解析器仅支持 `key = 标量` 行与 `#` 注释（`#` 仅在双引号字符串外生效）；标量只有四种——双引号字符串（转义仅支持 `\"` 与 `\\`）、`true` / `false`、十进制整数（`src/config.mjs`）。**不支持**数组、浮点数、多行字符串、嵌套表、内联表等标准 TOML 语法——写了这些会解析失败，落入「非法配置项启动时 stderr 告警并回退默认值」路径（不阻塞使用，但该项配置不生效）。本项目全部默认配置都只用到上述四种标量。**项目级文件的查找规则**：只检查启动 gitcue 时进程所在目录（当前工作目录）下的 `.gitcue.toml`，不向上递归父目录、也不按 git 仓库根定位——请在仓库根目录启动 gitcue，或把文件放在实际工作目录。可用配置项：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `lang` | `"zh-CN"` | 界面语言（`zh-CN` / `en-US`） |
| `candidate_limit` | `8` | 候选同屏条数 |
| `theme` | `"default"` | 主题（`default` / `contrast` / `none`，`none` 强制纯文本） |
| `enter_action` | `"exec"` | Enter 行为（`exec` 执行 / `complete` 优先补全） |
| `history_enabled` | `true` | 历史持久化开关 |
| `history_limit` | `1000` | 历史条数上限 |
| `danger_warning` | `true` | 高危命令状态栏警示开关（只提示不拦截）。**警示规则固定为 4 条**（`push --force`/`-f`、`reset --hard`、`clean -f`+`-d`、`branch -D`），硬编码于 `src/exec/danger.mjs`，**不支持自定义或扩展**；本开关仅能整体关闭，增删规则需修改源码 |
| `dynamic_cache_seconds` | `30` | 动态数据缓存时长（秒） |
| `custom_command_dir` | `""` | 自定义命令目录（空 = `<GITCUE_HOME>/commands`） |
| `pager` | `"cat"` | 执行命令时注入子进程的 `GIT_PAGER`/`PAGER`，使 git 分页输出直通、在界面内展示。**Windows 注意**：cmd/PowerShell 本身没有 `cat` 命令，但这不影响本默认值——git 由自身捆绑环境解析并启动分页器（`GIT_PAGER=cat git --paginate log` 在 PATH 仅含 git 目录时仍正常直通输出）；若你希望 REPL 内仍用交互式分页器，可改为 `less` 等，但全屏分页器会接管屏幕、与界面重绘相互干扰，不建议 |
| `hint_bar` | `true` | 底部按键提示条 |
| `exec_output` | `"passthrough"` | 执行输出形态：`passthrough` 执行时让位终端原样透传（默认，保留颜色与完全交互，输出留在终端回滚缓冲可上滚查看）；`inline` 捕获进窗口顶部历史区（常驻单窗口形态） |
| `log_height` | `10` | 历史区默认显示行数（`F2` 展开为 3 倍，1–50） |

非法配置项启动时 stderr 告警并回退默认值，不阻塞使用。

## 知识库结构与自定义扩展

### 知识库覆盖（25 个内置命令）

`data/commands/` 一文件一命令，当前 25 个：

`add` `branch` `checkout` `cherry-pick` `clone` `commit` `config` `diff` `fetch` `init` `log` `merge` `mv` `pull` `push` `rebase` `remote` `reset` `restore` `revert` `show` `stash` `status` `switch` `tag`

常见问询：**`worktree` 不在内置知识库内**；未收录命令输入时不报错，退化为纯执行模式（语法区显示「未收录，直接执行」）。`stash` / `remote` 等含子动作的命令以字面量分支建模（如 `git stash push`、`git remote add`）。

### 条目结构

知识库为结构化 JSON，一文件一命令，位于 `data/commands/<command>.json`（内置）或 `<GITCUE_HOME>/commands/*.json`（自定义）。条目示例（节选自内置 `data/commands/rebase.json`）：

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

要点：

- **顶层字段**：`schemaVersion`（当前 `"1.0"`，程序向前兼容一个次版本）、`command`、`category`（`porcelain`/`plumbing`/`custom`）、`popularity`（1–5 常用度，参与候选排序）、`summary`（≤ 40 码点）、`grammar`、`examples`、`notes`；
- **grammar 四类节点**：`option`（选项，支持 `aliases`/`param`/`mutex` 互斥组/`repeatable`/`since` 版本标注）、`positional`（位置参数占位符）、`literal`（字面量子命令，如 `stash push`，带 `then` 分支语法）、`group`（`mutex`/`repeat` 组）；
- **param.kind 六种动态数据源**：`branch` / `tag` / `remote` / `stash` / `pathspec`（对应本地仓库实时查询）与 `commit`（派生自 HEAD、分支、标签），另有 `enum`（静态枚举）与 `text`（自由文本）；
- **语法骨架由 grammar 生成**（数据文件不存手写骨架串），从源头保证与官方语法一致、避免双源漂移；
- **`since` 版本标注**：如 `"since": "2.23"`，本机 git 版本低于该值时候选行追加 `（需 git ≥ 2.23）`。

### 自定义命令

把 JSON 条目放入 `<GITCUE_HOME>/commands/`（默认 `~/.gitcue/commands/`；也可在 config.toml 用 `custom_command_dir` 改指他处）：

- **同名覆盖**：条目 `command` 字段与内置命令同名时，覆盖内置条目；
- **新名新增**：新命令名直接进入子命令候选，可为本公司自定义子命令（如 `git-deploy`）编写语法与中文说明；
- 文件名不强制等于命令名，以条目 `command` 字段为准；
- 自定义条目缺 `schemaVersion` 时视为 `"1.0"` 接受并告警；解析失败的条目跳过并告警，不影响其他命令。

### 数据校验

```bash
gitcue validate-data   # 校验内置 + 自定义条目：0 错误退出码 0，有错误逐条打印并退出码 2
```

校验内容包括：JSON 可解析、schemaVersion 兼容、字段类型与格式（选项 key、枚举非空、`popularity` 1–5、`summary` ≤ 40 码点、`detail` ≤ 3 句、`since` 格式），以及互斥/别名/隐式否定（`--no-x`）展开集合两两不相交的冲突检测。

### 官方一致性校验规程

知识库语法与 git 官方一致性由以下两层规程保障：

1. **编写时人工比对**（每个数据批次入库时执行）：条目编写与本机 `git <cmd> -h`（只读帮助命令）的选项集合与用法行逐项人工比对。
2. **自动化断言**（随 `npm test` 运行，比对结果即测试的通过/失败，无独立报告文件）。三个数据批次各认领 8 个命令（以下名单实读自各测试文件的 `COMMANDS` 数组）：
   - `test/data-1.test.mjs`（`add` `branch` `checkout` `cherry-pick` `clone` `commit` `config` `diff`）：前 6 个命令做 `-h` 文本自动比对（`--[no-]x` 形式归一化 + `--no-x` 基名回退 + token 边界匹配）；`diff` 与 `config` 因本机 `-h` 输出特性（diff 的 `-h` 缺 `--staged` 等、config 2.46+ 不再列旧式标志）改用解析式校验（声明的选项能被真实 git 接受）——8 个命令全员覆盖；
   - `test/data-2.test.mjs`（`fetch` `init` `log` `merge` `mv` `pull` `push` `remote`）：8 条目 `-h` 归一化比对，另加沙箱仓库功能验证——每个选项的全部形式真实调用 git 并断言不报 unknown option（含伪造选项的阴性对照，防假绿）；
   - `test/data-3.test.mjs`（`reset` `restore` `revert` `show` `stash` `status` `switch` `tag`）：8 条目中 7 个 `-h` 逐名比对；`show` 因 git 2.55 的 `-h` 输出被截断，改沙箱真实验证（每选项退出码 0 + 未知选项阴性对照）；
   - **覆盖缺口（如实登记）**：8 + 8 + 8 = 24，第 25 个命令 **`rebase` 不在任何数据批次的一致性比对内**——它的条目随 `test/m2-loader-validate.test.mjs` 的全量加载做结构校验，并作为解析引擎测试的核心样本命令被 `m3-skeleton` / `m3-suggest` 大量功能断言使用，但**没有** `-h` 文本比对或沙箱选项验证，其语法与官方文档的一致性依赖编写时的人工比对规程（上述第 1 层）。补齐方式：为 rebase 在任一数据批次追加同款断言即可（见各批次测试文件的现有写法）；
   - `test/m2-loader-validate.test.mjs` 不重复 `-h` 比对（该文件头注明确：离线比对由 data 批次测试承担门禁）。

**扩库时如何复用**：新命令条目加入 `data/commands/` 后，在对应批次测试文件（或按 `test/` 现有前缀规则新建）为该命令添加同款断言——`-h` 文本比对（输出可正常解析时）或沙箱功能验证（`-h` 缺项/截断时），再运行 `npm test` 与 `gitcue validate-data` 确认。

### 本地数据与隐私

GitCue 产生的全部用户级数据都在 `<GITCUE_HOME>`（默认 `~/.gitcue/`）内，无任何网络上传：

| 文件 | 内容 | 隐私要点 | 清除/关闭 |
| --- | --- | --- | --- |
| `usage.json` | 使用频率计数，格式 `{"version":1,"counts":{...}}`，键为三类：`cmd:<命令名>`、`opt:<选项规则ID>`、`dyn:<数据类型>:<值>`（如分支名） | **只记录计数与候选值，不含完整命令文本**；不可关闭（参与候选排序加权），可随时清除 | `gitcue --reset-usage`；写入有 2s 防抖 |
| `history.jsonl` | 执行历史，每行 `{"t":<毫秒时间戳>,"cmd":"<完整命令文本>"}`（不含输出） | **记录完整命令文本**——含提交信息、路径、可能出现的敏感参数，注意所在机器的访问控制 | `history_enabled = false` 关闭（仅会话内记忆）；`history_limit` 限条数 |
| `guide-shown` | 空标记文件，记录首次引导已展示 | 无 | 删除后下次启动重新显示引导 |
| `config.toml`、`commands/` | 用户配置与自定义命令条目 | 用户自建内容 | 手动删除 |

## 测试方法

全部测试离线运行、自动在 `.sandbox/` 内自建自清 git 夹具（禁用全局配置、隔离环境变量），不触碰真实用户主目录与工作区外路径：

```bash
# 1) 单元测试（npm test 等价于 node --test "test/*.test.mjs"）
npm test

# 2) 验收测试（node scripts/acceptance.mjs）：13 个场景
#    功能场景（补全/候选/详情/互斥/执行透传/纠错/历史回溯/单次输出/非仓库降级/未收录降级）
#    + 知识库完整性（25 命令 + validate-data）
#    + 性能（10 万次随机按键回放 P95/P99、生产模式渲染抽样、冷启动）
#    + 仓库完整性核查（产品文件集旧内容零残留、react/ink import 白名单）
npm run acceptance

# 3) 手工冒烟
gitcue "git rebase -i" --plain --debug
```

验收脚本启动即自检 `GITCUE_HOME` 必须位于 `.sandbox/` 内，否则拒绝运行（安全边界）；任一场景失败退出码 1 并打印明细。性能场景的测量口径：按键回放只计行编辑 + 解析 + 候选计算的同步链路（异步 exec 回调不计入）；渲染走生产模式采样器（`createRenderSampler`）；冷启动单次模式以 spawn 到首屏建议输出为口径、20 次取中位。

参考实测（Node 22 / Windows 开发机）：单元测试约 23s、验收 13 场景约 20s 全部通过；按键回放 P95≈0.01ms、P99≈0.02ms，渲染抽样 max<21ms，冷启动单次模式中位约 100ms，REPL 首帧中位约 0.5s（Ink 依赖导入成本所致，期间无输出）。性能数字对机器与 Node 版本敏感（渲染抽样 max 在不同环境可从 ≈15ms 到 ≈60ms 不等），以实际运行为准。

## 目录结构

```
GitCue/
├── README.md                    # 本文件（中文，默认）
├── README.en.md                 # 英文版 README
├── LICENSE                      # MIT
├── package.json                 # dependencies: ink/react；devDeps: ink-testing-library；
│                                #   scripts: test（node --test glob 全量）/ acceptance（验收）/ start
├── package-lock.json            # 依赖精确 pin，安装可复现
├── bin/
│   └── gitcue.mjs               # CLI 入口：参数分派、依赖装配、顶层错误兜底
├── src/
│   ├── cli/args.mjs             # 参数解析 + VERSION
│   ├── config.mjs               # 配置加载（mini-TOML 三级合并）
│   ├── i18n.mjs                 # 界面文案（zh-CN / en-US）
│   ├── log.mjs                  # 日志（GITCUE_LOG / --debug）
│   ├── usage.mjs                # 使用频率统计（候选排序加权）
│   ├── history.mjs              # 会话与持久化历史
│   ├── kb/
│   │   ├── loader.mjs           # 知识库加载/合并/编译
│   │   └── validate.mjs         # validate-data 校验
│   ├── parser/
│   │   ├── lexer.mjs            # 词法（引号/转义/活动词）
│   │   ├── machine.mjs          # 语法编译 + 匹配状态机
│   │   ├── skeleton.mjs         # 骨架渲染
│   │   ├── distance.mjs         # Levenshtein 编辑距离
│   │   └── suggest.mjs          # 建议管线（总装）
│   ├── providers/
│   │   ├── gitQuery.mjs         # 只读 git 子进程封装
│   │   ├── kinds.mjs            # 六类动态数据采集映射
│   │   └── hub.mjs              # 快照/缓存/失效/事件中枢
│   ├── ui/
│   │   ├── keys.mjs             # ANSI/C0 键解码器
│   │   ├── reducer.mjs          # 按键 reducer（纯函数）
│   │   ├── controller.mjs       # REPL 控制器
│   │   ├── appView.mjs          # 五区视图：zone 纯函数 + Ink 组件形态
│   │   ├── repl.mjs             # REPL 终端装配层：Ink 实例/键监听桥/raw mode 自管
│   │   └── testHarness.mjs      # 无头渲染断言契约（renderAppLines/采样器，仅测试路径加载）
│   └── exec/
│       ├── runner.mjs           # 子进程执行/取消/透传
│       ├── danger.mjs           # 高危命令检测
│       └── gitVersion.mjs       # git 版本探测与比较
├── data/
│   └── commands/                # 25 个内置命令知识库 *.json
├── test/                        # 单元测试（模块前缀 m1–m6 + data-1/2/3 数据批次 + tui-*）
│   ├── package.json             # test 目录入口垫片：Node v24 起 node --test <目录> 会把目录当子进程入口
│   │                            #   执行而非递归收集，本文件（main: index.mjs）使目录形态汇集运行全部测试
│   └── index.mjs                # 同上垫片的汇集入口
├── scripts/
│   └── acceptance.mjs           # 验收脚本（13 场景：功能 / 知识库完整性 / 性能 / 完整性核查）
└── .sandbox/                    # 测试沙箱（自动创建，测试产物，可整体删除）
```

## 技术选型说明

本项目以 **Node.js（≥ 22）+ Ink 8** 实现（运行时依赖 ink 与 react 两项，均为精确 pin；devDependencies 另有 `ink-testing-library` 作无头测试契约）。理由：

1. **声明式 TUI**：五区界面为组件树（边框布局、行内多段着色、主题样式映射），差分重绘与终端状态恢复（光标、raw mode 交接）交由 Ink 成熟实现；按键 reducer、解析引擎、知识库、providers 等状态层与渲染层解耦，可独立测试；
2. **运行时仅 ink + react 两项直接依赖，均为本地渲染所需，无任何网络行为**——与零联网、纯本地原则保持契合；解析引擎、知识库、执行层全部基于 Node 内置模块，渲染层之外不引入第三方库；react/ink 仅在 REPL 路径动态 import，**单次模式不加载**（保障单次模式冷启动）；
3. **性能余量充足**：知识库仅 25 个 JSON 文件（毫秒级加载），按键管线为纯同步内存计算——10 万次随机按键回放 P95≈0.01ms、P99≈0.03ms（阈值 50/100ms），生产模式渲染抽样 max<21ms（阈值 50ms）；冷启动单次模式中位约 100ms（阈值 300ms）；REPL 首帧受 Ink 依赖导入成本约束（中位约 0.5 秒，期间无输出）。

配套约定：全部源码与测试使用 ESM `.mjs`、**无 JSX**（组件一律 `React.createElement`，无构建链）；测试框架为内置 `node:test` + `node:assert`；换行 LF、编码 UTF-8（无 BOM）。

---

许可：MIT（见 [LICENSE](LICENSE)）。
