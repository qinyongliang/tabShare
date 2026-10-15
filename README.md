# TabShare

**用一个链接，让多人共同操作同一个浏览器标签页。**

TabShare 由 Chrome 扩展和 Go 服务组成。网页继续在你的浏览器中运行，访客打开分享链接即可操作同一页面，共用原有登录状态。适合远程协助、演示和协作操作。

[下载 Releases](https://github.com/qinyongliang/tabShare/releases) · [快速开始](#快速开始) · [使用指南](docs/usage.md) · [部署文档](docs/deployment.md) · [开发指南](docs/development.md) · [报告问题](https://github.com/qinyongliang/tabShare/issues)

## 功能

- **原生 DOM 体验**：文字可选择、复制，表单使用浏览器控件；首次同步结构，后续只发送差异。
- **输入、复制与下载**：支持图片粘贴、视频区域输入法定位与文字选区；页面附件和 Blob 下载转发到访客浏览器。
- **DOM 与视频混合**：Canvas、跨域嵌入等复杂区域使用 WebRTC 视频，只编码可见局部区域，遮挡或超预算也保留 DOM 页面。
- **P2P 优先**：DOM、输入、图片、字体和视频优先直连，失败后自动使用 Go 服务内置的 TURN。
- **两种分享方式**：共享指定标签页，或创建可复用的网址链接，标签页关闭后按需重开。
- **多人协作与屏幕适配**：支持多人访问、缩放、全屏、移动端触控及共享视口调整。
- **自主部署**：一个 Go 进程提供会话、信令和 TURN；配对令牌与中继凭据自动生成，传输质量自动调整。

## 快速开始

推荐使用 Docker Compose 部署服务，再安装 Chrome 扩展。需要 Docker Compose、Chrome 118+，以及一个 A 记录直接指向服务器公网 IPv4 的域名。

### 1. 启动服务

```sh
git clone https://github.com/qinyongliang/tabShare.git
cd tabShare
cp deploy/.env.example deploy/.env
```

编辑 `deploy/.env`，只需填写自己的域名：

```dotenv
TABSHARE_DOMAIN=tabs.example.com
```

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

Caddy 自动配置 HTTPS，Go 从域名解析 TURN 地址，并自动保存数据与密钥。服务器需开放 `80/TCP`、`443/TCP`、`3478/TCP+UDP`、`49160–49359/UDP`。域名应直接解析到服务器；CDN、多个 A 记录等特殊网络配置见 [部署文档](docs/deployment.md)。

### 2. 连接扩展

可从 [Releases](https://github.com/qinyongliang/tabShare/releases) 下载 `tabshare-extension.zip` 并解压，也可以使用仓库中的 `extension/` 目录。

在服务器终端读取配对令牌，妥善保存：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec tabshare cat /data/admin-token
```

1. 打开 `chrome://extensions`，开启开发者模式。
2. 点击“加载已解压的扩展程序”，选择解压后的扩展目录（或仓库中的 `extension/`）。
3. 打开 TabShare 设置，填写 `https://你的域名` 和配对令牌，勾选自动连接并保存。

### 3. 创建分享

点击扩展图标，选择 **共享当前标签页**，或输入网址并选择 **创建可复用的网址分享**，将生成的链接发给可信的人。访客直接打开链接即可操作，无需安装扩展。

共享页面铺满访客窗口，设置收在 **共享设置** 悬浮按钮中。源端和访客端的按钮都可拖拽。访客使用浏览器原生前进、后退控制共享页面，源网址同步到 hash。首次配对后，网址分享支持自动连接与恢复；源电脑和 Chrome 需要保持运行。

只想在本机试用？参阅 [从源码运行](docs/development.md#从源码运行)，无需域名或 Docker。

## 分享方式

| 方式 | 行为 |
| --- | --- |
| 当前标签页 | 共享指定标签页，关闭后停止；浏览器重启后需要重新分享 |
| 可复用网址 | 保留分享链接，优先复用会话原标签页，关闭后在下次访问时复用匹配网址或新开页面 |

所有访客操作同一个真实页面，多人同时输入会互相影响。可以在扩展中选择 **停止并撤销链接** 收回访问权。

## 工作原理

原网站的 JavaScript 和登录状态保留在源浏览器，扩展同步 DOM 差异、资源及必要的视频画面，并执行访客的输入。WebRTC 优先直接连接两端；网络不允许时使用内置 TURN，中继仍保持 WebRTC 端到端加密；WebRTC 不可用时使用应急传输。

实现和性能预算见 [架构与同步机制](docs/architecture.md)。

## 安全与限制

完整分享链接包含控制权限，只应交给可信的人；配对令牌只用于连接自己的扩展。Chrome 的调试提示保持可见。

项目仍在开发中。复杂区域可使用局部视频补偿，不保证所有网站逐像素一致。目前不提供音频、麦克风、录制或系统桌面控制。详见 [安全、兼容性与限制](docs/compatibility.md)。

## 开发与贡献

欢迎通过 [Issues](https://github.com/qinyongliang/tabShare/issues) 提交问题或建议，通过 Pull Request 改进项目。

- [开发与构建](docs/development.md)：源码启动、测试、目录结构和 tag 自动构建。
- [真实网站检查](docs/development.md#真实网站检查)：GitHub、YouTube、Wikipedia 的实测入口、截图与网络要求。
- [贡献指南](CONTRIBUTING.md)：问题反馈、提交要求和验证方式。
- [设计参考](docs/reference.md)：参考工具与技术选择。

## 许可证

本仓库目前尚未声明开源许可证。
