// GET  /api/admin/orders[?only=pending&limit=50]        列表 + 概览
// GET  /api/admin/orders?id=<id>                         单张详情（含时间线）
// POST /api/admin/orders?id=<id>&action=cooking|retry|served|delete   { reply }
//
// 审核动作会同步给她发邮件：cooking → 美食准备中 / retry → 再唱一首 / served → 上菜。
// retry 会立刻删掉这一轮的录音（省存储；她重唱时会传新的）。

import { json, preflight, ensureSchema, verifyAdmin, cfg, logEvent, deleteOrderMedia, gcMaybe, fmtTime, getOwnerEmail } from '../_lib.js';
import { notifyGuest } from '../_notify.js';

export async function onRequestOptions() {
  return preflight('GET, POST, OPTIONS');
}

function safeJson(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function shape(o, media) {
  return {
    id: o.id,
    code: o.code,
    guestName: o.guest_name || '',
    guestEmail: o.guest_email || '',
    dishes: safeJson(o.dishes),
    wish: o.wish || '',
    serveAt: o.serve_at || '',
    status: o.status,
    reply: o.reply || '',
    rounds: Number(o.rounds || 1),
    created: Number(o.created),
    updated: Number(o.updated || 0),
    decidedAt: Number(o.decided_at || 0),
    purgeAt: Number(o.purge_at || 0),
    purged: !!Number(o.purged),
    song: (media || []).find((m) => m.kind === 'song') || null,
    photos: (media || []).filter((m) => m.kind === 'photo'),
  };
}

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  if (!(await verifyAdmin(request, env))) return json({ ok: false, error: '未登录' }, 401);

  const url = new URL(request.url);
  const q = await ensureSchema(env);
  const gc = gcMaybe(env, q);
  if (ctx.waitUntil) ctx.waitUntil(gc);
  else gc.catch(() => {});

  const one = String(url.searchParams.get('id') || '').trim();
  if (one) {
    if (!/^[A-Za-z0-9_-]+$/.test(one)) return json({ ok: false, error: 'id 非法' }, 400);
    const o = await q.first('SELECT * FROM dinner_orders WHERE id = ?', [one]);
    if (!o) return json({ ok: false, error: '找不到' }, 404);
    const media = await q.all('SELECT id, kind, mime, bytes, round FROM dinner_media WHERE order_id = ? ORDER BY kind, created', [one]);
    const events = await q.all('SELECT type, detail, created FROM dinner_events WHERE order_id = ? ORDER BY id', [one]);
    return json({
      ok: true,
      order: shape(o, media.map(normMedia)),
      timeline: events.map((e) => ({ type: e.type, detail: e.detail, created: Number(e.created) })),
    });
  }

  const only = String(url.searchParams.get('only') || '').trim();
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  const where = only === 'pending' ? "WHERE status = 'pending'" : only === 'open' ? "WHERE status IN ('pending','cooking','retry')" : '';
  const rows = await q.all(`SELECT * FROM dinner_orders ${where} ORDER BY created DESC LIMIT ?`, [limit]);

  let mediaByOrder = {};
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    const ms = await q.all(`SELECT id, order_id, kind, mime, bytes, round FROM dinner_media WHERE order_id IN (${ph}) ORDER BY kind, created`, ids);
    for (const m of ms) {
      if (!mediaByOrder[m.order_id]) mediaByOrder[m.order_id] = [];
      mediaByOrder[m.order_id].push(normMedia(m));
    }
  }

  const stat = await q.all('SELECT status, COUNT(*) AS n FROM dinner_orders GROUP BY status');
  const size = await q.first('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM dinner_media');
  const lastGc = await q.first('SELECT v FROM dinner_meta WHERE k = ?', ['last_gc']);
  const c = cfg(env);

  return json({
    ok: true,
    list: rows.map((o) => shape(o, mediaByOrder[o.id] || [])),
    stats: {
      byStatus: stat.reduce((a, x) => {
        a[x.status] = Number(x.n);
        return a;
      }, {}),
      mediaRows: Number((size && size.n) || 0),
      mediaBytes: Number((size && size.b) || 0),
      lastGc: lastGc ? Number(lastGc.v) || 0 : 0,
      lastGcText: lastGc && Number(lastGc.v) ? fmtTime(Number(lastGc.v), c.tzOffset) : '',
      retentionDays: c.retentionDays,
      orderRetentionDays: c.orderRetentionDays,
      storage: env.MEDIA ? 'R2' : 'D1',
      mailReady: !!String(env.RESEND_API_KEY || '').trim(),
      ownerEmail: await getOwnerEmail(env, q),
    },
  });
}

function normMedia(m) {
  return { id: m.id, kind: m.kind, mime: m.mime, bytes: Number(m.bytes), round: Number(m.round) };
}

const ACTIONS = { cooking: 'cooking', retry: 'retry', served: 'served' };

export async function onRequestPost({ request, env }) {
  if (!(await verifyAdmin(request, env))) return json({ ok: false, error: '未登录' }, 401);

  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim();
  const action = String(url.searchParams.get('action') || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ ok: false, error: 'id 非法' }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    /* reply 可为空 */
  }
  const reply = String(body.reply || '').trim().slice(0, 300);

  const q = await ensureSchema(env);
  const o = await q.first('SELECT * FROM dinner_orders WHERE id = ?', [id]);
  if (!o) return json({ ok: false, error: '找不到这张单' }, 404);
  const now = Date.now();

  if (action === 'delete') {
    await deleteOrderMedia(env, q, id);
    await q.run('DELETE FROM dinner_events WHERE order_id = ?', [id]);
    await q.run('DELETE FROM dinner_orders WHERE id = ?', [id]);
    return json({ ok: true, deleted: true });
  }

  const next = ACTIONS[action];
  if (!next) return json({ ok: false, error: '未知操作' }, 400);

  await q.run('UPDATE dinner_orders SET status = ?, reply = ?, decided_at = ?, updated = ? WHERE id = ?', [next, reply, now, now, id]);

  // 不满意 → 立刻释放这一轮录音的存储
  let songDeleted = 0;
  if (next === 'retry') {
    const olds = await q.all("SELECT id, r2_key FROM dinner_media WHERE order_id = ? AND kind = 'song'", [id]);
    for (const m of olds) {
      if (m.r2_key && env.MEDIA) {
        try {
          await env.MEDIA.delete(m.r2_key);
        } catch (e) {
          /* ignore */
        }
      }
      await q.run('DELETE FROM dinner_media WHERE id = ?', [m.id]);
      songDeleted++;
    }
  }

  await logEvent(q, id, next, reply || '');

  const fresh = await q.first('SELECT * FROM dinner_orders WHERE id = ?', [id]);
  const mail = await notifyGuest(env, q, fresh, safeJson(fresh.dishes), next === 'cooking' ? 'cooking' : next === 'retry' ? 'retry' : 'served');

  return json({ ok: true, status: next, songDeleted, mail: mail.ok ? 'sent' : mail.error });
}
