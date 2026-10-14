# 参考工具与实现路线

核对的资料：

- [Tab Controller 商店页面](https://chromewebstore.google.com/detail/tab-controller/pfpklflgcohcgjcabncbooelenbbbkcj)：版本 3.8.0，商店显示更新于 2026-09-26。单主机、单访客、明确授权、调试提示、页面镜像、点击/键盘/滚动/导航、P2P 优先并可中继。
- [开发者公开网站仓库](https://github.com/rbu-ong/Tab-Controller)：检查时只提供 `index.html` 和 `privacy.html`，没有插件实现源码。未复制或反编译该插件。
- [开发者隐私政策](https://rbu-ong.github.io/Tab-Controller/privacy.html)：共享标签页 screencast 与输入转发；可见的 Chrome 调试提示；短期内存中的房间配对。
- [Chrome debugger 官方说明](https://developer.chrome.com/docs/extensions/reference/api/debugger)和 [CDP 协议定义](https://github.com/ChromeDevTools/devtools-protocol)：支持按 tab 附加调试连接、页面输入、隔离世界和截图。

TabShare 的需求额外包含无人值守重连、持久分享链接、网址对应会话复用以及多人同时访问。用户进一步选择 DOM 同步优先，并要求只发送差异、限制动画的同步开销，特殊区域可降级为画面，重叠时可降级整页。

因此普通网页采用“源页运行逻辑 + 安全 DOM 镜像 + 固定输入回传”，不让访客重新独立运行原网站。源页与登录状态仍只有一个。Canvas/跨域 iframe 等无法直接复制的区域才使用低频截图。Chrome 调试提示不隐藏。该路线与参考工具的全页画面镜像不同，并有 README 中列出的兼容性限制。
