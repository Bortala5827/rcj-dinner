// GET /api/config?k=<邀请码>
// 门禁接口：邀请码有效才返回菜单与配置；无效只返回一句话，不泄露任何内部信息。
// 前端不硬编码任何邀请码，菜单也只从这里拿 —— 单一数据源，便于白牌化。

import { json, preflight, ensureSchema, checkInvite, INVITE_ERRORS, cfg, gcMaybe } from './_lib.js';
import { brand, menu } from './_config.js';

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const code = String(url.searchParams.get('k') || '').trim();
  const b = brand(env);
  const door = { name: b.name, nameZh: b.nameZh, footer: b.footer };

  if (!code) return json({ ok: false, gate: 'nokey', brand: door });

  let q;
  try {
    q = await ensureSchema(env);
  } catch (e) {
    return json({ ok: false, error: '数据库未就绪：' + e.message }, 500);
  }

  // 顺手做一次自动清理（不阻塞响应）
  const gc = gcMaybe(env, q);
  if (ctx.waitUntil) ctx.waitUntil(gc);
  else gc.catch(() => {});

  const chk = await checkInvite(q, code);
  if (!chk.ok) return json({ ok: false, gate: chk.error, msg: INVITE_ERRORS[chk.error] || '进不来', brand: door });

  const inv = chk.invite;
  const c = cfg(env);

  // 她进行中的单子（用于页面直接展示状态 / 重唱入口）
  const orders = await q.all(
    `SELECT id, status, dishes, wish, serve_at, reply, rounds, created, updated
       FROM dinner_orders WHERE code = ? ORDER BY created DESC LIMIT 5`,
    [code]
  );

  return json({
    ok: true,
    brand: { ...b, guest: inv.label || b.guest },
    menu: menu(env),
    invite: {
      label: inv.label || '',
      email: inv.email || '',
      emailLocked: !!(inv.email && Number(inv.lock_email)),
    },
    limits: {
      maxPhotos: c.maxPhotos,
      maxPhotoBytes: c.maxPhotoBytes,
      maxSongBytes: c.maxSongBytes,
      songRequired: String(env.SONG_REQUIRED || '1') === '1',
      retentionDays: c.retentionDays,
    },
    orders: orders.map((o) => ({
      id: o.id,
      status: o.status,
      dishes: safeJson(o.dishes),
      wish: o.wish,
      serveAt: o.serve_at,
      reply: o.reply,
      rounds: Number(o.rounds),
      created: Number(o.created),
      updated: Number(o.updated),
    })),
  });
}

function safeJson(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}
