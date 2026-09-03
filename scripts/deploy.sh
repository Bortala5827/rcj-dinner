#!/usr/bin/env bash
# rcj-dinner · 一键部署（在本机 / CI 跑，不是沙箱）
# 用法：  bash scripts/deploy.sh
#   - 已设环境变量（ADMIN_PASSWORD 等）会直接写入，否则逐个交互询问
#   - 全程不改代码，只写密钥 + 建表 + 发布
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="rcj-dinner"
DB="rcj-analytics-d1"
SECRETS=(ADMIN_PASSWORD RESEND_API_KEY OWNER_EMAIL SITE_URL GC_KEY)

echo "== rcj-dinner 部署 =="
if ! command -v wrangler >/dev/null 2>&1; then
  echo "未找到 wrangler，请先安装并登录："
  echo "  npm i -g wrangler && wrangler login"
  exit 1
fi

echo "== 1/3 初始化 D1 表（dinner_ 前缀，幂等，可重复执行）=="
wrangler d1 execute "$DB" --remote --file=./schema.sql

echo "== 2/3 写入 Secrets（敏感信息，不进仓库）=="
for s in "${SECRETS[@]}"; do
  if [ -n "${!s:-}" ]; then
    printf '%s' "${!s}" | wrangler pages secret put "$s" --project-name "$PROJECT"
  else
    echo ">>> 设置 $s"
    wrangler pages secret put "$s" --project-name "$PROJECT"
  fi
done

echo "== 3/3 发布到 Cloudflare Pages =="
wrangler pages deploy . --project-name "$PROJECT"

echo ""
echo "✅ 完成。打开 \$SITE_URL/admin 登录后台，先到「邀请码」页建一个码发给对方。"
