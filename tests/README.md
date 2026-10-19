# 验证入口

测试应匹配改动的功能和平台。源码测试不等于已经编译、安装或在三个系统上完成真实客户端联调。

## Python 后端

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

Harness 个人分支功能另有 `node scripts/test-deepseek-browser.cjs`：需要已有的 Playwright 与 Chromium（可通过 `NODE_PATH` 使用现有测试运行时），在四种屏幕尺寸执行实际 DOM 断言，仅使用隔离合成会话。详情见 [功能对应与验证](../docs/deepseek-personal-features.md)。

Windows Harness 正常退出另有 `python -B scripts/test-backend.py -p test_dsh_menu_native.py`：复用本机已有 Electron 运行库（可通过 `CMB_TEST_ELECTRON_EXECUTABLE` 指定），仅将运行库复制到 `.tmp/`，在非活动桌面启动独立合成应用，实际调用中英文标题栏菜单和原生退出项。覆盖正常清理、待处理窗口、重复退出项和进程创建身份变化；不加载真实 Harness 资源、数据目录或模型。缺少运行库时明确跳过，不计作通过。

## Node 与浏览器

```sh
npm run test:desktop
npm run test:updater
```

`test:desktop` 通过 `scripts/test-frontend.cjs` 自动递归发现 `tests/` 和 `mobile/tests/` 中 `*.test.js`、`*.test.cjs`、`*.test.mjs`。新增 Node 用例不需编辑长命令清单；资源路径检查包含在该入口。

导航栏自动状态同步可单独运行 `node --test tests/sidebar-activity.test.cjs`；真实 DOM 验证为 `node scripts/test-sidebar-activity-browser.cjs`，使用合成 API，在手机、平板和电脑尺寸检查首次显示、滚动、折叠与重新展开、收起与重新打开导航栏时的可见聊天订阅，确认无需点击聊天，也没有打开桌面聊天或发送消息。浏览器驱动需要已有 Playwright/Chromium，可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定运行时。

未加载的 Desktop 聊天状态补读由 `test_desktop_metadata_activity.py`、`test_tool_pipe.py` 和 `test_uploads_activity.py` 覆盖，验证只读方法白名单、原生身份、缓存过期、失败回退、可见范围及不提升为可写连接。上述浏览器驱动同时验证“未知灰点 → 原生确认未加载/已完成 → 灰点消失”的自动轮询过程。

宿主与宽窄布局变更可先运行 `node --test tests/host-environment.test.cjs tests/layouts.test.cjs tests/frontend-assets.test.cjs mobile/tests/resources.test.cjs`。这些检查覆盖宿主识别与晚注入、容器分屏边界、样式顺序和原生资源清单，不启动或编译手机 App。布局的真实渲染和窗口变化后状态保留仍需浏览器夹具验证。

[浏览器夹具](browser/README.md) 位于 `tests/browser/*.browser.js`，依赖真实 DOM 或隔离服务，应由相应驱动调用。其中有些文件只定义测试函数，单独加载不会执行断言。本轮将它们与 Node 分开，避免虚增通过计数。

`scripts/smoke-*` 中部分入口启动真实应用或依赖打包产物；运行前先看其头部与 fixture，不把它们作为无副作用的常规单元测试。

## 手机与打包

`mobile/tests/` 中 Java/Swift 用例由相应 `scripts/test-mobile-*`、`scripts/test-ios-*` 驱动，可能编译测试程序；只在本次任务允许且环境具备时执行。Web 资源验证不代替 Android WebView 或 iOS WKWebView 的原生交互验证。

Android 通知点击回归为 `python -B scripts/test-android-notification-navigation.py`：使用 JDK 编译实际 Intent 处理方法，替换系统界面，检查同电脑复用 WebView、跨电脑跳转以及配对和来源限制，不构建或安装 APK。普通聊天输入草稿的真实浏览器回归为 `node scripts/test-composer-drafts-browser.cjs`，使用 Playwright/Chromium 和合成 API，覆盖手机/平板上的通知跳转、页面重建、三种客户端的草稿恢复及发送后清理。可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定已有运行时。

`python -B scripts/test-mobile-events.py` 还会编译并执行实际 Android 登录保存回调，检查重复保存同一登录不会吞掉新完成通知，换登录和前后台切换仍保留历史保护。仅运行该回归可加 `--session-refresh`。

真实 Android 通知链路使用 `python -B scripts/test-android-notification-flow.py --serial emulator-端口 --apk 本地测试APK --classes-dir 同一构建的classes目录`。需预先准备 Android 35 SDK、JDK 和已启动的隔离模拟器；工具不会启动模拟器，只接受 `emulator-*` 和独立 `localtest` 包，会覆盖该模拟器上的测试版、清空该测试版的偏好并运行合成网关。验证真实 MainActivity、WebView 登录回调、前台服务与 NotificationManager，不连接真实电脑、聊天或账号。

`scripts/gateway-resources.json` 与源路径测试保证清单一致，但冻结导入、签名、安装和更新必须在获准打包后、目标系统上另外验证。不要根据 macOS 单机测试宣称 Windows/Linux 已实机通过。

交互问题草稿的后端验证为 `python -B scripts/test-backend.py --source-only -p test_answer_drafts.py`，浏览器验证为 `node scripts/test-answer-drafts-browser.cjs`。后者使用独立手机/平板上下文、真实 DOM 和合成草稿服务，检查页面重建、跨设备恢复、并发冲突及断线核对；需要已有 Playwright/Chromium，可通过 `NODE_PATH`、`BROWSER_EXECUTABLE` 指定测试运行时。详见 [答案草稿说明](../docs/answer-drafts.md)。
