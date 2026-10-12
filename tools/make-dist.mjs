// ============================================================
//  make-dist.mjs —— 打包守夜人插件成"可分发"形态
// ------------------------------------------------------------
//  产出两个文件：
//    dist/守夜人-安装包.md      ← 单文件！发给别人，让他的DSH AI照着装
//    dist/dsh-proactive-vX.zip  ← 完整包（手动安装/归档用）
//
//  跑法:  node tools/make-dist.mjs
//  设计:  从【活的源文件】读取内容嵌入，所以永远不会跟代码不同步
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
fs.mkdirSync(DIST, { recursive: true })

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VER = pkg.version

/** 读文件；不存在返回 null */
function rd(rel) {
    const p = path.join(ROOT, rel)
    try { return fs.readFileSync(p, 'utf8') } catch { return null }
}

/** 给代码块选语言 */
function lang(rel) {
    if (rel.endsWith('.json')) return 'json'
    if (rel.endsWith('.yml') || rel.endsWith('.yaml')) return 'yaml'
    if (rel.endsWith('.mjs') || rel.endsWith('.js')) return 'javascript'
    return 'text'
}

// 要打进"单文件安装包"的东西（按安装顺序列）
const PAYLOAD = [
    { rel: 'package.json',         dest: '<插件目录>/package.json',         note: '插件清单（dsh.bundle.patch 指向下面的 cordis.patch.yml）' },
    { rel: 'cordis.patch.yml',     dest: '<插件目录>/cordis.patch.yml',     note: 'DSH 组合补丁：把这插件 insert 进 profile' },
    { rel: 'index.js',             dest: '<插件目录>/index.js',             note: '★插件主体（不能删）' },
    { rel: 'watch.example.json',   dest: '<插件目录>/watch.example.json',   note: '监听清单模板（六种类型都填了；复制成 watch.json 再改）' },
    { rel: 'README.md',            dest: '<插件目录>/README.md',            note: '英文说明（可选，但建议留）' },
    { rel: 'README.zh-CN.md',      dest: '<插件目录>/README.zh-CN.md',      note: '中文说明（可选）' },
    { rel: 'LICENSE',              dest: '<插件目录>/LICENSE',              note: 'MIT 许可证' },
    { rel: 'test/test.mjs',        dest: '<插件目录>/test/test.mjs',        note: '测试套件（可选；装完可以 npm test 验一下）' },
]

const WATCH_TEMPLATE = {
    _说明: '守夜人监听清单。往 watches 里加项 → 条件达成 → 隐形叫醒 agent → agent 主动汇报。触发过的项自动标记 fired:true。',
    _可用类型: {
        'file-stable': '文件大小连续N次不变=下完了。字段: path, rounds(默认3), message',
        'file-exists': '文件出现即触发（只认文件，目录不算）。字段: path, message',
        'file-size': '文件达到指定字节数。字段: path, bytes, message',
        'process-exit': '进程消失即触发。字段: process(如 curl.exe), message',
        'port-open': '端口开始监听。字段: port, host(默认127.0.0.1), message',
        'time': '到点触发。字段: at(本地时间 如 2026-09-21T22:00:00), message',
    },
    _公共字段: {
        id: '唯一标识（中文也行）',
        message: '叫醒时 agent 看到的话 —— 建议写成给 agent 的指令',
        sessionId: '可选。指定叫醒哪个会话；不写=最近活动的那个（指定的会话不在时跳过本轮，绝不改投别人）',
        sourceKind: '可选。plugin(默认,隐形) / user(渲染成用户气泡)',
        form: "可选。配合 sourceKind:plugin 用；'notice' 会额外带 summary",
        repeatSeconds: '可选。不标记 fired 而是重新上膛；只有 time / file-size 能重排，其它类型退化成一次性',
    },
    _用法示例: [
        { id: '等大文件下完', type: 'file-stable', path: 'C:\\path\\to\\big.iso', rounds: 3, message: '文件下载完成了，检查大小是否正确，然后主动向用户汇报。' },
        { id: '等curl结束', type: 'process-exit', process: 'curl.exe', message: 'curl 下载任务结束了，看看结果并主动汇报。' },
        { id: '提醒休息', type: 'time', at: '2026-01-01T22:00:00', message: '提醒用户该休息了。' },
    ],
    watches: [],
}

const parts = []
const push = (s) => parts.push(s)

push(`# 守夜人插件 · 安装包（**给 DSH 的 AI 看**）

> **收件人**：如果你是 DSH（DeepSeek Harness）里的 AI，请**通读本文件**，
> 然后**照着「安装步骤」把插件装好**。用户把这份文件丢给你，就是要你干这件事。
>
> 版本：\`v${VER}\` ｜ 单文件自包含（代码全在下面，不需要联网下载任何东西）
> 作者署名：见文末 ｜ 许可证：MIT

---

## 这是什么

**dsh-proactive（守夜人）** —— 一个 DSH 插件，解决的问题是：

> DSH 的 agent 干长活（下载几十 GB、等编译、等安装）时，**回合结束就"睡了"**。
> 任务其实还在跑，但跑完了没人吭声，用户得自己回来问"好了吗"。

装上之后：插件自己盯着条件（文件下完 / 进程结束 / 端口起来 / 到点），
**一达成就把消息塞进会话，把 agent 叫醒** —— agent 于是主动开口汇报。

**关键设计**：注入用的是 \`source.kind = 'plugin'\`，
**这条消息在界面上不渲染** —— 所以不会出现一条伪装成"用户自己打的字"的假消息，
用户看到的只是 **agent 被叫醒后说的那段话**。

---

## 安装前：先确认三件事

**① 找到 DSH 的 profile 目录**（默认在 \`~/.dsh/profiles/web/\`，
Windows 通常是 \`C:\\Users\\<用户名>\\.dsh\\profiles\\web\\\`）。
里面应该有 \`package.json\`。找不到就问用户，或用：

\`\`\`bash
# Windows (PowerShell)
dir "$env:USERPROFILE\\.dsh\\profiles"
# macOS / Linux
ls -la ~/.dsh/profiles
\`\`\`

**② 选一个插件存放目录**（建议跟 profile 同级，别放系统区）。
推荐：\`<某个你记得住的地方>/dsh-proactive/\`，例如 \`~/dsh-plugins/dsh-proactive\`。

**③ 确认 Node 版本 ≥ 22**（插件用的是 ESM + 标准库，不需要额外依赖）：

\`\`\`bash
node --version
\`\`\`

---

## 安装步骤（照做）

### 第 1 步：创建插件目录并写入文件

把下面「文件清单」里的 **每个文件**，**原样**写到
\`<插件目录>/<相对路径>\`。
**一个字都不要改**（尤其 \`index.js\`，它是主体）。

> ⚠️ 写文件时注意：**\`index.js\` 里的中文注释和字符串不能丢**，
> 也不要"美化"或"改写"代码。原样写。

### 第 2 步：注册到 profile

编辑 \`<profile目录>/package.json\`，做两处改动：

**a) 在 \`dependencies\` 里加一行**（路径按你的插件目录改）：

\`\`\`json
"dsh-proactive": "link:<插件目录的绝对路径>"
\`\`\`

**b) 在 \`dsh.profile.bundles\` 数组里加上**：

\`\`\`json
"dsh-proactive"
\`\`\`

> ⚠️ **改之前先备份** \`package.json\`（复制成 \`package.json.bak-<时间戳>\`）。
> 这是这个项目的一条铁律：**动任何配置/脚本前先备份**。

### 第 3 步：确认依赖能解析

\`index.js\` 里有一行：
\`\`\`javascript
import { createUserMessage } from '@deepseek-ai/dsh-llm'
\`\`\`

**如果你的插件目录不在 DSH 的 node_modules 树里**，Node 可能找不到这个包。
两个办法（任选）：

- **办法A（推荐）**：在插件目录建一个 \`node_modules/@deepseek-ai\` 的软链接/Junction，
  指向 DSH 自己的那个目录：
  \`\`\`
  <profile目录>/node_modules/@deepseek-ai
  \`\`\`
- **办法B**：直接把插件目录放进 \`<profile目录>/node_modules/\` 下，
  再在 \`dependencies\` 里用相对名字引用。

验证办法：在插件目录跑
\`\`\`bash
node -e "import('@deepseek-ai/dsh-llm').then(m=>console.log('OK createUserMessage =', typeof m.createUserMessage))"
\`\`\`
打印 \`OK createUserMessage = function\` 就对了。

### 第 4 步：重启 DSH

插件带 \`requiresRestart: true\`，**必须重启 DSH 才加载**。

重启后**验证加载成功**：
\`\`\`bash
# 插件目录下会出现 boot.log
type boot.log          # Windows
cat boot.log           # macOS/Linux
\`\`\`
应该能看到三行：
\`\`\`
apply() 被调用  enabled=true  intervalMs=15000
定时器已挂载
守夜人就绪
\`\`\`
**看到这三行 = 装好了。**

如果 \`boot.log\` 没出现 → 插件没加载，回到第 2 步检查注册。

### 第 5 步（可选）：跑测试验一下

\`\`\`bash
cd <插件目录>
npm test
\`\`\`
测试在临时目录里跑，不碰你真实的 watch.json / boot.log，
输出末尾那行「失败 0」就是结论。这是最硬的验证。

---

## 装完怎么用

编辑 \`<插件目录>/watch.json\`，往 \`watches\` 里加一项。
**存盘即生效，不用重启**（每 15 秒读一次）。

\`\`\`json
{
  "watches": [
    {
      "id": "等大文件下完",
      "type": "file-stable",
      "path": "C:\\\\path\\\\to\\\\big.iso",
      "rounds": 3,
      "message": "文件下载完成了，校验一下大小，然后主动向用户汇报。"
    }
  ]
}
\`\`\`

**六种触发类型**：

| type | 何时触发 | 字段 |
|---|---|---|
| \`file-stable\` | 文件大小连续 N 次不变（**下完了**）| \`path\`, \`rounds\`(默认3) |
| \`file-exists\` | 文件出现 | \`path\` |
| \`file-size\` | 达到指定字节数 | \`path\`, \`bytes\` |
| \`process-exit\` | 进程消失（**活干完了**）| \`process\` |
| \`port-open\` | 端口开始监听（**服务起来了**）| \`port\`, \`host\` |
| \`time\` | 到点（闹钟）| \`at\`（本地时间）|

---

## ⚠️ 给 AI 的提醒（做之前请读）

1. **先备份再改** —— 改 \`package.json\` 之前复制一份带时间戳的备份。
2. **不要改 \`index.js\` 的内容** —— 尤其是那行 \`import\` 和中文注释。
3. **路径不要写死中文** —— 如果要写 \`.bat\`/\`.ps1\` 包装脚本，
   注意 **cmd 按 GBK 读 \`.bat\`**，中文路径会乱码；用 \`%~dp0\` 取脚本自身目录。
4. **装不上就查 \`boot.log\`** —— 它是最直接的诊断信息。
5. **如果 DSH 起不来** —— 把 \`package.json\` 的改动撤掉（用备份恢复），
   插件本身有全 \`try/catch\` 兜底，正常情况下不会让 DSH 挂。

---

## 文件清单

下面每个代码块就是该文件的**完整内容**，请原样写入对应路径。

`)

/**
 * 选择包裹用的代码围栏长度。
 * ★ 关键：README.md / README.zh-CN.md 里本身就含 ``` 代码块。
 *   如果用三反引号包裹，遇到文件内的第一个 ``` 就【提前闭合】，内容被截断。
 *   所以：内容里含 ``` 就用四反引号包裹（Markdown 的标准做法）。
 */
function fenceFor(body) {
    return body.includes('```') ? '````' : '```'
}

for (const item of PAYLOAD) {
    const body = rd(item.rel)
    if (body === null) { console.error('!! 缺文件，跳过: ' + item.rel); continue }
    const f = fenceFor(body)
    push(`### \`${item.dest}\`\n`)
    push(`> ${item.note}\n`)
    push(f + lang(item.rel))
    push(body.replace(/\n+$/, ''))
    push(f + '\n')
}

{
    const tpl = JSON.stringify(WATCH_TEMPLATE, null, 2)
    const f = fenceFor(tpl)
    push(`### \`<插件目录>/watch.json\`（**监听清单模板**，装上先写这个空壳）\n`)
    push(f + 'json')
    push(tpl)
    push(f + '\n')
}

push(`---

## 验收标准（装完请自检并向用户汇报）

- [ ] \`boot.log\` 出现，且含「守夜人就绪」
- [ ] \`<profile>/package.json\` 里能看到 \`dsh-proactive\`（两处：dependencies + bundles）
- [ ] （可选）\`npm test\` 末尾显示「失败 0」
- [ ] \`watch.json\` 已写入模板
- [ ] 重启 DSH 后没报错

**汇报时请说清楚**：装到了哪个路径、\`boot.log\` 有没有出来、有没有跑测试。

---

## 许可 / 出处

MIT。机制来自 DSH 自身的 \`dsh-subagent/lib/continuation.js\`
（子代理回报父代理用的就是 \`agent.steer(createUserMessage(...))\`）。
本插件把同一套 API 用在了"条件达成 → 叫醒 agent"上。
`)

const mdPath = path.join(DIST, `守夜人-安装包-v${VER}.md`)
fs.writeFileSync(mdPath, parts.join('\n'), 'utf8')

// ---------- 顺便打一个 zip ----------
let zipPath = null
try {
    const zipName = `dsh-proactive-v${VER}.zip`
    zipPath = path.join(DIST, zipName)
    try { fs.unlinkSync(zipPath) } catch {}

    // 先把要打包的文件复制到暂存目录（避开 dist 自身 & 备份文件），再压缩
    const STAGE = path.join(DIST, '_stage')
    fs.rmSync(STAGE, { recursive: true, force: true })
    const include = ['package.json', 'cordis.patch.yml', 'index.js', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', 'watch.example.json', 'test/test.mjs', 'tools/make-dist.mjs']
    for (const rel of include) {
        const src = path.join(ROOT, rel)
        if (!fs.existsSync(src)) continue
        const dst = path.join(STAGE, rel)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
    }
    fs.writeFileSync(path.join(STAGE, 'watch.json'), JSON.stringify(WATCH_TEMPLATE, null, 2), 'utf8')

    if (process.platform === 'win32') {
        execFileSync('powershell', ['-NoProfile', '-Command',
            `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zipPath}' -Force`],
            { stdio: 'ignore' })
    } else {
        execFileSync('zip', ['-qr', zipPath, '.'], { cwd: STAGE, stdio: 'ignore' })
    }
    fs.rmSync(STAGE, { recursive: true, force: true })
} catch (e) {
    console.log('  (zip 打包跳过: ' + e.message + ')')
}

console.log('生成完毕：')
console.log('  ' + mdPath + '   ' + (fs.statSync(mdPath).size / 1024).toFixed(1) + ' KB')
if (zipPath && fs.existsSync(zipPath)) console.log('  ' + zipPath + '   ' + (fs.statSync(zipPath).size / 1024).toFixed(1) + ' KB')
console.log('\n把 .md 那个文件发给别人，让他的 DSH AI 读它就行。')
