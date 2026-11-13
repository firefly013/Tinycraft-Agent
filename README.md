# Tinycraft-Agent

> A minimal Minecraft agent: an agent loop and a handful of tools.  
> 一个极简的 Minecraft Agent：只有 Agent Loop 和少量工具。

目标很朴素：让一个语言模型通过**一个动作一轮**的协议控制 Minecraft 角色，行为尽量简单、可读、可观察。

## 设计原则

- **Less is More**：能删就不加；工具面保持最小。
- **身体与大脑分离**：模型只选工具和参数；工具只校验输入，不裁决意图。
- **动作异步、事件驱动**：动作立即 `accepted` 并结束本轮，完成/失败用一条事件叫醒模型，不做轮询。
- **反射独立于模型**：溺水、落地水、进食、拾取等保命反射由身体自己处理，不占用模型上下文。
- **一切可观察**：控制面每次转移、每次请求、每个工具回执都有日志与轨迹。

## 快速开始

需要 Node ≥ 22.18（直接运行 TypeScript，不需要构建），以及一个开启局域网端口的 Minecraft Java 服务器（推荐 1.21.4）。

```bash
npm install
cp .env.example .env    # 填入 DEEPSEEK_API_KEY
npm start
```

改 `bots/<name>/bot.json`（或环境变量）指定服务器地址与模型。第一次运行可以先复制示例：

```bash
mkdir -p bots/alice && cp examples/bots/alice/bot.json bots/alice/bot.json
BOT=alice npm start
```

视觉（截图）依赖 `canvas` / `gl` 的原生二进制；装不上或不需要时用 `VISION=0` 关闭，只保留文本。

## 目录

```
src/core/     事件分级、控制面、反射仲裁、轨迹（不认识领域）
src/shared/   工具声明、参数校验、LiveState 结构与渲染
src/agent/    pi-durable 装配、Runner（工具执行与控制面）、会话与日志
src/body/     工具对应的身体实现、mineflayer 原语、反射、每轮快照
src/body/vision/  截图管线（prismarine-viewer + GL）
src/prompts.ts    系统提示词与全部工具说明
providers/    供应商配置（一个供应商一个 JSON）
examples/     Bot 配置模板
tests/        测试（node --test 直接跑 TypeScript）
```

## 配置

```
providers/<id>.json   供应商：module/factory 指向 pi-ai 的 provider 模块
bots/<name>/          一个 Bot 一个目录
├── bot.json          供应商/模型、提示词文件、MC 连接
├── session.db        会话（重启接着用）
└── logs/             结构化日志
```

`providers/deepseek.json` 自带；换模型/供应商就是加一个 `providers/<id>.json`，再在 Bot 里写 `"provider": "<id>"`。API key 由对应 provider 读自己的环境变量。

常用环境变量（完整列表见 `src/main.ts`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MC_HOST` | `127.0.0.1` | 服务器地址 |
| `MC_PORT` | 必填 | 服务器端口（也可写进 `bot.json`） |
| `MC_VERSION` | 自动 | 例如 `1.21.4`；开视觉时必须用渲染器支持的版本 |
| `MC_USERNAME` | `BaselineBot` | 游戏内名字，也是默认 Bot 目录名 |
| `BOT` | 同 `MC_USERNAME` | 使用哪个 `bots/<name>/` |
| `MODEL_PROVIDER` / `MODEL_ID` | `deepseek` / `deepseek-flash` | 默认模型 |
| `THINKING` | `off` | 思考等级：`off` / `low` / `high` / `max` |
| `DEEPSEEK_API_KEY` | — | DeepSeek API key |
| `VISION` | 开 | 设 `0` 关闭截图 |
| `COMBAT` | 开 | 设 `0` 关闭自动战斗 |
| `ADMIN_PORT` | 关 | 开启本机 HTTP 管理口（只绑 127.0.0.1） |
| `TRACE` | 关 | 设 `1` 打印控制面每次转移 |
| `TOKEN_BUDGET` | 30000000 | 单次会话的 token 上限；设 `0` 表示不限 |
| `TOOLS` | 全部 | 只把列出的工具交给模型 |
| `TOOL_OUTPUT_CHARS` | 20000 | 单条工具回执的字符上限 |
| `SNAPSHOT` | 全量 | `small` = 精简快照 |

## 工具面

14 个工具：`goTo`、`mineBlock`、`collectBlock`、`placeBlock`、`placeHere`、`container`、`useBlock`、`craft`、`furnace`、`attack`、`inventory`、`Stop`、`UpdateGoal`、`Finish`。

执行契约：占身体的工具立刻返回 `accepted` 并结束本轮；完成/失败通过事件回报。`Stop` 是有序停机（先让动作收尾）；`Finish` 表示本轮没有动作。

## 测试

```bash
npm run check   # tsc --noEmit + node --test
npm run smoke   # 需要真实服务器
```

## 许可

GPL-3.0，见 [LICENSE](LICENSE)。
