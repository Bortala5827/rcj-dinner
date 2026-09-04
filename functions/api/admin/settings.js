// GET  /api/admin/settings  → 当前设置（站长通知邮箱、会话天数、邮件就绪、站点）
// POST /api/admin/settings  { ownerEmail }  → 保存站长通知邮箱（落 D1，覆盖 OWNER_EMAIL 环境变量兜底）
import { json, preflight, ensureSchema, verifyAdmin, cfg, getOwnerEmail } from '../_lib.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestOptions() {
  return preflight('GET, POST, OPTIONS');
}

export async function onRequestGet({ request, env }) {
  if (!(await verifyAdmin(request, env))) return json({ ok: false, error: '未登录' }, 401);
  const q = await ensureSchema(env);
  const c = cfg(env);
  return json({
    ok: true,
    ownerEmail: await getOwnerEmail(env, q),
    adminSessionDays: c.adminSessionDays,
    mailReady: !!String(env.RESEND_API_KEY || '').trim(),
    site: c.site,
  });
}

export async function onRequestPost({ request, env }) {
  if (!(await verifyAdmin(request, env))) return json({ ok: false, error: '未登录' }, 401);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.ownerEmail || '').trim();
  if (email && !EMAIL_RE.test(email)) return json({ ok: false, error: '邮箱格式不对' }, 400);
  const q = await ensureSchema(env);
  await q.run("INSERT OR REPLACE INTO dinner_meta (k, v) VALUES ('owner_email', ?)", [email]);
  return json({ ok: true, ownerEmail: email });
}
