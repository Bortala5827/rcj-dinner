-- rcj-dinner · D1 schema
-- 所有表以 dinner_ 前缀隔离，可与现有 orders / sing_requests 同库共存。
-- 应用启动时也会自动建表（functions/api/_lib.js → ensureSchema），
-- 本文件用于「一键初始化 / 迁移到新库」：
--   wrangler d1 execute <db-name> --remote --file=./schema.sql

-- ── 邀请码 = 白名单。没有有效 code 的人看不到任何点餐界面与接口。
CREATE TABLE IF NOT EXISTS dinner_invites (
  code       TEXT PRIMARY KEY,          -- 邀请码，出现在链接里 /?k=<code>
  label      TEXT NOT NULL DEFAULT '',  -- 备注：给谁的（也会显示在她的页面上）
  email      TEXT NOT NULL DEFAULT '',  -- 绑定邮箱：首次提交后自动锁定，之后只认这个邮箱
  lock_email INTEGER NOT NULL DEFAULT 1,-- 1=首次使用后锁邮箱
  max_uses   INTEGER NOT NULL DEFAULT 0,-- 0 = 不限次
  used       INTEGER NOT NULL DEFAULT 0,
  expires    INTEGER NOT NULL DEFAULT 0,-- 0 = 永久；否则毫秒时间戳
  active     INTEGER NOT NULL DEFAULT 1,
  created    INTEGER NOT NULL
);

-- ── 点餐单（不含媒体二进制，保证列表查询轻量）
CREATE TABLE IF NOT EXISTS dinner_orders (
  id         TEXT PRIMARY KEY,          -- dn_xxxxx
  code       TEXT NOT NULL,             -- 来自哪个邀请码
  guest_name TEXT NOT NULL DEFAULT '',
  guest_email TEXT NOT NULL,
  dishes     TEXT NOT NULL DEFAULT '[]',-- JSON: [{id,name,qty,note}]
  wish       TEXT NOT NULL DEFAULT '',  -- 「还想吃点别的」自由输入
  serve_at   TEXT NOT NULL DEFAULT '',  -- 期望时间（文本，避免时区坑）
  status     TEXT NOT NULL DEFAULT 'pending', -- pending|cooking|served|retry
  reply      TEXT NOT NULL DEFAULT '',  -- 厨师留言（会进邮件）
  rounds     INTEGER NOT NULL DEFAULT 1,-- 唱了第几轮（retry 后 +1）
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL DEFAULT 0,
  decided_at INTEGER NOT NULL DEFAULT 0,
  purge_at   INTEGER NOT NULL,          -- 媒体到点自动清理（created + RETENTION_DAYS）
  purged     INTEGER NOT NULL DEFAULT 0,-- 1 = 媒体已清
  ip         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_dinner_orders_status  ON dinner_orders(status, created DESC);
CREATE INDEX IF NOT EXISTS idx_dinner_orders_code    ON dinner_orders(code, created DESC);
CREATE INDEX IF NOT EXISTS idx_dinner_orders_purge   ON dinner_orders(purged, purge_at);

-- ── 媒体：录音 + 参考图。r2_key 非空 = 存在 R2，否则 data 里是 base64。
-- 拆表的意义：3 天到点只删这张表，订单元数据与时间线仍可留档 / 导出。
CREATE TABLE IF NOT EXISTS dinner_media (
  id       TEXT PRIMARY KEY,            -- md_xxxxx
  order_id TEXT NOT NULL,
  kind     TEXT NOT NULL,               -- song | photo
  mime     TEXT NOT NULL DEFAULT '',
  bytes    INTEGER NOT NULL DEFAULT 0,
  round    INTEGER NOT NULL DEFAULT 1,  -- 第几轮录的歌
  r2_key   TEXT NOT NULL DEFAULT '',
  data     TEXT NOT NULL DEFAULT '',    -- base64（D1 模式）
  created  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dinner_media_order ON dinner_media(order_id, kind);

-- ── 时间线：她能看到进度，也是邮件发送的审计日志
CREATE TABLE IF NOT EXISTS dinner_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  type     TEXT NOT NULL,               -- submitted|resang|cooking|retry|served|mail|purge
  detail   TEXT NOT NULL DEFAULT '',
  created  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dinner_events_order ON dinner_events(order_id, id);

-- ── 内部元数据（懒 GC 的上次执行时间等）
CREATE TABLE IF NOT EXISTS dinner_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT ''
);
