// rcj-dinner · 双向通知
// 一侧：她提交 / 重唱 → 邮件 + TG 给厨师（我），带一键进后台的深链
// 另一侧：我审核 → 邮件给她（美食准备中 / 再唱一首 / 上菜）
//
// 所有发送都写 dinner_events 审计，失败不阻断主流程（点单永远成功）。

import { cfg, fmtTime, sendMail, sendTG, logEvent, getOwnerEmail } from './_lib.js';
import { brand } from './_config.js';
import { mailOwnerNew, mailGuestReceived, mailGuestCooking, mailGuestRetry, mailGuestServed } from './_config.js';

export async function notifyOwner(env, q, order, dishes, { resang = false, photoCount = 0, hasSong = false } = {}) {
  const c = cfg(env);
  const ownerEmail = await getOwnerEmail(env, q);
  const b = brand(env);
  const when = fmtTime(Date.now(), c.tzOffset);
  const site = c.site;
  const results = [];

  if (ownerEmail) {
    const m = mailOwnerNew({ b, order, dishes, when, site, photoCount, hasSong, resang });
    const r = await sendMail(env, { to: ownerEmail, subject: m.subject, html: m.html, replyTo: order.guest_email });
    results.push('mail:' + (r.ok ? 'ok' : r.error));
  } else {
    results.push('mail:skip(未配置通知邮箱)');
  }

  const tg = await sendTG(
    env,
    `【${b.nameZh}】${resang ? '又唱了一首' : '有新点单'}\n${when}\n` +
      `${order.guest_name || order.guest_email}\n` +
      `点了：${(dishes || []).map((d) => d.name).join('、') || '（只写了想吃的）'}\n` +
      `${order.wish ? '还想吃：' + order.wish + '\n' : ''}` +
      `进后台：${site}/admin?focus=${order.id}`
  );
  if (tg.ok) results.push('tg:ok');

  await logEvent(q, order.id, 'mail', '通知厨师 → ' + results.join(' / '));
  return results;
}

export async function notifyGuest(env, q, order, dishes, kind) {
  const c = cfg(env);
  const ownerEmail = await getOwnerEmail(env, q);
  const b = brand(env);
  const when = fmtTime(Date.now(), c.tzOffset);
  const statusUrl = `${c.site}/?k=${encodeURIComponent(order.code)}&order=${encodeURIComponent(order.id)}`;
  if (!order.guest_email) return { ok: false, error: '无收件人' };

  let m = null;
  if (kind === 'received') m = mailGuestReceived({ b, order, dishes, when, statusUrl });
  else if (kind === 'cooking') m = mailGuestCooking({ b, order, dishes, when, statusUrl });
  else if (kind === 'retry') m = mailGuestRetry({ b, order, when, retryUrl: statusUrl });
  else if (kind === 'served') m = mailGuestServed({ b, order, dishes, when });
  if (!m) return { ok: false, error: '未知邮件类型' };

  const r = await sendMail(env, { to: order.guest_email, subject: m.subject, html: m.html, replyTo: ownerEmail || undefined });
  await logEvent(q, order.id, 'mail', `通知她(${kind}) → ` + (r.ok ? 'ok' : r.error));
  return r;
}
