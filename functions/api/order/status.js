// GET /api/order/status?k=<邀请码>&id=<单号>
// 她自己查进度：状态 + 时间线 + 媒体清单（只给 id，取内容走 /api/order/media/<id>）
//
// ⚠️ Pages Functions 按文件路径路由：functions/api/order.js 匹配不到 /api/order/status，
//    必须像这样单独建文件，否则请求会回退到静态首页（返回 200 + HTML）。

import { json, preflight, ensureSchema, checkInvite, INVITE_ERRORS } from '../_lib.js';

export async function onRequestOptions() {
  return preflight();
}

const LABEL = {
  pending: '等他听歌',
  cooking: '美食准备中',
  served: '已上菜',
  retry: '他想再听一首',
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = String(url.searchParams.get('k') || '').trim();
  const id = String(url.searchParams.get('id') || '').trim();

  let q;
  try {
    q = await ensureSchema(env);
  } catch (e) {
    return json({ ok: false, error: '数据库未就绪' }, 500);
  }

  const chk = await checkInvite(q, code);
  if (!chk.ok) return json({ ok: false, error: INVITE_ERRORS[chk.error] || '进不来' }, 403);

  if (!id) {
    // 不传单号 → 返回她最近的单子列表
    const rows = await q.all(
      'SELECT id, status, dishes, wish, serve_at, reply, rounds, created, updated, purged FROM dinner_orders WHERE code = ? ORDER BY created DESC LIMIT 10',
      [code]
    );
    return json({ ok: true, list: rows.map(shape) });
  }

  if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ ok: false, error: '单号不对' }, 400);
  const o = await q.first('SELECT * FROM dinner_orders WHERE id = ? AND code = ?', [id, code]);
  if (!o) return json({ ok: false, error: '找不到这张单' }, 404);

  const media = await q.all('SELECT id, kind, mime, bytes, round FROM dinner_media WHERE order_id = ? ORDER BY kind, created', [id]);
  const events = await q.all('SELECT type, detail, created FROM dinner_events WHERE order_id = ? ORDER BY id', [id]);

  return json({
    ok: true,
    order: shape(o),
    media: media.map((m) => ({ id: m.id, kind: m.kind, mime: m.mime, bytes: Number(m.bytes), round: Number(m.round) })),
    // 邮件相关的审计日志不给她看，只给动作时间线
    timeline: events
      .filter((e) => e.type !== 'mail')
      .map((e) => ({ type: e.type, detail: e.detail, created: Number(e.created) })),
  });
}

function shape(o) {
  let dishes = [];
  try {
    const v = JSON.parse(o.dishes || '[]');
    if (Array.isArray(v)) dishes = v;
  } catch (e) {
    /* 坏数据不让接口挂 */
  }
  return {
    id: o.id,
    status: o.status,
    statusText: LABEL[o.status] || o.status,
    dishes,
    wish: o.wish || '',
    serveAt: o.serve_at || '',
    reply: o.reply || '',
    rounds: Number(o.rounds || 1),
    created: Number(o.created),
    updated: Number(o.updated || 0),
    purged: !!Number(o.purged),
  };
}
