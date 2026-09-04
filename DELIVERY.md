# Dinner for You · 情侣点餐 & 语音互动系统（白牌交付说明）

> 纯前端 + Cloudflare Pages + D1 + Resend，**零服务器**，可完全白牌（换品牌 / 换菜单 / 换域名都不用改代码）。

**EN · TL;DR** A "dinner for two" page where she picks the dishes, drops reference photos, and records a ≤60s song. The chef gets a deep-link email; one tap plays her song, looks at the photo, and chooses *cook / resing / served*. **A printable thermal-style water-slip (外卖小票) shows up on her side after submit, and on the chef side per order — both print to 80mm thermal paper.** 100% Cloudflare Pages + D1 + Resend, no server, fully white-label.

## 这是什么
她输入邀请码（白名单）→ 选菜、传参考图、录一首歌（≤60s）→ 你（厨师）收到一封带**一键进后台深链**的邮件 → 听歌、看参考图 → 点「开火 / 再唱一首 / 上菜」→ 她收到对应邮件。防骚扰四层：邀请码门禁 + 邮箱绑定 + 限流 + 蜜罐。

## 〇、亮点（先看这一段）
- **水单 / 外卖小票**：她提交后立刻看到一张可打印小票（点"打印水单"走系统打印 → 80mm 热敏纸直接出纸）。**厨师后台每张单也有一张同款可打印小票**，紧挨着"开火/再唱一首/上菜"按钮。两联齐了，跟真外卖点单撕单一样。
- **手机友好菜单**：默认 3 类 9 道（硬菜慢炖 / 家常快手 / 汤&甜点），按"她手机随手点"的颗粒度组织；想扩菜直接改 `MENU_JSON` 环境变量，零改码。
- **完全白牌**：品牌 / 菜单 / 邀请码白名单 / 站长通知邮箱，**全部在后台或环境变量改**，不动一行代码。
- **零服务器**：纯 Cloudflare Pages + D1 + Resend。个人低频使用月度 ≈ 0 元（免费档够用）。
- **隐私安全**：录音 / 参考图默认 3 天自动清理（订单元数据留 30 天）；邀请码首次绑定邮箱、IP+码+日三维限流、蜜罐 + 最短填写时长。

## 一、先体验（演示账号，随时可试）
- 买家/体验入口：`https://rcj-dinner-demo.pages.dev/?k=cwz6udbgrd`
- 厨师后台：`https://rcj-dinner-demo.pages.dev/admin`
- 后台密码：`bo7lOeYgyyx3RUB6`
- 体验邀请码：`cwz6udbgrd`

**体验流程**：用上面的入口进入 → 填邮箱、选菜、录歌 → 提交；厨师在后台「订单」里能听歌、看图，点 **开火** 后，她会收到「美食准备中」邮件（提交后厨师也会立即收到带深链的提醒邮件）。每张订单旁还有一张可打印水单（点"打印水单"→ 80mm 热敏纸出纸）。

## 二、买下后自己跑起来，只需准备两件事
不用懂代码，只要有两个外部服务账号：

### ① 把你的域名托管到 Cloudflare（用来挂自定义域名）
1. 在 Cloudflare 添加你的域名（例如 `yourdomain.xyz`），按提示把域名的 DNS / NS 改成 Cloudflare 的。
2. 部署好 Pages 后，进 Cloudflare Pages 项目 → **Custom domains** 加上你的域名，按提示补一条 CNAME 记录即可。

### ② 申请 Resend 并绑定发信域名（用来发邮件通知）
1. 去 [resend.com](https://resend.com) 注册，拿到 API Key（形如 `re_xxx`）。
2. Resend → **Domains** 添加你的发信域名（建议就用 ① 里的域名），按提示在 Cloudflare 该域名的 DNS 里加上 **SPF / DKIM** 两条记录，点 **Verify** 变绿即可。
3. 把 API Key 填到部署环境变量 `RESEND_API_KEY`。

> 不想绑自己域名也行：Resend 验证后默认发件人 `noreply@你的域名` 就能直接发。
> **站长收通知的邮箱**还能在后台「工具 → 通知邮箱（站长）」里随时改，不用碰环境变量。

## 三、部署方式（二选一）
- **自己部署**：有代码后 `npm run deploy`（= `wrangler pages deploy . --project-name 你的项目名`）；首次建表 `wrangler d1 execute 你的库 --remote --file=./schema.sql`。
- **卖方代部署**：提供 Cloudflare + Resend 的写入权限即可，由卖方完成上面的步骤。

## 四、可白牌自定义（全部不改代码）
| 想改什么 | 怎么做 |
|----------|--------|
| 品牌名 / 标语 / 称呼 | 环境变量 `BRAND_JSON` 或后台 |
| 菜单 | 环境变量 `MENU_JSON` 或后台 |
| 站长通知邮箱 | 后台「工具 → 通知邮箱（站长）」直接填 |
| 邀请码白名单 | 后台「邀请码」管理（一码一人、可设次数/过期） |
| 水单 / 外卖小票 | 内置功能，无需配置；提交后她这边出单、后台每张单也出单，均支持 80mm 热敏打印 |

---
*演示账号为公开测试用，正式交付请部署到你自己的 Cloudflare + Resend 账户。*
