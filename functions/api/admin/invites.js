// GET  /api/admin/invites                                邀请码列表
// POST /api/admin/invites?action=create                   { label, email, maxUses, expiresDays, lockEmail }
// POST /api/admin/invites?action=update&code=<code>       { label, email, active, maxUses, expiresDays, lockEmail }
// POST /api/admin/invites?action=reset&code=<code>        解绑邮箱 + 次数清零
// POST /api/admin/invites?action=delete&code=<code>       删除（有历史订单时需 force=1）
//
// 邀请码就是白名单本身：一码一人。
// 想扩展到多人点餐时，直接多发几个码即可，每个码的 label 就是这个人的名字。

import { json, preflight, ensureSchema, verifyAdmin, cfg } from '../_lib.js';

// 去掉容易看错的字符（0/O/1/l/I），方便手抄和口述
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const DAY = 24 * 60 * 60 * 1000;

export async function onRequestOptions() {
  return preflight('GET, POST, OPTIONS');
}

function genCode(len = 10) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export async function onRequestGet({ request, env }) {
  if (!(await verifyAdmin(request, env))) return json({ ok: false, error: '未登录' }, 401);
  const q = await ensureSchema(env);
  const rows = await q.all('SELECT * FROM dinner_invites ORDER BY created DESC LIMIT 200');
  const counts = await q.all('SELECT code, COUNT(*) AS n FROM dinner_orders GROUP BY code');
  const cmap = counts.reduce((a, x) => {
    a[x.code] = Number(x.n);
    return a;
  }, {});
  const site = cfg(env).site;
  return json({
    ok: true,
    site,
    list: rows.map((r) => ({
      code: r.code,
      label: r.label || '',
      email: r.email || '',
      lockEmail: !!Number(r.lock_email),
      maxUses: Number(r.max_uses),
      used: Number(r.used),
      expires: Number(r.expires),
      active: !!Number(r.active),
      created: Number(r.created),
      orders: cmap[r.code] || 0,
      link: `${site}/?k=${r.code}`,
    })),
  });
}

export async function onRequestPost({ request, env }) {
  if (!(await verifyAdmin(request, env))) return json({ ok: false, error: '未登录' }, 401);

  const url = new URL(request.url);
  const action = String(url.searchParams.get('action') || '').trim();
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    /* 允许空 body */
  }

  const q = await ensureSchema(env);
  const now = Date.now();
  const site = cfg(env).site;

  if (action === 'create') {
    const label = String(body.label || '').trim().slice(0, 40);
    const email = String(body.email || '').trim().slice(0, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: '邮箱格式不对' }, 400);
    const maxUses = Math.max(0, Math.floor(Number(body.maxUses) || 0));
    const days = Math.max(0, Math.floor(Number(body.expiresDays) || 0));
    const lockEmail = body.lockEmail === false ? 0 : 1;

    let code = '';
    for (let i = 0; i < 6; i++) {
      const cand = genCode(10);
      const hit = await q.first('SELECT code FROM dinner_invites WHERE code = ?', [cand]);
      if (!hit) {
        code = cand;
        break;
      }
    }
    if (!code) return json({ ok: false, error: '生成失败，再试一次' }, 500);

    await q.run(
      'INSERT INTO dinner_invites (code, label, email, lock_email, max_uses, used, expires, active, created) VALUES (?,?,?,?,?,0,?,1,?)',
      [code, label, email, lockEmail, maxUses, days ? now + days * DAY : 0, now]
    );
    return json({ ok: true, code, link: `${site}/?k=${code}` });
  }

  const code = String(url.searchParams.get('code') || '').trim();
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(code)) return json({ ok: false, error: '邀请码非法' }, 400);
  const inv = await q.first('SELECT * FROM dinner_invites WHERE code = ?', [code]);
  if (!inv) return json({ ok: false, error: '找不到这个邀请码' }, 404);

  if (action === 'update') {
    const label = body.label === undefined ? inv.label : String(body.label || '').trim().slice(0, 40);
    const email = body.email === undefined ? inv.email : String(body.email || '').trim().slice(0, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: '邮箱格式不对' }, 400);
    const active = body.active === undefined ? Number(inv.active) : body.active ? 1 : 0;
    const lockEmail = body.lockEmail === undefined ? Number(inv.lock_email) : body.lockEmail ? 1 : 0;
    const maxUses = body.maxUses === undefined ? Number(inv.max_uses) : Math.max(0, Math.floor(Number(body.maxUses) || 0));
    let expires = Number(inv.expires);
    if (body.expiresDays !== undefined) {
      const d = Math.max(0, Math.floor(Number(body.expiresDays) || 0));
      expires = d ? now + d * DAY : 0;
    }
    await q.run('UPDATE dinner_invites SET label = ?, email = ?, lock_email = ?, max_uses = ?, expires = ?, active = ? WHERE code = ?', [
      label, email, lockEmail, maxUses, expires, active, code,
    ]);
    return json({ ok: true });
  }

  if (action === 'reset') {
    await q.run("UPDATE dinner_invites SET email = '', used = 0, active = 1 WHERE code = ?", [code]);
    return json({ ok: true });
  }

  if (action === 'delete') {
    const n = await q.first('SELECT COUNT(*) AS n FROM dinner_orders WHERE code = ?', [code]);
    if (Number(n && n.n) > 0 && String(url.searchParams.get('force')) !== '1') {
      return json({ ok: false, error: `这个码下还有 ${n.n} 张单，确认要删就带 force=1（订单会保留）`, orders: Number(n.n) }, 409);
    }
    await q.run('DELETE FROM dinner_invites WHERE code = ?', [code]);
    return json({ ok: true, deleted: true });
  }

  return json({ ok: false, error: '未知操作' }, 400);
}
