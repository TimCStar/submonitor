# SubMonitor

SubMonitor 是面向 Sub2API 的 Codex OAuth 额度周期监控和自动恢复控制台。它只读取 Codex 上游额度，不调用任何 OpenAI 上游额度重置接口。

检测到 Codex OAuth 账号自然进入新额度周期后，SubMonitor 可以自动：

1. 恢复源账号的异常、限流和临时不可调度状态。
2. 重置同一 Sub2API 实例内指定目标账号的本地额度计数。
3. 重置关联订阅分组中有效用户订阅的日、周或月额度。

## 功能

- 无需登录的公开监控页；配置与审计后台单独登录
- 支持多个独立 Codex OAuth 监控任务，每个任务拥有独立 Sub2API 凭据、源账号、目标账号和订阅规则
- 后台展示订阅分组中的有效用户，邮箱和用户名在服务端脱敏后再传给浏览器
- Sub2API 风格的响应式 React 控制台和 Node.js 后台服务
- `5h`、`7d`、`primary`、`secondary` 额度窗口
- 以 `reset_at` 周期推进为主要判据
- `5% -> 0%`、`0% -> 0%` 均可识别
- 连续快照确认，避免瞬时数据误判
- SQLite 基线、事件、动作状态和审计日志
- 源账号、目标账号和订阅动作逐项记录及失败续跑
- SSE 实时状态更新
- AES-256-GCM 加密保存 Sub2API 管理凭据
- 管理员登录、HttpOnly Cookie、同源检查和登录限速
- 默认 dry-run，预览事件不会在关闭 dry-run 后补执行
- Docker Compose 部署和 GitHub Actions 验证

## 快速部署

需要 Docker 和 Docker Compose。

```bash
cp .env.example .env
```

编辑 `.env`，至少设置：

```dotenv
SUBMONITOR_ADMIN_PASSWORD=一个至少12位的管理密码
SUBMONITOR_MASTER_KEY=一个至少32位且长期保持不变的随机密钥
```

启动：

```bash
docker compose pull
docker compose up -d
```

正式部署默认直接拉取 GitHub Actions 构建的 GHCR 镜像，不在 1C1G 服务器上安装依赖或编译前端。更新版本时执行 `git pull && docker compose pull && docker compose up -d`。如果 GHCR 镜像尚未公开或服务器无法拉取，再使用 `docker compose up -d --build` 本地构建。

如果必须本地构建，国内服务器可以在 `.env` 中设置 `NPM_REGISTRY=https://registry.npmmirror.com`，构建缓存和重试参数已经写入 Dockerfile。

访问 `http://服务器地址:8787` 会直接进入公开监控页，不需要登录。配置和审计页面使用 `SUBMONITOR_ADMIN_PASSWORD` 登录后访问。

首次进入“配置”页面后，可以创建任意数量的监控任务。每个任务分别填写 Sub2API 地址、管理员 API Key 或 JWT、Codex 源账号、目标账号和订阅规则；不同任务的凭据、基线、快照、事件和调度器互相隔离。

后台安全设置位于“配置”页面顶部。管理员可以在“后台安全”中生成 TOTP 绑定密钥，将密钥或导入 URI 添加到 Google Authenticator、Microsoft Authenticator、1Password、Aegis 等身份验证器，再输入 6 位验证码启用 2FA。启用后后台登录需要管理员密码和动态验证码；停用 2FA 还需要再次输入管理员密码和当前验证码。2FA 密钥与 Sub2API 凭据一样使用 `SUBMONITOR_MASTER_KEY` 加密保存。

登录风控会记录管理员账户和来源地址的失败次数。15 分钟窗口内达到 5 次、8 次、12 次和 20 次失败时，分别封禁约 1 分钟、5 分钟、30 分钟和 24 小时；封禁状态写入 SQLite，服务重启后仍然有效。丢失身份验证器时，需要恢复原来的主密钥后通过数据库维护方式清除 `auth_2fa` 设置，再重新绑定。

公网部署应通过 HTTPS 反向代理访问，并设置：

```dotenv
SUBMONITOR_COOKIE_SECURE=true
```

## 本地开发

要求 Node.js 24 和 pnpm 11。

```bash
pnpm install
pnpm dev
```

开发模式地址：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:8787`

启动后端前需要设置：

```dotenv
SUBMONITOR_ADMIN_PASSWORD=replace-with-a-long-admin-password
SUBMONITOR_MASTER_KEY=replace-with-at-least-32-random-characters
```

生产构建：

```bash
pnpm build
pnpm start
```

## 自然重置判定

首次快照只建立基线。正常路径要求：

```text
old.reset_at + resetGraceSeconds <= now
new.reset_at > old.reset_at + resetGraceSeconds
```

默认连续确认两次。使用率、`allowed` 和 `limit_reached` 不参与正常路径判定，因此低使用量或零使用量周期仍会触发。

当新周期暂时缺少 `reset_at` 时，才使用保守回退：旧边界已过期、当前使用率不高于配置阈值且低于旧使用率。

每个事件使用以下唯一键：

```text
monitorId:sourceAccountId:window:oldResetAt
```

建议只配置一个权威窗口。同时配置 `5h` 和 `7d` 时，两个窗口各自切换都会生成事件。

## 动作顺序

正常模式下：

```text
恢复源账号
  -> 重置目标账号本地额度
  -> 发现有效订阅
  -> 重置订阅额度
```

源账号恢复失败会阻断后续动作。其他失败动作会保留在 `pending` 事件中，下次轮询只重试未成功项。

修改 Sub2API 地址、源账号或监控窗口会建立新基线，并取消旧连接下尚未完成的事件，避免旧动作在新账号或新实例上续跑。

使用的 Sub2API 管理接口：

```text
GET  /api/v1/admin/openai/accounts/:id/quota
POST /api/v1/admin/accounts/:id/recover-state
POST /api/v1/admin/accounts/:id/reset-quota
GET  /api/v1/admin/accounts/:id
GET  /api/v1/admin/groups/all
GET  /api/v1/admin/subscriptions
POST /api/v1/admin/subscriptions/:id/reset-quota
```

`reset-quota` 操作的是 Sub2API 本地计数，不会重置目标服务商的真实上游额度。

## 数据和备份

默认数据库路径：

```text
data/submonitor.sqlite
```

Docker Compose 使用 `submonitor-data` 命名卷保存数据库。可以在停止服务后导出数据：

```bash
docker compose stop
docker compose cp submonitor:/app/data ./submonitor-backup
docker compose start
```

`SUBMONITOR_MASTER_KEY` 必须随备份保留且不能改变，否则数据库中的 Sub2API 管理凭据无法解密。

如果启动后提示凭据无法解密，说明当前主密钥与保存凭据时使用的值不同。优先恢复原主密钥；原密钥已经丢失时，在后台为受影响的监控任务重新输入 Sub2API API Key 或 JWT 并保存，新凭据会使用当前主密钥重新加密。

## 测试

```bash
pnpm test
pnpm run check
```

测试覆盖低使用量和零使用量自然重置、完整动作链去重、dry-run 事件归档、多任务隔离、公开接口脱敏和连接错误诊断。

## 安全边界

- 浏览器不会收到 Sub2API 管理凭据明文或密文。
- 公开接口不会返回 Sub2API 地址、目标账号 ID、订阅分组 ID 或动作错误详情。
- SubMonitor 不提供 OpenAI 上游额度手动重置功能。
- “立即检查”会读取实时额度；如果恰好完成自然重置确认，正常模式下会执行配置的 Sub2API 自动动作。
- SQLite 部署只应运行一个 SubMonitor 实例。
- HTTP 成功后、动作状态落库前进程被强制终止时，该动作仍有极小概率重复执行，因为 Sub2API 写接口没有幂等键。

详见 [SECURITY.md](SECURITY.md)。
