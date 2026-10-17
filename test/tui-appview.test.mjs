/**
 * appView 五区视图单元测试。
 *
 * 覆盖：
 *  - 黄金快照：renderPlainLines 对一组代表性 state 的输出逐字节断言
 *    （基线冻结为测试数据，见 GOLDEN）；
 *  - 五区顺序与标签、分页标题、CJK 列对齐（▏ 列位置，口径 padWidth）、详情展开三要素、
 *    淡出判断（注入 state.now）的纯文本断言；
 *  - ANSI 形态存在性：renderAppFrame 非空且含 Ink 边框字形（限形态断言）；
 *  - sgr→Ink 样式映射表静态常量断言（固定契约）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPlainLines,
  buildSyntaxZone,
  buildCandidatesZone,
  buildDetailZone,
  buildStatusSegs,
  buildLogZone,
  titleText,
  inputSegs,
  padWidth,
  padEndW,
  truncateW,
  firstSentence,
  STRINGS,
  INK_STYLES,
  FADE_MS,
} from '../src/ui/appView.mjs';
import { renderAppFrame } from '../src/ui/testHarness.mjs';
import { createInitialState } from '../src/ui/reducer.mjs';

const SK_TEXT = 'git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]';

/** 与生产 appView.t 同语义的文案函数（zone 纯函数测试用） */
function tt(lang) {
  return (key, params = {}) => {
    const table = STRINGS[lang] || STRINGS['zh-CN'];
    let s = table[key] !== undefined ? table[key] : STRINGS['zh-CN'][key];
    if (s === undefined) return key;
    s = s.replace(/\{(\w+)\}/g, (m, name) => (params[name] !== undefined ? String(params[name]) : m));
    return s;
  };
}

/** 构造带 rebase 场景视图的状态（与黄金快照生成器同构） */
function scenarioState(overrides = {}) {
  const view = {
    isGit: true,
    covered: true,
    phase: 'options',
    commandName: 'rebase',
    tokens: [],
    active: null,
    marks: [],
    corrections: [],
    positionLabel: '选项名（--on*）',
    skeleton: {
      text: SK_TEXT,
      marks: [{ start: 12, end: 14, patternId: 'rebase:opt:-i', state: 'consumed' }],
      cursor: 35, // 指向 [<upstream>] 之前
    },
    candidates: [
      {
        text: '--onto',
        paramHint: '<newbase>',
        summary: '把提交重放到指定新基点上',
        kind: 'option',
        patternId: 'rebase:opt:--onto',
        placeholderKind: null,
        popularity: 3,
        usage: 0,
        since: null,
        insert: null,
        detail: '不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。',
        example: 'git rebase --onto main topicA topicB',
      },
      { text: '--keep-base', summary: '以当前分支与上游共同祖先为基点', kind: 'option', patternId: 'rebase:opt:--keep-base', insert: null },
      { text: '--fork-point', summary: '用 reflog 找出的分叉点作上游', kind: 'option', patternId: 'rebase:opt:--fork-point', insert: null },
      { text: '<branch>', summary: '要变基的分支（默认当前分支）', kind: 'placeholder', placeholderKind: 'branch', insert: '' },
    ],
    debug: { timingsMs: {} },
  };
  const state = {
    ...createInitialState({
      config: {},
      repo: { isRepo: true, branch: 'main', cwd: 'D:\\demo' },
      now: 1000,
    }),
    line: 'git rebase -i ',
    cursor: 14,
    view,
  };
  return { ...state, ...overrides };
}

// ───────────────── 黄金快照（基线冻结为测试数据） ─────────────────
// renderPlainLines 必须逐字节复现这些行。
const GOLDEN = [
  // 黄金基线：24 个代表性 state（rebase 骨架/F1 展开/纠错置顶/非仓库/guide/超宽截断/分页/
  // 收起/淡出/danger/running/en-US/待填提示/view null/hint_bar=false/notes/CJK/暂无说明/exited/未收录/引导）
  { name: "rebase-五区全景", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "F1-详情展开", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":true,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","      例：git rebase --onto main topicA topicB","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "纠错置顶", state: {"mode":"input","line":"git chekcout ","cursor":12,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"unknown","commandName":null,"tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"checkout","kind":"correction","insert":"checkout","summary":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git chekcout▏ ","语法: 输入子命令，↓ 浏览全部","候选(1):","  ► Did you mean: checkout? (Tab 采纳)","说明: （暂无说明）","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "非仓库标题", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":false,"branch":null,"cwd":"D:\\tmp"},"now":1000}, lines: ["GitCue ─ D:\\tmp （当前目录不是 git 仓库）","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "guide 态", state: {"mode":"guide","line":"","cursor":0,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["  GitCue：输入 git 命令，实时获得语法与候选提示","  Tab 补全 │ ↑↓ 选择 │ Enter 执行 │ F1 详情","  ↑（空行）回溯历史 │ Esc 清空 │ Ctrl+C×2 或 Ctrl+Q 退出","  输入非 git 命令将直接执行","  按任意键继续"] },
  { name: "超宽骨架截断", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git log --opt0 --opt1 --opt2 --opt3 --opt4 --opt5 --opt6 --opt7 --opt8 --opt9 --opt10 --opt11 --opt12 --opt13 --opt14 --opt15 --opt16 --opt17 --opt18 --opt19 --opt20 --opt21 --opt22 --opt23 --opt24 --opt25 --opt26 --opt27 --opt28 --opt29","marks":[],"cursor":null},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git log --opt0 --opt1 --opt2 --opt3 --opt4 --opt5 --opt6 --opt7 --opt8…","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "分页第2页", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":3,"page":1,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"opt0","summary":"说明0","kind":"option","insert":null},{"text":"opt1","summary":"说明1","kind":"option","insert":null},{"text":"opt2","summary":"说明2","kind":"option","insert":null},{"text":"opt3","summary":"说明3","kind":"option","insert":null},{"text":"opt4","summary":"说明4","kind":"option","insert":null},{"text":"opt5","summary":"说明5","kind":"option","insert":null},{"text":"opt6","summary":"说明6","kind":"option","insert":null},{"text":"opt7","summary":"说明7","kind":"option","insert":null},{"text":"opt8","summary":"说明8","kind":"option","insert":null},{"text":"opt9","summary":"说明9","kind":"option","insert":null}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":3,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(10) 2/4页:","  ► opt3  说明3","     opt4  说明4","     opt5  说明5","说明: 说明3","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "Esc 收起", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":true,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "exit0 淡出窗口内", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":{"code":0,"at":1000},"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出 │ ✔ exit 0"] },
  { name: "exit128", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":{"code":128,"at":1000},"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出 │ ✘ exit 128"] },
  { name: "exit0 已淡出(now=2501)", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":{"code":0,"at":1000},"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":2501}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "danger 优先于 exit", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":{"code":0,"at":1000},"danger":{"message":"⚠ 强制推送将覆盖远端历史","at":1000},"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出 │ ⚠ 强制推送将覆盖远端历史"] },
  { name: "running 态（已执行命令不再占用输入行，命令与输出在历史区）", state: {"mode":"running","line":"","cursor":0,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"git status","execLog":[{"cmd":"git status","output":"On branch main\nnothing to commit, working tree clean\n","echo":"","code":null,"at":1000}],"logExpanded":false,"view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true,"exec_output":"inline","log_height":10},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","历史(1):","  $ git status …运行中","  On branch main","  nothing to commit, working tree clean","输入: ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出 │ …运行中"] },
  { name: "en-US", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"en-US","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","Input: git rebase -i ▏","Syntax: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ typed                └ current position","Candidates(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","Detail: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。","Status: Tab complete │ ↑↓ select │ F1 detail │ Enter run │ Esc clear │ Ctrl+Q quit"] },
  { name: "optionParam 待填提示", state: {"mode":"input","line":"git rebase --onto ","cursor":18,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"optionParam","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"--onto 的参数 <newbase>","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase --onto <newbase>▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "view 为 null", state: {"mode":"input","line":"","cursor":0,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":null,"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: ▏","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "hint_bar=false", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"hint_bar":false},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。"] },
  { name: "notes 注意事项展开", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":true,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"rebase","summary":"在另一个基持之上重放提交","kind":"command","patternId":null,"insert":null,"detail":null,"example":"git rebase -i HEAD~3","notes":["变基会改写提交历史，已推送的分支慎用","冲突后先 git add 再 --continue"]}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(1):","  ► rebase  在另一个基持之上重放提交","说明: 在另一个基持之上重放提交","      例：git rebase -i HEAD~3","      注意：变基会改写提交历史，已推送的分支慎用","      注意：冲突后先 git add 再 --continue","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "CJK 对齐", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"中文分支","summary":"说明一","kind":"dynamic","placeholderKind":"branch","insert":null},{"text":"en","summary":"说明二","kind":"dynamic","placeholderKind":"branch","insert":null}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(2):","  ► 中文分支  说明一","     en        说明二","说明: 说明一","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "暂无说明兜底", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--x","kind":"option","insert":null}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(1):","  ► --x   （暂无说明）","说明: （暂无说明）","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "exited 态", state: {"mode":"exited","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: [] },
  { name: "未收录命令", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":false,"commandName":"mytool","phase":"uncovered","candidates":[],"skeleton":{"text":"","marks":[],"cursor":null}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git <command> [args...]（未收录，直接执行）","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "git 后无子命令", state: {"mode":"input","line":"git ","cursor":4,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":false,"commandName":null,"phase":"command","candidates":[{"text":"status","kind":"command","summary":"显示工作区状态","insert":null}],"skeleton":{"text":"","marks":[],"cursor":null}},"config":{"lang":"zh-CN","candidate_limit":8,"theme":"default","enter_action":"exec","history_enabled":true,"history_limit":1000,"danger_warning":true,"dynamic_cache_seconds":30,"custom_command_dir":"","pager":"cat","hint_bar":true},"lang":"zh-CN","plain":true,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git ▏","语法: 输入子命令，↓ 浏览全部","候选(1):","  ► status  显示工作区状态","说明: 显示工作区状态","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
  { name: "theme=none 等价 plain", state: {"mode":"input","line":"git rebase -i ","cursor":14,"selected":0,"page":0,"detailOpen":false,"dismissed":false,"historyList":[],"historyIndex":null,"historyDraft":"","ctrlcCount":0,"lastExit":null,"danger":null,"notice":null,"runningLine":"","view":{"isGit":true,"covered":true,"phase":"options","commandName":"rebase","tokens":[],"active":null,"marks":[],"corrections":[],"positionLabel":"选项名（--on*）","skeleton":{"text":"git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","marks":[{"start":12,"end":14,"patternId":"rebase:opt:-i","state":"consumed"}],"cursor":35},"candidates":[{"text":"--onto","paramHint":"<newbase>","summary":"把提交重放到指定新基点上","kind":"option","patternId":"rebase:opt:--onto","placeholderKind":null,"popularity":3,"usage":0,"since":null,"insert":null,"detail":"不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。","example":"git rebase --onto main topicA topicB"},{"text":"--keep-base","summary":"以当前分支与上游共同祖先为基点","kind":"option","patternId":"rebase:opt:--keep-base","insert":null},{"text":"--fork-point","summary":"用 reflog 找出的分叉点作上游","kind":"option","patternId":"rebase:opt:--fork-point","insert":null},{"text":"<branch>","summary":"要变基的分支（默认当前分支）","kind":"placeholder","placeholderKind":"branch","insert":""}],"debug":{"timingsMs":{}}},"config":{"theme":"none"},"lang":"zh-CN","plain":false,"repo":{"isRepo":true,"branch":"main","cwd":"D:\\demo"},"now":1000}, lines: ["GitCue ─ D:\\demo (branch: main)","输入: git rebase -i ▏","语法: git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]","              ┬                      ▏","              └ 已输入                  └ 当前位置","候选(4):","  ► --onto <newbase>  把提交重放到指定新基点上","     --keep-base       以当前分支与上游共同祖先为基点","     --fork-point      用 reflog 找出的分叉点作上游","  ▸ <branch>          要变基的分支（默认当前分支）","说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。","状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出"] },
];

describe('tui-appview 黄金快照：renderPlainLines 与旧 renderPlain 逐字节兼容', () => {
  for (const c of GOLDEN) {
    it(c.name, () => {
      assert.deepEqual(renderPlainLines(c.state), c.lines);
    });
  }
  it('plain 标志不影响输出（renderPlainLines 恒为纯文本路径）', () => {
    const s = scenarioState();
    assert.deepEqual(renderPlainLines({ ...s, plain: false }), renderPlainLines({ ...s, plain: true }));
    assert.deepEqual(renderPlainLines({ ...s, config: { ...s.config, theme: 'contrast' } }), renderPlainLines(s));
  });
});

// ───────────────── 五区结构 ─────────────────

describe('tui-appview 五区分行与降级', () => {
  it('五区分行：输入/语法/候选/说明/状态（逐字节）', () => {
    const lines = renderPlainLines(scenarioState({ plain: true }));
    assert.deepEqual(lines, [
      'GitCue ─ D:\\demo (branch: main)',
      '输入: git rebase -i ▏',
      `语法: ${SK_TEXT}`,
      '  ' + ' '.repeat(12) + '┬' + ' '.repeat(22) + '▏',
      '  ' + ' '.repeat(12) + '└ 已输入' + ' '.repeat(18) + '└ 当前位置',
      '候选(4):',
      '  ► --onto <newbase>  把提交重放到指定新基点上',
      '     --keep-base       以当前分支与上游共同祖先为基点',
      '     --fork-point      用 reflog 找出的分叉点作上游',
      '  ▸ <branch>          要变基的分支（默认当前分支）',
      '说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。',
      '状态: Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出',
    ]);
  });
  it('纯文本零转义序列', () => {
    const lines = renderPlainLines(scenarioState({ plain: true }));
    assert.ok(!lines.some((l) => l.includes('\x1b')));
  });
  it('非仓库标题文案', () => {
    const lines = renderPlainLines(
      scenarioState({ plain: true, repo: { isRepo: false, branch: null, cwd: 'D:\\tmp' } }),
    );
    assert.equal(lines[0], 'GitCue ─ D:\\tmp （当前目录不是 git 仓库）');
  });
  it('guide 态：≤5 行引导文案', () => {
    const s = { ...scenarioState({ plain: true }), mode: 'guide', line: '', cursor: 0 };
    const lines = renderPlainLines(s);
    assert.equal(lines.length, 5);
    assert.equal(lines[0], '  GitCue：输入 git 命令，实时获得语法与候选提示');
    assert.equal(lines[4], '  按任意键继续');
  });
  it('未收录命令语法区文案', () => {
    const s = scenarioState({ plain: true, view: { isGit: true, covered: false, commandName: 'mytool', phase: 'uncovered', candidates: [], skeleton: { text: '', marks: [], cursor: null } } });
    const lines = renderPlainLines(s);
    assert.ok(lines.some((l) => l === '语法: git <command> [args...]（未收录，直接执行）'));
  });
  it('git 后无子命令：语法区引导文案', () => {
    const s = scenarioState({ plain: true, line: 'git ', cursor: 4, view: { isGit: true, covered: false, commandName: null, phase: 'command', candidates: [{ text: 'status', kind: 'command', summary: '显示工作区状态', insert: null }], skeleton: { text: '', marks: [], cursor: null } } });
    const lines = renderPlainLines(s);
    assert.ok(lines.some((l) => l === '语法: 输入子命令，↓ 浏览全部'));
  });
  it('view 为 null：仅输入与状态行', () => {
    const lines = renderPlainLines(scenarioState({ plain: true, line: '', cursor: 0, view: null }));
    assert.equal(lines.length, 3);
    assert.equal(lines[1], '输入: ▏');
  });
  it('F1 展开：详情全文 + 示例行', () => {
    const lines = renderPlainLines(scenarioState({ plain: true, detailOpen: true }));
    assert.equal(lines[10], '说明: 不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。');
    assert.equal(lines[11], '      例：git rebase --onto main topicA topicB');
  });
  it('F1 展开：候选携带 notes → 逐条渲染「注意：」行；收起态不输出', () => {
    const s = scenarioState({ plain: true, detailOpen: true });
    s.view = {
      ...s.view,
      candidates: [
        {
          text: 'rebase',
          summary: '在另一个基线之上重放提交',
          kind: 'command',
          patternId: null,
          insert: null,
          detail: null, // 命令条目无 pattern 级 detail → 回退 summary（作用说明）
          example: 'git rebase -i HEAD~3',
          notes: ['变基会改写提交历史，已推送的分支慎用', '冲突后先 git add 再 --continue'],
        },
      ],
    };
    const lines = renderPlainLines(s);
    assert.ok(lines.includes('说明: 在另一个基线之上重放提交'), '详情默认行回退 summary');
    assert.ok(lines.includes('      例：git rebase -i HEAD~3'), '示例行');
    assert.ok(lines.includes('      注意：变基会改写提交历史，已推送的分支慎用'), '注意事项第 1 条');
    assert.ok(lines.includes('      注意：冲突后先 git add 再 --continue'), '注意事项第 2 条');
    const collapsed = renderPlainLines({ ...s, detailOpen: false });
    assert.ok(!collapsed.some((l) => l.includes('注意：')), '收起态不输出注意事项');
  });
  it('候选项缺 summary → （暂无说明）兜底', () => {
    const s = scenarioState({ plain: true });
    s.view = { ...s.view, candidates: [{ text: '--x', kind: 'option', insert: null }] };
    const lines = renderPlainLines(s);
    assert.ok(lines.includes('  ► --x   （暂无说明）'));
  });
  it('五区顺序固定：标签行依次为 输入/语法/候选/说明/状态', () => {
    const lines = renderPlainLines(scenarioState({ plain: true }));
    const labels = lines
      .filter((l) => /^(输入|语法|候选|说明|状态)[:（(]/.test(l))
      .map((l) => l.split(/[:（(]/)[0]);
    assert.deepEqual(labels, ['输入', '语法', '候选', '说明', '状态']);
  });
  it('纠错行文案（Did you mean）', () => {
    const s = scenarioState({ plain: true });
    s.view = { ...s.view, candidates: [{ text: 'checkout', kind: 'correction', insert: 'checkout', summary: '' }] };
    const lines = renderPlainLines(s);
    assert.ok(lines.some((l) => l.includes('Did you mean: checkout? (Tab 采纳)')), lines.join('\n'));
  });
});

// ───────────────── 分页与收起 ─────────────────

describe('tui-appview 分页与收起', () => {
  function pagedState(extra = {}) {
    const cands = Array.from({ length: 10 }, (_, i) => ({
      text: `opt${i}`,
      summary: `说明${i}`,
      kind: 'option',
      insert: null,
    }));
    const s = scenarioState({ plain: true, ...extra });
    s.view = { ...s.view, candidates: cands };
    s.config = { ...s.config, candidate_limit: 3 };
    return s;
  }
  it('默认第 1 页显示前 3 条，标题含总数与页码', () => {
    const lines = renderPlainLines(pagedState());
    assert.ok(lines.includes('候选(10) 1/4页:'));
    assert.ok(lines.includes('  ► opt0  说明0'));
    assert.ok(lines.includes('     opt1  说明1'));
    assert.ok(!lines.some((l) => l.includes('opt3')));
  });
  it('page=1 显示第 2 批候选并更新页码', () => {
    const lines = renderPlainLines(pagedState({ page: 1, selected: 3 }));
    assert.ok(lines.includes('候选(10) 2/4页:'));
    assert.ok(lines.includes('  ► opt3  说明3'));
    assert.ok(!lines.some((l) => l.includes('opt0') || l.includes('opt6')));
  });
  it('Esc 收起（dismissed）：候选行消失但区标题保留', () => {
    const lines = renderPlainLines(pagedState({ dismissed: true }));
    assert.ok(lines.includes('候选(10) 1/4页:'));
    assert.ok(!lines.some((l) => l.includes('opt0')));
    assert.ok(!lines.some((l) => l.startsWith('说明')));
  });
});

// ───────────────── 状态条动态段（优先级与 1.5s 淡出） ─────────────────

describe('tui-appview 状态条动态段', () => {
  const HINT = 'Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出';
  it('exit 0 对号；exit 非零红叉文案', () => {
    const ok = renderPlainLines(scenarioState({ plain: true, lastExit: { code: 0, at: 1000 } }));
    assert.ok(ok.some((l) => l.startsWith('状态: ') && l.includes('✔ exit 0')), ok.join('\n'));
    const fail = renderPlainLines(scenarioState({ plain: true, lastExit: { code: 128, at: 1000 } }));
    assert.ok(fail.some((l) => l.startsWith('状态: ') && l.includes('✘ exit 128')));
  });
  it('1.5s 后淡出（state.now 注入判定）', () => {
    const lines = renderPlainLines(scenarioState({ plain: true, lastExit: { code: 0, at: 1000 }, now: 2501 }));
    assert.ok(!lines.some((l) => l.includes('exit 0')));
  });
  it('danger 优先于 exit，超时后让位', () => {
    const lines = renderPlainLines(
      scenarioState({ plain: true, danger: { message: '⚠ 强制推送将覆盖远端历史', at: 1000 }, lastExit: { code: 0, at: 1000 } }),
    );
    assert.ok(lines.some((l) => l.includes('⚠ 强制推送将覆盖远端历史')));
    assert.ok(!lines.some((l) => l.includes('✔ exit 0')));
    const later = renderPlainLines(
      scenarioState({ plain: true, danger: { message: '⚠ 强制推送将覆盖远端历史', at: 1000 }, lastExit: { code: 0, at: 2600 }, now: 2600 }),
    );
    assert.ok(later.some((l) => l.includes('✔ exit 0')));
  });
  it('running 态显示运行指示', () => {
    const lines = renderPlainLines({ ...scenarioState({ plain: true }), mode: 'running' });
    assert.ok(lines.some((l) => l.includes('…运行中')));
  });
  it('hint_bar=false 隐藏按键提示条', () => {
    const s = scenarioState({ plain: true, config: { hint_bar: false } });
    const lines = renderPlainLines(s);
    assert.ok(!lines.some((l) => l.includes(HINT)));
    assert.ok(!lines.some((l) => l.startsWith('状态:')));
  });
  it('FADE_MS = 1500（状态条淡出窗口）', () => {
    assert.equal(FADE_MS, 1500);
  });
});

// ───────────────── 语言与待填提示 ─────────────────

describe('tui-appview 语言切换与 optionParam 待填提示', () => {
  it('en-US 语言切换框架文案', () => {
    const lines = renderPlainLines(scenarioState({ plain: true, lang: 'en-US' }));
    assert.ok(lines[1].startsWith('Input: '), lines[1]);
    assert.ok(lines.some((l) => l.startsWith('Syntax: ')));
    assert.ok(lines.some((l) => l.startsWith('Candidates(4):')));
    assert.ok(lines.some((l) => l.startsWith('Detail: ')));
    assert.ok(lines[lines.length - 1].startsWith('Status: '));
  });
  it('optionParam 态：输入行光标处渲染暗青待填参数位', () => {
    const s = scenarioState({ plain: true, line: 'git rebase --onto ', cursor: 18 });
    s.view = {
      ...s.view,
      phase: 'optionParam',
      positionLabel: '--onto 的参数 <newbase>',
      candidates: [],
    };
    const lines = renderPlainLines({ ...s });
    assert.equal(lines[1], '输入: git rebase --onto <newbase>▏');
    // zone 级：inputSegs 的待填段带 paramHint 逻辑样式
    const segs = inputSegs(s, tt('zh-CN'));
    assert.ok(segs.some((seg) => seg.text === '<newbase>' && seg.sgr === 'paramHint'));
  });
  it('超宽骨架截断（简化实现）且不输出标注行', () => {
    const s = scenarioState({ plain: true });
    const long = 'git log ' + Array.from({ length: 30 }, (_, i) => `--opt${i}`).join(' ');
    s.view = { ...s.view, skeleton: { text: long, marks: [], cursor: null } };
    const lines = renderPlainLines(s);
    const syn = lines.find((l) => l.startsWith('语法: '));
    assert.ok(syn.endsWith('…'));
    assert.ok(padOf(syn) - padOf('语法: ') <= 72, '截断后骨架不超过内容区宽 72');
    assert.ok(!lines.some((l) => l.trim().startsWith('└')), '截断时省略标注行');
  });
  it('exited 态返回空数组；渲染容错不抛异常', () => {
    assert.deepEqual(renderPlainLines({ ...scenarioState({ plain: true }), mode: 'exited' }), []);
    assert.ok(Array.isArray(renderPlainLines({ ...scenarioState({ plain: true }), view: { skeleton: null } })));
  });
});

// ───────────────── CJK 对齐（padWidth：码点 > 0xFF 记 2 列） ─────────────────

describe('tui-appview CJK 对齐', () => {
  it('中英文候选关键字说明列对齐', () => {
    const s = scenarioState({ plain: true });
    s.view = {
      ...s.view,
      candidates: [
        { text: '中文分支', summary: '说明一', kind: 'dynamic', placeholderKind: 'branch', insert: null },
        { text: 'en', summary: '说明二', kind: 'dynamic', placeholderKind: 'branch', insert: null },
      ],
    };
    const lines = renderPlainLines(s);
    const row1 = lines.find((l) => l.includes('中文分支'));
    const row2 = lines.find((l) => l.includes('说明二'));
    assert.equal(row1, '  ► 中文分支  说明一');
    assert.equal(row2, '     en        说明二');
    assert.equal(visCol(row1, '说明一'), visCol(row2, '说明二'));
  });
  it('标注行 ▏ 列位置（验收场景 1 锚点：indexOf 列 === 2 + upstreamAt）', () => {
    const TT = tt('zh-CN');
    const s = scenarioState({ plain: true });
    const zone = buildSyntaxZone(s, TT);
    assert.ok(zone, 'rebase 场景应有语法区');
    // zone 级：▏ 在标注行中的字符列 === 骨架 cursor 列（骨架 ASCII，字符列与显示列一致）
    const markerLine = zone.anno[0].map((seg) => seg.text).join('');
    assert.equal(markerLine.indexOf('▏'), s.view.skeleton.cursor);
    // 行级：plain 标注行 ▏ 的 indexOf 列 === 2 + [<upstream>] 列
    const plainLines = renderPlainLines(s);
    const marker = plainLines.find((l) => l.startsWith('  ') && l.includes('▏'));
    assert.ok(marker !== undefined, '渲染应含当前位置标注行 ▏');
    const upstreamAt = SK_TEXT.indexOf('[<upstream>]');
    assert.equal(marker.indexOf('▏'), 2 + upstreamAt);
  });
});

// ───────────────── zone 纯函数直测 ─────────────────

describe('tui-appview zone 纯函数', () => {
  const TT = tt('zh-CN');
  it('buildCandidatesZone：标题/计数/页码（n/m页）', () => {
    const s = scenarioState({ plain: true, config: { ...scenarioState().config, candidate_limit: 3 } });
    s.view = { ...s.view, candidates: Array.from({ length: 10 }, (_, i) => ({ text: `opt${i}`, summary: `说明${i}`, kind: 'option', insert: null })) };
    const z0 = buildCandidatesZone({ ...s, page: 0 }, TT);
    assert.equal(z0.title, '候选 (10) 1/4页');
    assert.equal(z0.count, 10);
    const z1 = buildCandidatesZone({ ...s, page: 1, selected: 3 }, TT);
    assert.equal(z1.title, '候选 (10) 2/4页');
    assert.ok(z1.rows[0].length >= 1);
  });
  it('buildDetailZone：展开三要素（详述/例/注意）', () => {
    const s = scenarioState({ plain: true, detailOpen: true });
    const z = buildDetailZone(s, TT);
    assert.equal(z.title, '详情 --onto <newbase>');
    assert.equal(z.rows[0][0].text, '不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交上。常用于把一段提交搬到别的分支。');
    assert.equal(z.rows[1][0].text, '例：git rebase --onto main topicA topicB');
  });
  it('buildStatusSegs：提示条 dim + 动态段拼接', () => {
    const s = scenarioState({ plain: true, lastExit: { code: 0, at: 1000 } });
    const segs = buildStatusSegs(s, TT);
    assert.equal(segs[0].sgr, 'dim');
    assert.ok(segs.some((seg) => seg.text === '✔ exit 0' && seg.sgr === 'exitOk'));
  });
  it('titleText：仓库/非仓库两种形态', () => {
    assert.equal(titleText(scenarioState(), TT), 'GitCue ─ D:\\demo (branch: main)');
    assert.equal(
      titleText(scenarioState({ repo: { isRepo: false, branch: null, cwd: 'D:\\tmp' } }), TT),
      'GitCue ─ D:\\tmp （当前目录不是 git 仓库）',
    );
  });
  it('工具函数：padWidth/padEndW/truncateW/firstSentence', () => {
    assert.equal(padWidth('中文a'), 5);
    assert.equal(padWidth('─'), 2);
    assert.equal(padEndW('中', 5), '中   ');
    assert.equal(truncateW('abcdefghij', 7), 'abcde…');
    assert.equal(truncateW('中文字', 6), '中文字');
    assert.equal(truncateW('中文字', 5), '中…'); // '…' 占 2 列需预留：中(2)+…(2)=4 ≤ 5
    assert.equal(firstSentence('第一句。第二句'), '第一句。');
    assert.equal(firstSentence('无句读文本'), '无句读文本');
  });
});

// ───────────────── ANSI 形态存在性（renderAppFrame，限形态断言） ─────────────────

describe('tui-appview ANSI 形态（Ink 组件树）', () => {
  it('renderAppFrame 非空且含 Ink 圆角边框字形（F9）', () => {
    const frame = renderAppFrame(scenarioState());
    assert.ok(typeof frame === 'string' && frame.length > 0);
    assert.ok(frame.includes('╭') && frame.includes('╰'), 'round 边框字形');
  });
  it('帧含五区标签（语法/候选/详情）与输入行前缀', () => {
    const frame = renderAppFrame(scenarioState());
    assert.ok(frame.includes('─ 语法 '), frame);
    assert.ok(frame.includes('─ 候选 (4)'), frame);
    assert.ok(frame.includes('─ 详情 --onto <newbase>'), frame);
    assert.ok(frame.includes('git> git rebase -i '), '输入行');
    assert.ok(frame.includes('█'), '光标块');
    assert.ok(frame.includes('► --onto <newbase>'), '高亮候选行');
  });
  it('guide 态帧含引导行', () => {
    const frame = renderAppFrame({ ...scenarioState(), mode: 'guide' });
    assert.ok(frame.includes('按任意键继续'));
  });
  it('exited 态帧为空（不渲染）', () => {
    assert.equal(renderAppFrame({ ...scenarioState(), mode: 'exited' }), '');
  });
  it('防御性 plain 分支：state.plain / theme none 时组件树渲染 plain 行', () => {
    const frame = renderAppFrame(scenarioState({ plain: true }));
    assert.ok(frame.includes('输入: git rebase -i '), frame);
    assert.ok(frame.includes('候选(4):'));
    const none = renderAppFrame(scenarioState({ config: { theme: 'none' } }));
    assert.ok(none.includes('输入: git rebase -i '));
  });
});

// ───────────────── sgr→Ink 样式映射表静态常量断言 ─────────────────

describe('tui-appview sgr→Ink 映射表（固定契约）', () => {
  it('default 主题各逻辑样式映射唯一且与表逐字一致', () => {
    assert.deepEqual(INK_STYLES.default.consumed, { underline: true, bold: true });
    assert.deepEqual(INK_STYLES.default.dim, { dimColor: true });
    assert.deepEqual(INK_STYLES.default.cursor, { inverse: true });
    assert.deepEqual(INK_STYLES.default.block, { inverse: true });
    assert.deepEqual(INK_STYLES.default.selected, { inverse: true });
    assert.deepEqual(INK_STYLES.default.correction, { color: 'red' });
    assert.deepEqual(INK_STYLES.default.paramHint, { color: 'cyan', dimColor: true });
    assert.deepEqual(INK_STYLES.default.danger, { color: 'red' });
    assert.deepEqual(INK_STYLES.default.exitOk, { color: 'green' });
    assert.deepEqual(INK_STYLES.default.exitFail, { color: 'red' });
  });
  it('contrast 主题仅 consumed 变为反色，其余同 default', () => {
    assert.deepEqual(INK_STYLES.contrast.consumed, { inverse: true });
    for (const key of ['dim', 'cursor', 'block', 'selected', 'correction', 'paramHint', 'danger', 'exitOk', 'exitFail']) {
      assert.deepEqual(INK_STYLES.contrast[key], INK_STYLES.default[key], `contrast.${key} 应与 default 一致`);
    }
  });
  it('zone 纯函数产出的 sgr 全部在映射表内（逻辑样式名封闭集）', () => {
    const s = scenarioState({ plain: true, lastExit: { code: 1, at: 1000 } });
    const used = new Set();
    for (const seg of [
      ...inputSegs(s, tt('zh-CN')),
      ...buildStatusSegs(s, tt('zh-CN')),
      ...buildSyntaxZone(s, tt('zh-CN')).segs,
      ...buildCandidatesZone(s, tt('zh-CN')).rows.flat(),
      ...buildDetailZone(s, tt('zh-CN')).rows.flat(),
    ]) {
      if (seg.sgr) used.add(seg.sgr);
    }
    for (const style of used) {
      assert.ok(style in INK_STYLES.default, `未知逻辑样式 ${style}`);
    }
  });
});

/** 计算子串在行中的显示列（与 appView 的 padWidth 规则一致） */
function visCol(line, sub) {
  const idx = line.indexOf(sub);
  let w = 0;
  for (const ch of line.slice(0, idx)) w += ch.codePointAt(0) > 0xff ? 2 : 1;
  return w;
}
function padOf(s) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0xff ? 2 : 1;
  return w;
}

// ───────────────── 历史区终端高度预算与光标闪烁（渲染层注入 term/cursorBlink） ─────────────────

describe('tui-appview 历史区高度预算与光标字形', () => {
  const TT = tt('zh-CN');
  const mkState = (over = {}) => ({
    mode: 'input',
    line: '',
    cursor: 0,
    config: { log_height: 10 },
    logExpanded: false,
    execLog: [
      {
        cmd: 'git log --oneline',
        output: Array.from({ length: 14 }, (_, i) => `commit-${i}`).join('\n') + '\n',
        echo: '',
        code: 0,
        at: 1000,
      },
    ],
    ...over,
  });

  it('无 term（无头/单测路径）：按配置预算 10 收缩并加省略标记', () => {
    const z = buildLogZone(mkState(), TT);
    // 内容行 = 1 命令行 + 14 输出行 = 15，预算 10 → 保尾 10 行 + 1 省略标记
    assert.equal(z.rows.length, 11);
    assert.ok(z.rows[0].map((s) => s.text).join('').includes('已省略'), '首行应为省略标记');
  });

  it('term.rows 注入（渲染层）：预算收缩至 max(1, rows-16)，历史区至少保留 1 行', () => {
    // rows=20 → 预算 min(10, 20-16)=4 → 4 行 + 省略标记
    const z20 = buildLogZone(mkState({ term: { rows: 20, columns: 100 } }), TT);
    assert.equal(z20.rows.length, 5);
    assert.ok(z20.rows[0].map((s) => s.text).join('').includes('已省略'));
    // rows=16 → 预算 max(1, 0)=1 → 保底 1 行 + 省略标记（帧顶历史区不因矮终端完全消失）
    const z16 = buildLogZone(mkState({ term: { rows: 16, columns: 100 } }), TT);
    assert.equal(z16.rows.length, 2);
    assert.ok(z16.rows[1].map((s) => s.text).join('').includes('commit-13'), '保底行取最新一条输出');
  });

  it('F2 展开（3×）同样受终端预算约束', () => {
    const z = buildLogZone(mkState({ logExpanded: true, term: { rows: 24, columns: 100 } }), TT);
    // 预算 min(30, 24-16=8) = 8 → 8 行 + 省略标记
    assert.equal(z.rows.length, 9);
  });

  it('输入行光标：默认 █，cursorBlink 翻转时为细条 ▏（两种形态均标示插入位置）', () => {
    const s = { line: 'git branch ', cursor: 11, config: {} };
    const glyphOf = (st) => inputSegs(st, TT).find((seg) => seg.sgr === 'block').text;
    assert.equal(glyphOf(s), '█');
    assert.equal(glyphOf({ ...s, cursorBlink: true }), '▏');
  });
});

describe('tui-appview 历史区空输出标记', () => {
  const TT = tt('zh-CN');
  const mk = (over = {}) => ({
    mode: 'input',
    line: '',
    cursor: 0,
    config: { log_height: 10 },
    logExpanded: false,
    execLog: [
      {
        cmd: 'git branch',
        output: '',
        echo: '',
        code: 0,
        at: 1000,
        ...over,
      },
    ],
  });
  const headText = (z) => z.rows[0].map((s) => s.text).join('');

  it('完成且无输出：命令行缀（无输出），明确区分"无输出"与"输出丢失"', () => {
    const z = buildLogZone(mk(), TT);
    assert.ok(headText(z).includes('$ git branch'), '命令行在');
    assert.ok(headText(z).includes('（无输出）'), `应缀（无输出）标记，实际 ${JSON.stringify(headText(z))}`);
    assert.equal(z.rows.length, 1, '除命令行外不应有输出行');
  });

  it('完成且有输出：不缀标记', () => {
    const z = buildLogZone(mk({ output: '* main\n' }), TT);
    assert.ok(!headText(z).includes('无输出'), '有输出不应缀（无输出）标记');
    assert.ok(z.rows.some((r) => r.map((s) => s.text).join('') === '* main'));
  });

  it('运行中：缀 …运行中 而非（无输出）', () => {
    const z = buildLogZone(mk({ code: null }), TT);
    assert.ok(headText(z).includes('…运行中'));
    assert.ok(!headText(z).includes('无输出'));
  });

  it('完成且非零退出：缀 ✘ exit N 而非（无输出）', () => {
    const z = buildLogZone(mk({ code: 128 }), TT);
    assert.ok(headText(z).includes('✘ exit 128'));
    assert.ok(!headText(z).includes('（无输出）'));
  });
});
