// GET /api/order/media/<mediaId>[?k=<邀请码>]
// 取录音 / 参考图的二进制。两种身份可读：
//   1) 厨师（已登录后台的签名 Cookie）
//   2) 她本人（带自己的邀请码，且这条媒体属于她的单）
//
// ⚠️ 动态路由文件是必须的：functions/api/order.js 匹配不到 /api/order/media/<id>，
//    没有这个文件时请求会回退静态资源，<audio>/<img> 会收到首页 HTML —— 表现像「播放器坏了」。

import { json, preflight, ensureSchema, verifyAdmin, readMedia, checkInvite } from '../../_lib.js';

export async function onRequestOptions() {
  return preflight('GET, OPTIONS');
}

export async function onRequestGet({ request, env, params }) {
  const mediaId = String((params && params.id) || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(mediaId)) return json({ ok: false, error: 'id 非法' }, 400);

  let q;
  try {
    q = await ensureSchema(env);
  } catch (e) {
    return json({ ok: false, error: '数据库未就绪' }, 500);
  }

  const isAdmin = await verifyAdmin(request, env);
  let allowed = isAdmin;
  let ownerCode = '';

  if (!allowed) {
    const url = new URL(request.url);
    const code = String(url.searchParams.get('k') || '').trim();
    const chk = await checkInvite(q, code);
    if (chk.ok) {
      ownerCode = code;
      allowed = true;
    }
  }
  if (!allowed) return json({ ok: false, error: '没有权限' }, 401);

  const m = await readMedia(env, q, mediaId);
  if (!m) return json({ ok: false, error: '内容已清理或不存在' }, 404);

  // 非管理员：必须是自己那张单里的媒体
  if (!isAdmin) {
    const o = await q.first('SELECT code FROM dinner_orders WHERE id = ?', [m.orderId]);
    if (!o || o.code !== ownerCode) return json({ ok: false, error: '没有权限' }, 403);
  }

  return new Response(m.body, {
    headers: {
      'Content-Type': m.mime,
      'Cache-Control': 'private, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
