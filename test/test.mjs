// ============================================================
//  dsh-proactive 守夜人插件 · 测试套件
// ------------------------------------------------------------
//  跑法:  node test/test.mjs
//  覆盖:  checkCondition 单元测试 + apply() 集成测试
//  特点:  全部用临时目录，不碰真实 watch.json / boot.log
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { apply, checkCondition } from '../index.js'

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proactive-test-'))

let pass = 0, fail = 0
const failures = []

function ok(name, cond, extra = '') {
    if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name) }
    else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')) }
}
function section(t) { console.log('\n\x1b[36m── ' + t + '\x1b[0m') }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * 轮询等待条件成立。
 * ★ 为什么不用固定 sleep：定时器下限是 3000ms，写死 sleep(3200) 等它，
 *   机器一忙（或 CI 上）就会错过窗口 → flaky test。改成轮询：条件一成立立刻走，
 *   慢的时候也给足 12 秒窗口。
 */
async function until(pred, ms = 12000, step = 120) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
        try { if (await pred()) return true } catch { /* 条件还没到 */ }
        await sleep(step)
    }
    return false
}
/** 要证明"它【不】会触发"时，必须等满一个完整定时器窗口。
 *  取 2× interval(3000) —— 单层跑 4.2s 够，但被 pwsh→node→node 套着跑时
 *  机器更忙，会错过窗口 → flaky。6s 实测稳。 */
const QUIET = 6000

// ---------- 测试夹具 ----------
const tmpWatch = path.join(TMP, 'watch.json')
const tmpLog = path.join(TMP, 'boot.log')
const tmpFile = path.join(TMP, 'payload.bin')
const tmpGone = path.join(TMP, 'does-not-exist.bin')

function setName(name) { return path.join(TMP, name) }
function writeFile(n, bytes) { fs.writeFileSync(n, Buffer.alloc(bytes, 1)); return n }
function setWatches(list) { fs.writeFileSync(tmpWatch, JSON.stringify({ _说明: 'DOC-KEY', watches: list }, null, 2)) }
function readWatches() { return JSON.parse(fs.readFileSync(tmpWatch, 'utf8')) }
function logText() { try { return fs.readFileSync(tmpLog, 'utf8') } catch { return '' } }

/** 造一个假的 ctx（只实现插件用到的接口） */
function makeCtx({ throwOnEffect = false, systemPrompt = undefined, llm = undefined } = {}) {
    const agents = []
    const listeners = new Map()
    const cleanups = []
    return {
        agents: { list: () => agents },
        on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn) },
        effect: (fn) => { if (throwOnEffect) throw new Error('effect 挂了'); cleanups.push(fn()) },
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(llm ? { llm } : {}),
        // 测试辅助
        _agents: agents,
        _emit: (ev, p) => (listeners.get(ev) || []).forEach(f => f(p)),
        _cleanup: () => cleanups.forEach(c => { try { c() } catch {} }),
    }
}

/** 假的 systemPrompt 服务：记录 variable/section 注册，能手动"装配一次"看注入值 */
function makeSystemPrompt() {
    const vars = new Map()
    const sections = []
    return {
        variable: (n, p) => { vars.set(n, p); return () => vars.delete(n) },
        section: (s) => { sections.push(s); return () => {} },
        _vars: vars,
        _sections: sections,
        /** 模拟一次提示装配：返回本轮的 section 文本（空串表示没注入） */
        _assemble: () => sections.map((s) => String(s.text).replace(/\{\{([a-z0-9_]+)\}\}/g, (_, n) => {
            const p = vars.get(n)
            const v = typeof p === 'function' ? p() : ''
            return v === undefined || v === null ? '' : String(v)
        })).filter((t) => t.length > 0),
    }
}

/** 假的 llm 服务：把收到的 prompt 记下来，按预设回答 */
function makeLlm(answer = '否') {
    const calls = []
    return {
        stream: (options) => (async function* () {
            calls.push(options)
            const text = String(options.messages?.[0]?.content?.[0]?.text || '')
            const reply = typeof answer === 'function' ? answer(text) : answer
            if (reply) yield { type: 'text-delta', text: reply }
            yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
        _calls: calls,
    }
}

function makeAgent(id, { onSteer, options } = {}) {
    const got = []
    return {
        session: { id },
        // session-semantic 要 provider/model（跟 compaction 摘要取的是同一个来源）
        options: options || { provider: 'deepseek-official', model: 'deepseek-flash' },
        steer: (msg) => { got.push(msg); if (onSteer) onSteer(msg) },
        _got: got,
    }
}

const FAST = 60 // 测试用不到定时器，intervalMs 会被 clamp 到 3000，这里只跑手动 tick

// ============================================================
section('A. checkCondition 单元测试')
// ============================================================
const CFG = { stableRounds: 3 }

// --- file-exists ---
writeFile(tmpFile, 10)
ok('file-exists: 存在的文件 → true', await checkCondition({ type: 'file-exists', path: tmpFile }, CFG))
ok('file-exists: 不存在的文件 → false', (await checkCondition({ type: 'file-exists', path: tmpGone }, CFG)) === false)
ok('file-exists: 目录 → false（只认文件）', (await checkCondition({ type: 'file-exists', path: TMP }, CFG)) === false)
ok('file-exists: 空 path → false', (await checkCondition({ type: 'file-exists' }, CFG)) === false)

// --- file-size ---
writeFile(tmpFile, 100)
ok('file-size: 达到阈值 → true', await checkCondition({ type: 'file-size', path: tmpFile, bytes: 100 }, CFG))
ok('file-size: 超过阈值 → true', await checkCondition({ type: 'file-size', path: tmpFile, bytes: 50 }, CFG))
ok('file-size: 未达阈值 → false', (await checkCondition({ type: 'file-size', path: tmpFile, bytes: 101 }, CFG)) === false)
ok('file-size: 文件不存在 → false', (await checkCondition({ type: 'file-size', path: tmpGone, bytes: 0 }, CFG)) === false)
ok('file-size: bytes 缺省(=0) → 文件存在即 true', await checkCondition({ type: 'file-size', path: tmpFile }, CFG))

// --- file-stable ---
{
    const f = writeFile(setName('stable.bin'), 500)
    const w = { type: 'file-stable', path: f, rounds: 3 }
    const r1 = await checkCondition(w, CFG)
    const r2 = await checkCondition(w, CFG)
    const r3 = await checkCondition(w, CFG)
    ok('file-stable: 第1轮 → false', r1 === false)
    ok('file-stable: 第2轮 → false', r2 === false)
    ok('file-stable: 第3轮(连续3次没变) → true', r3 === true)
}
{
    const f = writeFile(setName('growing.bin'), 500)
    const w = { type: 'file-stable', path: f, rounds: 3 }
    await checkCondition(w, CFG)
    await checkCondition(w, CFG)
    writeFile(f, 900)                                  // 还在长
    const r = await checkCondition(w, CFG)
    ok('file-stable: 大小变了 → 计数重置回1(false)', r === false && w.__stable === 1)
}
{
    const f = writeFile(setName('vanish.bin'), 500)
    const w = { type: 'file-stable', path: f, rounds: 2 }
    await checkCondition(w, CFG)
    await checkCondition(w, CFG)                       // 这一轮应该 true
    const fired = await checkCondition(w, CFG)
    fs.unlinkSync(f)
    const r = await checkCondition(w, CFG)
    ok('file-stable: 文件消失 → 重置且 false', r === false && w.__stable === 0)
    ok('file-stable: 消失前确实触发过', fired === true)
}
{
    const w = { type: 'file-stable', path: tmpFile, rounds: 1 }
    const r = await checkCondition(w, CFG)
    ok('file-stable: rounds=1 → 首轮即 true', r === true)
}

// --- process-exit ---
ok('process-exit: 存在的进程 → false', (await checkCondition({ type: 'process-exit', process: 'explorer.exe' }, CFG)) === false)
ok('process-exit: 不存在的进程 → true', (await checkCondition({ type: 'process-exit', process: 'no-such-proc-xyz.exe' }, CFG)) === true)

// --- port-open ---
{
    const srv = net.createServer()
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    const port = srv.address().port
    ok('port-open: 正在监听的端口 → true', await checkCondition({ type: 'port-open', port }, CFG))
    await new Promise(r => srv.close(r))
    await sleep(120)
    ok('port-open: 已关闭的端口 → false', (await checkCondition({ type: 'port-open', port }, CFG)) === false)
}
ok('port-open: 不存在的端口(1) → false', (await checkCondition({ type: 'port-open', port: 1 }, CFG)) === false)

// --- time ---
ok('time: 过去的时间 → true', await checkCondition({ type: 'time', at: '2020-01-01T00:00:00' }, CFG))
ok('time: 未来的时间 → false', (await checkCondition({ type: 'time', at: '2099-01-01T00:00:00' }, CFG)) === false)
ok('time: 非法时间串 → false（不抛）', (await checkCondition({ type: 'time', at: 'not-a-date' }, CFG)) === false)

// --- 未知类型 ---
ok('未知 type → false（静默）', (await checkCondition({ type: 'no-such-type' }, CFG)) === false)
ok('type 缺省 → false', (await checkCondition({}, CFG)) === false)

// ============================================================
section('B. apply() 集成测试')
// ============================================================

// --- B1: 正常触发，消息送达 agent ---
{
    setWatches([{ id: 't1', type: 'file-exists', path: tmpFile, message: 'FILE-READY' }])
    const ctx = makeCtx()
    const ag = makeAgent('sess-1')
    ctx._agents.push(ag)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: ag })
    await sleep(QUIET)                                   // 等第一次 tick（clamp 到 3000ms）
    const w = readWatches().watches[0]
    ok('B1 触发: 标记 fired=true', w.fired === true)
    ok('B1 触发: 记录了 firedAt', typeof w.firedAt === 'string' && w.firedAt.length > 10)
    ok('B1 触发: agent 收到 1 条消息', ag._got.length === 1, '实际 ' + ag._got.length)
    ok('B1 触发: 消息文本正确', ag._got[0]?.content?.[0]?.text === 'FILE-READY')
    ok('B1 触发: source.kind = plugin', ag._got[0]?.source?.kind === 'plugin')
    ok('B1 触发: source.plugin = dsh-proactive', ag._got[0]?.source?.plugin === 'dsh-proactive')
    ok('B1 触发: 保留了 _说明 文档键', readWatches()._说明 === 'DOC-KEY')
    ctx._cleanup()
}

// --- B2: fired=true 的项不再触发 ---
{
    setWatches([{ id: 't2', type: 'file-exists', path: tmpFile, fired: true, message: 'X' }])
    const ctx = makeCtx(); const ag = makeAgent('sess-2'); ctx._agents.push(ag)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: ag })
    await sleep(QUIET)
    ok('B2 已fired: 不再触发', ag._got.length === 0)
    ctx._cleanup()
}

// --- B3: 没有 agent 时不崩、累加 retries ---
{
    setWatches([{ id: 't3', type: 'file-exists', path: tmpFile, message: 'Y' }])
    const ctx = makeCtx()
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    await sleep(QUIET)
    const w = readWatches().watches[0]
    ok('B3 无agent: 不标记 fired', !w.fired)
    ok('B3 无agent: retries 累加', (w.retries || 0) >= 1, 'retries=' + w.retries)
    ok('B3 无agent: 日志有记录', logText().includes('无可用 agent'))
    ctx._cleanup()
}

// --- B4: steer 抛异常 → 被捕获 + retries++ ---
{
    setWatches([{ id: 't4', type: 'file-exists', path: tmpFile, message: 'Z' }])
    const ctx = makeCtx()
    const ag = makeAgent('sess-4', { onSteer: () => { throw new Error('steer炸了') } })
    ctx._agents.push(ag)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: ag })
    await sleep(QUIET)
    const w = readWatches().watches[0]
    ok('B4 steer异常: 不标记 fired', !w.fired)
    ok('B4 steer异常: retries 累加', (w.retries || 0) >= 1)
    ok('B4 steer异常: 日志记下 steer 失败', logText().includes('steer 失败'))
    ctx._cleanup()
}

// --- B5: maxRetries 超限 → 放弃并标记 fired ---
{
    setWatches([{ id: 't5', type: 'file-exists', path: tmpFile, message: 'W', retries: 99 }])
    const ctx = makeCtx()
    const ag = makeAgent('sess-5', { onSteer: () => { throw new Error('nope') } })
    ctx._agents.push(ag)
    apply(ctx, { enabled: true, maxRetries: 1, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: ag })
    await sleep(QUIET)
    const w = readWatches().watches[0]
    ok('B5 重试超限: 标记 fired（放弃）', w.fired === true)
    ok('B5 重试超限: 日志有"重试超限"', logText().includes('重试超限'))
    ctx._cleanup()
}

// --- B6: 损坏的 watch.json → 不崩 ---
{
    fs.writeFileSync(tmpWatch, '{ 这不是合法JSON !!!')
    const ctx = makeCtx(); const ag = makeAgent('sess-6'); ctx._agents.push(ag)
    let threw = false
    try {
        apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
        await sleep(QUIET)
    } catch { threw = true }
    ok('B6 坏JSON: apply 不抛', !threw)
    ok('B6 坏JSON: agent 没被打扰', ag._got.length === 0)
    ctx._cleanup()
}

// --- B7: watch.json 是裸数组 → 兼容 ---
{
    fs.writeFileSync(tmpWatch, JSON.stringify([{ id: 't7', type: 'file-exists', path: tmpFile, message: 'ARR' }]))
    const ctx = makeCtx(); const ag = makeAgent('sess-7'); ctx._agents.push(ag)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: ag })
    await sleep(QUIET)
    ok('B7 数组格式: 兼容并触发', ag._got.length === 1 && ag._got[0]?.content?.[0]?.text === 'ARR')
    ctx._cleanup()
}

// --- B8: watch.json 不存在 → 自动创建，不崩 ---
{
    const missing = path.join(TMP, 'sub', 'watch.json')
    const ctx = makeCtx()
    let threw = false
    try {
        apply(ctx, { enabled: true, intervalMs: 3000, watchFile: missing, logFile: tmpLog })
        await sleep(200)
    } catch { threw = true }
    ok('B8 文件不存在: 不崩', !threw)
    ok('B8 文件不存在: 自动创建了 watch.json', fs.existsSync(missing))
    ctx._cleanup()
}

// --- B9: enabled:false → 不挂定时器 ---
{
    setWatches([{ id: 't9', type: 'file-exists', path: tmpFile, message: 'OFF' }])
    const ctx = makeCtx(); const ag = makeAgent('sess-9'); ctx._agents.push(ag)
    apply(ctx, { enabled: false, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: ag })
    await sleep(QUIET)
    ok('B9 enabled=false: 完全不触发', ag._got.length === 0)
    ok('B9 enabled=false: 日志说明不加载', logText().includes('enabled=false'))
    ctx._cleanup()
}

// --- B11: sourceKind 覆盖 ---
{
    setWatches([{ id: 't11', type: 'file-exists', path: tmpFile, message: 'U', sourceKind: 'user' }])
    const ctx = makeCtx(); const ag = makeAgent('sess-11'); ctx._agents.push(ag)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: ag })
    await sleep(QUIET)
    ok('B11 sourceKind=user: 产出 user 来源', ag._got[0]?.source?.kind === 'user')
    ctx._cleanup()
}

// --- B12: message 缺省 → 有默认文本 ---
{
    setWatches([{ id: 't12', type: 'file-exists', path: tmpFile }])
    const ctx = makeCtx(); const ag = makeAgent('sess-12'); ctx._agents.push(ag)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: ag })
    await sleep(QUIET)
    ok('B12 默认消息: 含【守夜人】', String(ag._got[0]?.content?.[0]?.text || '').includes('【守夜人】'))
    ctx._cleanup()
}

// --- B13: agent/disposed 后不再投递 ---
{
    setWatches([{ id: 't13', type: 'file-exists', path: tmpFile, message: 'D' }])
    const ctx = makeCtx(); const ag = makeAgent('sess-13'); ctx._agents.push(ag)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/session-start', { agent: ag })
    ctx._emit('agent/disposed', { agent: ag })
    await sleep(QUIET)
    ok('B13 已disposed: 不投递', ag._got.length === 0)
    ctx._cleanup()
}

// --- B14: 空 watches[] → 不报错 ---
{
    setWatches([])
    const ctx = makeCtx()
    let threw = false
    try { apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog }); await sleep(200) } catch { threw = true }
    ok('B14 空清单: 不崩', !threw)
    ctx._cleanup()
}

// ============================================================
section('C. 会话选择（"叫醒哪个会话"）')
// ============================================================
// 背景：以前 pickAgent 取"Map 里最后一个"=最后【注册】的会话，不是最近【活跃】的，
//       开两个会话时会叫醒错的那个（实测踩过）。修成"最近活跃"+"指定不存在不误投"。

// --- C1: 指定 sessionId 且存在 → 只叫它 ---
{
    setWatches([{ id: 'c1', type: 'file-exists', path: tmpFile, message: 'TO-A', sessionId: 'sess-A' }])
    const ctx = makeCtx()
    const agA = makeAgent('sess-A'); const agB = makeAgent('sess-B')
    ctx._agents.push(agA, agB)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: agA })
    ctx._emit('agent/created', { agent: agB })
    await until(() => readWatches().watches[0]?.fired === true)
    ok('C1 指定会话: 只有它收到', agA._got.length === 1 && agB._got.length === 0, `A=${agA._got.length} B=${agB._got.length}`)
    ctx._cleanup()
}

// --- C2: 指定 sessionId 但那个会话不存在 → 【绝不】误投给别人 ---
{
    setWatches([{ id: 'c2', type: 'file-exists', path: tmpFile, message: 'TO-GHOST', sessionId: 'sess-NOT-EXIST' }])
    const ctx = makeCtx()
    const ag = makeAgent('sess-REAL'); ctx._agents.push(ag)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: ag })
    await sleep(QUIET)
    ok('C2 指定的会话不存在: 不误投给别的会话', ag._got.length === 0, '实际收到 ' + ag._got.length)
    ok('C2 指定的会话不存在: 日志有说明', logText().includes('指定的会话不存在'))
    ok('C2 指定的会话不存在: 不标记 fired（还在等）', !readWatches().watches[0].fired)
    ctx._cleanup()
}

// --- C3: 没指定 → 挑【最近活跃】的，而不是最后注册的 ---
{
    setWatches([{ id: 'c3', type: 'file-exists', path: tmpFile, message: 'LATEST' }])
    const ctx = makeCtx()
    const agOld = makeAgent('sess-OLD')
    const agNew = makeAgent('sess-NEW')
    ctx._agents.push(agOld, agNew)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: agOld })
    await sleep(30)
    ctx._emit('agent/created', { agent: agNew })          // NEW 注册更晚
    await sleep(30)
    // 但让 OLD 变成"最近活跃"（模拟用户切回旧会话说了句话）
    ctx._emit('agent/inbox/inserted', { agent: agOld, message: { content: [] } })
    await until(() => readWatches().watches[0]?.fired === true)
    ok('C3 最近活跃: 叫醒的是 OLD（活跃晚），不是 NEW（注册晚）',
        agOld._got.length === 1 && agNew._got.length === 0,
        `OLD=${agOld._got.length} NEW=${agNew._got.length}`)
    ctx._cleanup()
}

// --- C4: agent/status running 也算活跃 ---
{
    setWatches([{ id: 'c4', type: 'file-exists', path: tmpFile, message: 'STATUS' }])
    const ctx = makeCtx()
    const agA = makeAgent('sess-X'); const agB = makeAgent('sess-Y')
    ctx._agents.push(agA, agB)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: agA })
    await sleep(30)
    ctx._emit('agent/created', { agent: agB })
    await sleep(30)
    ctx._emit('agent/status', { agent: agA, status: 'running' })   // A 开始干活
    await until(() => readWatches().watches[0]?.fired === true)
    ok('C4 status=running: 算活跃并叫醒该会话', agA._got.length === 1 && agB._got.length === 0)
    ctx._cleanup()
}

// --- C5: 会话 disposed 后不再叫它 ---
{
    setWatches([{ id: 'c5', type: 'file-exists', path: tmpFile, message: 'GONE' }])
    const ctx = makeCtx()
    const ag = makeAgent('sess-GONE'); ctx._agents.push(ag)
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: tmpWatch, logFile: tmpLog })
    ctx._emit('agent/created', { agent: ag })
    ctx._emit('agent/disposed', { agent: ag })
    await sleep(QUIET)
    ok('C5 会话已关闭: 不叫醒', ag._got.length === 0)
    ctx._cleanup()
}

// --- B10: ctx.effect 挂载失败 → 记一行日志并停用，绝不抛出去 ---
// 加固后【不再】退回"裸 setInterval"：裸定时器没人能收回来（插件停用或重载之后它还在跑，
// 继续读 watch.json 去叫醒 agent）。这条路径现在和别的注册失败一样，只写一行日志然后停用。
{
    const b10Watch = path.join(TMP, 'watch-b10.json')
    fs.writeFileSync(b10Watch, JSON.stringify({ watches: [{ id: 't10', type: 'file-exists', path: tmpFile, message: 'FALLBACK' }] }))
    const ctx = makeCtx({ throwOnEffect: true })
    const ag = makeAgent('sess-10'); ctx._agents.push(ag)
    let threw = false
    try { apply(ctx, { enabled: true, intervalMs: 3000, watchFile: b10Watch, logFile: tmpLog }) } catch { threw = true }
    ctx._emit('agent/created', { agent: ag })
    await sleep(QUIET)
    ok('B10 effect异常: apply 不抛', !threw)
    ok('B10 effect异常: 日志有"注册失败，插件停用"', logText().includes('注册失败，插件停用'))
    ok('B10 effect异常: 确实停用了（没叫醒）', JSON.parse(fs.readFileSync(b10Watch, 'utf8')).watches[0].fired !== true && ag._got.length === 0)
    ctx._cleanup()
}

// --- B15: 上下文不兼容（ctx.on 抛异常 / 根本没有 / ctx 是 null）→ 一行日志 + 停用，不抛 ---
// 这就是本次加固针对的失败模式：第三方插件 cancanqiqi/dsh-human-subagent 调了本 build
// 没有的服务方法，异常从 apply() 冒进加载器，整个 profile 起不来。
// 注意：这条路径【绝不能】靠外面那个 try/catch 兜底 —— 那样只会记一条"致命异常"，
// 而且插件已经注册了一半。必须是"一行日志说清楚哪一步失败 + 干净停用"。
{
    const b15Log = path.join(TMP, 'boot-hostile.log')
    const b15Watch = path.join(TMP, 'watch-b15.json')
    fs.writeFileSync(b15Watch, JSON.stringify({ watches: [{ id: 't11', type: 'file-exists', path: tmpFile, message: 'HOSTILE' }] }))
    const cases = [
        { label: 'ctx.on 抛异常', ctx: { agents: { list: () => [] }, on: () => { throw new Error('boom-on') }, effect: () => {} } },
        { label: 'ctx.on 不存在', ctx: { agents: { list: () => [] }, effect: () => {} } },
        { label: 'ctx 是 null', ctx: null },
    ]
    for (const c of cases) {
        let threw = null
        try { apply(c.ctx, { enabled: true, intervalMs: 3000, watchFile: b15Watch, logFile: b15Log }) }
        catch (e) { threw = e }
        ok('B15 ' + c.label + ': apply 不抛', threw === null, threw ? String(threw.message) : '')
    }
    await sleep(QUIET)
    const text = fs.readFileSync(b15Log, 'utf8')
    const lines = (text.match(/注册失败，插件停用/g) || []).length
    ok('B15 每次失败正好一行"注册失败，插件停用"', lines === cases.length, '实际 ' + lines)
    ok('B15 停用后没有定时器在跑（监听项没被标记 fired）', JSON.parse(fs.readFileSync(b15Watch, 'utf8')).watches[0].fired !== true)
}

// ============================================================
section('C. session-match / session-semantic / system-prompt 注入（2026-11-27 新增）')
// ============================================================
{
    const { pushUserText, matchSession } = await import('../index.js')

    // 清窗口
    for (let i = 0; i < 8; i++) pushUserText('无关内容' + i)

    const w = { id: 'k', type: 'session-match', keywords: ['会话日志', '插件'], window: 3 }
    ok('C1 无关消息不命中', matchSession(w) === false)
    pushUserText('帮我把会话日志重建一下')
    ok('C2 命中关键词', matchSession(w) === true)
    // 冷却：刚命中过，立刻再判应该是 false
    ok('C3 命中后进入冷却', matchSession(w) === false)

    // window=1 只认最后一条
    const narrow = { id: 'k2', type: 'session-match', keywords: ['插件'], window: 1 }
    pushUserText('这个插件怎么用')
    pushUserText('今天天气不错')
    ok('C4 window=1 只认最后一条', matchSession(narrow) === false)

    // 没有关键词恒 false
    ok('C5 无关键词恒 false', matchSession({ type: 'session-match' }) === false)
}

// --- C6~C9: system-prompt 注入通道 + via:'system-prompt' 不插对话 ---
{
    const sp = makeSystemPrompt()
    const ctx = makeCtx({ systemPrompt: sp })
    const cWatch = path.join(TMP, 'watch-c.json')
    const cLog = path.join(TMP, 'boot-c.log')
    fs.writeFileSync(cWatch, JSON.stringify({
        watches: [{
            id: 'sp注入', type: 'file-exists', path: tmpFile,
            via: 'system-prompt', rounds: 2, message: '【测试】请先读须知',
        }],
    }))
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: cWatch, logFile: cLog })
    await sleep(QUIET)
    ok('C6 日志显示系统提示通道已就绪', fs.readFileSync(cLog, 'utf8').includes('系统提示注入通道已就绪'))
    const assembled = sp._assemble()
    ok('C7 第一轮装配能读到注入内容', assembled.some((t) => t.includes('请先读须知')), JSON.stringify(assembled))
    const second = sp._assemble()
    ok('C8 第二轮仍在（rounds:2）', second.some((t) => t.includes('请先读须知')))
    const third = sp._assemble()
    ok('C9 rounds 用完后不再注入', third.length === 0, JSON.stringify(third))
    ctx._cleanup()
}

// --- C10~C13: session-semantic 走 llm，且没有新消息不判 ---
{
    const sp = makeSystemPrompt()
    const llm = makeLlm('是')
    const ctx = makeCtx({ systemPrompt: sp, llm })
    const agent = makeAgent('sem-1')
    ctx._agents.push(agent)
    ctx._emit('agent/created', { agent })   // 让 apply 内部的 agents 表记到它（pickAgent 靠这张表）
    const sWatch = path.join(TMP, 'watch-sem.json')
    const sLog = path.join(TMP, 'boot-sem.log')
    fs.writeFileSync(sWatch, JSON.stringify({
        watches: [{
            id: '语义判断', type: 'session-semantic',
            prompt: '最近对话是不是在讨论会话日志？',
            window: 2, via: 'system-prompt', rounds: 1,
            cooldownSeconds: 900, timeoutMs: 3000,
            message: '【语义命中】请先读须知',
        }],
    }))
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: sWatch, logFile: sLog })
    // 没消息时不应调用 llm
    await sleep(QUIET)
    ok('C10 没有新消息时不调 llm', llm._calls.length === 0, 'calls=' + llm._calls.length)

    ctx._emit('session/message', { type: 'user/message', data: { content: [{ type: 'text', text: '我们聊聊会话日志的重建' }] } })
    await sleep(QUIET)
    ok('C11 有新消息时调用了 llm', llm._calls.length === 1, 'calls=' + llm._calls.length)
    ok('C12 请求带 provider/model', !!(llm._calls[0] && llm._calls[0].provider && llm._calls[0].model), JSON.stringify(llm._calls[0] && { p: llm._calls[0].provider, m: llm._calls[0].model }))
    const asm = sp._assemble()
    ok('C13 语义命中后排入系统提示', asm.some((t) => t.includes('语义命中')), JSON.stringify(asm))
    ctx._cleanup()
}

// --- C14: 语义判断返回"否"时不注入 ---
{
    const sp = makeSystemPrompt()
    const llm = makeLlm('否')
    const ctx = makeCtx({ systemPrompt: sp, llm })
    const agent2 = makeAgent('sem-2')
    ctx._agents.push(agent2)
    ctx._emit('agent/created', { agent: agent2 })
    const nWatch = path.join(TMP, 'watch-sem2.json')
    const nLog = path.join(TMP, 'boot-sem2.log')
    fs.writeFileSync(nWatch, JSON.stringify({
        watches: [{
            id: '语义否', type: 'session-semantic',
            prompt: '相关吗？', window: 2, via: 'system-prompt', rounds: 1,
            cooldownSeconds: 900, timeoutMs: 3000, message: '不该出现的提醒',
        }],
    }))
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: nWatch, logFile: nLog })
    ctx._emit('session/message', { type: 'user/message', data: { content: [{ type: 'text', text: '今天天气真好' }] } })
    await sleep(QUIET)
    const asm = sp._assemble()
    ok('C14 语义返回否 -> 不注入', asm.length === 0, JSON.stringify(asm))
    ctx._cleanup()
}

// --- C15: 插件来源的消息不参与 session-match（防自己触发自己）---
{
    const { pushUserText: push } = await import('../index.js')
    const ctx = makeCtx()
    const pWatch = path.join(TMP, 'watch-plan.json')
    fs.writeFileSync(pWatch, JSON.stringify({ watches: [] }))
    apply(ctx, { enabled: true, intervalMs: 3000, watchFile: pWatch, logFile: path.join(TMP, 'boot-plan.log') })
    const w2 = { id: 'x', type: 'session-match', keywords: ['不该命中'], window: 1 }
    for (let i = 0; i < 8; i++) push('无关')
    ctx._emit('session/message', {
        type: 'user/message',
        data: { source: { kind: 'plugin', plugin: 'dsh-proactive' }, content: [{ type: 'text', text: '不该命中 的插件消息' }] },
    })
    ok('C15 插件来源消息不计入话题窗口', (await checkCondition(w2)) === false)
    ctx._cleanup()
}

// --- C16~C20: scope:'tool' —— 只在我动插件时提醒 ---
{
    const { pushUserText: push, pushToolText, matchSession } = await import('../index.js')
    for (let i = 0; i < 8; i++) { push('无关'); pushToolText('read 无关') }

    const tw = { id: 'toolonly', type: 'session-match', scope: 'tool', keywords: ['cordis.patch.yml', 'dsh-proactive'], window: 2 }
    ok('C16 工具窗口为空时不命中', matchSession(tw) === false)

    // 用户说了插件，但 scope=tool 不该看用户消息
    push('帮我改一下插件')
    ok('C17 scope=tool 不看用户消息', matchSession(tw) === false)

    pushToolText('write {"file_path":"E:/deepseek插件/dsh-proactive/index.js"}')
    ok('C18 工具参数命中 -> 触发', matchSession(tw) === true)

    // scope=user 不该被工具调用触发
    const uw = { id: 'useronly', type: 'session-match', scope: 'user', keywords: ['cordis.patch.yml'], window: 3 }
    ok('C19 scope=user 不被工具触发', matchSession(uw) === false)

    // both 都能看（用 C18 推过的工具文本里的词）
    const bw = { id: 'both', type: 'session-match', scope: 'both', keywords: ['dsh-proactive'], window: 3 }
    ok('C20 scope=both 能看到工具调用', matchSession(bw) === true)
}

// ============================================================
// 收尾
// ============================================================
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}

console.log('\n' + '='.repeat(56))
console.log('  通过 \x1b[32m' + pass + '\x1b[0m   失败 ' + (fail ? '\x1b[31m' + fail + '\x1b[0m' : '0'))
if (fail) {
    console.log('\n  失败的用例:')
    failures.forEach(f => console.log('    - ' + f))
}
console.log('='.repeat(56))
process.exit(fail ? 1 : 0)
