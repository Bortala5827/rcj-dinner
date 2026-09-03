// GET /api/admin/export?format=json|csv[&scope=all|open][&media=1]
//
// 定期导出 = 数据不被 3 天清理吃掉的保险，也是「换库 / 交付给买家」的迁移通道。
//   format=json&media=1  → 完整备份（含 base64 媒体，可直接回灌）
//   format=csv           → 只有订单表，方便丢进表格看
//
// 注意：媒体存 R2 时不内联二进制（会很慢），只导出 key，用 rclone / wrangler r2 单独同步。

import { json, preflight, ensureSchema, verifyAdmin, cfg, fmtTime } from '../_lib.js';

export async function onRequestOptions() {
  return preflight('GET, OPTIONS');
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function onRequestGet({ request, env }) {
  if (!(await verifyAdmin(request, env))) return json({ ok: false, error: '未登录' }, 401);

  const url = new URL(request.url);
  const format = String(url.searchParams.get('format') || 'json').toLowerCase();
  const scope = String(url.searchParams.get('scope') || 'all').toLowerCase();
  const withMedia = String(url.searchParams.get('media') || '') === '1';
  const c = cfg(env);
  const q = await ensureSchema(env);

  const where = scope === 'open' ? "WHERE status IN ('pending','cooking','retry')" : '';
  const orders = await q.all(`SELECT * FROM dinner_orders ${where} ORDER BY created DESC LIMIT 2000`);
  const stamp = fmtTime(Date.now(), c.tzOffset).replace(/[: ]/g, '-');

  if (format === 'csv') {
    const head = ['单号', '邀请码', '姓名', '邮箱', '菜品', '还想吃', '希望时间', '状态', '厨师留言', '轮次', '下单时间', '媒体已清'];
    const lines = [head.map(csvCell).join(',')];
    for (const o of orders) {
      let dishes = [];
      try {
        dishes = JSON.parse(o.dishes || '[]');
      } catch (e) {
        dishes = [];
      }
      lines.push(
        [
          o.id, o.code, o.guest_name, o.guest_email,
          (Array.isArray(dishes) ? dishes : []).map((d) => `${d.name}${Number(d.qty) > 1 ? '×' + d.qty : ''}${d.note ? '(' + d.note + ')' : ''}`).join(' / '),
          o.wish, o.serve_at, o.status, o.reply, o.rounds,
          fmtTime(Number(o.created), c.tzOffset), Number(o.purged) ? '是' : '否',
        ]
          .map(csvCell)
          .join(',')
      );
    }
    // BOM：让 Excel 正确识别 UTF-8 中文
    return new Response('\uFEFF' + lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="dinner-orders-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const ids = orders.map((o) => o.id);
  let mediaRows = [];
  let eventRows = [];
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const cols = withMedia ? 'id, order_id, kind, mime, bytes, round, r2_key, data' : 'id, order_id, kind, mime, bytes, round, r2_key';
    mediaRows = await q.all(`SELECT ${cols} FROM dinner_media WHERE order_id IN (${ph})`, ids);
    eventRows = await q.all(`SELECT order_id, type, detail, created FROM dinner_events WHERE order_id IN (${ph}) ORDER BY id`, ids);
  }
  const invites = await q.all('SELECT * FROM dinner_invites ORDER BY created DESC LIMIT 500');

  const byOrder = (arr) =>
    arr.reduce((a, x) => {
      if (!a[x.order_id]) a[x.order_id] = [];
      a[x.order_id].push(x);
      return a;
    }, {});
  const mm = byOrder(mediaRows);
  const ee = byOrder(eventRows);

  const dump = {
    schema: 'rcj-dinner/1',
    exportedAt: Date.now(),
    exportedAtText: fmtTime(Date.now(), c.tzOffset),
    storage: env.MEDIA ? 'R2' : 'D1',
    mediaInlined: withMedia && !env.MEDIA,
    retentionDays: c.retentionDays,
    invites,
    orders: orders.map((o) => ({
      ...o,
      dishes: (() => {
        try {
          return JSON.parse(o.dishes || '[]');
        } catch (e) {
          return [];
        }
      })(),
      media: (mm[o.id] || []).map((m) => ({
        id: m.id, kind: m.kind, mime: m.mime, bytes: Number(m.bytes), round: Number(m.round),
        r2Key: m.r2_key || '',
        data: withMedia && m.data ? m.data : undefined,
      })),
      timeline: (ee[o.id] || []).map((e) => ({ type: e.type, detail: e.detail, created: Number(e.created) })),
    })),
  };

  return new Response(JSON.stringify(dump, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="dinner-backup-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
