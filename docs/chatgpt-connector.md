# Windows ChatGPT 连接器验证

这是完整 ChatGPT 接入方案的第一阶段验证工具，尚未开放手机端聊天操作或固定 ChatGPT 分区。真实运行门槛通过后，才能继续实现新建、发送、停止、附件、模型设置、编辑、重新生成和独立分支。

## 当前状态

2026-10-29，已在本机核验安装包版本 `26.1021.31345` 及两个原窗口模块的 SHA-256。只读诊断返回 `restart-required`：原桌面没有远程调试参数，而本开发聊天仍在执行。因此没有退出或重启桌面，也没有把源码中存在 `Jp.scope` 当作实际调用成功。

Windows Store 带参数激活目前经过模拟测试，尚未实际启动验证。普通 ChatGPT 运行时上下文、后台刷新、账号核验及断开后桌面继续运行仍待实机验证；完整功能的第 2–4 阶段保持关闭。

## 接入边界

- `installation.py` 读取有界 ASAR 成员，核对包名、版本及必要模块指纹。未知版本、同版本变化、归档损坏或更新中均拒绝连接。
- Windows 原生模块即时核对精确安装路径、主进程 PID、创建时间、用户 SID、会话及调试监听归属。任何非回环监听或另一进程占用均拒绝。
- `bootstrap.py` 通过现有命名管道和原项目核验 profile。只允许全部原应用进程已退出后启动一次，不提供退出、强杀、自动重启或重复启动。
- 直接启动保留参数数组；受保护 Store 程序使用 `IApplicationActivationManager.ActivateApplication` 传参。带参数启动失败不回退到 Explorer 普通启动。启动返回值不代表初始化成功，仍须核对监听和原 profile。
- `connection.py` 仅连接已核验的 `127.0.0.1` 端点，拒绝 HTTP/WebSocket 重定向、代理环境和不明确的窗口。连接前后和读取前后重新核验进程身份。
- `probe.js` 是固定探针：进入原 renderer 主世界，读取既有 `Jp.scope`，输出账号身份摘要、路由和目标聊天缓存元数据。显式刷新只调用原生被动 GET 查询，不调用导航或消息写操作。正文、标题、凭据和认证对象不导出。
- 账号或路由在读取中变化、窗口重载、连接丢失均使验证失败。请求不重放，关闭探针只断开 WebSocket，不关闭桌面。

目前没有给手机开放 CDP、脚本、函数名、地址或 RPC 转发入口，也没有新增 HTTP 业务接口。调试端口仅供本机验证；验证后可在任务空闲时正常退出桌面，再按平常方式启动以去掉调试参数。

## 完成真实门槛

在本仓库目录使用已有 Python 和项目依赖运行。默认命令只检查安装与进程，不启动桌面：

```powershell
python -B scripts/probe-chatgpt-connector.py
```

必要时使用 `--executable '原安装路径\ChatGPT.exe'` 和 `--codex-home '原数据目录'` 明确原环境，不得选择新的空 profile。

先准备一个专用普通 ChatGPT 测试聊天并记下服务端 ID，让桌面停在另一个聊天页面。等待所有任务空闲后，手动正常退出原桌面，再在外部 PowerShell 中运行：

```powershell
python -B scripts/probe-chatgpt-connector.py --launch-if-stopped --thread '<测试聊天服务端 ID>' --refresh
```

该命令只在原桌面及其子进程均已退出时启动一次。失败时不改安装包、不建立另一个账号环境，也不结束已启动的程序。桌面已通过受控方式运行时，后续只读验证使用：

```powershell
python -B scripts/probe-chatgpt-connector.py --probe --thread '<测试聊天服务端 ID>' --refresh
```

只有新查询取得目标聊天数据、账号保持一致、当前路由属于另一个页面、读取期间未发生导航、断开后原进程仍匹配，才返回 `runtimeGatePassed: true` 和退出码 0。仅发现监听、加载 scope、观察缓存、未指定聊天或桌面正在展示目标聊天，都不能通过，退出码为 3。多个同源窗口时默认拒绝猜测，可用 `--target-id` 指定核实过的原窗口；仍须验证窗口类型为 `primary`。

这只证明第一阶段读取连接可用。新建、发送、停止等写操作要在后续阶段分别实现和实测。

## 自动验证

本轮新增 ChatGPT 后端测试 34 项通过，固定探针 Node 测试 4 项通过。启动、发现、资源和平台边界回归运行 48 项，其中 46 项通过、2 项为 POSIX 专项而跳过。完整 `npm run test:desktop` 在“已提交基线＋本次改动”的隔离副本中 1055 项全部通过；共享工作区有另一任务正在修改的排序与快照代码，不能把其临时失败算作本次提交的验证结果。

真实 Windows 证据仅包括安装指纹和进程只读诊断。多渲染进程下逐项 WMI 请求超时的问题已通过批量读取修复，后续身份核验只复查绑定主进程；实测最终返回 `restart-required`。未启用调试、未调用原窗口函数、未执行 Store 激活，也没有运行第 4 阶段的浏览器验收。

```powershell
python -B scripts/test-backend.py --source-only -p 'test_chatgpt_*.py'
node --test tests/chatgpt-probe.test.cjs
npm run test:desktop
```

连接测试实际运行回环 HTTP/WebSocket 夹具，需要项目已有的 `aiohttp`（`requirements-relay.txt`）。缺少依赖时会明确跳过这类测试，不能把跳过视作接入通过。其余测试使用合成安装包、进程和身份数据，不操作真实聊天。第一阶段没有变更 Web/手机界面，后续仍须完成手机和平板浏览器验收。

参数与激活方式参考 [Electron 调试开关](https://www.electronjs.org/docs/latest/api/command-line-switches#--remote-debugging-portport) 和 [Microsoft ActivateApplication](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-iapplicationactivationmanager-activateapplication)。原应用内部模块及压缩导出仅为当前版本适配资料，不是稳定业务 API。
