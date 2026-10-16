# 浏览器检查

本目录中的 `*.browser.js` 依赖真实 DOM、页面模块及隔离的网关夹具。它们由浏览器驱动加载并调用文件中声明的检查函数；Markdown 与公式脚本在加载后直接运行。各文件开头说明所需页面与前置状态。

仅使用合成会话和测试工作区。不要在真实用户会话中运行会发送消息、修改文件或操作 Git 的夹具。

这些脚本不会由 `npm run test:desktop` 执行。该命令只发现 `tests/` 和 `mobile/tests/` 下的 `*.test.js`、`*.test.cjs`、`*.test.mjs`；浏览器检查应单独记录实际执行与未执行情况。

`subagent-activity.browser.js` 的 `checkSubagentActivityBrowserPhase(phase,id)` 使用父会话本轮已完成、两个子代理逐个结束的活动夹具，由驱动等待真实 5 秒轮询后分别传入 `two`、`one`、`unknown`、`parent-offline`、`done`。检查父会话侧栏与头部运行标识、未知状态、提前完成抑制及最终未读清除。后端对子树的被动订阅、主机与 owner 核验、断线、超时回收及批量元数据发现由 `test_subagent_activity.py` 和 `test_subagents.py` 覆盖。
