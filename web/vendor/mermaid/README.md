# Mermaid 本地资源

- 版本：12.3.0，MIT 许可，原始许可见 `LICENSE`。
- 来源：[官方 npm 包](https://www.npmjs.com/package/mermaid/v/12.3.0)中的 `dist/mermaid.min.js`，未经修改。
- npm tarball SHA-512：`4113TdXeLAsMruJ79OpFL5O8+LTFXhQqZ260rF3tgUmiNAtRm4Uume04I+65PRN6yZ69J4f8rVYWW8zRk65UYw==`。
- `mermaid.min.js` SHA-256：`336df803d87a38b70a01e736e666c8f7601d2ce42f5e47c8fafe5d721074b9a3`。

聊天首次遇到完整 Mermaid 围栏时才加载。依赖只在现有 `/html-preview-shell` 的不透明源沙箱中执行，不进入主页面运行环境。主页面展示无脚本交互的 SVG 图片，不调用 Mermaid 的事件绑定函数。

升级时重新核对 npm 完整性、文件摘要、独立 bundle 无额外网络依赖，以及浏览器夹具的中文、流式、配置拒绝和外部请求隔离用例。
