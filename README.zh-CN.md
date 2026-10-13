# dsh-proactive · DSH「守夜人」

> 让 DSH 的 agent 干长活（下载几十 GB、等编译、等安装）时，**回合结束后活才干完，
> 它自己会开口告诉你** —— 不用你回来问"好了吗"。

[![tests](https://img.shields.io/badge/tests-63%20passing-brightgreen)](#测试)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English →](README.md)

---
> 符号说明：**✓** = 实测确认过 · **✗** = 陷阱，别这么做 · **⚠️** = 注意 · **⇒** = 所以


## 它解决什么

你让 agent 干一件要跑几小时的事（拉一个 40 GB 的模型、等编译、等安装）。
agent 起了个头，回合结束，**睡了**。任务其实还在跑 —— 但**没有任何东西会告诉它活干完了**，
所以也没有任何东西会告诉你：只能你自己回来问一句。

这个插件让 DSH 替你盯着。条件一达成，就往会话里塞一条消息，**把 agent 叫醒** ——
于是 agent 主动开口汇报。

```
你：  帮我把那个 20G 的东西下下来，下完告诉我
agent：（开始下载 → 回合结束 → 睡了）
        …几小时后…
插件： *发现文件大小不再变化* → *注入一条消息* → *把 agent 叫醒*
agent：「下好了，20.3 GB，校验和跟官方那个对上了。」
```

## 为什么需要它

agent 是"请求—响应"式的：回合一结束，它就没有时钟、没有定时器，
也**没有任何途径**知道它起的那个 `curl` 已经退出、或者某个文件已经出现在磁盘上。
在 DSH 里，唯一能把这个事实送到它面前的，是**一条进入它收件箱的消息** ——
而那正是"你打字说话"时会发生的事。没有消息，它就一直在睡，直到有人戳它。

所以缺的不是"等待"，是**叫醒**。这个插件就是负责叫醒的那一环。

## 机制

叫醒用的是 DSH 自己回报子代理时用的那套调用（出处 `dsh-subagent/lib/continuation.js`）：

```js
agent.steer(createUserMessage({
    content: [{ type: 'text', text: message }],
    source: { kind: 'plugin', plugin: 'dsh-proactive' },
}))
```

`agent.steer(...)` 是那扇通往"当前没在跑回合的会话"的门，
`createUserMessage(...)` 造出那扇门要的消息对象。这是 DSH 自己的 API，不是私开后门。

默认的 `source.kind = 'plugin'` 是重点：**插件来源的消息在界面上不渲染**。
所以你不会看到一条伪装成"你自己打的字"的假消息，**你看到的只是 agent 被叫醒后说的那段话**。
如果确实想让它渲染成用户气泡，可以按项覆盖成 `source.kind = 'user'`
（测试套件正是用这一点证明两者确实不同）。

## 六种触发类型

| `type` | 什么时候触发 | 必填字段 |
|---|---|---|
| `file-stable` | 文件大小连续 `rounds` 次不变 —— **判断"下完了"的标准做法** | `path`、`rounds`（默认取配置 `stableRounds`=3）|
| `file-exists` | 路径存在，且**是文件**（目录不算）| `path` |
| `file-size` | 文件存在且大小 ≥ `bytes` | `path`、`bytes`（默认 0）|
| `process-exit` | 指定进程消失 —— **它干的活结束了** | `process`（如 `curl.exe`）|
| `port-open` | 能连上 `host:port` —— **服务起来了** | `port`、`host`（默认 `127.0.0.1`）|
| `time` | 时间越过 `at` —— 闹钟 | `at`（ISO 时间串，不带 `Z` = 本地时间）|

**未知类型永远不会触发**：静默跳过，不猜。

### 公共字段

| 字段 | 说明 |
|---|---|
| `id` | 在 `boot.log` 和默认消息里标识这一项。任意字符串。 |
| `message` | 叫醒时 agent 看到的话 —— **建议写成给 agent 的指令**，而不是写给自己的备忘。 |
| `sessionId` | 可选。只叫醒这个会话。它不在时该轮跳过、**保持待命**，**绝不改投给别的会话**。不写 = 叫醒最近活跃的那个。 |
| `sourceKind` | 可选。`plugin`（默认，不渲染）/ `user`（渲染成用户气泡）。 |
| `form` | 可选，配合 `sourceKind: 'plugin'`。给来源打个自由标签；`notice` 还会带上 `summary`（`message` 前 120 字）。 |
| `repeatSeconds` | 可选。不标记 fired，而是"重新上膛"，见下。 |

### 叫醒哪个会话

开了多个 DSH 会话时，只会叫醒**一个**：

1. **写了 `sessionId`** → 只认它。会话不存在就跳过本轮、写日志、**继续待命**。
   拒绝投递是有意的：提醒送错了会话，比不送更糟。
2. **没写 `sessionId`** → 挑**最近活跃**的那个。活跃 = 收件箱进了消息、
   状态变成 `running`、或会话刚启动。**不是"最后注册的"** ——
   旧规则在开两个会话时会叫醒错的那个，现在有 5 个测试（`C. 会话选择`）钉着。

### 一次性 vs 重复

触发过的项会被标记 `fired: true`，不再重复打扰。
带 `repeatSeconds` 的项不标 fired，而是**重新上膛**，并用 `firedCount` / `lastFiredAt` 记历史：

- `time` → `at` 推到 now + `repeatSeconds`。
- `file-size` → `bytes` 抬到"当前文件大小 + 1"，下次多出 1 字节就再响。
- **其它类型** → `repeatSeconds` 没有意义，静默退化成一次性。

盯"一直在变的东西"（增长中的日志、进度文件）就是 `repeatSeconds` 的用途。

## 安装

插件 import 了 `@deepseek-ai/dsh-llm`，所以它得放在 Node 解析得到这个包的位置 ——
通常就是 profile 的模块树里。

```bash
# 1. 把插件放在 profile 旁边（或里面）
git clone https://github.com/mili1360/dsh-proactive.git ./dsh-proactive

# 2. 在 <profile>/package.json 里注册
#    dependencies:        "dsh-proactive": "link:<插件目录的绝对路径>"
#    dsh.profile.bundles: [ "dsh-proactive" ]      <- 加进这个数组
```

然后在插件目录里验证依赖能解析：

```bash
node -e "import('@deepseek-ai/dsh-llm').then(m => console.log('createUserMessage =', typeof m.createUserMessage))"
# createUserMessage = function
```

解析不了就按 DSH 暴露它的方式做个链接 —— 例如在插件目录里建一个
`node_modules/@deepseek-ai` 的 Junction，指向 `<profile>/node_modules/@deepseek-ai`。

**必须重启 DSH**：`dsh.marketplace.requiresRestart` 是 `true`，新注册的 bundle 不重启不会加载。
重启后插件目录会出现 `boot.log`，看到这三行就是装好了：

```
apply() 被调用  enabled=true  intervalMs=15000
定时器已挂载
守夜人就绪
```

没有 `boot.log` = bundle 根本没加载，回去检查 profile 注册。

## 要求 / 兼容性

**装上之后要确认它真的在工作** ✓ 光"profile 起得来"不算数 ✗
插件可能加载得好好的、路由也活着，却把宿主弄坏 —— 我们真踩过 ✓
验收动作: **新建一个会话、发一条消息** ✓
（它平时是安静的，要等某个 watch 触发才会说话 —— 日志没动静是正常的）
只要确认会话能建、agent 能回，就算装上成功 ✓
如果连新会话都建不出来 ⇒ 把上面那行挂载删掉、重启 ✓

针对 **DSH `0.1.0-rc.7`** 开发并测试 —— 这是一个**魔改版**，不是官方原版。别的版本可能把服务
或事件名改掉：本插件用到 `ctx.on`、`ctx.effect`、`ctx.agents`，以及 `agent/created`、
`agent/session-start`、`agent/inbox/inserted`、`agent/status`、`agent/disposed` 五个事件，
还有 `@deepseek-ai/dsh-llm` 的 `agent.steer` + `createUserMessage`。

版本对不上时，插件**不会**让 profile 起不来 ✓ 它会直接**停用**：没有监听、没有定时器，
`boot.log` 里只会留一行（而不是平时那行 `守夜人就绪`）：

```
注册失败，插件停用: ctx.on 不可用（这个 DSH build 没有它）
```

**万一装上之后 profile 根本起不来**：把 `<profile>/cordis.patch.yml` 里挂载它的那段删掉
（若你是用 `dsh.profile.bundles` 装的，就把数组里的 `"dsh-proactive"` 去掉），然后重启：

```yaml
- insert:
    - id: dsh-proactive
      name: dsh-proactive
      config:
        enabled: true
        intervalMs: 15000
        stableRounds: 3
        maxRetries: 5
```

## 配置

写在 bundle 补丁（`cordis.patch.yml`）或 profile 的插件配置里：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 完全不加载，连定时器都不建 |
| `intervalMs` | `15000` | 多久重读并检查一次 `watch.json`。**下限钳到 3000**。 |
| `stableRounds` | `3` | `file-stable` 的默认 `rounds` |
| `maxRetries` | `5` | 叫醒失败最多容忍几次，超限放弃该项 |
| `sourceKind` | `'plugin'` | 注入消息的默认来源类型 |
| `watchFile` | `<插件目录>/watch.json` | 覆盖清单路径（测试隔离用）|
| `logFile` | `<插件目录>/boot.log` | 覆盖日志路径（同上）|

**插件自带零个监听项**：`watches` 为空时它什么都不做，也没有任何内置默认路径或提醒。
`watch.example.json` 是把六种类型都填好的模板 —— 复制成 `watch.json` 再改。

清单**每一轮都从磁盘重读**，所以改完 `watch.json` 一个间隔内生效，**不用重启**。
插件写回时会**保留顶层其它键**，你自己写的 `_note` / `_说明` 注释键不会丢。

## 安全模型

| 情况 | 会发生什么 |
|---|---|
| 条件达成时 agent 正在跑回合 | 照常调 `agent.steer(...)`。消息进会话，**不打断、不中止**正在跑的回合；agent 下次看收件箱时读到它。 |
| DSH 重启 | 定时器没了，但 `watch.json` 还在：没触发过的项下次开机重新读入继续盯，已标 `fired` 的保持已触发。**没有独立的状态数据库**。 |
| 同一个监听反复响 | 只有显式写了 `repeatSeconds` 才会，而且只有 `time` / `file-size` 能重排（靠把自己的阈值往前挪）。其余类型**只触发一次**就标 `fired`。 |
| 没有可用会话（全关了，或指定的 `sessionId` 不在了）| 拒绝投递，`retries` +1，**保持待命**，后续轮次继续试到 `maxRetries`，超限才放弃并在 `boot.log` 留一行。**绝不投给别的会话**。 |
| `agent.steer` 抛异常 | 被捕获、写日志、算一次重试。不外泄。 |
| `watch.json` 缺失/为空/是裸数组/JSON 坏了 | 缺失就自动创建；裸数组当清单用；JSON 坏了这一轮就当作"没有监听项"，下轮再试。都不抛。 |
| 其它任何失败 | `apply()` 里每条注册都有守卫。`ctx.on` / `ctx.effect` 缺失或拒绝注册时，只记一行 `注册失败，插件停用: …` 然后停用 —— 不留半个监听、不留半个定时器。**本插件的故障不可能让 DSH 起不来** —— 最坏情况只是 `boot.log` 里多一行。 |

另外两条值得明说：

- **默认无法伪造你的输入**：注入消息标记为 `plugin`，界面不把它渲染成你说的话。
- **它只碰自己的两个文件**：读 `watch.json`、写 `watch.json`、追加 `boot.log`。
  不读、不写、不删会话记录、凭据或任何其它 DSH 状态。

## 测试

```bash
npm test          # node test/test.mjs
```

**68 个用例，全绿**，分三层：

- **A. `checkCondition` 单元测试** —— 每种类型、每个边界：文件在/不在/是目录、
  阈值达标/未达、大小稳定/中途变大/盯到一半文件消失、进程在/不在、
  端口开/关、时间过去/未来/非法串、未知类型、字段缺省。
- **B. `apply()` 集成测试** —— 用假 `ctx` + 假 agent 跑真实流程：触发并送达、
  `fired` 去重、无会话时累加重试、`steer` 抛异常被吞、超 `maxRetries` 放弃、
  JSON 损坏不崩、裸数组格式兼容、清单不存在自动创建、`enabled:false` 不挂定时器、
  `ctx.effect` 缺失或挂载失败时记一行日志并停用（**不再**退回裸定时器）、
  上下文不兼容（`on` 抛异常 / 没有 `on` / `ctx` 是 `null`）时 apply 不抛且不留定时器、
  `sourceKind` 覆盖、默认消息、
  `dispose` 后不投递、空清单不崩、**写回保留非 watches 的键**。
- **C. 会话选择** —— 指定会话被尊重、指定但不存在的会话**不误投**、
  最近**活跃**优先于最近**注册**、`status: running` 算活跃、已 dispose 的会话不再被叫。

全部跑在临时目录里，**不碰真实的 `watch.json` / `boot.log`**。
整个套件约 90 秒 —— 因为要证明"它**不会**触发"，就必须等满一个完整定时器窗口。

测试驱动发现并已修掉的真 bug：`file-stable` 首轮被当成基线不计数，
导致 `rounds: 3` 实际要检查 4 次；清单目录不存在时写回抛异常；
会话选择按"注册顺序"而不是"活跃度"，开两个会话时会叫醒错的。

## 分发助手

```bash
npm run dist        # 产出 dist/
npm run verify:dist # 对 dist/ 做 23 项检查
npm run check       # dist + test + verify:dist 一条龙
```

`npm run dist` 生成**一个自包含的 Markdown 单文件**（源码全嵌在里面，
附一份写给"收件人的 agent"看的安装说明）和一个同源码的 zip 包。
打包器从**活的源文件**读取内容，所以包不会跟代码脱节。

`npm run verify:dist` 扮演收件人的 agent：把 Markdown 里每个代码块抠回来，
跟源文件**逐字节比对**（SHA-256），把整个插件还原到临时目录，
在还原副本上跑 `node --check` 和**完整测试套件**，
并检查说明书里"装机需要的信息"是否还都在。

## 已知限制

- **裸定时器兜底已经取消（Unreleased）。** 0.2.1 及以前：`ctx.effect` 挂载失败会退回裸
  `setInterval`，它活到进程结束。现在改成"记一行日志并停用"——插件只要无法完成注册就不会
  继续跑，因此任何实例都能被完整卸载。
- **`watch.json` 路径是模块级状态。** 同一进程内多次 `apply()` 会共用它，
  两个实例同时加载会互相抢。一个 DSH 进程装一个插件（受支持的形态）没问题。
- **`file-exists` 故意不认目录**："目录存在"和"下载完成"不是一回事。
- **`process-exit` 在 Windows 上靠 `tasklist`。** 查不到进程时它返回"未知"，
  该轮跳过而不是触发 —— 缺 `tasklist` 不会造成误报。
- **`file-stable` 检的是"大小不再变"，不是"传输成功完成"** ——
  卡住的下载和跑完的下载长得一模一样。真要较真就用 `file-size` 配已知大小。
- **轮询式。** `intervalMs: 15000` 意味着条件达成到 agent 被叫醒之间最多有一个间隔的延迟。
  缩短间隔要花 CPU，下限是 3000 ms。

## 相关插件

同一套东西，三个插件各治一头 —— 都是"会话越跑越长、越贵越慢"这件事：

- **[dsh-history-fold](https://github.com/mili1360/dsh-history-fold)** —— 把可见历史里最老的一段折成
  一条消息（原文进无损归档），每轮请求带的 token 就降下来 ✓
- **[dsh-session-vacuum](https://github.com/mili1360/dsh-session-vacuum)** —— 开机后把会话日志里
  "定稿后没人读"的流式碎片删掉，长会话加载时不再膨胀成几个 GB ✓


## 许可证

MIT —— 见 [LICENSE](LICENSE)。
