# Web 与手机共享界面

`index.html` 是浏览器入口，手机外壳也加载同一页面。脚本仍按 HTML 中的顺序加载，共享现有全局对象。

| 目录 | 职责与入口 |
| --- | --- |
| `shell/` | `app.js` 组织页面启动、网关请求与模块交互；`style.css` 提供基础布局。 |
| `features/chat/` | 会话列表、消息时间线、输入与附件、权限和工作模式。 |
| `features/accounts/` | 官方账号、API 接入、额度及客户端账号管理。 |
| `features/clients/` | 应用切换、启用管理与 Claude/DeepSeek 会话界面。 |
| `features/workspace/` | 文件与下载、源码高亮、PDF/HTML 预览、Git、终端、侧边聊天、子任务和分屏工作台。 |
| `features/settings/` | `presentation.js` 管理本地外观偏好。 |
| `shared/` | 翻译、Markdown、图片查看器与共享视觉样式。 |
| `hosts/` | 浏览器、iOS/Android App 的身份和原生布局适配；不参与宽窄判断。 |
| `layouts/` | 紧凑、中等、宽屏的页面结构与工作台容器分屏判断。 |
| `client-icons/`、`vendor/` | 客户端原始图标和有许可证记录的第三方浏览器资源。 |

## 静态地址契约

`assets.json` 将现有公开地址映射到磁盘文件，例如 `/app.js` 对应 `shell/app.js`。后端仅发布 `bridge/api/assets.py` 固定白名单允许的入口，以及限定路径的字体与 PDF.js CMap 资源；清单本身不会扩大公开范围。CSS 清单可以是有序数组，后端按原顺序在内存中组合并缓存；每个公开 URL 仍只需一次请求。搬移源文件时更新清单；HTML 中的公开地址、查询版本和脚本顺序保持稳定。

桌面网关通过本地文件引用 `shared/i18n.js` 和 `features/accounts/`；这些路径还需要出现在根 `package.json` 的打包清单中。图片地址相对于页面，CSS 地址相对于公开样式 URL；不要根据脚本所在目录改写浏览器地址。

从仓库根目录运行 `npm run test:desktop`。该命令递归发现 `tests/` 和 `mobile/tests/` 下的 `*.test.js`、`*.test.cjs`、`*.test.mjs`，无需手动添加测试清单。资源映射与桌面本地引用由 `tests/frontend-assets.test.cjs` 验证；相关功能测试按实际磁盘路径读取源码。

`tests/browser/*.browser.js` 是依赖真实页面和隔离网关夹具的浏览器检查，不属于 Node 测试；需要通过对应浏览器驱动单独执行，不能将仅加载脚本视作检查通过。

## 文件阅读模块

- `source-view.js` 用本地 Prism 词元生成只读源码节点，行号独立，复制取原文；软换行与原始行宽可切换。超过 65,536 字符或 4,000 行不高亮，超过 10,000 行省略行号，仍遵守 512 KiB 文本预览上限。见[源码约定](../.agents/notes/implemented/feature/2026-10-13-source-code-view.md)。
- `pdf-preview.js` 使用随网关分发的 PDF.js legacy 模块、worker、CMap 和字体。沿用鉴权下载与 Range，并加 `preview=1`：服务端逐次检查实际大小不超过 `min(20 MiB, clickDownloadMiB)`，不能与显式下载或目录归档混用。可见页按需绘制，预算内保留至多两张邻近完成画布；缩放保留旧画布，单个离屏绘制完成后替换，文本层独立更新。已显示画布最多约 12 MP，替换缓冲另限约 4 MP；这是单个阅读器的画布预算，不是所有标签的总内存预算。
- `html-preview.js` 只把文本交给已鉴权的 `/html-preview-shell`。父页核验消息来源与壳实例；壳的 CSP 与 iframe sandbox 隔离内联脚本，不授同源、网络、表单、弹窗或导航权限。Android/iOS 原生壳仅放行预期的预览子页面，拒绝其余高权限操作。关闭或切换到源码时销毁 iframe，标签返回重新握手。见[PDF/HTML 约定](../.agents/notes/implemented/feature/2026-10-13-pdf-html-preview-and-source-mode.md)。
- `workbench.js` 持有目录返回、阅读位置和全屏状态。Back 先退出预览全屏、关闭浮层，再处理当前文件目录；文件子目录先回父级，根目录后回聊天。全屏沿用同一预览实例，不重新创建 PDF 或 HTML。

Claude 账号面板的定时刷新只读已保存额度；只有显式 `details(refresh=True)` 查询。成功快照的日期时间与面板刷新时间分开，失败不能覆盖原成功值。见[手动额度约定](../.agents/notes/implemented/bug-fix/2026-10-12-keychain-access-and-manual-quota.md)。

## CLI 能力展示

列表与会话快照的 `access` 字段控制 CLI 历史阅读、显式连接和允许的操作。界面不自动接入 CLI；服务端独立校验相同能力，隐藏按钮不能替代权限检查。连接失败保留原因，连接成功后清除；诊断下载使用既有登录会话。无 `access` 的旧网关维持原桌面行为。

## Codex 侧边栏

列表新增“Codex 分区”视图，新用户默认使用此视图，已有显示偏好保持不变。列表刷新时读取当前 Codex 账号的自定义分区名称、顺序、项目归属和初始折叠状态，并读取会话数据库的分区、置顶和项目字段；独立聊天不根据工作目录重新归入项目。已保存的空项目也提供新建入口。项目标题右侧的“＋”打开已选中该项目的新建窗口，沿用原有创建请求与结果未知时不自动重放的规则。

运行标识每 5 秒读取父会话及其完整子代理树的汇总状态。父会话已结束本轮、任一子代理或嵌套子代理仍在运行或等待回应时，侧栏绿点提示“子代理运行中”，聊天头部同步显示；父会话暂时断开不掩盖已确认的子代理运行。子代理状态未知时显示不可用，待全部结束后才显示父会话的完成未读标识，进入会话后清除。子代理继续只出现在原会话的子智能体面板，不作为可发送的普通聊天暴露。

当前同步方向为 Codex → 网页；网页暂不提供新增、重命名、移动或删除 Codex 分区。网页内折叠仅用于当前显示，刷新后仍以 Codex 状态为准。无法确定当前账号时不合并多个账号的自定义分区。ChatGPT 云端聊天不属于本网关的 Codex 会话列表。

旧聊天的数据库 `project_id` 可能为空，不能据此覆盖 Codex 保存的项目归属。项目解析优先使用原生项目字段，其次读取桌面显式归属；明确列在 `projectless-thread-ids` 中的独立聊天不按目录推断项目，其余聊天保留最长工作目录匹配。
