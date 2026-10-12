// ============================================================
//  verify-dist.mjs —— 验证"单文件安装包"真的能装
// ------------------------------------------------------------
//  做法（模拟收件人的 AI 照做）：
//    1. 读 dist/守夜人-安装包-vX.md
//    2. 把里面每个 ```代码块 ``` 抠出来，还原成文件
//    3. 跟【源文件】逐字节比对（哈希）
//    4. 在还原出来的副本上跑 node --check 和 npm test
//
//  跑法:  node tools/verify-dist.mjs
//  退出码: 0 = 通过, 1 = 有问题
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const MD = path.join(ROOT, 'dist', `守夜人-安装包-v${pkg.version}.md`)

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + n) } else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + n + (e ? '  → ' + e : '')) } }
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)

console.log('安装包: ' + MD)
ok('安装包存在', fs.existsSync(MD))
if (!fs.existsSync(MD)) process.exit(1)

const md = fs.readFileSync(MD, 'utf8')
console.log('大小: ' + (md.length / 1024).toFixed(1) + ' KB\n')

// ---- 1. 收集 .md 里的代码块，并尝试对应到"目标路径" ----
// .md 的实际格式（块之间可能夹空行；围栏可能是 3 或 4 个反引号）：
//     ### `<dest>`
//     <空行>
//     > note
//     <空行>
//     ````lang          ← 内容里含 ``` 时用 4 个反引号包裹
//     ...code...
//     ````
const re = /^### `([^`]+)`[^\n]*\n+((?:>[^\n]*\n+)*)(`{3,})[a-z]*\n([\s\S]*?)\n\3/gm
const found = []
let m
while ((m = re.exec(md)) !== null) {
    found.push({ dest: m[1], fence: m[3].length, body: m[4] })
}
console.log('从安装包里抠出 ' + found.length + ' 个代码块:\n')
for (const f of found) console.log('    ' + f.dest + '   (' + f.body.length + ' 字符, 围栏' + f.fence + '反引号)')
console.log('')

// ---- 2. 期望的文件清单 ----
const EXPECT = [
    { dest: '<插件目录>/package.json',       src: 'package.json' },
    { dest: '<插件目录>/cordis.patch.yml',   src: 'cordis.patch.yml' },
    { dest: '<插件目录>/index.js',           src: 'index.js' },
    { dest: '<插件目录>/README.md',          src: 'README.md' },
    { dest: '<插件目录>/README.zh-CN.md',    src: 'README.zh-CN.md' },
    { dest: '<插件目录>/LICENSE',            src: 'LICENSE' },
    { dest: '<插件目录>/watch.example.json', src: 'watch.example.json' },
    { dest: '<插件目录>/test/test.mjs',      src: 'test/test.mjs' },
    { dest: '<插件目录>/watch.json',         src: null },   // 模板，无源文件
]

// ---- 3. 逐字节比对（关键！）----
console.log('── 代码块完整性（跟源文件字节级比对）')
for (const e of EXPECT) {
    const got = found.find(f => f.dest === e.dest)
    if (!got) { ok(e.dest + ' 在安装包里', false, '没找到'); continue }
    if (e.src) {
        const orig = fs.readFileSync(path.join(ROOT, e.src), 'utf8')
        const a = sha(Buffer.from(orig.replace(/\n+$/, ''), 'utf8'))
        const b = sha(Buffer.from(got.body, 'utf8'))
        ok(e.dest + ' 内容一字不差', a === b, a === b ? '' : `源=${a} 包内=${b} (长度 源${orig.length} / 包${got.body.length})`)
    } else {
        let parsed = null
        try { parsed = JSON.parse(got.body) } catch {}
        ok(e.dest + ' 是合法 JSON 模板', parsed !== null && Array.isArray(parsed.watches))
    }
}

// ---- 4. 模拟安装：还原到临时目录并跑真实检查 ----
console.log('\n── 模拟安装（还原到临时目录）')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proactive-install-'))
try {
    for (const f of found) {
        // 只还原"插件目录"里的文件；把 <插件目录> 映射到临时目录
        if (!f.dest.startsWith('<插件目录>/')) continue
        const rel = f.dest.replace('<插件目录>/', '')
        // 防目录穿越
        if (rel.includes('..') || path.isAbsolute(rel)) { ok('安全: ' + rel + ' 不含穿越', false); continue }
        const dst = path.join(TMP, rel)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.writeFileSync(dst, f.body, 'utf8')
    }
    const wrote = []
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(x => {
        const p = path.join(d, x.name)
        x.isDirectory() ? walk(p) : wrote.push(path.relative(TMP, p))
    })
    walk(TMP)
    console.log('  还原出 ' + wrote.length + ' 个文件: ' + wrote.join(', '))
    ok('还原的 package.json 可解析', (() => { try { JSON.parse(fs.readFileSync(path.join(TMP, 'package.json'), 'utf8')); return true } catch { return false } })())

    // node --check index.js
    let syntaxOk = true
    try { execFileSync('node', ['--check', path.join(TMP, 'index.js')], { stdio: 'pipe' }) } catch { syntaxOk = false }
    ok('还原的 index.js 语法正确 (node --check)', syntaxOk)

    // 跑测试（需要 @deepseek-ai/dsh-llm 能解析 → 建个 junction 到真实的）
    const realNm = path.join(ROOT, '..', 'node_modules', '@deepseek-ai')
    const tmpNm = path.join(TMP, 'node_modules', '@deepseek-ai')
    let testRan = false, testOut = ''
    try {
        if (fs.existsSync(realNm)) {
            fs.mkdirSync(path.dirname(tmpNm), { recursive: true })
            if (process.platform === 'win32') {
                execFileSync('cmd', ['/c', 'mklink', '/J', tmpNm, path.resolve(realNm)], { stdio: 'pipe' })
            } else {
                fs.symlinkSync(path.resolve(realNm), tmpNm, 'dir')
            }
        }
        testOut = String(execFileSync('node', [path.join(TMP, 'test', 'test.mjs')], { stdio: 'pipe', encoding: 'utf8' }))
        testRan = true
    } catch (e) {
        testOut = String(e.stdout || '') + String(e.stderr || '')
        testRan = testOut.includes('通过')
    }
    // ★ 先剥掉 ANSI 颜色码再解析 —— 直接对带色码的文本做正则匹配过，
    //   结果把总结行解析错（明明"失败 0"却读出 2）。这是验证器自身的 bug。
    const cleanOut = testOut.replace(/\x1b\[[0-9;]*m/g, '')
    const sum = cleanOut.match(/通过\s+(\d+)\s+失败\s+(\d+)/)
    const pnum = sum ? Number(sum[1]) : -1
    const fnum = sum ? Number(sum[2]) : -1
    ok('在还原副本上跑通了测试', testRan)
    // ★ 不硬编码用例数（加了测试就会假报警）—— 只要求"有用例、且全绿"
    ok('还原副本测试全绿（0 失败）', pnum > 0 && fnum === 0, `通过=${pnum} 失败=${fnum}`)

    // 如果没全绿，把整个输出末尾打出来（不然没法诊断）
    if (fnum > 0) {
        console.log('\n  ── 还原副本测试输出的末尾 45 行 ──')
        const clean = testOut.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
        console.log(clean.slice(-45).map(l => '    | ' + l).join('\n'))
        console.log('')
    }
} finally {
    fs.rmSync(TMP, { recursive: true, force: true })
}

// ---- 5. 给AI看的说明书必须有的关键段落 ----
console.log('\n── 说明书本身的可读性（收件人的 AI 要靠它干活）')
const NEED = [
    ['开头就说清楚"给DSH的AI看"', /给 DSH 的 AI 看/],
    ['说明了这是什么插件', /这是什么/],
    ['有安装步骤', /安装步骤/],
    ['教怎么找 profile 目录', /profile 目录/],
    ['教怎么注册 dependencies', /dependencies/],
    ['教怎么注册 bundles', /bundles/],
    ['说明了要重启 DSH', /重启 DSH/],
    ['教了怎么验证装成功 (boot.log)', /boot\.log/],
    ['给了 watch.json 用法', /六种触发类型/],
    ['有验收清单', /验收标准/],
    ['提醒先备份', /备份/],
]
for (const [name, rx] of NEED) ok(name, rx.test(md))

console.log('\n' + '='.repeat(56))
console.log('  通过 \x1b[32m' + pass + '\x1b[0m   失败 ' + (fail ? '\x1b[31m' + fail + '\x1b[0m' : '0'))
console.log('='.repeat(56))
process.exit(fail ? 1 : 0)
