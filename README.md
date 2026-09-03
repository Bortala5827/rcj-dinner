# Dinner for You · 情侣点餐互动系统

> 女的点、男的做。她点想吃的、录一首歌，你（厨师）收到邮件 → 一键进后台听歌 + 审核 → 开火 / 让她再唱一首。
> 纯前端 + Cloudflare Pages Functions + D1 + Resend，**零服务器**，可整库迁移、可换皮售卖。

---

## 1. 它是怎么跑起来的

```
她打开网页
  └─ 输邀请码（白名单）── 没码进不来
       └─ 选菜 → 写「还想吃」→ 传参考图（canvas 自动压缩）
            └─ 录一段歌（≤60s）
                 └─ 留邮箱 → 提交
                       │
                       ├─ Resend 邮件 → 你：新订单 + 一键深链进后台
                       └─ Resend 邮件 → 她：回执「单子进厨房了」
       
你在后台 /admin
  ├─ 听歌 + 看参考图
  ├─ 「开火」   → 她收到邮件「美食准备中」
  ├─ 「再唱一首」→ 她收到邮件「再来一首」（原单保留，只换歌，省存储）
  └─ 「上菜」   → 她收到邮件「上菜了」

存储 & 清理
  ├─ 媒体（录音/图）默认保留 3 天 → 自动删二进制，订单元数据留着
  ├─ 订单元数据默认保留 30 天 → 整单清掉
  └─ 任何 API 访问顺手懒清理 + /api/gc 给外部定时器兜底
```

核心是**邀请码 = 白名单**：一码一人、首次提交自动绑邮箱、可设次数 / 过期。比邮箱白名单更防骚扰（陌生人拿不到码就进不来，且每个码可单独作废）。

---

## 2. 部署（5 分钟）

环境要求：Node 18+，已登录 `wrangler`（本地 `wrangler login` 或 CI 里 `CLOUDFLARE_API_TOKEN`）。

```bash
# 1. 进目录
cd rcj-dinner

# 2. 本地预览（可选）
npm run dev                      # http://localhost:8788

# 3. 设密钥（敏感信息走 secret，不进仓库 / 不入 git）
wrangler pages secret put ADMIN_PASSWORD
wrangler pages secret put RESEND_API_KEY
wrangler pages secret put OWNER_EMAIL
wrangler pages secret put SITE_URL          # 例如 https://dinner.你的域名.xyz
wrangler pages secret put GC_KEY            # 随便一段长随机串，外部定时器用它调 /api/gc

# 4. 建表（首次）
wrangler d1 execute rcj-analytics-d1 --remote --file=./schema.sql
#    交付给别人时改成对方自己的库（见 §5）

# 5. 发布
npm run deploy                    # = wrangler pages deploy . --project-name rcj-dinner
```

> `wrangler.toml` 里 `[vars]` 的非敏感项（保留天数、时区等）直接可改；敏感项一律走 `secret put`，已明文写在 README 里的是 **缺省值**，不会泄漏真实凭证。

**嫌一条条敲太烦？本机一条命令搞定**（需本地装了 `wrangler` 且已登录；沙箱里没有 wrangler，不能远程跑）：

```bash
bash scripts/deploy.sh
# 已 export 的环境变量会直接写入；否则逐个交互询问。
```

---

## 3. 环境变量 / 密钥清单

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ADMIN_PASSWORD` | ✅ secret | — | 后台 `/admin` 登录密码 |
| `RESEND_API_KEY` | ✅ secret | — | Resend 邮件（双向提醒） |
| `OWNER_EMAIL` | ✅ secret | — | 新订单邮件发到这 |
| `SITE_URL` | ✅ secret | `https://dinner.955827.xyz` | 用于拼邮件深链，改成你的域名 |
| `GC_KEY` | ✅ secret | — | 外部定时器调 `/api/gc?key=` 用 |
| `MAIL_FROM` | 可选 | `Dinner <noreply@955827.xyz>` | 发件人 |
| `BRAND_JSON` | 可选 | 见 `_config.js` | **换皮**：`{"name":"...","tagline":"...","chef":"...","guest":"..."}` |
| `MENU_JSON` | 可选 | 见 `_config.js` | **换菜单**：`[{"cat":"主菜","items":[{"id":"x","name":"红烧肉","mins":70}]}]` |
| `RETENTION_DAYS` | 可选 | `3` | 媒体保留天数 |
| `ORDER_RETENTION_DAYS` | 可选 | `30` | 订单元数据保留天数 |
| `TZ_OFFSET` | 可选 | `8` | 邮件时间显示时区 |
| `MAX_PHOTOS` | 可选 | `3` | 单次最多参考图 |
| `MAX_PHOTO_BYTES` | 可选 | `307200` | 单图上限（约 300KB，压缩后） |
| `MAX_SONG_BYTES` | 可选 | `2097152` | 单段录音上限（约 2MB） |
| `DAILY_LIMIT` | 可选 | `5` | 每邀请码每天最多提交 |
| `PENDING_LIMIT` | 可选 | `3` | 每邀请码最多进行中单数 |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | 可选 | — | 站长收单 Telegram 通知（与邮件并存） |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` / `D1_DATABASE_ID` | 仅 REST 兜底 | — | 没绑 DB binding 时用，正常绑定后不用 |

完整可复制模板见 `.env.example`（注意：secret 不写进 `.env` 文件随仓库走，这里只列名字与缺省值，便于交付时对照）。

---

## 4. 换皮 / 白牌化（作为产品售卖的关键）

**不用改一行代码**，二选一：

- **方案 A（推荐）**：部署后在 Cloudflare Pages 后台 `Settings → Environment variables` 设 `BRAND_JSON` / `MENU_JSON`，站点名、标语、菜单全变。
- **方案 B**：直接改 `functions/api/_config.js` 里的 `DEFAULT_BRAND` / `DEFAULT_MENU`（适合打包成固定主题卖给不同客户）。

四层防骚扰（开箱即有）：
1. 邀请码门禁（没码进不来）
2. 邮箱绑定（首次提交自动绑，之后该码只认这个邮箱）
3. 频率限流（按 邀请码 / IP / 天 + 进行中单数）
4. 蜜罐字段 + 最短填写时长（挡机器人）

---

## 5. 迁移 / 交付给买家

**整库搬家（数据 + 媒体）**：
```
GET /api/admin/export?format=json&scope=all&media=1   # 含 base64 媒体，可回灌
```
新站建好后把这份 JSON 回灌进 D1 即可，零外部依赖。

**换 Cloudflare 账户 / 换库**：
1. 新账户里 `wrangler d1 create dinner-d1` → 拿到 `database_id`
2. 改 `wrangler.toml`：把 `database_id` 和 `database_name` 换成新的
3. `wrangler d1 execute <新库> --remote --file=./schema.sql`
4. 重新 `wrangler pages secret put` 一遍密钥
5. （可选）绑定 R2：取消 `wrangler.toml` 里 `[[r2_buckets]]` 注释，媒体自动改存 R2，D1 只留元数据，**代码零改动**

**换域名**：改 `SITE_URL` 这一个变量即可（影响邮件深链）。

---

## 6. 目录结构

```
rcj-dinner/
├─ wrangler.toml              # 部署配置（交付改 name + d1_databases 两处）
├─ package.json               # dev / deploy / check / db:init
├─ schema.sql                 # 5 张表，全部 dinner_ 前缀隔离
├─ index.html + assets/       # 点餐端（门禁→菜单→参考图→录音→提交→进度）
├─ admin.html + assets/admin.js  # 厨师后台（审核 / 邀请码 / 导出 / 清理）
├─ functions/api/
│  ├─ _lib.js                 # 共享层：CORS/HMAC/D1双通道/媒体/GC/邀请码
│  ├─ _config.js              # 品牌/菜单/邮件模板（换皮只改这）
│  ├─ _notify.js              # 双向邮件（notifyOwner / notifyGuest）
│  ├─ config.js               # GET /api/config?k=邀请码（门禁 + 拉菜单）
│  ├─ order.js                # POST /api/order（新点单 / 重唱）
│  ├─ order/status.js         # GET 进度
│  ├─ order/media/[id].js     # GET 媒体二进制
│  ├─ admin/login.js          # 登录 / 登录态
│  ├─ admin/orders.js         # 列表 / 审核动作
│  ├─ admin/invites.js        # 邀请码管理
│  ├─ admin/export.js         # JSON / CSV 导出
│  └─ gc.js                   # 外部定时器触发清理
└─ scripts/check-syntax.mjs   # 提交前语法门禁：node scripts/check-syntax.mjs
```

---

## 7. 提交前自检

```bash
npm run check     # 校验 functions + 前端 JS + 内联脚本，防跨行引号等污染
```
所有 SQL 均走预编译参数；媒体存储双通道（R2 优先、D1 兜底）。
