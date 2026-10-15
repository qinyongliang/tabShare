# 开发与构建

[返回 README](../README.md)

## 环境

- Go 1.26+；CI 使用 Go 1.27.2。
- Chrome 118+ 用于加载扩展和人工检查。
- Node.js 22+、Chrome/Chromium 用于自动化测试。

## 从源码运行

```sh
git clone https://github.com/qinyongliang/tabShare.git
cd tabShare
go mod download
go build -o bin/tabshare ./cmd/tabshare
./bin/tabshare -listen 127.0.0.1:8080 -public-url http://localhost:8080 -data .data
```

本机开发默认不启用 TURN。扩展加载和配对步骤见 [使用指南](usage.md)。首次运行生成 `.data/admin-token`，分享信息保存在 `.data/sessions.json`，请保留此目录。

`web/` 静态资源嵌入 Go 二进制，修改后需要重新构建。修改 `extension/` 后，在 Chrome 扩展管理页面重新加载扩展。

## 测试

```sh
go test -race ./...
go vet ./...
npm ci --ignore-scripts
npm test
CHROMIUM_PATH=/usr/bin/chromium npm run test:optimizations
CHROMIUM_PATH=/usr/bin/chromium TEST_RTC=0 npm run test:e2e
CHROMIUM_PATH=/usr/bin/chromium TEST_TURN=1 npm run test:e2e
```

`CHROMIUM_PATH` 指向本机 Chrome/Chromium 可执行文件。字体资源测试默认使用 Linux DejaVuSans.ttf，可通过 `TEST_FONT_PATH` 指定其他已安装的 TTF。`test:optimizations` 覆盖字体筛选、CSS 单独增删和资源定向刷新；两套完整浏览器测试分别覆盖应急传输，以及同一 Go 进程提供的 TURN/WebRTC 链路。

浏览器测试用 Chrome API 适配器运行原始 worker 主体，连接真实 CDP 和访客页面，运行原始 offscreen 模块及 RTCPeerConnection。它验证控制、同步、视频编解码和中继，不覆盖实际扩展安装、权限提示或 MV3 生命周期。这些需要在允许加载开发者扩展的 Chrome 中人工检查。现有云环境的验证记录见 [validation.md](validation.md)。

## 目录结构

```text
cmd/tabshare/     服务入口
internal/relay/   分享、信令、鉴权、资源及 TURN
extension/       Chrome Manifest V3 扩展
web/             访客网页与 DOM 镜像
tests/           浏览器集成及 JavaScript 检查
deploy/          Docker Compose、Caddy 与环境安装脚本
docs/            使用、部署与实现文档
```

## Tag 构建

推送任意 tag 到 GitHub 时，`.github/workflows/tag-build.yml` 自动运行 Go race 测试、`go vet` 、扩展控制器测试及真实浏览器协议集成测试。通过后构建 Linux、macOS、Windows 的 amd64/arm64 服务端，以及 Chrome 插件 ZIP；产物带 SHA-256 校验文件，在对应 Actions 运行的 Artifacts 中保留 30 天。工作流也支持手动运行。

例如，在准备发布的主分支提交上创建并推送标签：

```sh
git tag v0.5.0
git push origin v0.5.0
```

本地创建标签不会触发 GitHub 构建，必须将标签推送到远端。当前工作流上传构建产物，不自动创建 GitHub Release。
