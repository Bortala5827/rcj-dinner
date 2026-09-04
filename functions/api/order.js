// POST /api/order        提交点餐（需有效邀请码）
// POST /api/order        { resubmit: "<orderId>", song: {...} }  → 被要求「再唱一首」后重新提交
//
// 白名单 = 邀请码（invite code）。没有有效 code 的请求一律 403，且不返回任何细节。
// 反骚扰四层：邀请码门禁 → 邮箱绑定（首次提交锁定）→ 频率限流（按 code + 按 IP）→ 蜜罐 + 最短填写时长。

import {
  json, preflight, ensureSchema, checkInvite, INVITE_ERRORS, cfg, newId,
  putMedia, deleteOrderMedia, logEvent, gcMaybe,
} from './_lib.js';
import { menuIndex } from './_config.js';
import { notifyOwner, notifyGuest } from './_notify.js';

const DAY = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestOptions() {
  return preflight();
}

function b64Bytes(s) {
  const str = String(s || '');
  const pure = str.indexOf(',') >= 0 ? str.slice(str.indexOf(',') + 1) : str;
  return Math.floor((pure.length * 3) / 4);
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: '数据格式不对' }, 400);
  }

  const code = String(body.k || '').trim();
  const ip = String(request.headers.get('CF-Connecting-IP') || '0.0.0.0');
  const c = cfg(env);
  const now = Date.now();

  // 蜜罐：真人看不到这个字段，填了就是机器人
  if (String(body.hp || '').trim()) return json({ ok: false, error: '提交失败' }, 400);
  // 最短填写时长：2 秒内提交完整张表 = 脚本
  if (Number(body.elapsed) >= 0 && Number(body.elapsed) < 2000) return json({ ok: false, error: '慢一点，再看看菜单' }, 400);

  let q;
  try {
    q = await ensureSchema(env);
  } catch (e) {
    return json({ ok: false, error: '数据库未就绪：' + e.message }, 500);
  }

  const chk = await checkInvite(q, code, { now });
  if (!chk.ok) return json({ ok: false, error: INVITE_ERRORS[chk.error] || '进不来' }, 403);
  const inv = chk.invite;

  const gc = gcMaybe(env, q);
  if (ctx.waitUntil) ctx.waitUntil(gc);
  else gc.catch(() => {});

  /* ───────── 分支 A：重唱（菜不用重点，只换录音） ───────── */
  const resubmitId = String(body.resubmit || '').trim();
  if (resubmitId) {
    if (!/^[A-Za-z0-9_-]+$/.test(resubmitId)) return json({ ok: false, error: '单号不对' }, 400);
    const o = await q.first('SELECT * FROM dinner_orders WHERE id = ? AND code = ?', [resubmitId, code]);
    if (!o) return json({ ok: false, error: '找不到这张单' }, 404);
    if (o.status !== 'retry') return json({ ok: false, error: '这张单现在不需要重唱' }, 409);
    if (Number(o.purged)) return json({ ok: false, error: '这张单太久了，重新点一次吧' }, 409);

    const song = body.song || {};
    if (!song.data) return json({ ok: false, error: '没收到录音' }, 400);
    if (b64Bytes(song.data) > c.maxSongBytes) return json({ ok: false, error: `录音太大（上限 ${Math.round(c.maxSongBytes / 1024)}KB）` }, 400);

    // 删掉上一轮录音（省存储），只保留最新一首
    const olds = await q.all("SELECT id, r2_key FROM dinner_media WHERE order_id = ? AND kind = 'song'", [resubmitId]);
    for (const m of olds) {
      if (m.r2_key && env.MEDIA) {
        try {
          await env.MEDIA.delete(m.r2_key);
        } catch (e) {
          /* ignore */
        }
      }
      await q.run('DELETE FROM dinner_media WHERE id = ?', [m.id]);
    }

    const rounds = Number(o.rounds) + 1;
    await putMedia(env, q, { orderId: resubmitId, kind: 'song', mime: song.mime || 'audio/webm', b64: song.data, round: rounds });
    await q.run("UPDATE dinner_orders SET status = 'pending', rounds = ?, reply = '', updated = ?, purge_at = ? WHERE id = ?", [
      rounds, now, now + c.retentionDays * DAY, resubmitId,
    ]);
    await logEvent(q, resubmitId, 'resang', `第 ${rounds} 首`);

    const fresh = await q.first('SELECT * FROM dinner_orders WHERE id = ?', [resubmitId]);
    await notifyOwner(env, q, fresh, safeJson(fresh.dishes), { resang: true, hasSong: true });
    return json({ ok: true, id: resubmitId, rounds, msg: '又唱了一首，等他听' });
  }

  /* ───────── 分支 B：新点单 ───────── */

  // 邮箱：邀请码已绑定 → 强制用绑定的那个；未绑定 → 校验后写回并锁定
  let email = String(body.email || '').trim().slice(0, 120);
  if (inv.email) {
    email = inv.email;
  } else {
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: '邮箱填对一下，结果要发给你' }, 400);
  }

  const name = String(body.name || inv.label || '').trim().slice(0, 40);
  const wish = String(body.wish || '').trim().slice(0, 300);
  const serveAt = String(body.serveAt || '').trim().slice(0, 40);

  // 菜品：只认菜单里存在的 id，名字在下单时快照下来（之后改菜单不影响历史单）
  const idx = menuIndex(env);
  const rawDishes = Array.isArray(body.dishes) ? body.dishes.slice(0, 12) : [];
  const dishes = [];
  for (const d of rawDishes) {
    const it = idx.get(String(d && d.id));
    if (!it) continue;
    const qty = Math.min(9, Math.max(1, Math.floor(Number(d.qty) || 1)));
    dishes.push({ id: it.id, name: it.name, qty, note: String(d.note || '').trim().slice(0, 60), mins: Number(it.mins) || 0 });
  }
  if (!dishes.length && !wish) return json({ ok: false, error: '至少点一个菜，或者写一句想吃什么' }, 400);

  // 录音
  const song = body.song || {};
  const songRequired = String(env.SONG_REQUIRED || '1') === '1';
  if (songRequired && !song.data) return json({ ok: false, error: '还差一首歌' }, 400);
  if (song.data && b64Bytes(song.data) > c.maxSongBytes) {
    return json({ ok: false, error: `录音太大（上限 ${Math.round(c.maxSongBytes / 1024)}KB），短一点` }, 400);
  }

  // 参考图（前端已用 canvas 压过，这里只做上限兜底）
  const photos = (Array.isArray(body.photos) ? body.photos : []).slice(0, c.maxPhotos);
  for (const p of photos) {
    if (!p || !p.data) return json({ ok: false, error: '有张图片没读到' }, 400);
    if (b64Bytes(p.data) > c.maxPhotoBytes) {
      return json({ ok: false, error: `图片太大（单张上限 ${Math.round(c.maxPhotoBytes / 1024)}KB）` }, 400);
    }
  }

  // 限流
  const pend = await q.first("SELECT COUNT(*) AS n FROM dinner_orders WHERE code = ? AND status = 'pending'", [code]);
  if (Number(pend && pend.n) >= c.pendingLimit) {
    return json({ ok: false, error: `还有 ${c.pendingLimit} 张单没处理完，等等` }, 429);
  }
  const d24 = await q.first('SELECT COUNT(*) AS n FROM dinner_orders WHERE code = ? AND created > ?', [code, now - DAY]);
  if (Number(d24 && d24.n) >= c.dailyLimit) {
    return json({ ok: false, error: '今天点得够多了，明天再来' }, 429);
  }
  const ip24 = await q.first('SELECT COUNT(*) AS n FROM dinner_orders WHERE ip = ? AND created > ?', [ip, now - DAY]);
  if (Number(ip24 && ip24.n) >= c.dailyLimit * 2) {
    return json({ ok: false, error: '这个网络今天提交太多了' }, 429);
  }

  const id = newId('dn');
  await q.run(
    `INSERT INTO dinner_orders
      (id, code, guest_name, guest_email, dishes, wish, serve_at, status, reply, rounds, created, updated, purge_at, ip)
     VALUES (?,?,?,?,?,?,?,'pending','',1,?,?,?,?)`,
    [id, code, name, email, JSON.stringify(dishes), wish, serveAt, now, now, now + c.retentionDays * DAY, ip]
  );

  // 媒体入库（R2 已绑定就走 R2，否则 base64 落 D1）
  let songSaved = false;
  try {
    if (song.data) {
      await putMedia(env, q, { orderId: id, kind: 'song', mime: song.mime || 'audio/webm', b64: song.data, round: 1 });
      songSaved = true;
    }
    for (const p of photos) {
      await putMedia(env, q, { orderId: id, kind: 'photo', mime: p.mime || 'image/webp', b64: p.data, round: 1 });
    }
  } catch (e) {
    // 媒体存不进去就整单回滚，避免留下一张没歌没图的空单
    await deleteOrderMedia(env, q, id);
    await q.run('DELETE FROM dinner_orders WHERE id = ?', [id]);
    return json({ ok: false, error: '录音或图片没存上：' + e.message }, 500);
  }

  // 邀请码：计次 + 首次绑定邮箱
  await q.run('UPDATE dinner_invites SET used = used + 1 WHERE code = ?', [code]);
  if (!inv.email && Number(inv.lock_email)) {
    await q.run('UPDATE dinner_invites SET email = ? WHERE code = ?', [email, code]);
  }

  await logEvent(q, id, 'submitted', `${dishes.length} 个菜${photos.length ? ` · ${photos.length} 张图` : ''}${songSaved ? ' · 有录音' : ''}`);

  const order = await q.first('SELECT * FROM dinner_orders WHERE id = ?', [id]);
  await notifyOwner(env, q, order, dishes, { photoCount: photos.length, hasSong: songSaved });
  if (String(env.NOTIFY_GUEST_ON_SUBMIT || '1') === '1') {
    await notifyGuest(env, q, order, dishes, 'received');
  }

  return json({ ok: true, id, msg: '单子进厨房了，他会听你唱的歌' });
}

function safeJson(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}
