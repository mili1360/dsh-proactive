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

        ctx.on('agent/created', ({ agent }) => { if (agent) remember(agent) })
        ctx.on('agent/session-start', ({ agent }) => { if (agent) remember(agent) })
        // 有消息进收件箱 = 用户刚在这个会话说话 → 最可靠的"活跃"信号
        ctx.on('agent/inbox/inserted', ({ agent }) => { if (agent) remember(agent) })
        // 状态变成 running（开始干活）也算活跃
        ctx.on('agent/status', ({ agent, status }) => { if (agent && status === 'running') remember(agent) })

        ctx.on('agent/disposed', ({ agent }) => {
            const s = sidOf(agent)
            if (s) { agents.delete(s); activeAt.delete(s) }
        })

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
            const agent = pickAgent(w)
            if (!agent) { trace('无可用 agent，暂缓: ' + w.id); return false }
            const text = w.message || `【守夜人】监听项 ${w.id} 的条件已达成。`
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

        async function tick() {
            try {
                const list = readWatches()
                if (!list.length) return
                let dirty = false
                for (const w of list) {
                    if (!w || w.fired) continue
                    let hit = false
                    try {
                        hit = await checkCondition(w, cfg)
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

        // 定时器：用 ctx.effect 持有清理函数，插件停用/更新时自动收掉
        try {
            ctx.effect(() => {
                const h = setInterval(() => { void tick() }, Math.max(3000, Number(cfg.intervalMs) || 15000))
                return () => { try { clearInterval(h) } catch {} }
            })
            trace('定时器已挂载')
        } catch (e) {
            // 兜底：即便是裸 setInterval，也要让插件跑起来（DSH 进程退出时会自然结束）
            trace('ctx.effect 挂载失败，退回裸定时器: ' + (e?.message || e))
            setInterval(() => { void tick() }, Math.max(3000, Number(cfg.intervalMs) || 15000))
        }

        // 确保 watch.json 存在（方便用户直接编辑）
        try {
            if (!fs.existsSync(WATCH_FILE)) writeWatches([])
        } catch {}

        trace('守夜人就绪')
    } catch (e) {
        // 绝对不能因为本插件让 DSH 起不来
        trace('apply 致命异常（已吞下）: ' + (e?.stack || e?.message || e))
    }
}
