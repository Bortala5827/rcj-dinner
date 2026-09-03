// rcj-dinner · 共享工具层
// 下划线开头的文件不会被 Pages Functions 当成路由，仅作模块被 import。
//
// 提供：CORS/JSON、HMAC 登录、D1 双通道访问（binding 优先，REST 兜底）、
//       建表、base64 编解码、Resend 邮件、Telegram、懒 GC（3 天清媒体）。
//
// 设计原则（为了「可复制、可迁移、可售卖」）：
//   1. 所有 SQL 走预编译参数，绝不字符串拼接 —— 换人部署也不会被注入。
//   2. 存储双通道：绑定 R2 就用 R2，没绑定就 base64 落 D1，代码零改动。
//   3. 一切品牌/菜单/文案/保留天数都能用环境变量覆盖，白牌化不用改代码。

const DAY = 24 * 60 * 60 * 1000;
const GC_INTERVAL = 10 * 60 * 1000; // 懒 GC 最小间隔

/* ─────────────── HTTP ─────────────── */

export function cors(methods = 'GET, POST, OPTIONS') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export function json(o, status = 200, extra = {}) {
  return new Response(JSON.stringify(o), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...cors(),
      ...extra,
    },
  });
}

export function preflight(methods) {
  return new Response(null, { status: 204, headers: cors(methods) });
}

/* ─────────────── 鉴权（HMAC 签名 Cookie，与 RCJ 其他站同构） ─────────────── */

export const COOKIE = 'dinner_admin';

export async function hmac(value, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

export function getCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function verifyAdmin(request, env) {
  const pw = String(env.ADMIN_PASSWORD || '').trim();
  if (!pw) return false;
  const cookie = getCookie(request, COOKIE);
  if (!cookie) return false;
  const idx = cookie.indexOf('.');
  if (idx < 0) return false;
  const ts = cookie.slice(0, idx);
  const sig = cookie.slice(idx + 1);
  if (!/^\d+$/.test(ts)) return false;
  const days = cfg(env).adminSessionDays || 2;
  if (Date.now() - Number(ts) > days * DAY) return false;
  return (await hmac(ts, pw)) === sig;
}

/* ─────────────── 配置（全部可用环境变量覆盖） ─────────────── */

export function cfg(env) {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    retentionDays: num(env.RETENTION_DAYS, 3),
    orderRetentionDays: num(env.ORDER_RETENTION_DAYS, 30),
    tzOffset: Number.isFinite(Number(env.TZ_OFFSET)) ? Number(env.TZ_OFFSET) : 8,
    ownerEmail: String(env.OWNER_EMAIL || '').trim(),
    mailFrom: String(env.MAIL_FROM || 'Dinner <noreply@955827.xyz>').trim(),
    site: String(env.SITE_URL || 'https://dinner.955827.xyz').replace(/\/+$/, ''),
    maxPhotos: num(env.MAX_PHOTOS, 3),
    maxPhotoBytes: num(env.MAX_PHOTO_BYTES, 300 * 1024),
    maxSongBytes: num(env.MAX_SONG_BYTES, 2 * 1024 * 1024),
    dailyLimit: num(env.DAILY_LIMIT, 3),
    pendingLimit: num(env.PENDING_LIMIT, 2),
    adminSessionDays: num(env.ADMIN_SESSION_DAYS, 2),
  };
}

export function fmtTime(ts, tzOffset = 8) {
  const t = new Date(Number(ts) + tzOffset * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

export function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ─────────────── D1 访问：binding 优先，REST 兜底 ─────────────── */

export function db(env) {
  if (env.DB && typeof env.DB.prepare === 'function') {
    const stmt = (sql, params) => {
      const st = env.DB.prepare(sql);
      return params && params.length ? st.bind(...params) : st;
    };
    return {
      mode: 'binding',
      async all(sql, params = []) {
        const r = await stmt(sql, params).all();
        return (r && r.results) || [];
      },
      async first(sql, params = []) {
        return await stmt(sql, params).first();
      },
      async run(sql, params = []) {
        const r = await stmt(sql, params).run();
        return (r && r.meta) || {};
      },
    };
  }

  // REST 兜底：无 binding 时用 API Token 直调（便于在别的账户/环境快速跑通）
  const acct = String(env.CF_ACCOUNT_ID || '').trim();
  const token = String(env.CF_API_TOKEN || '').trim();
  const dbid = String(env.D1_DATABASE_ID || '').trim();
  const query = async (sql, params) => {
    if (!acct || !token || !dbid) throw new Error('D1 未配置：请绑定 DB 或提供 CF_ACCOUNT_ID / CF_API_TOKEN / D1_DATABASE_ID');
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database/${dbid}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params: params || [] }),
    });
    const j = await r.json();
    if (!j.success) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'D1_FAIL');
    return (j.result && j.result[0]) || {};
  };
  return {
    mode: 'rest',
    async all(sql, params = []) {
      const r = await query(sql, params);
      return r.results || [];
    },
    async first(sql, params = []) {
      const r = await query(sql, params);
      return (r.results && r.results[0]) || null;
    },
    async run(sql, params = []) {
      const r = await query(sql, params);
      return r.meta || {};
    },
  };
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS dinner_invites (
    code TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    lock_email INTEGER NOT NULL DEFAULT 1, max_uses INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dinner_orders (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, guest_name TEXT NOT NULL DEFAULT '',
    guest_email TEXT NOT NULL, dishes TEXT NOT NULL DEFAULT '[]', wish TEXT NOT NULL DEFAULT '',
    serve_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
    reply TEXT NOT NULL DEFAULT '', rounds INTEGER NOT NULL DEFAULT 1,
    created INTEGER NOT NULL, updated INTEGER NOT NULL DEFAULT 0, decided_at INTEGER NOT NULL DEFAULT 0,
    purge_at INTEGER NOT NULL, purged INTEGER NOT NULL DEFAULT 0, ip TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS idx_dinner_orders_status ON dinner_orders(status, created DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dinner_orders_code ON dinner_orders(code, created DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dinner_orders_purge ON dinner_orders(purged, purge_at)`,
  `CREATE TABLE IF NOT EXISTS dinner_media (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0, round INTEGER NOT NULL DEFAULT 1,
    r2_key TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_dinner_media_order ON dinner_media(order_id, kind)`,
  `CREATE TABLE IF NOT EXISTS dinner_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, type TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_dinner_events_order ON dinner_events(order_id, id)`,
  `CREATE TABLE IF NOT EXISTS dinner_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '')`,
];

export async function ensureSchema(env) {
  const q = db(env);
  for (const sql of DDL) await q.run(sql);
  return q;
}

export async function logEvent(q, orderId, type, detail = '') {
  try {
    await q.run('INSERT INTO dinner_events (order_id, type, detail, created) VALUES (?,?,?,?)', [orderId, type, String(detail).slice(0, 500), Date.now()]);
  } catch (e) {
    /* 日志失败不阻断主流程 */
  }
}

/* ─────────────── base64 ⇄ bytes ─────────────── */

export function b64ToBytes(b64) {
  const raw = String(b64 || '');
  const pure = raw.indexOf(',') >= 0 ? raw.slice(raw.indexOf(',') + 1) : raw;
  const bin = atob(pure);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function bytesToB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/* ─────────────── 媒体存取（R2 优先 → D1 兜底） ─────────────── */

export async function putMedia(env, q, { orderId, kind, mime, b64, round = 1 }) {
  const bytes = b64ToBytes(b64);
  const id = newId('md');
  const now = Date.now();
  let r2Key = '';
  let data = '';
  if (env.MEDIA && typeof env.MEDIA.put === 'function') {
    r2Key = `${orderId}/${id}`;
    await env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: mime || 'application/octet-stream' } });
  } else {
    data = bytesToB64(bytes); // 归一化：去掉 dataURL 前缀后重新编码
  }
  await q.run(
    'INSERT INTO dinner_media (id, order_id, kind, mime, bytes, round, r2_key, data, created) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, orderId, kind, mime || '', bytes.length, round, r2Key, data, now]
  );
  return { id, bytes: bytes.length, r2: !!r2Key };
}

export async function readMedia(env, q, mediaId) {
  const row = await q.first('SELECT id, order_id, kind, mime, r2_key, data FROM dinner_media WHERE id = ?', [mediaId]);
  if (!row) return null;
  if (row.r2_key) {
    if (!env.MEDIA) return null;
    const obj = await env.MEDIA.get(row.r2_key);
    if (!obj) return null;
    return { orderId: row.order_id, mime: row.mime || (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream', body: obj.body };
  }
  if (!row.data) return null;
  return { orderId: row.order_id, mime: row.mime || 'application/octet-stream', body: b64ToBytes(row.data) };
}

export async function deleteOrderMedia(env, q, orderId) {
  const rows = await q.all('SELECT id, r2_key FROM dinner_media WHERE order_id = ?', [orderId]);
  for (const r of rows) {
    if (r.r2_key && env.MEDIA) {
      try {
        await env.MEDIA.delete(r.r2_key);
      } catch (e) {
        /* R2 删除失败不阻断 */
      }
    }
  }
  await q.run('DELETE FROM dinner_media WHERE order_id = ?', [orderId]);
  return rows.length;
}

/* ─────────────── 通知：Resend 邮件 + Telegram ─────────────── */

export async function sendMail(env, { to, subject, html, replyTo }) {
  const key = String(env.RESEND_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'RESEND_API_KEY 未配置' };
  const list = (Array.isArray(to) ? to : [to]).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, error: '收件人为空' };
  const body = { from: cfg(env).mailFrom, to: list, subject, html };
  if (replyTo) body.reply_to = replyTo;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (j && j.message) || ('HTTP ' + r.status) };
    return { ok: true, id: j.id || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function sendTG(env, text) {
  const token = String(env.TG_BOT_TOKEN || '').trim();
  const chat = String(env.TG_CHAT_ID || '').trim();
  if (!token || !chat) return { ok: false, error: 'TG 未配置' };
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ─────────────── 自动清理 ─────────────── */
// Pages Functions 没有 cron trigger，所以用两条腿：
//   1) 懒 GC：任意 API 请求时顺手检查，最小间隔 10 分钟（零外部依赖，一定会跑）
//   2) /api/gc?key=<GC_KEY>：给外部定时器（cron-job.org / GitHub Actions）调
// 两者复用同一个 runGC，行为一致。

export async function runGC(env, q) {
  const c = cfg(env);
  const now = Date.now();
  const out = { mediaPurgedOrders: 0, mediaRows: 0, ordersDeleted: 0 };

  // 1) 媒体到期（默认 3 天）→ 删 R2/D1 二进制，订单元数据保留
  const expired = await q.all('SELECT id FROM dinner_orders WHERE purged = 0 AND purge_at <= ? LIMIT 200', [now]);
  for (const o of expired) {
    const n = await deleteOrderMedia(env, q, o.id);
    await q.run('UPDATE dinner_orders SET purged = 1, updated = ? WHERE id = ?', [now, o.id]);
    await logEvent(q, o.id, 'purge', `媒体已自动清理（保留 ${c.retentionDays} 天）`);
    out.mediaPurgedOrders++;
    out.mediaRows += n;
  }

  // 2) 订单元数据到期（默认 30 天）→ 整单清除
  const cutoff = now - c.orderRetentionDays * DAY;
  const old = await q.all('SELECT id FROM dinner_orders WHERE created <= ? LIMIT 200', [cutoff]);
  for (const o of old) {
    await deleteOrderMedia(env, q, o.id);
    await q.run('DELETE FROM dinner_events WHERE order_id = ?', [o.id]);
    await q.run('DELETE FROM dinner_orders WHERE id = ?', [o.id]);
    out.ordersDeleted++;
  }

  await q.run('INSERT OR REPLACE INTO dinner_meta (k, v) VALUES (?,?)', ['last_gc', String(now)]);
  return out;
}

export async function gcMaybe(env, q) {
  try {
    const row = await q.first('SELECT v FROM dinner_meta WHERE k = ?', ['last_gc']);
    const last = row ? Number(row.v) || 0 : 0;
    if (Date.now() - last < GC_INTERVAL) return null;
    return await runGC(env, q);
  } catch (e) {
    return null;
  }
}

/* ─────────────── 邀请码校验（白名单核心） ─────────────── */

export async function checkInvite(q, code, { now = Date.now() } = {}) {
  const c = String(code || '').trim();
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(c)) return { ok: false, error: 'INVALID' };
  const row = await q.first('SELECT code, label, email, lock_email, max_uses, used, expires, active FROM dinner_invites WHERE code = ?', [c]);
  if (!row) return { ok: false, error: 'INVALID' };
  if (!Number(row.active)) return { ok: false, error: 'DISABLED' };
  if (Number(row.expires) > 0 && now > Number(row.expires)) return { ok: false, error: 'EXPIRED' };
  if (Number(row.max_uses) > 0 && Number(row.used) >= Number(row.max_uses)) return { ok: false, error: 'USED_UP' };
  return { ok: true, invite: row };
}

export const INVITE_ERRORS = {
  INVALID: '这扇门不认识你',
  DISABLED: '这把钥匙已经收起来了',
  EXPIRED: '这把钥匙过期了',
  USED_UP: '这把钥匙的次数用完了',
};
