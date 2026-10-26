# 验证入口

测试应匹配改动的功能和平台。源码测试不等于已经编译、安装或在三个系统上完成真实客户端联调。

## Python 后端

Markdown 编辑的专项后端验证为 `python -B scripts/test-backend.py --source-only -p test_markdown_edit.py`，HTTP 保存边界包含在 `test_workspace.py`。真实浏览器验证为 `node scripts/test-markdown-edit-browser.cjs`（可加 `--screenshots` 将截图写入 `.tmp/`），使用隔离 Chromium 和合成文件，覆盖六种尺寸、中英文、格式工具、真实键盘快捷键、草稿保留、并发保存、冲突与回执丢失后的只读核对。需要已有 Playwright，可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定运行时；不连接真实客户端或修改用户文件。

从仓库根目录，使用已有项目环境运行：

```sh
python -B scripts/test-backend.py --source-only
python -B scripts/test-backend.py --source-only -p 'test_desktop_discovery.py'
python -B scripts/test-backend.py --source-only -p 'test_platform_architecture.py'
python -B scripts/test-backend.py --source-only -p 'test_resource_layout.py'
```

`--source-only` 明确跳过七个原生夹具类：Claude 的 Swift Console 选择器、macOS 桌面会话检查、Windows 窗口选择器，以及 Windows Codex 退出、Harness 菜单退出、强制退出和 Explorer 启动器验证。这些夹具可能编译或执行原生程序；纯 Python 的平台模拟与安全检查仍运行。省略该选项与完整 unittest discovery 等价，会按当前系统和环境运行原生测试。平台、可选依赖和原生 SDK 的跳过项会在结果中列出。现有 CI 保留各平台完整 discovery。

HTTP、中继、IPC、mailbox 等测试使用本机隔离监听和合成数据，需要允许测试进程绑定 loopback/Unix socket。受限执行环境的 EPERM 不是功能通过，也不能隐藏为产品跳过。共享中继测试需要现有 `requirements-relay.txt` 环境；测试脚本自身不安装依赖。

| 修改范围 | 主要测试文件前缀 |
| --- | --- |
| 账号、额度、模型 | `test_account*`、`test_api_catalog*`、`test_saved_account*` |
| 客户端发现/启停 | `test_client_*`、`test_desktop_discovery*`、`test_desktop_idle*` |
| Claude/DSH | `test_claude_*`、`test_deepseek_*`、`test_desktop_sessions*` |
| 认证/配对/网络 | `test_auth*`、`test_pairing*`、`test_login_security*`、`test_shared_relay*`、`test_network*` |
| 会话与发送/授权 | `test_bridge*`、`test_cli_bridge_integration.py`、`test_codex_app_server.py`、`test_codex_cli_session.py`、`test_desktop_*`、`test_goal_*`、`test_permissions*`、`test_timeline*` |
| 文件/终端 | `test_workspace*`、`test_download_ranges*`、`test_*terminal*` |
| 目录与资源边界 | `test_platform_architecture.py`、`test_resource_layout.py`、`test_web_assets.py` |

测试名仍保持在 `tests/` 顶层，方便按前缀发现并复用既有夹具。平台测试的模拟结果不能替代对应操作系统的实机结果。

需要真实符号链接的夹具通过 `symlink_support.require_symlink_support()` 检查能力。Windows 账户缺少该权限（WinError 1314）时，仅跳过对应检查并显示原因；不修改系统安全策略，也不把这些检查算作通过。

认证持久化保护运行 `python -B scripts/test-backend.py --source-only -p test_auth.py`，并联动 `test_login_security.py`、`test_pairing.py`。覆盖完整 JSON 强制落盘后才替换、首次保存与旧数据补建备份、落盘及替换失败时保留主文件和清理临时文件、全零/非法/缺失主文件不自动恢复旧权限，以及损坏主文件不覆盖有效备份。夹具使用合成数据和真实临时文件；故障注入不代表已完成真实断电或蓝屏测试。

Harness 个人分支功能另有 `node scripts/test-deepseek-browser.cjs`：需要已有的 Playwright 与 Chromium（可通过 `NODE_PATH` 使用现有测试运行时），在四种屏幕尺寸执行实际 DOM 断言，仅使用隔离合成会话。详情见 [功能对应与验证](../docs/deepseek-personal-features.md)。

Windows Harness 正常退出另有 `python -B scripts/test-backend.py -p test_dsh_menu_native.py`：复用本机已有 Electron 运行库（可通过 `CMB_TEST_ELECTRON_EXECUTABLE` 指定），仅将运行库复制到 `.tmp/`，在非活动桌面启动独立合成应用，实际调用中英文标题栏菜单和原生退出项。覆盖正常清理、待处理窗口、重复退出项和进程创建身份变化；不加载真实 Harness 资源、数据目录或模型。缺少运行库时明确跳过，不计作通过。

## Node 与浏览器

主聊天之间的来信运行 `python -B scripts/test-backend.py --source-only -p test_cross_thread_messages.py`，检查实时/保存记录、目录定位、增量去重、来源标记、禁止编辑来信、子代理通知过滤和独立 SSH 源码执行。`node scripts/test-message-navigation-browser.cjs` 同时在手机、平板和电脑宽度检查来信正文与导航可见、来源标签、历史跳转以及子代理通知仍然隐藏。

```sh
npm run test:desktop
npm run test:updater
```

`test:desktop` 通过 `scripts/test-frontend.cjs` 自动递归发现 `tests/` 和 `mobile/tests/` 中 `*.test.js`、`*.test.cjs`、`*.test.mjs`。新增 Node 用例不需编辑长命令清单；资源路径检查包含在该入口。

对话显示跨设备同步运行 `python -B scripts/test-backend.py --source-only -p test_chat_display.py`、`node --test tests/chat-display-sync.test.cjs tests/chat-display-panels.test.cjs` 和 `node scripts/test-chat-display-browser.cjs`。浏览器驱动使用合成 API 与独立电脑/手机存储，在手机竖横屏和平板尺寸核验电脑关闭后手机主聊天、侧边聊天隐藏工具详情，但保留独立的文字进度框；开启后相邻工具放进默认收起的执行过程段，逐项详情仍可单独展开，文字进度与工具交替时保持原顺序和多个段落。开关更新同步到已打开的面板，思考摘要在执行过程内单独控制且主题不跨设备覆盖。Node 夹具还验证子任务记录、错误和待确认请求保留；后端覆盖持久化、并发版本、登录、Origin/CSRF 与中继白名单。另在手机竖横屏和平板尺寸实际点击进度正文首行与后续行，并用回车和空格操作，检查单行省略与全文展开。需要已有 Playwright/Chromium，可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定运行时，不连接真实客户端或调用模型。

聊天分组的真实 DOM 回归由 `node scripts/test-message-navigation-browser.cjs` 调用 `runTimelineGroupingTests`，覆盖交替进度和工具的时序、相邻工具与思考摘要合并、无边框无背景的紧凑样式、正文作为进度折叠点击行且不重复渲染、运行中进度默认展开、成功完成才自动收起、中断和失败保持展开、不同结果的历史默认状态、完成后手动重开、不同轮次隔离、嵌套工具详情、流式更新及补读保留展开、错误直接可见。侧边聊天和子任务记录同样由 `tests/chat-display-panels.test.cjs` 验证；不连接真实客户端或发送模型任务。

消息时间运行 `python -B scripts/test-backend.py --source-only -p test_message_times.py` 与 `node --test tests/message-times-ui.test.cjs`，覆盖原生开始时间、保存记录与导航窗口、增量读取及未完成尾行、大记录有界读取、独立 SSH 源码执行、文件边界、关闭时丢弃晚到结果、仅补时间不改变消息身份，以及秒/毫秒/ISO 时间和缺失时间。`node scripts/test-chat-display-browser.cjs` 同时在三种尺寸检查原始时间按设备时区精确到秒、消息操作栏末尾只有一个时间、各执行记录的折叠标题时间、重标标题与更新按钮后时间保留。使用合成数据，不将页面刷新时间作为消息时间。

侧栏聊天排序可运行 `node --test tests/sidebar-sync.test.cjs tests/project-thread-order.test.cjs`；真实 DOM 验证为 `node scripts/test-sidebar-order-browser.cjs`。后者在手机、平板和电脑宽度检查三种列表方式、最新五条与加载更多、分区/置顶/独立聊天、交互更新、折叠展开和刷新，并预置旧的本机聊天顺序以确认其不再覆盖最近交互排序；还实际操作右键/长按菜单，检查手动聊天调序及排序切换入口已移除、项目内多个置顶的独立时间顺序、取消、普通分页额度、搜索过滤，以及冷启动时全局预读行和最近一百条以外的旧置顶。定向元数据读取的登录、主机、数量及原有可见性边界由 `test_bridge.py` 覆盖。仅使用合成数据，需要已有 Playwright/Chromium，可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定运行时。

侧栏跨设备同步运行 `node --test tests/sidebar-preferences.test.cjs` 和 `python -B scripts/test-backend.py --source-only -p 'test_sidebar*.py'`；真实页面验证为 `node scripts/test-sidebar-preferences-browser.cjs`。后者使用独立浏览器上下文，在手机、平板和电脑宽度实际操作长按/右键菜单，检查旧设置迁移、前台自动同步、项目上下顺序、原生项目跨分区移动、分区顺序、聊天归属、整页重载及丢失保存回包时不重复提交。后端另验证原生项目完成后无需浏览器轮询即可清除旧显示覆盖、未知原生结果不清除，以及操作期间另一设备的新选择优先。所有数据与原生客户端均为合成夹具，需要已有 Playwright/Chromium，不启动真实聊天或模型。

导航栏自动状态同步可单独运行 `node --test tests/sidebar-activity.test.cjs`；真实 DOM 验证为 `node scripts/test-sidebar-activity-browser.cjs`，使用合成 API，在手机、平板和电脑尺寸检查首次显示、滚动、折叠与重新展开、收起与重新打开导航栏时的可见聊天订阅，确认无需点击聊天，也没有打开桌面聊天或发送消息。浏览器驱动需要已有 Playwright/Chromium，可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定运行时。

灰点首次显示时主动预约读取；`POST /api/activity` 在同一个请求内等待当前桌面状态，请求内的主机和聊天共享五秒截止时间。并发的相同只读查询合并等待；Windows 原生补读重新查询，不用十五秒内的旧快照直接返回。页面按聊天排除在途查询，展开或滚动出现的新条目可以立即查询，五秒更新可刷新已经返回的其他条目；每页面和每主机最多并行四个查询，满额后释放空位时查询最新可见范围。超时响应使用 `timedOut` 和条目的 `activityError: timeout` 标记，灰点说明为“读取运行状态超时”。前端不为未知状态安排短间隔补查，等待中的同一聊天不被普通五秒更新重复排队，网络请求另设十秒保护。

超时回退不再等待会话锁：锁正被其他线程持有时，该条目返回未知状态，其他可读取条目仍返回当前状态。`test_activity_query.py` 用真实线程持有会话锁，验证整个查询能够及时返回。`test_session_maintenance.py` 验证维护异常按聊天隔离、整轮异常记录后仍继续下一轮，以及排队消息发送结果未知后不自动重发；日志只附带主机和聊天标识，不记录消息内容。

后端定向回归为 `test_activity_query.py`、`test_desktop_metadata_activity.py`、`test_subagent_activity.py` 和 `test_uploads_activity.py`，覆盖单请求等待结果、查询去重、共同截止时间、超时/关闭/晚到结果、子代理初始快照、实时 owner 优先及只读边界。Node 回归覆盖阻塞请求完成、超时保留灰点、网络中断与视口变化后的合并刷新；浏览器驱动在三种尺寸实际阻塞合成响应，检查等待期间没有重复补查、同一响应更新页面，以及超时提示。上述时限不承诺真实客户端或网络必定在五秒内成功。

延迟回归用事件控制合成读取：实时 owner 已就绪时不等较慢的原生补读，已核验的原生结果不等连接清理，运行中的父会话不等子代理发现；等待期间收到的新运行状态也能唤醒查询，空闲父会话仍等待子代理确认。排序时间读取被阻塞时，状态仍在同一请求返回，并检查辅助读取的并发合并、后续时间更新、失败保留、关闭时等待资源释放与关闭后晚到结果丢弃。

并发回归额外阻塞旧的五秒查询，再让新聊天进入视口，检查页面立即提交新增范围、网关独立处理新查询、原 owner 订阅按聊天合并，以及实时状态能够跳过其他原生补读的等待。Node 与后端用例检查并发上限、释放空位和同一聊天不重复读取；浏览器驱动在三种尺寸保留旧响应不返回，实际滚动并确认新聊天已经取得状态。

完成已读同步运行 `python -B scripts/test-backend.py --source-only -p test_chat_read_state.py` 与 `node --test tests/chat-read-state.test.cjs tests/attachments-activity.test.cjs tests/desktop-sessions-ui.test.cjs tests/deepseek-personal.test.mjs`，检查 Codex/DeepSeek 前台完成、背景及文件页隔离、轮次变化、原生身份与主机核对、CSRF 和持久化未知回执；Harness 用例还实际运行客户端插件工厂并验证只清除目标蓝点。第 6 版接入升级与组件校验由 `test_deepseek_migration.py` 覆盖。以上均使用合成数据，不能代替已安装客户端的实机联调。

长聊天消息目录运行 `python -B scripts/test-backend.py --source-only -p test_message_index.py`，覆盖 5000 条目录缓存、增量追加、替换/截断、未写完尾行、附件摘要、过期/跨聊天/跨主机标识、只读 HTTP、文件边界及独立 SSH 源码执行，并核验导航窗口的历史编辑、半轮补充消息限制、内嵌图片鉴权预览及变更后拒绝写入。真实浏览器驱动为 `node scripts/test-message-navigation-browser.cjs`，复用已有 Playwright/Chromium，在 390、820、1280 像素下实际执行 `message-navigation.browser.js` 和原有时间线、显隐、公开思考摘要夹具，检查完整目录、虚拟条目、早期/中间定位、上下滚动自动补页、相邻两页的有界保留、编辑入口、实际图片加载、实时阅读隔离、竞态与分页失败后的显式重试；也检查只有 1、2、5 条发言时点击横线展开弹窗、外侧与 Escape 收起、普通阅读与导航跳转均隐藏系统上下文、目录和已加载消息合并时只保留真实发言，显示设置切换不恢复上下文、带换行的实时发言与保存目录合并去重，以及右侧居中弹窗随窗口缩小仍不遮挡横线；仅使用合成数据，不操作真实客户端。

同一浏览器驱动还验证历史提问同时提供原地重发和新建分支，运行中的会话禁用历史原地重发；并实际执行 `runQuestionReadingScrollTests()`，验证最后为问题框时，用户只向上滚动 50 像素或在布局恢复帧内滚动，也会立即停止跟随；连续问题刷新保持阅读锚点，仅主动返回最新后才恢复跟随。`test_message_actions.py` 和 `test_message_index.py` 覆盖历史原地编辑沿用原 owner、目录消息的原生历史加载及加载后重验、活动轮次阻止、过期版本和未知写入不重放；`message-actions-ui.test.cjs` 验证历史移除提示和成功后重建同一聊天的时间线与目录。

未加载的 Desktop 聊天状态补读由 `test_desktop_metadata_activity.py`、`test_tool_pipe.py` 和 `test_uploads_activity.py` 覆盖，验证只读方法白名单、原生身份、缓存过期、失败回退、可见范围及不提升为可写连接。上述浏览器驱动同时验证“未知灰点 → 同一请求等待原生确认未加载/已完成 → 灰点消失”的查询过程。

`test_desktop_tool_profile.py` 验证状态补读复用自动发现的桌面程序路径，避免每五秒重新扫描 Windows 安装目录；每次连接仍核验管道服务进程、当前项目和聊天上下文。首次发现耗尽截止时间时不再提交原生读取，下一次查询可复用发现结果；路径消失、运行时变化或连接失败后重新发现，明确选择的桌面程序始终优先。路径提示不缓存聊天状态，也不作为停止程序或切换账号的依据。

原桌面重建状态订阅后的完成同步由 `test_codex_ipc_following.py` 与 `test_bridge.py` 覆盖：经真实长度前缀帧恢复仍有效的订阅，检查聊天/主机/owner、取消与断连边界，并用隔离命名管道复现“桌面空闲、网关仍运行中”后确认状态变为空闲、下一条普通消息只发送一次且沿用原 owner。夹具不连接真实聊天。

历史聊天自动连接运行 `node --test tests/chat-opening-ui.test.cjs tests/cli-access-ui.test.cjs` 和 `python -B scripts/test-backend.py --source-only -p test_bridge.py`，覆盖历史与重连并行、CLI 被动阅读不激活、模型目录不重复等待 owner、正文未加载时沿用已核验的 cwd/provider，以及连接分阶段耗时日志。真实 DOM 驱动为 `node scripts/test-chat-opening-browser.cjs`，使用已有 Playwright/Chromium，在 390、820、1280 像素下实际阻塞合成重连接口，确认历史先显示、连接前不预读模型，以及连接后即使模型查询仍被阻塞也能继续输入且保留草稿；不操作真实客户端。可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定运行时。

宿主与宽窄布局变更可先运行 `node --test tests/host-environment.test.cjs tests/layouts.test.cjs tests/frontend-assets.test.cjs mobile/tests/resources.test.cjs`。这些检查覆盖宿主识别与晚注入、容器分屏边界、样式顺序和原生资源清单，不启动或编译手机 App。布局的真实渲染和窗口变化后状态保留仍需浏览器夹具验证。

工作台标签滑动运行 `node scripts/test-workbench-swipe-browser.cjs`，使用已有 Playwright/Chromium 和合成 API，在手机竖横屏、平板和电脑宽度检查 Codex/Harness 的聊天整页及工具页滑动、正文和问题卡片选区保护、Git 变更／历史／分支内部切换与边界、Git 标题栏的外层切换、文件目录和预览、真实 PTY 与命令终端界面、草稿及问题答案保留、原生输入优先和防误发送，并检查分屏中的 Git 内外层切换。另通过真实 Animation 对象和标签点击验证全部工作台标签及 Git 内部标签的淡入、完成清理、连续切换取消和减少动态效果设置。可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定运行时；终端使用合成 API，不连接真实客户端或启动进程。

侧边聊天直接创建运行 `node scripts/test-side-chat-create-browser.cjs`，使用已有 Playwright/Chromium 和合成 API，在手机竖横屏、平板和电脑宽度实际点击“＋ → 侧边聊天”和“选区操作 → 新建侧边聊天”，检查 Codex/Harness 自动创建后可直接发送、选区完整保留且不自动发送、主聊天草稿保留、多标签独立、刷新恢复只读，以及创建失败、显式重试与回执丢失时不自动重发。可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定运行时；不启动真实客户端或模型。`node --test tests/workbench-side-chats.test.cjs tests/selection-targets.test.cjs` 另覆盖初始读取与创建回包的竞态、同一标签防止重复创建，以及取消、失效或超长选区不创建聊天。

同一浏览器驱动还会删除合成服务端的旧侧边槽位，验证停留主聊天时发现失效、旧消息与草稿保留、只读提示、真实键盘不能修改输入、主聊天与其他侧边聊天的真实选区入口禁用失效目标，以及失效前已打开的目标窗口不能继续投递；发送、创建和关闭失效标签均不额外写入服务端。`tests/chat-display-panels.test.cjs` 另覆盖短暂读取失败后恢复、首次读取已无记录、聊天身份变化和反复读取不恢复失效标签。

同一驱动还实际执行 `side-message-navigation.browser.js`，检查侧边聊天复用主聊天的缩略导航、摘要点击定位、单条与附件发言、重复发言和上下文过滤、160 条发言的虚拟列表、新回复下的阅读锚点、手动或按钮返回最新、分屏定位、标签隔离及关闭后的监听释放。主聊天导航原有回归仍为 `node scripts/test-message-navigation-browser.cjs`；所有夹具只使用合成数据。

[浏览器夹具](browser/README.md) 位于 `tests/browser/*.browser.js`，依赖真实 DOM 或隔离服务，应由相应驱动调用。其中有些文件只定义测试函数，单独加载不会执行断言。本轮将它们与 Node 分开，避免虚增通过计数。

`scripts/smoke-*` 中部分入口启动真实应用或依赖打包产物；运行前先看其头部与 fixture，不把它们作为无副作用的常规单元测试。

## 手机与打包

`mobile/tests/` 中 Java/Swift 用例由相应 `scripts/test-mobile-*`、`scripts/test-ios-*` 驱动，可能编译测试程序；只在本次任务允许且环境具备时执行。Web 资源验证不代替 Android WebView 或 iOS WKWebView 的原生交互验证。

Android 通知点击回归为 `python -B scripts/test-android-notification-navigation.py`：使用 JDK 编译实际 Intent 处理方法，替换系统界面，检查同电脑复用 WebView、跨电脑跳转以及配对和来源限制，不构建或安装 APK。普通聊天输入草稿的真实浏览器回归为 `node scripts/test-composer-drafts-browser.cjs`，使用 Playwright/Chromium 和合成 API，覆盖手机/平板上的通知跳转、页面重建、三种客户端的草稿恢复及发送后清理。可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定已有运行时。

`python -B scripts/test-mobile-events.py` 还会编译并执行实际 Android 登录保存回调，检查重复保存同一登录不会吞掉新完成通知，换登录和前后台切换仍保留历史保护。仅运行该回归可加 `--session-refresh`。

真实 Android 通知链路使用 `python -B scripts/test-android-notification-flow.py --serial emulator-端口 --apk 本地测试APK --classes-dir 同一构建的classes目录`。需预先准备 Android 35 SDK、JDK 和已启动的隔离模拟器；工具不会启动模拟器，只接受 `emulator-*` 和独立 `localtest` 包，会覆盖该模拟器上的测试版、清空该测试版的偏好并运行合成网关。验证真实 MainActivity、WebView 登录回调、前台服务与 NotificationManager，不连接真实电脑、聊天或账号。

`scripts/gateway-resources.json` 与源路径测试保证清单一致，但冻结导入、签名、安装和更新必须在获准打包后、目标系统上另外验证。不要根据 macOS 单机测试宣称 Windows/Linux 已实机通过。

交互问题草稿的后端验证为 `python -B scripts/test-backend.py --source-only -p test_answer_drafts.py`，浏览器验证为 `node scripts/test-answer-drafts-browser.cjs`。后者使用独立手机/平板上下文、真实 DOM 和合成草稿服务，检查页面重建、跨设备恢复、并发冲突及断线核对；需要已有 Playwright/Chromium，可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定测试运行时。问题工具选区另由 `node scripts/test-side-chat-create-browser.cjs` 实际执行 `question-selection.browser.js`，覆盖 Codex/Harness 主聊天与侧边聊天中的题目、选项和回答片段引用、自动启用入口、桌面右键保留系统菜单、原生选区凭证、卡片移除和答案修改后的失效，以及不提交答案或自动发消息。详见 [答案草稿说明](../docs/answer-drafts.md)。
