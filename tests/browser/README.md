# 浏览器检查

`workbench-swipe.browser.js` 由 `node scripts/test-workbench-swipe-browser.cjs` 执行。使用生产页面、隔离合成 API 和 Chromium 触屏输入，在手机竖屏、横屏、平板和电脑宽度检查主聊天／侧边聊天的消息区、头部、输入区与 Git／子智能体／文件目录和预览／终端整页的相邻标签切换、首尾不循环、草稿保留和长按；终端实际使用生产 PTY 与命令终端界面组件，服务端完全模拟。另执行 `runWorkbenchChatAreaChecks()`，覆盖正文、问题卡片、问题回答和空白区域的双向滑动、答案保留与选区保护；`runWorkbenchTransitionChecks()` 读取真实 Animation 对象，检查每种工作台标签和 Git 内部标签的淡入、结束样式清理、快速切换及减少动态效果设置，驱动也实际点击标签验证动画。DOM 边界断言继续覆盖多指、取消、纵向滚动、文件和终端选字、弹窗、切换期间旧手势、横向滚动和横滑后点击拦截。检查 Codex 与 Harness 两套共享工作台，统计聊天发送、终端输入和 Git 写请求，确保滑动无误操作。需要已有 Playwright/Chromium，可通过 `NODE_PATH` 和 `BROWSER_EXECUTABLE` 指定运行时，不连接真实客户端，也不启动终端进程。

`message-navigation.browser.js` 由 `node scripts/test-message-navigation-browser.cjs` 执行。使用生产 `ChatTimeline`、CSS 和合成只读 API，在手机、平板与电脑尺寸验证 5000 条完整目录、虚拟滚动、单次触屏定位最早/中间消息、纯附件、双向正文分页、历史阅读与实时更新隔离、连续点击与已加载消息抢占、切换后的旧回包，以及目录/窗口网络失败与重试。驱动还逐一执行本目录原时间线的三个检查函数；不能只加载脚本就报告通过。

`file-refresh.browser.js` 的 `runFileRefreshBrowserChecks()` 由 `node scripts/test-file-refresh-browser.cjs` 执行。需要已有 Playwright 和 Chromium，可通过 `NODE_PATH` 指向现有依赖、`BROWSER_EXECUTABLE` 指定测试浏览器。驱动在电脑、手机、平板和横屏尺寸分别验证中文与英文，实际刷新 Markdown、HTML 预览／源码、源码、图片、PDF 与仅下载文件，覆盖全屏、文本阅读位置、错误重试、重复点击、八标签上限、关闭／重置后的旧回包，以及 SSH 和其他客户端的读取归属。所有会话和文件均为合成夹具，不访问已安装客户端。

`selection-gestures.browser.js` 的 `runSelectionGestureBrowserTests()` 使用同一合成文件夹具，但目录响应故意省略 `root`。它分阶段模拟手机选词、扩大/缩小范围和重复长按，分别检查文件、聊天消息及活动正文：所有触屏 contextmenu 均不被网页取消，所有长按都不显示自定义菜单或浮动按钮，只有主动点击“引用选区”或“选区操作”才执行草稿操作，且菜单获得焦点后清空选区仍能引用先前完整文本。驱动需覆盖手机、平板和横屏，并确认选择/引用没有发出聊天发送请求。

Android 原生选区手柄还会生成 `pointerType=mouse`、`button=-1`、`firesTouchEvents=false` 的菜单事件，不能把它当作电脑右键。此事件由上述夹具及 `navigation-preferences.test.cjs` 单列覆盖；验证系统复制、分享和拖动手柄时，还应在独立 Android WebView 夹具或实机上执行真实触屏操作，不能用脚本先设置 DOM Range 替代原生手柄。

`file-quotes.browser.js` 的 `runFileQuoteBrowserTests(gesture)` 使用合成文件、两个聊天和侧边聊天夹具，`gesture` 为 `mouse` 或 `touch`。检查电脑右键与触屏显式引用按钮、统一目标选择、代码选区与完整路径、引用标签详情和删除、聊天草稿隔离，以及主会话/侧边聊天仅有引用时的发送与成功清理。驱动需在电脑、手机、平板和手机横屏分别执行，并检查捕获的发送正文；触屏长按由浏览器 PointerEvent 定时器模拟，不能替代 Android/iOS 原生选区菜单实机验证。

本目录中的 `*.browser.js` 依赖真实 DOM、页面模块及隔离的网关夹具。它们由浏览器驱动加载并调用文件中声明的检查函数；Markdown 与公式脚本在加载后直接运行。各文件开头说明所需页面与前置状态。

`side-chat-names.browser.js` 的 `runSideChatNamesBrowserTests()` 在全新的隔离侧边聊天网关中执行，检查连续创建三条独立聊天、创建前命名、创建后改名、名称发现与版本防回退、草稿隔离、空名称校验，以及名称与 UI 翻译词相同时仍按原文显示。驱动另开独立页面检查三个名称自动恢复与双向改名同步，并核对 390 像素和宽屏布局；只使用合成运行时，不发送真实模型消息。

仅使用合成会话和测试工作区。不要在真实用户会话中运行会发送消息、修改文件或操作 Git 的夹具。

`navigation-preferences.browser.js` 的 `runNavigationPreferenceBrowserTests()` 依赖合成导航网关，检查分区/项目折叠、新建设置与统一选词入口中的新建侧边聊天草稿。`markdown-navigation.browser.js` 的 `runMarkdownNavigationChecks()` 自建合成文件读取，检查章节、跨文件链接和保留标签栏的 Markdown 全屏；需在窄屏和平板宽度分别调用，检查结果应包含实际断言数。

这些脚本不会由 `npm run test:desktop` 执行。该命令只发现 `tests/` 和 `mobile/tests/` 下的 `*.test.js`、`*.test.cjs`、`*.test.mjs`；浏览器检查应单独记录实际执行与未执行情况。

`session-list.browser.js` 的 `runSessionListBrowserTests()` 依赖同一项目包含多个聊天的隔离列表夹具，验证项目内聊天不提供手动调序、刷新保留最近交互排序，以及实时标题同时更新聊天头部和侧栏。新建成功但后台列表仍旧时的条目保留、手机长按和整页刷新后的顺序应由夹具驱动另外检查。

`project-pagination.browser.js` 的 `runProjectPaginationBrowserTests()` 使用含 27 条会话的项目和占据中间全局分页的另一个项目，验证 5→15→25→27、项目间隔离、刷新保留加载进度以及跨页排序。驱动还需使用真实定时器验证新会话标题自动同步，覆盖侧栏滚动超过 24 像素、手机侧栏收起，以及聊天实时数据反复返回旧“新聊天”占位标题；不以手动调用列表刷新替代定时同步检查。

`subagent-activity.browser.js` 的 `checkSubagentActivityBrowserPhase(phase,id)` 使用父会话本轮已完成、两个子代理逐个结束的活动夹具，由驱动等待真实 5 秒轮询后分别传入 `two`、`one`、`unknown`、`parent-offline`、`done`。检查父会话侧栏与头部运行标识、未知状态、提前完成抑制及最终未读清除。后端对子树的被动订阅、主机与 owner 核验、断线、超时回收及批量元数据发现由 `test_subagent_activity.py` 和 `test_subagents.py` 覆盖。

`running-send-choice.browser.js` 的 `checkRunningSendChoiceBrowserState(phase,text)` 由隔离驱动在桌面、手机和平板尺寸分别调用，检查任务执行中发送时的原生弹框、两个明确选项、取消默认焦点、布局和草稿保留。驱动需统计真实发送请求，确认取消、Escape、遮罩和 Enter 均不发消息，选择后只发送一次；还需覆盖切换会话、后台明确拒绝普通发送后的弹框。`running-send-choice.test.cjs` 另验证附件/Skill 保留、未知结果沿用原请求 ID 和发送方式、不自动重试未确认写入。

`sidebar-placements.browser.js` 的 `runSidebarPlacementBrowserTests()` 使用含 `planning` 自定义分区的隔离夹具，验证项目与会话的右键菜单、分区选择弹出框、置顶与取消置顶、刷新后的归属保留。驱动还应分别在平板与手机尺寸执行长按菜单，并检查“跟随 Codex”、取消操作以及操作未发送聊天写请求。

`project-section-order.browser.js` 的 `runProjectSectionOrderBrowserTests()` 使用自定义分区、置顶区各有三个项目的夹具，检查项目菜单上下移动、边界禁用、分区中直接聊天的位置不变，以及区域排序隔离。驱动继续验证手机/平板长按和整页刷新后的顺序。

`sidebar-collapse.browser.js` 的 `runSidebarCollapseBrowserTests(mode)` 在 `codex` 和 `project` 显示方式下检查工具栏“⋯”菜单的“折叠所有”，覆盖分区及嵌套项目一起收起、刷新保留、单独重新展开，以及当前聊天、草稿和项目分页保留。驱动在电脑、手机和平板宽度分别调用，并检查整页刷新后仍折叠。

`reference-picker.browser.js` 的 `runReferencePickerBrowserTests()` 使用合成技能、嵌套项目文件和分区会话，检查“＋”入口、三个类型标签、技能纯文本、引用次数排序及后续分页常用技能前移、搜索顺序与分页不受次数影响、清空搜索恢复排序、文件完整路径、目录懒展开、搜索保留父目录、隐藏文件，以及会话搜索保留分区/项目结构。技能夹具需包含 `review-skill` 和 `skill-0` 至 `skill-219`，初始顺序与每页 200 项保持一致。驱动需在电脑、手机、平板和手机横屏分别执行，校验发送正文包含三类引用且无独立 `skills` 字段；仅打开原合成聊天，选择会话引用不打开被引用聊天。`node --test tests/reference-picker.test.cjs` 另覆盖本地记录恢复、次数相同的稳定顺序、主/侧弹窗共用记录、主机/客户端/中继隔离、存储异常、失败引用不计数及分页取消竞态。目录搜索与读取边界由 `test_workspace.py` 验证。

`project-folder-browser.browser.js` 的 `runProjectFolderBrowserTests()` 使用合成的 `D:\Workspace` 目录和项目表单，检查文件夹弹窗、常用位置、面包屑、地址输入、搜索、空目录和错误状态。驱动提供 `window.projectFolderFixture`，在电脑、手机、平板和横屏尺寸实际调用；新建目录先返回处理中回执再经只读轮询完成，碰撞不覆盖，仅显式确认回填路径，不能调用原生项目创建或聊天写接口。`project-folder-browser.test.cjs` 另外覆盖未知回执、断线和旧请求，不自动重放创建。

同一夹具的 `runProjectFolderCreationCompatibilityChecks()` 由驱动分别省略 `canCreateDirectory` 和将其设为 `false`，检查旧网关仍可浏览和选择已有目录、新建按钮禁用且弹窗内明确提示重启；驱动同时验证没有目录写请求。创建或回执接口返回 404 的区别由 Node 回归覆盖，已接受写入后的查询失败保持未知状态。

`timeline.browser.js` 还提供 `runReasoningSummaryTests()`，检查无公开摘要的记录隐藏、不读取空记录，以及后续公开摘要到达后显示并加载正文。

`navigation-preferences.browser.js` 的 `runSelectionActionBrowserTests()` 检查选词后的滚动、当前输入框引用、侧边聊天草稿、活动正文选词，以及原生菜单消费选区凭证时的单次消费和会话隔离；只在合成聊天中执行。

`selection-targets.browser.js` 的 `runSelectionTargetsBrowserTests()` 由 `node scripts/test-side-chat-create-browser.cjs` 在独立合成网关执行，验证文件、主聊天和侧边聊天选区的目标选择、新侧边聊天直接创建并保留引用草稿、独立槽位与发送隔离；网关夹具须按 `slot` 分开保存侧边状态。不要在真实会话运行该发送夹具。

`side-message-navigation.browser.js` 的 `runSideMessageNavigationBrowserTests(provider)` 由同一驱动在四种尺寸分别验证 Codex/Harness 侧边聊天的缩略导航，实际断言弹窗位置、摘要跳转、阅读锚点、恢复跟随、附件及重复发言、160 条目录虚拟渲染、分屏与多标签隔离、聊天标识替换及关闭清理。导航夹具不发起聊天创建、发送或问题回复请求。

`question-selection.browser.js` 的 `runQuestionSelectionBrowserTests(provider)` 由同一驱动在手机竖横屏、平板和电脑尺寸分别执行，验证 Codex/Harness 真实问题卡片的题目、选项说明和已填写回答片段能够自动启用“选区操作”，引用到主聊天、已有或新建侧边聊天，并检查桌面右键、原生凭证消费、草稿保留、视图隔离、移除或修改后凭证失效。驱动核对没有聊天发送或问题回复请求；原生选区通过 DOM 和输入框偏移模拟，不能代替 Android/iOS 设备上的原生手柄实测。

`selection-popup.browser.js` 的 `runUnifiedSelectionPopupBrowserTests(gesture)` 使用各自隔离的合成侧边会话，检查主消息、侧边消息、文件三处主动引用后直接出现同一个目标框，并比较完整弹框 DOM。电脑通过右键触发，手机/平板通过显式按钮触发，触屏长按保留原生菜单；同时检查提醒设置入口已移至聊天详情。

`side-reference-picker.browser.js` 的 `runSideReferencePickerBrowserTests()` 使用独立合成侧边聊天与 221 项技能目录，验证侧边“＋”与主会话共用三个引用类型、技能分页和光标插入、项目文件完整路径、会话分区树、主/侧草稿隔离、新侧边创建前的文件引用，以及切换后丢弃旧读取。驱动需校验侧边技能请求绑定子会话 ID、发送正文包含全部引用且没有独立 `skills` 字段；`UNCONFIRMED_SIDE_REFERENCE` 在夹具中返回未知发送结果，用于验证保留草稿且不自动重发。不要在真实会话运行发送夹具。
