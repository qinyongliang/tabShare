# 参考工具与实现路线

核对的资料：

- [Tab Controller 商店页面](https://chromewebstore.google.com/detail/tab-controller/pfpklflgcohcgjcabncbooelenbbbkcj)：版本 3.8.0，商店显示更新于 2026-09-26。单主机、单访客、明确授权、调试提示、页面镜像、点击/键盘/滚动/导航、P2P 优先并可中继。
- [开发者公开网站仓库](https://github.com/rbu-ong/Tab-Controller)：检查时只提供 `index.html` 和 `privacy.html`，没有插件实现源码。未复制或反编译该插件。
- [开发者隐私政策](https://rbu-ong.github.io/Tab-Controller/privacy.html)：共享标签页 screencast 与输入转发；可见的 Chrome 调试提示；短期内存中的房间配对。
- [Chrome debugger 官方说明](https://developer.chrome.com/docs/extensions/reference/api/debugger)和 [CDP 协议定义](https://github.com/ChromeDevTools/devtools-protocol)：支持按 tab 附加调试连接、页面输入、隔离世界和截图。

TabShare 的设计目标包括无人值守重连、持久分享链接、网址对应会话复用以及多人同时访问。同步优先使用 DOM 差异，合并动画引起的频繁变化以控制开销；特殊区域可使用视频，重叠时可切换整页画面。

普通网页采用“源页运行逻辑 + 安全 DOM 镜像 + 固定输入回传”，源页和登录状态只有一份。Canvas/跨域 iframe 等区域使用 WebRTC 视频轨道，DOM 差异、资源和输入使用 DataChannel。实现见 [架构文档](architecture.md)，支持范围见 [兼容性文档](compatibility.md)。
