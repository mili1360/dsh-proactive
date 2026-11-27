// ============================================================
//  dsh-proactive · DSH「守夜人」插件
// ============================================================
//  解决的问题
//  ----------
//  让 agent 干一个要跑几小时的活（下载 48GB、等编译、等安装）时，
//  agent 的回合早就结束了，它"睡了"。任务其实还在跑，但跑完了没人吭声，
//  用户得自己回来问"好了吗"。
//
//  这个插件让 DSH 自己盯着：条件一达成，就把一条消息塞进会话，
//  把 agent 叫醒 —— agent 于是主动开口说话。
//
//  机制出处
//  --------
//  dsh-subagent/lib/continuation.js 里，子代理回报父代理用的就是：
//      parent.steer(createUserMessage({ content:[...], source:{kind:'user'} }))
//  这不是我编的 API，是 DSH 自己在用的。
//
//  用法
//  ----
//  往同目录的 watch.json 写监听项，插件每 intervalMs 毫秒检查一次。
//  条件满足 → 叫醒 agent → 该项标记 fired:true（不再重复触发）。
//
//  稳健性原则
//  ----------
//  任何一步失败都只写日志，绝不让 DSH 启动挂掉（apply 全程 try/catch）。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))

// 这两个路径可以被 config 覆盖（测试用：让测试写临时文件，别碰真实 watch.json）。
let WATCH_FILE = path.join(SELF_DIR, 'watch.json')
let BOOT_LOG = path.join(SELF_DIR, 'boot.log')

function trace(msg) {
    try {
        fs.appendFileSync(BOOT_LOG, new Date().toISOString() + '  ' + msg + '\n')
    } catch {
        /* 日志写不进去也不能影响主流程 */
    }
}

const DEFAULTS = {
    enabled: true,
    // 检查间隔。太短浪费 CPU，太长则"下完到你被告知"之间有空窗。
    intervalMs: 15000,
    // 连续多少次看到"大小没变"才认定文件已下完（配合 intervalMs 用）。
    stableRounds: 3,
    // 同一项通知失败后最多重试几次
    maxRetries: 5,
    // 注入消息的来源类型：
    //   'plugin' = 标成「插件注入」，UI 不会伪装成用户自己说的话（推荐）
    //   'user'   = 传统做法，会被渲染成用户气泡，容易让人以为是用户打的
    sourceKind: 'plugin',
    // 可覆盖的路径（测试用；生产留空 = 用插件目录下的 watch.json / boot.log）
    watchFile: null,
    logFile: null,
}

// ---------------------------------------------------------------- session-semantic（2026-11-27 加）
//
// 语义触发：不拿关键词硬匹配，而是把小窗口的最近对话丢给模型，让它判断
// "这个话题该不该提醒"。实现上走 DSH 自己的 ctx.llm.stream（跟 compaction 摘要用同一条路），
// 所以不用额外的 API key、不用另配 provider。
//
// 三条成本纪律（否则每 15 秒烧一次）：
//   1. 冷却：cooldownSeconds（默认 900 秒）内最多判一次
//   2. 有新用户消息才判：记消息序号，没新消息直接 false
//   3. 硬超时：默认 8 秒，超时当作"不提醒"
let llmRef = null
let userMsgVersion = 0
let toolVersion = 0

/** 调一次模型做 yes/no 判断。失败/超时一律 false（提醒不能因为 AI 挂了而误触发）。 */
async function judgeWithLlm(agent, prompt, signal) {
    if (!agent || !llmRef) return false
    const target = agent.options && agent.options.provider && agent.options.model
        ? { provider: agent.options.provider, model: agent.options.model }
        : null
    if (!target) return false
    const messages = [{
        role: 'user',
        content: [{ type: 'text', text: prompt }],
    }]
    let text = ''
    try {
        const stream = llmRef.stream({
            provider: target.provider,
            model: target.model,
            messages,
            maxTokens: 8,
            sessionId: agent.session && agent.session.id,
            purpose: 'proactive-judge',
            ...(signal ? { signal } : {}),
        })
        for await (const chunk of stream) {
            if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        }
    } catch {
        return false
    }
    const s = text.trim().toLowerCase()
    return s.startsWith('是') || s.startsWith('yes') || s.startsWith('true')
}
//
// 背景：想让守夜人在"聊到某个话题"时提醒一句，而它原来只有
// time / file-size / file-stable / process-exit / port-open 这几种"看文件看端口"的触发，
// 没有"看对话内容"这一档。这里补上。
//
// 两个新能力：
//   1. type: 'session-match' —— 最近 N 条【用户】消息里命中 keywords 任意一个就触发。
//      只看用户消息，不看模型自己的输出（否则模型一说这个话题就会自我触发，越滚越大）。
//   2. via: 'system-prompt' —— 触发后不 steer（不插对话、不唤醒新回合），而是把 message
//      挂到一个短期标记上，由 ctx.systemPrompt.variable 每轮装配时读走。
//      没命中就返回空串，systemPrompt 会把空 section 过滤掉，一行 token 都不多花。
//      'steer'（原行为）仍然保留，不写 via 时就是它。

// 全局的"最近要注入的系统提示"标记：{ text, roundsLeft }
// 多会话共用 —— 提醒内容本身是通用教训，串到别的会话也无害。
const noticeState = { text: '', roundsLeft: 0 }
let systemPromptRef = null

// 运行时状态（不写进 watch.json）：id -> { cooldownUntil, lastMsgVersion }
// ★ 为什么必须放这里而不是挂在 w 上：tick 每次都会 readWatches() 重新 parse 一遍文件，
//   拿到的是全新对象，挂在 w 上的一切内存态（冷却、消息基线）下一次 tick 就没了。
const runtimeState = new Map()
function rt(w) {
    const id = String(w && w.id || '')
    let s = runtimeState.get(id)
    if (!s) { s = { cooldownUntil: 0, lastMsgVersion: undefined }; runtimeState.set(id, s) }
    return s
}

/** 供单测直接调：模拟一次"最近消息"判定。 */
const recentUserTexts = []
// 2026-11-27: 工具调用文本窗口。用来实现"我要动插件时提醒我"——
// 光看用户说什么不够准，真正的动手指令是我这边的 tool/call（write / edit / pwsh ...）。
// 只收工具名 + 参数（JSON.stringify 后变小写），不含工具结果，避免把回执内容算成"要动手"。
const recentToolTexts = []
// 2026-11-27: 思考窗口。scope:'thinking' 用它 —— "我在脑子里决定要改插件"比工具调用更早发生。
// 思考从 llm/stream 的 reasoning-delta 旁听收集（流层原样透传，只读不改）。
const recentThinkTexts = []
export function pushThinkText(t) {
    const s = String(t || '').trim().toLowerCase()
    if (!s) return
    recentThinkTexts.push(s)
    while (recentThinkTexts.length > 3) recentThinkTexts.shift()
}
export function pushUserText(t) {
    const s = String(t || '').toLowerCase()
    if (!s) return
    recentUserTexts.push(s)
    while (recentUserTexts.length > 6) recentUserTexts.shift()
    userMsgVersion += 1
}
export function pushToolText(t) {
    const s = String(t || '').toLowerCase()
    if (!s) return
    recentToolTexts.push(s)
    while (recentToolTexts.length > 6) recentToolTexts.shift()
    toolVersion += 1
}
export function matchSession(w) {
    const kws = Array.isArray(w.keywords) ? w.keywords : (w.keyword ? [w.keyword] : [])
    if (kws.length === 0) return false
    // 冷却：命中过一次后，repeatSeconds（默认 600 秒）内不再重复提醒，
    // 否则同一句话每 15 秒 tick 一次就会一直响。
    const now = Date.now()
    const s = rt(w)
    if (now < s.cooldownUntil) return false
    const window = Math.max(1, Number(w.window || 3))
    // scope：'user'（默认）只看用户消息 / 'tool' 只看工具调用 / 'thinking' 只看思考
    //        'both' = user+tool / 'all' = user+tool+thinking / 也可以给数组 ['user','thinking']
    const raw = String(w.scope || 'user')
    const scopes = Array.isArray(w.scope)
        ? w.scope.map(String)
        : (raw === 'both' ? ['user', 'tool'] : (raw === 'all' ? ['user', 'tool', 'thinking'] : [raw]))
    const pools = []
    if (scopes.includes('user')) pools.push(...recentUserTexts.slice(-window))
    if (scopes.includes('tool')) pools.push(...recentToolTexts.slice(-window))
    if (scopes.includes('thinking')) pools.push(...recentThinkTexts.slice(-Math.min(window, 3)))
    const hit = pools.some((t) => kws.some((k) => t.includes(String(k).toLowerCase())))
    if (hit) s.cooldownUntil = now + Math.max(60, Number(w.repeatSeconds || 600)) * 1000
    return hit
}

/** 读取监听清单。文件不存在/损坏都返回空数组，绝不抛。 */
let lastRoot = {}
function readWatches() {
    try {
        const raw = fs.readFileSync(WATCH_FILE, 'utf8')
        const j = JSON.parse(raw)
        if (Array.isArray(j)) { lastRoot = {}; return j }
        lastRoot = (j && typeof j === 'object') ? j : {}
        return Array.isArray(lastRoot.watches) ? lastRoot.watches : []
    } catch {
        return []
    }
}

/** 写回监听清单。保留顶层其它键（比如用户写的 _说明 文档），只替换 watches。 */
function writeWatches(list) {
    try {
        // 目录可能不存在（测试或自定义路径）→ 先建出来，失败也不影响主流程
        try { fs.mkdirSync(path.dirname(WATCH_FILE), { recursive: true }) } catch {}
        fs.writeFileSync(WATCH_FILE, JSON.stringify({ ...lastRoot, watches: list }, null, 2), 'utf8')
    } catch (e) {
        trace('写 watch.json 失败: ' + (e?.message || e))
    }
}

/** 判断进程是否存在（Windows 用 tasklist，失败则当作"不存在"以外的保守结果）。 */
function processExists(name) {
    return new Promise((resolve) => {
        try {
            execFile('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { windowsHide: true }, (err, stdout) => {
                if (err) return resolve(null) // null = 查不到，本轮跳过
                const out = String(stdout || '')
                resolve(out.toLowerCase().includes(String(name).toLowerCase()))
            })
        } catch {
            resolve(null)
        }
    })
}

/** 端口是否有监听 */
function portOpen(port, host = '127.0.0.1', timeoutMs = 1200) {
    return new Promise((resolve) => {
        const sock = new net.Socket()
        let done = false
        const finish = (v) => { if (!done) { done = true; try { sock.destroy() } catch {} resolve(v) } }
        sock.setTimeout(timeoutMs)
        sock.once('connect', () => finish(true))
        sock.once('timeout', () => finish(false))
        sock.once('error', () => finish(false))
        try { sock.connect(port, host) } catch { finish(false) }
    })
}

function fileSize(p) {
    try {
        const st = fs.statSync(p)
        return st.isDirectory() ? null : st.size
    } catch {
        return null
    }
}

/**
 * 判断单个监听项的条件是否达成。
 * 导出是为了单测（不必起定时器，毫秒级跑完）。
 *
 * @param {object} w    监听项
 * @param {object} cfg  配置（用 stableRounds 作为默认轮数）
 * @returns {Promise<boolean>} 达成返回 true；条件不满足或查不到都返回 false
 */
export async function checkCondition(w, cfg = DEFAULTS) {
    switch (w.type) {
        case 'file-exists':
            return fileSize(w.path) !== null
        case 'file-size': {
            const s = fileSize(w.path)
            return s !== null && s >= Number(w.bytes || 0)
        }
        case 'file-stable': {
            // 连续 rounds 次看到同一个大小 = 下完了。
            // 首次观测计为 1（文件已经在那里，大小已知）；
            // 之后每轮大小不变就 +1，一变就重置回 1。
            // 所以 rounds:3 = 第 3 次检查时触发。
            const s = fileSize(w.path)
            if (s === null) { w.__lastSize = null; w.__stable = 0; return false }
            if (w.__lastSize === s) { w.__stable = (w.__stable || 0) + 1 } else { w.__stable = 1 }
            w.__lastSize = s
            return (w.__stable || 0) >= Math.max(1, Number(w.rounds || cfg.stableRounds))
        }
        case 'process-exit': {
            const ex = await processExists(w.process)
            if (ex === null) return false          // 查不到 → 本轮跳过
            return ex === false                     // 进程没了 = 活干完了
        }
        case 'port-open':
            return await portOpen(Number(w.port), w.host || '127.0.0.1')
        case 'time':
            return Date.now() >= new Date(w.at).getTime()
        case 'session-match':
            return matchSession(w)
        default:
            return false                            // 未知类型：静默不触发
    }
}

export function apply(ctx, config) {
    try {
        const cfg = { ...DEFAULTS, ...(config || {}) }
        // 允许覆盖路径（测试隔离用）
        if (cfg.watchFile) WATCH_FILE = path.resolve(String(cfg.watchFile))
        if (cfg.logFile) BOOT_LOG = path.resolve(String(cfg.logFile))
        trace('apply() 被调用  enabled=' + cfg.enabled + '  intervalMs=' + cfg.intervalMs)
        if (cfg.enabled === false) { trace('配置 enabled=false，不加载'); return }

        // sessionId -> agent。不依赖 ctx.agents（拿不到就靠事件里带的 agent 自己维护）。
        const agents = new Map()
        // sessionId -> 最近一次活跃时间戳。
        // ★ 为什么需要它：以前 pickAgent 用"Map 里最后一个"=最后【注册】的会话，
        //   不是"最近【活跃】"的，所以开两个会话时会叫醒错的那个（实测踩过）。
        const activeAt = new Map()
        const sidOf = (agent) => agent?.session?.id ?? agent?.id ?? null

        // 记录 agent，并把它标记为"最近活跃"。任何活动都走这里。
        const remember = (agent, bump = true) => {
            const sid = sidOf(agent)
            if (!sid) return null
            agents.set(sid, agent)
            if (bump) activeAt.set(sid, Date.now())
            return sid
        }

        // 注册阶段（加固，见 README「要求 / 兼容性」）：插件【仅仅是不兼容】不该把整个
        // profile 拖垮 —— 第三方插件 cancanqiqi/dsh-human-subagent 就是调了本 build 没有的
        // 服务方法，异常从 apply() 冒进加载器，整个 profile 起不来。所以每条注册都过 reg()：
        // 失败只写一行日志、把已经注册的收回来、然后停用（绝不抛出去）。
        // 一切都在时，走的是和以前一模一样的路径。
        const disposers = []
        const reg = (event, fn) => {
            try {
                const d = ctx.on(event, fn)
                if (typeof d === 'function') disposers.push(d)
                return true
            } catch (e) {
                for (const d of disposers) { try { d() } catch {} }
                trace('注册失败，插件停用: ctx.on(' + event + ') ' + (e?.message || e))
                return false
            }
        }
        if (!ctx || typeof ctx.on !== 'function') {
            trace('注册失败，插件停用: ctx.on 不可用（这个 DSH build 没有它）')
            return
        }

        if (!reg('agent/created', ({ agent }) => { if (agent) remember(agent) })) return
        if (!reg('agent/session-start', ({ agent }) => { if (agent) remember(agent) })) return
        // 有消息进收件箱 = 用户刚在这个会话说话 → 最可靠的"活跃"信号
        if (!reg('agent/inbox/inserted', ({ agent }) => { if (agent) remember(agent) })) return
        // 2026-11-27: 收用户消息文本，供 type:'session-match' 判断话题。
        // 只收 type=user/message 且来源不是插件（避免守夜人自己注入的东西又触发自己）。
        // 同一条监听里顺手收 tool/call 的参数 —— scope:'tool' 就靠它（"我要动插件时提醒我"）。
        if (!reg('session/message', (ev) => {
            try {
                if (!ev) return
                if (ev.type === 'tool/call') {
                    const name = String((ev.data && ev.data.name) || '')
                    let args = ''
                    try { args = JSON.stringify((ev.data && ev.data.arguments) || {}) } catch { args = '' }
                    pushToolText(name + ' ' + args)
                    return
                }
                if (ev.type !== 'user/message') return
                const src = ev.data && ev.data.source
                if (src && src.kind === 'plugin') return
                const content = (ev.data && ev.data.content) || []
                const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('')
                pushUserText(text)
            } catch { /* ignore */ }
        })) return
        // 2026-11-27: 旁听思考流（scope:'thinking' 用）。
        // 只读 reasoning-delta、原样 yield 回去，绝不改内容、不吞 chunk、不干扰 finish。
        // 收的是"模型自己在想什么"，比 tool/call 更早一步 —— 想到要动插件时就该提醒。
        if (!reg('llm/stream', (options, next) => {
            const inner = next()
            return (async function* () {
                let buf = ''
                for await (const chunk of inner) {
                    try {
                        if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                            buf += chunk.text
                            if (buf.length >= 600) { pushThinkText(buf); buf = '' }
                        }
                    } catch { /* 旁听失败不影响主流 */ }
                    yield chunk
                }
                try { if (buf) pushThinkText(buf) } catch { /* ignore */ }
            })()
        })) return
        // 状态变成 running（开始干活）也算活跃
        if (!reg('agent/status', ({ agent, status }) => { if (agent && status === 'running') remember(agent) })) return

        if (!reg('agent/disposed', ({ agent }) => {
            const s = sidOf(agent)
            if (s) { agents.delete(s); activeAt.delete(s) }
        })) return

        // 兜底：插件加载时已经存在的 agent
        try { for (const a of (ctx.agents?.list?.() ?? [])) remember(a) } catch {}

        function pickAgent(w) {
            // 1) 指定了 sessionId → 只认它。
            //    ★ 指定的会话不在（已关闭/写错）时，【绝不】改投给别的会话 ——
            //      宁可这轮不叫，也不能把提醒送到错误的会话里。
            if (w.sessionId) {
                const a = agents.get(w.sessionId)
                if (a) return a
                trace('指定的会话不存在，跳过本轮: ' + w.id + '  sessionId=' + w.sessionId)
                return null
            }
            // 2) 没指定 → 挑【最近活跃】的那个
            let best = null
            let bestAt = -1
            for (const [sid, a] of agents) {
                const t = activeAt.get(sid) || 0
                if (t > bestAt) { bestAt = t; best = a }
            }
            return best
        }

        async function fireOne(w) {
            const text = w.message || `【守夜人】监听项 ${w.id} 的条件已达成。`

            // 2026-11-27：via:'system-prompt' —— 不插对话、不唤醒回合，走系统提示注入。
            // 没拿到 systemPrompt 服务时退化成 steer，绝不静默丢掉提醒。
            if (w.via === 'system-prompt' && systemPromptRef) {
                noticeState.text = String(text)
                noticeState.roundsLeft = Math.max(1, Number(w.rounds || 3))
                trace('已排入系统提示: ' + w.id + '  rounds=' + noticeState.roundsLeft + '  text=' + String(text).slice(0, 40))
                return true
            }

            const agent = pickAgent(w)
            if (!agent) { trace('无可用 agent，暂缓: ' + w.id); return false }
            // 来源标记：默认标成 plugin，UI 就不会把它当成"用户自己打的字"。
            // 每项也可自己覆盖（w.sourceKind / w.form），方便对比不同呈现方式。
            const kind = w.sourceKind || cfg.sourceKind
            const source = kind === 'user'
                ? { kind: 'user' }
                : (w.form
                    ? (w.form === 'notice'
                        ? { kind: 'plugin', plugin: 'dsh-proactive', form: 'notice', summary: String(w.summary || text).slice(0, 120) }
                        : { kind: 'plugin', plugin: 'dsh-proactive', form: w.form })
                    : { kind: 'plugin', plugin: 'dsh-proactive' })
            try {
                agent.steer(createUserMessage({
                    content: [{ type: 'text', text }],
                    source,
                }))
                trace('已叫醒 agent: ' + w.id + '  source=' + kind + (w.form ? ('/form=' + w.form) : '') + '  sid=' + (sidOf(agent) || '?') + '  text=' + text.slice(0, 40))
                return true
            } catch (e) {
                trace('steer 失败: ' + w.id + '  ' + (e?.message || e))
                return false
            }
        }

        /**
         * session-semantic：把小窗口的最近用户消息丢给模型，问"该不该提醒"。
         * 三条成本纪律都在这里：冷却、有新消息才判、硬超时。
         */
        async function checkSemantic(w, cfg) {
            const now = Date.now()
            const s = rt(w)
            if (now < s.cooldownUntil) return false
            // 首次看到这个监听项：只把基线对齐到当前消息版本，不判 ——
            // 否则窗口里那些历史消息会被当成"刚来的新消息"，装完插件立刻误触发一次。
            if (s.lastMsgVersion === undefined) {
                s.lastMsgVersion = userMsgVersion
                return false
            }
            if (s.lastMsgVersion === userMsgVersion) return false
            const agent = pickAgent(w)
            if (!agent) return false
            const prompt = String(w.prompt || '')
            if (!prompt) return false
            const n = Math.max(1, Number(w.window || 5))
            const recent = recentUserTexts.slice(-n).join('\n---\n')
            if (!recent) return false
            const full = prompt + '\n\n【最近对话（用户说的）】\n' + recent + '\n\n只回答一个词：是 或 否'
            const ctrl = new AbortController()
            const timer = setTimeout(() => { try { ctrl.abort() } catch { /* ignore */ } }, Math.max(1000, Number(w.timeoutMs || 8000)))
            try {
                const hit = await judgeWithLlm(agent, full, ctrl.signal)
                s.lastMsgVersion = userMsgVersion
                if (hit) s.cooldownUntil = now + Math.max(60, Number(w.cooldownSeconds || 900)) * 1000
                if (hit) trace('语义判断命中: ' + w.id)
                return hit
            } catch {
                return false
            } finally {
                clearTimeout(timer)
            }
        }

        async function tick() {
            try {
                const list = readWatches()
                if (!list.length) return
                let dirty = false
                for (const w of list) {
                    if (!w || w.fired) continue
                    let hit = false
                    try {
                        hit = w.type === 'session-semantic'
                            ? await checkSemantic(w, cfg)
                            : await checkCondition(w, cfg)
                    } catch (e) {
                        trace('检查异常: ' + w.id + '  ' + (e?.message || e))
                    }
                    if (!hit) continue

                    const ok = await fireOne(w)
                    if (ok) {
                        // 重复型（带 repeatSeconds）：不标记 fired，而是把触发条件"往后挪一格"，
                        // 这样同一条监听可以反复响，不用人工重排。
                        // 2026-10-04 加，供「流中断检测」用。
                        //   time      -> at 推到 now + repeatSeconds
                        //   file-size -> bytes 抬到"当前文件大小 + 1"（涨 1 字节就再响）
                        //   其它类型  -> repeatSeconds 无意义，退化成一次性
                        const rep = Number(w.repeatSeconds)
                        let rearmed = false
                        if (Number.isFinite(rep) && rep > 0) {
                            if (w.type === 'time') {
                                w.at = new Date(Date.now() + rep * 1000).toISOString()
                                rearmed = true
                            } else if (w.type === 'file-size') {
                                const s = fileSize(w.path)
                                if (s !== null) { w.bytes = s + 1; rearmed = true }
                            }
                        }
                        // session-match 永远不设 fired：它靠 __cooldownUntil 自己冷却，
                        // 冷却期由 matchSession 在命中时写。
                        if (w.type === 'session-match') rearmed = true
                        if (rearmed) {
                            w.firedCount = (w.firedCount || 0) + 1
                            w.lastFiredAt = new Date().toISOString()
                            dirty = true
                        } else {
                            w.fired = true; w.firedAt = new Date().toISOString(); dirty = true
                        }
                    }
                    else {
                        w.retries = (w.retries || 0) + 1
                        if (w.retries >= cfg.maxRetries) { w.fired = true; w.firedAt = new Date().toISOString(); dirty = true; trace('重试超限，放弃: ' + w.id) }
                        else dirty = true
                    }
                }
                if (dirty) writeWatches(list)
            } catch (e) {
                trace('tick 异常: ' + (e?.message || e))
            }
        }

        // 定时器：用 ctx.effect 持有清理函数，插件停用/更新时自动收掉。
        // 加固：拿不到 ctx.effect 就【停用】，不再退回"裸 setInterval"。裸定时器没人能收回来
        // （插件停用或重载之后它还在跑，继续读 watch.json 去叫醒 agent），而"注册不全还硬跑"
        // 正是这次要消灭的失败模式。注册失败一律走"一行日志 + 停用"这条路。
        if (typeof ctx.effect !== 'function') {
            for (const d of disposers) { try { d() } catch {} }
            trace('注册失败，插件停用: ctx.effect 不可用（这个 DSH build 没有它）')
            return
        }
        try {
            ctx.effect(() => {
                const h = setInterval(() => { void tick() }, Math.max(3000, Number(cfg.intervalMs) || 15000))
                return () => { try { clearInterval(h) } catch {} }
            })
            trace('定时器已挂载')
        } catch (e) {
            for (const d of disposers) { try { d() } catch {} }
            trace('注册失败，插件停用: ctx.effect 挂载失败 ' + (e?.message || e))
            return
        }

        // 确保 watch.json 存在（方便用户直接编辑）
        try {
            if (!fs.existsSync(WATCH_FILE)) writeWatches([])
        } catch {}

        // 2026-11-27: system-prompt 注入通道（via:'system-prompt' 用）。
        // 走反射拿服务，拿不到只记一行日志，fireOne 会退化成 steer。
        try {
            let sp = null
            try { sp = ctx.systemPrompt } catch { /* 未声明就试反射 */ }
            if (!sp) {
                try { sp = ctx.reflect && typeof ctx.reflect.get === 'function' ? ctx.reflect.get('systemPrompt', false) : null } catch { /* ignore */ }
            }
            if (sp && typeof sp.variable === 'function' && typeof sp.section === 'function') {
                systemPromptRef = sp
                const dv = sp.variable('night_watch_notice', () => {
                    if (noticeState.roundsLeft > 0 && noticeState.text) {
                        noticeState.roundsLeft -= 1
                        return noticeState.text
                    }
                    return ''
                })
                const ds = sp.section({
                    name: 'night-watch-notice',
                    order: 91,
                    text: '{{night_watch_notice}}',
                })
                disposers.push(dv, ds)
                trace('系统提示注入通道已就绪（via:system-prompt 可用）')
            } else {
                trace('没有 systemPrompt 服务 —— via:system-prompt 会退化成 steer')
            }
        } catch (e) {
            trace('系统提示注入通道注册失败（退化成 steer）: ' + (e?.message || e))
        }

        // 2026-11-27: llm 服务（type:'session-semantic' 用）—— 跟 compaction 摘要是同一条路。
        // 拿不到只记日志，session-semantic 的监听项会永远判 false（不会误触发）。
        try {
            let llm = null
            try { llm = ctx.llm } catch { /* 未声明就试反射 */ }
            if (!llm) {
                try { llm = ctx.reflect && typeof ctx.reflect.get === 'function' ? ctx.reflect.get('llm', false) : null } catch { /* ignore */ }
            }
            if (llm && typeof llm.stream === 'function') {
                llmRef = llm
                trace('llm 服务已就绪（type:session-semantic 可用）')
            } else {
                trace('没有 llm 服务 —— session-semantic 的监听项不会触发')
            }
        } catch (e) {
            trace('llm 服务注册失败: ' + (e?.message || e))
        }

        trace('守夜人就绪')
    } catch (e) {
        // 绝对不能因为本插件让 DSH 起不来
        trace('apply 致命异常（已吞下）: ' + (e?.stack || e?.message || e))
    }
}
