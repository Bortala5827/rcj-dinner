// POST /api/admin/login   { password }        → 下发签名 Cookie（7 天）
// POST /api/admin/login   { logout: true }    → 清 Cookie
// GET  /api/admin/login                        → 查询当前登录状态
//
// 密码只存在 Cloudflare Secret（ADMIN_PASSWORD），永不下发到浏览器；
// Cookie 里只有「时间戳 + HMAC 签名」。同 IP 10 分钟内失败 8 次即锁。

import { json, preflight, hmac, verifyAdmin, ensureSchema, cfg, COOKIE } from '../_lib.js';

const FAIL_WINDOW = 10 * 60 * 1000;
const FAIL_MAX = 8;

export async function onRequestOptions() {
  return preflight('GET, POST, OPTIONS');
}

export async function onRequestGet({ request, env }) {
  return json({ ok: true, authed: await verifyAdmin(request, env), configured: !!String(env.ADMIN_PASSWORD || '').trim() });
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    /* 允许空 body（登出） */
  }

  const secure = new URL(request.url).protocol === 'https:';
  const base = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  if (body.logout) {
    return json({ ok: true, authed: false }, 200, { 'Set-Cookie': `${COOKIE}=; ${base}; Max-Age=0` });
  }

  const pw = String(env.ADMIN_PASSWORD || '').trim();
  if (!pw) return json({ ok: false, error: '后台未配置密码：wrangler pages secret put ADMIN_PASSWORD' }, 500);

  const q = await ensureSchema(env).catch(() => null);
  const ip = String(request.headers.get('CF-Connecting-IP') || '0.0.0.0');
  const key = 'login_fail:' + ip;
  const now = Date.now();

  if (q) {
    const row = await q.first('SELECT v FROM dinner_meta WHERE k = ?', [key]).catch(() => null);
    if (row && row.v) {
      const [n, start] = String(row.v).split(':').map(Number);
      if (now - (start || 0) < FAIL_WINDOW && (n || 0) >= FAIL_MAX) {
        return json({ ok: false, error: '试太多次了，十分钟后再来' }, 429);
      }
    }
  }

  const input = String(body.password || '');
  if (input !== pw) {
    if (q) {
      const row = await q.first('SELECT v FROM dinner_meta WHERE k = ?', [key]).catch(() => null);
      let n = 0;
      let start = now;
      if (row && row.v) {
        const parts = String(row.v).split(':').map(Number);
        if (now - (parts[1] || 0) < FAIL_WINDOW) {
          n = parts[0] || 0;
          start = parts[1] || now;
        }
      }
      await q.run('INSERT OR REPLACE INTO dinner_meta (k, v) VALUES (?,?)', [key, `${n + 1}:${start}`]).catch(() => {});
    }
    return json({ ok: false, error: '密码不对' }, 401);
  }

  if (q) await q.run('DELETE FROM dinner_meta WHERE k = ?', [key]).catch(() => {});

  const ts = String(now);
  const sig = await hmac(ts, pw);
  const sessionDays = cfg(env).adminSessionDays || 2;
  const SESSION = sessionDays * 24 * 60 * 60;
  return json({ ok: true, authed: true }, 200, { 'Set-Cookie': `${COOKIE}=${ts}.${sig}; ${base}; Max-Age=${SESSION}` });
}
