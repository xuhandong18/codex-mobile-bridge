# 桌面原生侧边聊天接入复核

核查日期：2026-11-06（Asia/Hong_Kong）。用户目标：手机与 Codex 桌面操作同一条原生侧边聊天，网关只负责转发，不持有独立模型执行器。

## 结论与证据等级

**已有原生侧边聊天通过原桌面 owner 转发收发，在当前桌面代码中有协议基础；“手机新建后立即成为桌面里的同一条原生侧边聊天”的完整闭环尚未验证，不能宣称已可直接切换。**

这次发现了旧调研没有覆盖的持久附属分支：当前桌面与运行时已包含相关能力，隔离真实运行时验证通过。它为恢复与发现提供了新的候选路径，但不能据此把外部创建的附属分支直接称为已由桌面管理的原生侧边聊天。

| 要求 | 当前核查结果 | 证据等级 |
| --- | --- | --- |
| 连接原桌面 owner 并取得快照 | 指定主聊天实机成功；旧网关侧边聊天返回 `no-client-found` | 本机只读协议实测 |
| 向既有原生侧边发送、补充、停止、处理审批 | 桌面 follower handler 使用会话 ID 调用原 manager；未发现按临时性质排除侧边的分支 | 当前安装包代码；尚无本轮真实原生侧边收发验收 |
| 持久附属分支跨进程恢复 | 7 项隔离检查通过，不启动模型回合 | 当前真实运行时实测 |
| 按父聊天列举持久附属分支 | 运行时支持，桌面也有调用链 | 本地 schema、桌面代码、隔离实测 |
| 手机请求桌面创建／关闭原生侧边 | 当前 follower 方法表与 handler 无对应入口 | 当前安装包代码；不证明其他未来版本不存在入口 |
| 网关外部创建附属分支后桌面显示和接管 owner | 尚未验证，不能把存储关联等同于桌面 owner 注册 | 待真实桌面联调 |
| 网关重启后原生侧边可继续 | 设计上应只断开 follower；需确认桌面仍持有该会话 | 待真实桌面重连验收 |

本轮没有改写生产侧边聊天实现，没有修改桌面包或功能开关，没有重启网关／桌面，没有创建真实桌面聊天或向现有聊天发送测试消息。只有隔离测试目录中的合成会话接受了协议写入；未调用模型、使用真实凭据或读取真实聊天正文。

## 当前版本和传输

- Windows 安装包：`OpenAI.Codex 26.1027.3384.0`。
- 当前运行时：`codex-cli 0.166.0-alpha.5.1`，路径为本机 Codex 安装发现所得，不通过 PATH 猜测其他 CLI。
- 桌面主进程与其 app-server 的父子关系已核验。桌面 app-server 未带 `--listen` 参数，沿用默认 stdio；网关的两个独立 app-server 则是网关进程的子进程，并显式使用 stdio。
- 只读枚举发现 `codex-ipc` 和 app-tools 管道；本轮未发现可用于复用桌面 app-server 的公开控制管道。没有擅自启动 daemon、开放 WebSocket、变更 Remote Control 或复用其他进程的私有句柄。

`app-server` 的 transport 支持与“已经运行的桌面实例是否暴露该 transport”是两件事；另开 app-server 不能获得既有内存侧边聊天的 owner。官方 transport 与生命周期说明见 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。

## 原桌面 owner 的转发能力

当前安装包的 follower handler 保留以下操作：

- `thread-owner-discovery`、`thread-stream-following-changed`：确认 owner、订阅快照和增量。
- `thread-follower-start-turn`、`thread-follower-steer-turn`、`thread-follower-interrupt-turn`：向原 manager 发送、补充和中止。
- command/file/permissions 审批、user-input、MCP elicitation 回复。
- model settings、历史加载、排队消息控制等。

其中 `thread-follower-start-turn` 的分派直接调用原 manager 的 `startTurn(conversationId, turnStart)`；侧边会话不需要因此创建新的执行器。handler 的前置条件是请求目标仍由该 owner 持有。这支持“原生侧边存在时网关只转发”的技术判断，不能代替真实双端收发验收。

**当前方法表不包含侧边聊天创建、侧边聊天列表、销毁侧边聊天请求。** app-tools 的公开 `fork_thread` 也没有附属侧边或 `ephemeral` 参数；普通 fork 不等于原生侧边标签。不能绕过方法限制，将一个仅存在于 app-server 的方法名直接发给桌面 follower。

仓库依据：[IPC 白名单和帧协议](../bridge/clients/codex/ipc.py)、[主聊天通过 owner 发送](../bridge/app/service.py)、[桌面工具限制](../bridge/clients/codex/desktop_tools.py)。

只读实机探针只执行 initialize、owner discovery、following broadcast：

- 用户指定主聊天：owner 存在，返回 `historyMode=paginated`、`ephemeral=false` 的实时快照。
- 上轮失效的网关侧边：桌面返回 `no-client-found`，再次证实它不是桌面持有的原生侧边。
- 当前选定的近期桌面日志中没有可核验的原生侧边候选；本轮未据此推断“整个桌面绝无原生侧边”。没有可用目标，因此没有完成本轮真实原生侧边的发送、审批和关闭验证。

## 新发现：持久附属分支

### 桌面创建路径

当前安装包 `local-conversation-side-chat-e8f1fc99f4b2.js` 的创建函数 `en` 有两条路径：

1. 用户来源、父聊天是 paginated、运行时支持 `persistentSideChats`，且桌面功能开关 `1450837220` 为真：使用 `attachToSource: true`。
2. 条件不满足：使用 `ephemeral: true`。

运行时能力阈值为 `0.166.0-alpha.1`，本机运行时满足版本条件。**代码存在和版本满足不能证明此账号的开关已经启用；本轮未修改或核验该开关值。** 本机原始数据库目前没有持久附属线程记录，也不能据此反推开关必然关闭。

同一模块有 `attached-side-chats` 查询，调用 manager 的 `listAttachedThreads(parentId)`。该查询使用 `staleTime: Infinity`、`gcTime: 0`；外部新增后的刷新、重新挂载和 owner 接管行为仍需实际验证，不能假定外部写入一定立即显示。

### 运行时实际协议

本机 `generate-json-schema --experimental` 生成的 `ThreadForkParams`、`ThreadListParams` 已确认：

- `attachToSource: true` 将 fork 持久关联到父聊天，在普通列表中隐藏。
- 要求父聊天使用 paginated、本地存储；与 `ephemeral`、`deferGoalContinuation` 互斥。
- 父聊天存在附属分支时不能直接删除，后续删除需考虑整棵关联关系。
- `thread/list` 的 `attachedToThreadId` 可按父聊天列出附属分支。

这些字段以本机实际版本生成的 schema 为依据；[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)提供 fork、持久读取、resume 和 transport 的背景，不将未在公开文档说明的字段冒充稳定公开保证。

### 隔离真实运行时验证

使用独立 `CODEX_HOME`、隔离工作目录、不可用的回环模型地址；从未调用 `turn/start` 或 `turn/steer`。创建 paginated 合成父聊天，并通过 `thread/inject_items` 写入一条合成参考记录后，调用 `thread/fork(attachToSource=true, excludeTurns=true)`。

实际通过的检查：

1. 分支 `ephemeral=false`。
2. 普通 `thread/list` 隐藏该分支。
3. `thread/list(attachedToThreadId=父ID)` 能找到它。
4. `attached_thread_parent_id` 正确持久保存。
5. 关闭第一个运行进程后，第二个进程 `thread/read` 成功。
6. 第二个进程 `thread/resume` 成功，仍为持久分支。
7. 全程没有 `turn/started` 事件。

初始尝试还确认：没有任何持久历史的空父聊天可能返回 `no rollout found`。这不是“不支持附属分支”；加入隔离参考记录后上述检查全部通过。该处理只用于合成测试，不应在真实父聊天里悄悄注入记录来规避错误。

探针与结果保留在本机 `.tmp/native-side-audit-20261106/`，不提交测试会话、安装包提取内容或本机记录。隔离验证只证明运行时的持久关联与恢复，**不证明真实桌面已显示、收养或注册这些分支的 owner**。

## 现有网关适配需要调整的地方

[现有原生同步器](../bridge/clients/codex/native_side_chats.py)只做只读备份，且有两个旧假设：

- 依赖有界日志里的 `thread/inject_items` 或 `sideConversation` 标志提供候选；这不是稳定的原生列表 API。当前桌面创建函数已经可以直接通过 fork 的 `developerInstructions` 建立侧边边界，日志发现不能保证覆盖新路径。
- 核验时硬性要求 `ephemeral=true`。这样会排除新版持久原生侧边；不能简单删除条件，须为持久分支增加可核验的父子关联、来源、owner、host、cwd 和 provider 规则。

[网关自管侧边](../bridge/features/sessions/side_chat.py)则另开 app-server 并创建临时 fork。这条路径不满足用户本次确认的“桌面与手机共享原生侧边，网关只转发”的目标。已有存档应保留，不能把旧分支无提示迁移或冒充同一个原生会话。

## 满足目标所需的后续验收

优先验证最直接的路径：桌面创建原生侧边 → 网关核验该子会话及原 owner → 手机经 follower 转发 → 桌面显示同一 ID 的消息和状态。已有原生临时侧边也可以走这条路线，不以开启持久开关为前提。

在隔离或明确指定的真实原生侧边上，至少验收：

1. 两端展示同一个子会话 ID、父 ID、host、provider、cwd；发送前即时核验 owner。
2. 手机发送一次，桌面出现一次；桌面发送后手机可见；补充、停止和审批都绑定同一原任务。
3. 手机断线或网关停止只取消 follower，不调用该子会话的 stop/unsubscribe-owner，也不结束桌面运行器；重连后补快照和增量。
4. 桌面真正关闭临时侧边时，手机禁用发送并保留存档，不另开执行器接管。
5. 创建、发送结果未知时只查询核对，不自动重放。
6. 持久原生侧边重开后保留关联；旧网关存档不会串入新原生聊天。

完整的手机新建还需要单独解决：找到桌面受控创建入口，或验证“持久附属分支创建 → 桌面发现并接管”的路径。后者即使成功，也须明确创建阶段是否仍使用短期元数据 helper，不能把它表述成已经存在的桌面原生创建 API。当前证据不支持承诺手机点击新建就能立即完成这一交接。

## 当前安装包的可复核定位

安装包只读来源：`OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0/app/resources/app.asar`。以下资源的文件名包含构建内容标识，升级后应重新定位：

| 资源 | 关键符号／定位 | 支撑结论 |
| --- | --- | --- |
| `.vite/build/early-bootstrap.js` | IPC 版本表，含 `thread-stream-state-changed`、`thread-follower-start-turn` | 当前 follower 方法集合 |
| `.vite/build/early-bootstrap-339-096ec1020e8592e0.js` | `pc` 注册 owner/follower handler；app-server 默认启动参数 | 转发能力与创建入口缺口、桌面 stdio |
| `.vite/build/early-bootstrap-491-e75c34fa1b2c0832.js` | `persistentSideChats` 阈值、`thread-follower-start-turn` 分派、fork 参数组装 | 新运行时能力与原 owner 执行 |
| `webview/assets/local-conversation-side-chat-e8f1fc99f4b2.js` | `en`、`1450837220`、`attached-side-chats` | 原生侧边的持久／临时选择及发现 |
| `webview/assets/app-initial-4267e52fe5b0.js` | `listAttachedThreads`、`attachedToThreadId` | 桌面按父聊天读取附属分支 |

上述安装包内部符号不是稳定第三方 API；本报告未复制或修改安装包实现。
