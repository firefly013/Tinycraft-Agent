<div align="center">

# Tinycraft-Agent

**一个极简、可观察的 Minecraft Agent**

*一个动作一轮 · 身体与大脑分离 · 工具即边界*

<a href="https://github.com/firefly013/Tinycraft-Agent/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/firefly013/Tinycraft-Agent?style=flat-square&logo=github"></a>
<a href="https://github.com/firefly013/Tinycraft-Agent/network/members"><img alt="GitHub forks" src="https://img.shields.io/github/forks/firefly013/Tinycraft-Agent?style=flat-square&logo=github"></a>
<a href="https://github.com/firefly013/Tinycraft-Agent/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/firefly013/Tinycraft-Agent?style=flat-square"></a>
<img alt="License" src="https://img.shields.io/github/license/firefly013/Tinycraft-Agent?style=flat-square">
<img alt="Last commit" src="https://img.shields.io/github/last-commit/firefly013/Tinycraft-Agent?style=flat-square">
<img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.18-339933?style=flat-square&logo=node.js&logoColor=white">
<img alt="Minecraft" src="https://img.shields.io/badge/minecraft-1.21.4-62B47A?style=flat-square">

</div>

> 让语言模型通过「一个动作一轮」的协议控制 Minecraft 角色：模型只选工具和参数，工具只校验输入，反射层负责需要即时接管的身体反应，控制面保证同一时刻只有一个执行者。

Tinycraft-Agent 把自由度收得很小：**工具面最小、控制流显式、所有状态可观察**。它跑在真实的 Minecraft Java 服务器上，代码尽量保持小、直、可读。

---

## 目录

- [它是什么](#它是什么)
- [一次动作的生命周期](#一次动作的生命周期)
- [架构](#架构)
- [工具面](#工具面)
- [建筑](#建筑)
- [安全边界](#安全边界)
- [快速开始](#快速开始)
- [配置](#配置)
- [可观测性](#可观测性)
- [目录](#目录)
- [测试](#测试)
- [扩展](#扩展)
- [Roadmap](#roadmap)
- [许可与致谢](#许可与致谢)

## 它是什么

一个跑在真实 Minecraft Java 服务器上的最小 agent：

- **工具面最小**：11 个动作原语 + 3 个流程工具；配置了 `mc-build` 后再多 6 个建筑工具。模型能做的事，就是它看到的事。
- **控制面显式**：谁在动身体、结果是否过期、被打断的动作怎么续做，全部落在一台纯函数状态机里，而不是散落在 prompt 和 `try/catch` 中。
- **反射与模型解耦**：落地水、自动战斗、低血进食、空闲拾取由身体自己处理，不唤醒模型（但会在上下文里留一条记录），也不靠模型"记得"。
- **会盖房子**：主模型只说"建什么、建在哪"，子模型自己写脚本、编译、看图、自检，把蓝图做出来再交给身体施工。
- **一切可观察**：每次控制面转移、每次请求、每条工具回执都有结构化日志与轨迹。

代码按层切开：控制面是纯函数，工具只做输入校验，身体只负责读世界和执行。要改行为，就去改对应的那一层。

## 一次动作的生命周期

![一次动作的生命周期](https://cdn.jsdelivr.net/gh/firefly013/Tinycraft-Agent@main/assets/lifecycle.png)

节奏是**异步事件驱动**的：工具调用不会阻塞等结果，而是立刻返回 `accepted` 结束本轮；动作真正完成（或失败）后再用一条事件把模型叫醒。模型不需要轮询，也不会被一个耗时几分钟的动作卡住。

## 架构

![Tinycraft-Agent 架构](https://cdn.jsdelivr.net/gh/firefly013/Tinycraft-Agent@main/assets/architecture.png?v=2)

四层各管一件事：

| 层 | 位置 | 职责 | 关键点 |
|---|---|---|---|
| 大脑 | `src/agent` | 供应商装配、Runner、会话 | 一次只发一个动作；模型只看到快照和工具 |
| 控制面 | `src/core` | 谁可以动身体 | `epoch` / `body` / `pendingResume`，纯函数、无 I/O |
| 身体 | `src/body` | mineflayer 会话、工具原语、反射、快照 | 工具只校验输入，不裁决意图 |
| 世界 | Minecraft | Java 服务器 | 通过 mineflayer 协议连接，离线/正版均可 |

### 控制面：三条转移

```ts
interface ControlState {
  epoch: number;                        // 回执是否过期
  body: BodyLock | null;                // 谁在动身体（模型动作带 resumable）
  pendingResume: PendingResume | null;  // 被打断的动作 + 检查点
}
```

- **抢占**：更高优先级的反射可以拿走身体；只有登记了 `resume` 钩子的模型动作才会被存进 `pendingResume`。
- **让位**：标了 `yieldToModel` 的反射（拾取）在模型要动手时立刻退出。
- **续做**：工具在执行中上报检查点；反射结束后，身体按 `resume` 钩子接着做，而不是重放整个动作。控制面只负责存 `pendingResume`。

### 反射：不唤醒模型的自动层

| 反射 | 优先级 | 行为 |
|---|---|---|
| 落地水 | 40（不可打断） | 下落超过 3.6 格且背包有水桶时自动放水 |
| 自动战斗 | 30 | 同层目标；可被更高优先级打断 |
| 低血进食 | 20 | 血量低且背包有食物时自动吃 |
| 空闲拾取 | 10 | 只在身体空闲时工作，模型一发动作就让位 |

反射触发是 **L5 静默事件**：不唤醒模型，但会作为一条记录写进上下文，下一次请求能看到。

## 工具面

11 个动作工具 + 3 个流程工具：

| 工具 | 作用 | 续做 |
|---|---|:--:|
| `goTo` | 走到坐标（可挖、可垫、可上下竖井） | 支持 |
| `mineBlock` | 挖指定坐标，带液体/不可破坏保护 | 支持 |
| `collectBlock` | 收集指定方块 N 个 | 检查点 |
| `placeBlock` | 在坐标放方块 | 支持 |
| `placeHere` | 跳起垫高 | 检查点 |
| `container` | 打开箱子/熔炉，取放物品 | — |
| `useBlock` | 右键工作台/熔炉/床等 | 支持 |
| `craft` | 按配方合成 | — |
| `furnace` | 熔炼/取出 | 检查点 |
| `attack` | 攻击实体 | 支持 |
| `inventory` | 装备/丢弃/吃 | — |
| `Stop` | 有序停机：先让动作收尾再停 | — |
| `UpdateGoal` | 更新当前目标 | — |
| `Finish` | 本轮没有动作 | — |

执行契约：占身体的工具立刻返回 `accepted`；完成/失败通过事件回报。

### 建筑（可选，需要外部 `mc-build`）

| 工具 | 作用 |
|---|---|
| `DesignBuild` | 派一个子模型设计建筑：写脚本、编译、自检，产出蓝图目录 |
| `ReworkDesign` | 在已有蓝图上改，不新开一份 |
| `BuildAt` | 把蓝图建到指定原点；有 op 自动用 `/fill`，没 op 逐块放置，`mode` 可强制 |
| `UndoBuild` | 按施工前的现场快照还原 |
| `ListBlueprints` | 列出蓝图（含可复用标记） |
| `CancelDesign` | 取消一个后台设计任务，不影响身体 |

设计任务不占身体、可以并发，`Stop` 不会停它们。完整流程见 [建筑](#建筑)。

## 建筑

![子模型设计的小屋](https://cdn.jsdelivr.net/gh/firefly013/Tinycraft-Agent@main/assets/building.png)

*上面这座 7×8×7、154 格的小屋，是子模型自己写脚本、编译、看图、改到 SELFCHECK 通过后交出来的；图是 `mc-build` 的 `main` 视角，顶部是渲染器的自检栏。*

主模型只经手两头，中间交给子模型：

1. **设计**：`DesignBuild("一座带门廊的两层石屋")` 立刻返回任务 id；后台开一个独立会话，它写 `script.js`
   → `mc-build build` → 看渲染图/ASCII → 按 SELFCHECK 的坐标簇改 → `finish`。会话不占身体、可以并发；
   `Stop` 不会停它，只有 `CancelDesign` 会。
2. **落盘**：蓝图是 `bots/<name>/build/blueprints/<id>/` 一个目录：`script.js`（可重跑）、
   `plan.schem`（Sponge v3）、`meta.json`（尺寸/方块数/材料/tags/`reusable`）、六视图 PNG 与 ASCII。
   组件复用就是把小蓝图 `pasteSchem` 进新脚本。
3. **施工**：主模型审阅后 `BuildAt(blueprint, x, y, z)`。有 op 走 `/fill` + `/setblock`（每 10 条一批、
   forceload、抽查），没 op 走逐块放置（单块失败跳过、连续 10 块停、每块检查点）。
   施工前记现场快照，`UndoBuild` 按同一条路还原。

子模型直接驱动 mc-build 的 CLI：`build --views` 挑视角、`preview --crop --persp --ruler` 放大审查、
`check` 校验 palette、`assets` 扫构件库；模型支持图片输入时还会把 PNG 读进上下文。

启用：克隆 [mc-build](https://github.com/firefly013/mc-build)，设 `MC_BUILD_DIR=/path/to/mc-build`
（或写进 `bot.json` 的 `build.mcBuildDir`）。没配置时这 6 个工具不会出现在工具表里。

## 安全边界

Agent 会挖穿地形，所以"挖开之后会发生什么"必须先算清楚：

- **挖不动的方块提前拒绝**：液体、基岩、传送门框、命令方块等直接返回原因，不让 `dig` 白等超时；
- **挖开会让液体流到身上就拒绝**：从目标六邻里的液体出发，按"向下直落、有支撑才水平扩散"做流动模拟，流到脚下/头部就拒绝；
- **pathfinder 两格间接流动保护**：库自带的 `dontCreateFlow` 只挡紧邻一格，这里再补一层"液体 → 中间空气格 → 被挖格"的两步检查；
- **寻路避水**：水不进入寻路图，过河靠搭桥；
- **下潜竖井逐格检查**：深目标不走 A* 斜挖，走到干柱子后竖直下挖，遇水/岩浆就停手横挪。

## 快速开始

前置：Node ≥ 22.18（直接运行 TypeScript，无需构建），Minecraft Java 服务器（推荐 1.21.4，开放局域网端口）。

```bash
# 1. 安装
npm install

# 2. API key
cp .env.example .env        # 编辑 .env，填入 DEEPSEEK_API_KEY

# 3. 准备一个 bot 配置
mkdir -p bots/alice
cp examples/bots/alice/bot.json bots/alice/bot.json
# 把 bot.json 里的 mc.port 改成你的服务器端口

# 4. 启动
BOT=alice npm start
```

想让它盖房子就多一步：克隆 [mc-build](https://github.com/firefly013/mc-build)，启动时带上路径：

```bash
MC_BUILD_DIR=/path/to/mc-build BOT=alice npm start
```

服务器建议（`server.properties`）：

```properties
online-mode=false
server-port=25565
difficulty=peaceful
```

视觉依赖 `canvas` / `gl` 的原生二进制；装不上或不需要时：

```bash
VISION=0 BOT=alice npm start
```

## 配置

`bots/<name>/bot.json`：

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "thinking": "off",
  "mc": { "host": "127.0.0.1", "port": 25565, "username": "Alice", "auth": "offline" },
  "vision": true,
  "combat": true,
  "toolChat": true,
  "build": { "mcBuildDir": "C:/path/to/mc-build" }
}
```

供应商放在 `providers/<id>.json`，指向 pi-ai 的 provider 模块；换模型/供应商就是加一个文件，再在 `bot.json` 里写 `"provider": "<id>"`。API key 由对应 provider 读取自己的环境变量。

常用环境变量（完整列表见 `src/main.ts`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MC_HOST` | `127.0.0.1` | 服务器地址 |
| `MC_PORT` | 必填 | 服务器端口 |
| `MC_VERSION` | 自动 | 例如 `1.21.4` |
| `MC_USERNAME` | `BaselineBot` | 游戏内名字 |
| `BOT` | 同 `MC_USERNAME` | 使用哪个 `bots/<name>/` |
| `MODEL_PROVIDER` / `MODEL_ID` | `deepseek` / `deepseek-flash` | 默认模型 |
| `THINKING` | `off` | `off` / `low` / `high` / `max` |
| `DEEPSEEK_API_KEY` | — | DeepSeek API key |
| `VISION` | 开 | `0` 关闭截图 |
| `COMBAT` | 开 | `0` 关闭自动战斗 |
| `ADMIN_PORT` | 关 | 本机 HTTP 管理口（只绑 `127.0.0.1`） |
| `TRACE` | 关 | `1` 打印控制面每次转移 |
| `TOKEN_BUDGET` | `30000000` | 单会话 token 上限，`0` = 不限 |
| `MC_BUILD_DIR` | — | `mc-build` 仓库路径；配了才启用建筑工具 |
| `TOOLS` | 全部 | 只把列出的工具交给模型 |
| `TOOL_OUTPUT_CHARS` | `20000` | 单条工具回执字符上限 |
| `SNAPSHOT` | 全量 | `small` = 精简快照 |

## 可观测性

- **轨迹**：控制面每次转移都有 trace 记录（`TRACE=1` 打到终端）；
- **结构化日志**：`bots/<name>/logs/`，请求、事件、工具回执都在；会话本身在 `bots/<name>/session.db`，重启接着用；
- **截图**：视觉开启时写到 `bots/<name>/screenshots/`；
- **管理口**：`ADMIN_PORT` 打开后只绑 `127.0.0.1`，用于本机查看状态。

## 目录

```
src/core/         事件分级、控制面、反射仲裁、轨迹（不认识领域）
src/shared/       工具声明、参数校验、LiveState 结构与渲染
src/agent/        pi-durable 装配、Runner、会话与日志
src/body/         工具对应的身体实现、mineflayer 原语、反射、每轮快照
src/body/vision/  截图管线（prismarine-viewer + GL）
src/prompts.ts    系统提示词与全部工具说明
providers/        供应商配置（一个供应商一个 JSON）
examples/         Bot 配置模板
bots/<name>/      运行数据：配置、session.db、日志、截图、build/blueprints/ 蓝图
tests/            测试（node --test 直接跑 TypeScript）
```

## 测试

```bash
npm run check   # tsc --noEmit + node --test
npm run smoke   # 连接真实服务器跑一轮，验证端到端
npm run smoke:build   # 建筑端到端：编译 → 命令施工 → 撤销 → 真实放置（需要 mc-build 与 op 用户名）
npm run smoke:design  # 架构师端到端：真实模型 + 真实 mc-build，不连服务器
```

测试覆盖控制面纯函数、工具参数校验、反射仲裁、快照渲染和每个原语的错误分支。没有 mock 整个世界的"集成测试"——那类测试在这里只会骗自己。

## 扩展

**加一个工具**（四步，缺一不可）：

1. `src/body/catalog.ts` 声明工具名、是否占身体、参数类型；
2. `src/body/primitives.ts` 实现原语（键名即工具名；需要续做加 `resume`，需要收尾加 `stop`）；
3. `src/prompts.ts` 写模型能读懂的说明；
4. `tests/` 补一个正常路径和一个拒绝路径。

**加一个供应商**：在 `providers/` 放一个 JSON，指向 pi-ai 的模块与 factory，然后在 `bot.json` 里改 `provider`。

## Roadmap

- [x] 生存循环：采集、合成、熔炼、吃饭、战斗、拾取
- [x] 控制面 / 反射 / 检查点续做
- [x] 挖掘安全边界：液体、不可破坏方块、间接流动
- [x] 建筑：子模型设计蓝图，身体逐块施工（可撤销）
- [ ] 下界：传送门浇筑、烈焰棒、猪灵交易
- [ ] 末地：要塞定位、末影龙
- [ ] 录一段完整通关视频

## 贡献

有 bug 或建议请开 issue。提交前请先跑 `npm run check`；新增行为请附带能复现问题的测试。

## 许可与致谢

[GPL-3.0](LICENSE)。

- [mineflayer](https://github.com/PrismarineJS/mineflayer) 与 PrismarineJS 生态
- [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer)
- [@earendil-works/pi-ai](https://github.com/earendil-works/pi-ai) / `pi-durable`
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)

<div align="center">

如果这个项目对你有帮助，点个 Star 就是最好的支持。

</div>
