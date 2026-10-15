# 部署与配置

[返回 README](../README.md)

## 默认部署

推荐按 README 的 Docker Compose 步骤部署。日常只配置 `deploy/.env` 中的一个值：

```dotenv
TABSHARE_DOMAIN=tabs.example.com
```

将域名的 A 记录直接指向运行服务的服务器公网 IPv4，关闭该域名的 CDN/HTTP 代理。Go 自动从域名解析 TURN 地址，Caddy 申请和续期 HTTPS 证书，数据和密钥保存在 Docker 卷中。不需要另外部署 coturn，也不需要手填 TURN 账号或密码。

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

共享电脑与访客主动连接服务器，共享电脑不需要开放入站端口。

### 端口

服务器的防火墙、安全组与 NAT 需要放通下列端口。NAT 转发保持端口一一对应：

| 用途 | 端口 |
| --- | --- |
| HTTP / HTTPS | 80/TCP、443/TCP |
| STUN / TURN | 3478/UDP、3478/TCP |
| TURN 中继分配 | 49160–49359/UDP |

TURN 不是 HTTP，不能只通过 Caddy 的普通反向代理访问。需要的中继端口已在 Compose 中映射。

### 维护

以下命令均在仓库根目录执行：

```sh
# 查看日志
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=100 tabshare caddy

# 更新源码并重新构建
git pull --ff-only
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build

# 停止服务，保留数据
docker compose --env-file deploy/.env -f deploy/compose.yaml down
```

数据目录包含 `admin-token`、`sessions.json` 和 `turn-secret`，应一并安全备份。Compose 将其保存在 `sessions` 卷中；不要通过 `down -v` 删除需要保留的分享和密钥。

## 特殊网络配置

以下设置只在默认配置不适用时使用。

### 手动指定公网 IPv4

如果存在多个 A 记录、分离 DNS 或 HTTP 域名经过 CDN，在 `deploy/.env` 增加：

```dotenv
TABSHARE_TURN_PUBLIC_IP=203.0.113.10
```

这里的示例地址必须替换成运行 Go 服务的服务器公网 IPv4。显式设置后不再从域名推断地址，客户端直接连接该 IP 的 TURN 端口。HTTP 域名使用 CDN 时，还需要该服务允许并正确转发 WebSocket。

自动解析只在启动时执行；解析失败或得到多个不同 IPv4 时，服务会提示修正 DNS 或填写此覆盖值，不会随机选一个地址。服务器 IP 发生变化后需要重启服务。

### 直接运行二进制

已有 HTTPS 反向代理时，可以直接运行 Go 服务：

```sh
./bin/tabshare -listen 0.0.0.0:8080 -data .data \
  -public-url https://tabs.example.com -turn-listen 0.0.0.0:3478
```

二进制默认只监听本机 HTTP，不启用 TURN。指定 `-turn-listen` 后启用内置 TURN，并默认从 `-public-url` 解析 IPv4。

| 参数 | 默认值 / 用途 |
| --- | --- |
| `-listen` | `127.0.0.1:8080`，HTTP 监听地址 |
| `-public-url` | `http://localhost:8080`，分享链接使用的服务地址 |
| `-data` | `.data`，会话与密钥目录 |
| `-turn-listen` | 空，启用时监听同一地址的 UDP/TCP |
| `-turn-public-ip` | 自动解析 `-turn-host` 或 `-public-url` 的 IPv4 |
| `-turn-host` | 手动指定通告的 TURN 域名；自动解析时沿用解析的域名 |
| `-turn-relay-ip` | 跟随 TURN 监听地址，指定本机中继绑定地址 |
| `-turn-relay-ports` | `49160-49359`，更改时同步调整防火墙和端口映射 |
| `-stun` | 额外使用 Google STUN；设为空可仅使用内置 STUN |

`TABSHARE_TURN_LISTEN` 和 `TABSHARE_TURN_PUBLIC_IP` 分别提供相应命令行参数的默认值；命令行参数优先。

### TURN/TLS

给同一个 Go 服务追加：

```sh
-turn-host turn.example.com -turn-tls-listen 0.0.0.0:5349 \
-turn-cert /path/to/fullchain.pem -turn-key /path/to/privkey.pem
```

证书需被客户端信任且匹配 TURN 域名；每次 TLS 握手重新读取证书和私钥，支持外部续期。需要额外开放 5349/TCP，Docker 部署还需挂载证书并映射端口。默认 Caddy 的 HTTPS 443 不直接承载 TURN；只允许 443 出站的网络需要独立 IP/端口规划。

### 局域网与外部 TURN

内置 TURN 默认拒绝服务器私网、回环和云元数据等保留地址。可信局域网部署可显式添加 `-turn-allow-private-peers`。当前 TURN 分配 IPv4 UDP 中继地址，通过 TURN/UDP、TURN/TCP 或 TURN/TLS 承载。

已有外部 TURN REST 服务时，可保持内置 TURN 关闭，设置 `TABSHARE_TURN_URLS`（逗号分隔）和 `TABSHARE_TURN_SECRET`（至少 32 字符，与外部 TURN 一致）。该方式直接运行二进制即可；使用 Compose 时需自行传入这两个环境变量。

## 凭据与会话

内置 TURN 自动生成私有密钥文件，向已加入分享的两端下发有效期 24 小时的临时凭据。重连时重新签发，访客离开或撤销分享时清理分配。每个临时账户最多 8 个分配/待分配，全局最多 256 个分配，并受端口池容量限制。

配对令牌、TURN 密钥和 TLS 私钥应保存在受信任的部署环境中。`deploy/.env` 已被 Git 忽略。

## 排查连接问题

| 现象 | 检查方向 |
| --- | --- |
| HTTPS 无法访问 | 域名 A 记录、80/443 端口、Caddy 日志 |
| 启动提示无法解析 TURN 地址 | 域名是否直接解析到服务器；特殊网络使用 `TABSHARE_TURN_PUBLIC_IP` |
| 插件无法连接 | HTTPS 服务地址、配对令牌、扩展访问权限、自动连接是否开启 |
| 长期显示 WebSocket 兜底 | TURN 监听和中继端口、安全组、NAT 映射、浏览器网络限制 |
| 页面离线 | 源电脑、Chrome、扩展和自动连接是否仍在运行 |

客户端会显示当前使用的 P2P、TURN 或应急传输。回环地址的测试无法代替实际公网 DNS、防火墙和端口映射验证。
