# DeepSeek 主聊天与侧边聊天功能补齐

本轮按 Harness `dsh-v0.2.1-rc.5` 的公开原生接口实现，网关接入协议升级到第 10 版。范围为现有本机接入。通用列表界面、SSH/CLI、任意第三方 API 管理不在本轮。

## 主聊天

| 能力 | 实现与验收要点 |
| --- | --- |
| 历史目录与消息导航 | 独立读取全部普通用户发言目录，目录每页最多 200 项；正文每页最多 100 行，阅读历史保留两个相邻窗口。技能和系统注入不计入用户目录。新回复到达时保留阅读位置，提供返回最新入口。 |
| 时间、轮次、来源和附件 | 使用原生事件 `time`、`seq`、用户来源及 `turn/start`、`turn/end`；同一条发言的文字和附件合并为一个用户目录项。历史窗口的旧轮次不会覆盖当前运行轮次。 |
| 普通文件 | 网关私有附件记录转换为原生 `fileUploads.uploadStream` 收据，消息使用该会话的收据发送。支持直接发送、排队与补充。文件路径和已解析附件不能由网页传入。 |
| 队列与撤回 | 展示原生待发送列表，以原生队列条目 ID 和提交 ID 双重核验撤回。 |
| 完整计划审阅 | 展示问题的完整 `detail` Markdown 和文件链接，保留原生问题、选项、审阅意图和请求身份。带自定义修改意见时，移除批准选项，继续交给原生规划流程；过期请求拒绝。 |
| 目标 | 正确解析运行时与持久投影两种结构。运行中可修改；保留原生阶段、轮次和上限。完成后修改仍保存为完成状态，明确继续时创建新目标，返回新的目标 ID 并显示新统计。 |
| 历史修改与分支 | 复用并适配 MIT `dsh-inline-edit` 的维护锁、原始日志和 surface replacement 核心，允许在较早普通发言位置修改原会话，仅提交修改后的这一条。可直接从历史位置分支，或编辑后新建分支。 |
| 容量故障自动继续 | Harness 独立开关，默认开启；只观察启动后的真实新轮次。首次立即，再次失败间隔十分钟，同一故障最多三次。人工介入、原生目标驱动、待处理请求或另一恢复插件接手时取消。侧边聊天不续跑。 |

历史编辑保留原始日志，也保留已经发生的文件与外部操作。运行中或已有队列时不修改原上下文；补充发言、已压缩或包含无法安全保留的技能/聊天引用上下文的位置明确拒绝。复用核心移除了恢复补发入口：即使已有持久 replacement，也只核对，不重发后续旧输入。

## 侧边聊天（独立验收）

| 能力 | 实现与验收要点 |
| --- | --- |
| 独立轮次与已读 | 兼容原生 `turnId`，按已验证 Harness 数据目录、父聊天和实际子会话分别记录完成与已读。阅读父聊天不清除侧边结果；原生桌面同步失败不丢失网关已读。 |
| 父聊天汇总 | 槽位摘要包含子会话实际轮次、运行、等待及派生任务信息；发现槽位不批量读取全部正文。断线或未知状态保留已确认结果。 |
| 最近交互 | 侧边用户发言、助手正文和成功回答推进父聊天时间。工具、思考、读取、纯状态和改名不推进。原生顺序视图仍采用原生顺序。 |
| 关闭、结束、历史 | 关闭标签仅收起本设备视图。明确结束才停止并归档。历史列表区分存活槽位和结束记录；存活槽位按原标签身份重开，结束记录只读。使用 Harness 持久历史，不复制 Codex 临时侧边运行时。 |
| 长历史、目录和图片 | 沿用现有消息导航，增加原生完整目录、前后分页和两个相邻窗口。图片通过已签名原生消息引用鉴权读取，附件属于实际子会话。 |
| 普通文件与队列 | 与主聊天共用上传、收据和鉴权规则。附件发送、排队、补充与撤回均作用于实际子会话；同内容多次发送继续使用不同提交身份。 |
| 计划与目标 | 独立展示完整计划，核验实际子会话和当前请求。目标可运行中修改、完成后编辑并明确继续，父目标保持独立。 |
| 断线与恢复 | 保留消息、标题、草稿、附件与阅读窗口；关闭重开保留未知发送的提交身份，仅通过读取回执核对。失效或桌面归档使输入只读，旧回包不能恢复输入；后续重新核验同一原生子会话才恢复可写，不自动建立替代聊天。 |

原有多命名侧边聊天、选区创建、各自草稿与引用、模型/权限、运行中发送选择、取消保留内容、消息导航、返回最新及快捷追问继续走共享组件。侧边本轮不新增历史编辑，也不增加后台自动续跑。

## 共同接入能力与边界

- 主聊天提供 `message-index`、`timeline`、`changes`、`detail`、`message-action`、`queue` 和鉴权图片读取；侧边目录、分页、历史、正文、已读继续经过 `side-chat` 的父子身份路由。
- 全部内容操作使用原生会话 ID。组合展示 ID 只用于共享已读记录，不作为原生会话 ID 发送。
- 网关写操作先写持久操作 ID 和未知回执，再调用原生接口；超时或回执丢失只读核对，不自动重放。自动继续在原生提示发送前另行保存尝试 ID 和发送状态，重启不恢复待执行计划。
- 历史游标和图片引用由接入私有令牌签名，核验实际会话和原生记录版本；图片仅允许受支持的栅格 MIME，响应私有且不缓存。文件和计划链接保留原工作目录边界。
- 新模块、MIT 许可证、接入来源 LF/CRLF 校验和中继白名单同步更新。已验证的第 9 版及更早来源继续使用原凭据和操作回执，升级仍走现有安全重启流程。
- 自动继续只识别明确容量错误，不把普通 503、限流、额度、认证或上下文长度错误当作容量故障；无法核验其他恢复插件时不自动发送。

## 验证入口与交付范围

```sh
node --test tests/deepseek-personal.test.mjs tests/deepseek-history.test.mjs tests/deepseek-inline-edit.test.mjs tests/deepseek-capacity.test.mjs
python -B scripts/test-backend.py --source-only -p 'test_deepseek*.py'
python -B scripts/test-backend.py --source-only -p test_desktop_uploads.py
npm run test:desktop
node scripts/test-deepseek-browser.cjs
node scripts/test-deepseek-history-browser.cjs
```

新增浏览器入口使用正式原生历史转换模块和隔离事件生产者，分别在手机竖屏 `390×844`、横屏 `844×390`、平板 `820×1180`、电脑 `1280×900` 验证主侧聊天；不连接真实客户端或模型。覆盖完整目录、连续分页、附件回显、实际文件上传、队列身份、独立完整计划、关闭重开、草稿及阅读位置、结束历史、断线与子会话替换保护。

2026-11-01 验证结果：

| 检查 | 结果 |
| --- | --- |
| 完整前端/桌面源码测试 | 1178 项全部通过；新增历史转换、维护锁、容量恢复和侧边原生合约均纳入自动发现 |
| DeepSeek 后端专项 | 94 项：93 通过，1 项因本机 Windows 符号链接权限跳过 |
| 私有附件与原生图片 HTTP | 8 项全部通过，包含登录、MIME、实际子会话和网页不能注入本机路径 |
| 共享工作区上传下载 | 27 项：25 通过，2 项平台条件跳过 |
| 原有功能四尺寸真实浏览器 | 352 项断言通过 |
| 新增主侧历史等四尺寸真实浏览器 | 132 项断言通过 |
| 静态资源与公开地址边界 | 5 项全部通过 |
| 后端全量源码回归 | 2402 项：2278 通过，120 跳过；1 项失败和 3 项错误均在改动前基线 `9e2e9ff` 中独立复现 |

四项基线结果分别为 `test_activity_query.ActivityFallbackTests.test_timeout_does_not_wait_again_for_a_busy_session_lock`、`test_runtime_consumers.RuntimeConsumerTests.test_new_side_chat_rechecks_updated_runtime_before_forking`、`test_runtime_consumers.RuntimeConsumerTests.test_unsupported_replacement_does_not_fork_or_cache_success`、`test_fast_mode.FastSettingsTests.test_split_catalog_keeps_current_tier_and_provider_boundary`。前面三项的夹具未匹配已有 Codex 侧边历史持久化接口；后一项为已有 Fast 能力断言。它们未被跳过或计为通过，本次不改动这些 Codex 功能。

本次仅修改和验证源码，未启停真实 Harness、调用真实模型、升级版本号、构建安装或发布。实际客户端升级后，仍需通过现有“重启并接入”流程加载第 10 版接入，再执行真实客户端联调。

原生接口依据：[Harness rc.5 Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/api/session-controller/src/types.ts)、[原生文件收据](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/client/file-upload/src/index.ts)、[计划审阅](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/plan/plan-mode/src/index.ts)。历史编辑来源：[dsh-inline-edit](https://github.com/maxy1817/dsh-inline-edit)，保留相应 MIT 许可证；自动继续参考 [dsh-client-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue) 的宿主内统一调度方式，本轮实现容量错误专用策略。
