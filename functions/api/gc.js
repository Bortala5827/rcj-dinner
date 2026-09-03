// GET /api/gc?key=<GC_KEY>   给外部定时器调用（cron-job.org / GitHub Actions / UptimeRobot）
// GET /api/gc                 已登录后台时可直接手动触发
//
// 为什么需要它：Cloudflare **Pages** Functions 没有 cron trigger（只有 Workers 有）。
// 所以清理有两条腿：
//   1) 懒 GC —— 任何 API 请求顺手检查，最小间隔 10 分钟（零依赖，一定会跑）
//   2) 本接口 —— 站点长期没人访问时，靠外部定时器兜底
// 两者调用的是同一个 runGC，行为完全一致，不会重复删。

import { json, preflight, ensureSchema, verifyAdmin, runGC, cfg, fmtTime } from './_lib.js';

export async function onRequestOptions() {
  return preflight('GET, OPTIONS');
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = String(url.searchParams.get('key') || '');
  const expect = String(env.GC_KEY || '').trim();

  const byKey = !!expect && key === expect;
  const byAdmin = await verifyAdmin(request, env);
  if (!byKey && !byAdmin) return json({ ok: false, error: '没有权限' }, 401);

  const c = cfg(env);
  const q = await ensureSchema(env);
  const out = await runGC(env, q);

  return json({
    ok: true,
    ...out,
    retentionDays: c.retentionDays,
    orderRetentionDays: c.orderRetentionDays,
    at: fmtTime(Date.now(), c.tzOffset),
  });
}
