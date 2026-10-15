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
CHROMIUM_PATH=/usr/bin/chromium npm run test:transport
```

`CHROMIUM_PATH` 指向本机 Chrome/Chromium 可执行文件。字体资源测试默认使用 Linux DejaVuSans.ttf，可通过 `TEST_FONT_PATH` 指定其他已安装的 TTF。`test:optimizations` 覆盖字体筛选、CSS 单独增删和资源定向刷新；两套完整浏览器测试分别覆盖应急传输，以及同一 Go 进程提供的 TURN/WebRTC 链路。

浏览器测试用 Chrome API 适配器运行原始 worker 主体，连接真实 CDP 和访客页面，运行原始 offscreen 模块及 RTCPeerConnection。它验证控制、同步、视频编解码和中继，不覆盖实际扩展安装、权限提示或 MV3 生命周期。这些需要在允许加载开发者扩展的 Chrome 中人工检查。现有云环境的验证记录见 [validation.md](validation.md)。

`test:optimizations` 还用真实 Canvas MediaStreamTrack 检查原生来源的裁剪像素、整页轨道切换、后台限帧和资源释放；它不验证 tabCapture 授权。`test:transport` 分别建立 1、5、10 名访客的实际 TURN/TCP 连接，共享区域视频，持续发送 DOM 差异和输入，并检查受限 TCP 通道中的资源传输、其他访客响应、重连和队列释放。默认持续 30 秒，可用 `TEST_SOAK_SECONDS=120` 或更长时间运行（最多 86400 秒）；这是受控传输回归，不代表公网容量承诺。

### 真实网站检查

```sh
CHROMIUM_PATH=/usr/bin/chromium npm run test:sites
# 也可以只检查一个站点
CHROMIUM_PATH=/usr/bin/chromium TEST_SITES=github npm run test:sites
```

该命令访问实时 GitHub Issues、Go 文档、YouTube 和 Wikipedia，用两名真实访客检查 WebRTC、页面显示、搜索输入/提交、滚动和地址导航。YouTube 还检查公开视频播放进度；不会录音或共享音频。测试使用与受控集成相同的原始 worker、CDP 和内置 TURN/TCP，仍不覆盖实际扩展安装和授权。渲染报告明确记录 `dom` 或 `whole-page-video`，视频降级通过不能作为复杂网站的原生 DOM 兼容性结论。

结果写入 `test-results/real-sites/results.json`，源页、访客完整界面与共享区域截图保存在同目录。报告含失败资源的主机名、检查结果、DOM 原始消息字节和五秒 WebRTC 接收统计；DOM 字节不包含视频或协议流量，ICE 统计也不等于运营商计费流量。使用全新浏览器配置，只访问公开页面；报告不包含分享密钥或 Cookie。

需要源浏览器能够访问网站、脚本、图片和字体域名。受限云网络需先在环境设置保存并发布允许域名；HTTPS 代理环境使用现有 `HTTPS_PROXY`，保留证书校验。Chromium 的现有 NSS 证书数据库也需要可写，否则会在初始化时拒绝证书库；不要关闭 TLS 校验处理此问题。网站同意页、反爬验证和网络失败都可能阻止检查。网络阻断标为 `blocked` 或 `partial-network-blocked`，交互或内容断言失败标为 `failed`；任何一项未通过均返回非零。网站结构会变化，因此该检查按需运行，不作为 tag 构建的固定门槛。当前实测范围及网络缺口见 [验证记录](validation.md#052-真实网站检查)。

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

推送任意 tag 到 GitHub 时，`.github/workflows/tag-build.yml` 自动运行 Go race 测试、`go vet` 、扩展控制器测试及真实浏览器协议集成测试。通过后构建 Linux、macOS、Windows 的 amd64/arm64 服务端，以及 Chrome 插件 ZIP。版本标签（如 `v0.5.2`、`v0.6.0-rc.1`）构建成功后，`Publish GitHub Release` 自动将七个包和合并后的 `SHA256SUMS.txt` 发布到 [Releases](https://github.com/qinyongliang/tabShare/releases)，预发布标签标记为 prerelease。Actions 的原始 Artifacts 另保留 30 天。构建工作流也支持手动运行。

例如，在准备发布的主分支提交上创建并推送标签：

```sh
git tag v0.6.1
git push origin v0.6.1
```

本地创建标签不会触发 GitHub 构建，必须将标签推送到远端。发布只接受对应标签提交上的成功构建，七个构建产物必须齐全且未过期，上传前逐一核对 SHA-256。发布流程通过 `GITHUB_TOKEN` 获得本仓库的 Actions 读取和 Release 写入权限，无需配置额外令牌。

已有标签需要补发时，在 Actions 中手动运行 `Publish GitHub Release`，填写标签；留空则使用扩展当前版本。安装或更新发布流程时，也会自动检查并补发当前版本。补发直接使用已成功构建的文件，不移动已有标签。若 Artifacts 已过期，先在该标签上重新运行 `Build tagged version`。下载位置是 Releases，GitHub Packages 主要用于容器等包格式。
