// rcj-dinner · 品牌 / 菜单 / 邮件文案
// 【白牌化只改这一个文件】，或者不改代码、直接用环境变量覆盖：
//   BRAND_JSON = {"name":"...","tagline":"...","chef":"...","guest":"..."}
//   MENU_JSON  = [{"cat":"主菜","items":[{"id":"x","name":"红烧肉","mins":70}]}]

export const DEFAULT_BRAND = {
  name: 'Dinner for You',
  nameZh: '今晚吃什么',
  tagline: '点你想吃的，唱一首给我听，厨房就开火',
  chef: '厨师',
  guest: '',
  footer: '这是一间只有两个人的厨房',
};

export const DEFAULT_MENU = [
  {
    cat: '硬菜（慢炖）',
    items: [
      { id: 'hongshaorou', name: '红烧肉', desc: '小火慢炖，肥而不腻', mins: 70 },
      { id: 'niuroumian', name: '番茄牛腩', desc: '炖久一点更入味', mins: 90 },
      { id: 'qingzhengyu', name: '清蒸鱼', desc: '葱姜热油，鲜', mins: 25 },
    ],
  },
  {
    cat: '家常快手',
    items: [
      { id: 'fanqiedan', name: '西红柿炒蛋', desc: '下饭', mins: 10 },
      { id: 'tudousi', name: '酸辣土豆丝', desc: '脆口', mins: 15 },
      { id: 'danchaofan', name: '蛋炒饭', desc: '隔夜饭更香', mins: 12 },
    ],
  },
  {
    cat: '汤 & 甜点',
    items: [
      { id: 'fanqiedantang', name: '番茄蛋汤', desc: '五分钟搞定', mins: 8 },
      { id: 'shuiguoban', name: '水果拼盘', desc: '摆好看点', mins: 15 },
      { id: 'kaoniunai', name: '烤奶 / 热可可', desc: '配夜宵', mins: 10 },
    ],
  },
];

export function brand(env) {
  let b = { ...DEFAULT_BRAND };
  if (env && env.BRAND_JSON) {
    try {
      b = { ...b, ...JSON.parse(env.BRAND_JSON) };
    } catch (e) {
      /* 配置坏了就用默认值，不让站点挂掉 */
    }
  }
  return b;
}

export function menu(env) {
  if (env && env.MENU_JSON) {
    try {
      const m = JSON.parse(env.MENU_JSON);
      if (Array.isArray(m) && m.length) return m;
    } catch (e) {
      /* 同上 */
    }
  }
  return DEFAULT_MENU;
}

export function menuIndex(env) {
  const map = new Map();
  for (const g of menu(env)) {
    for (const it of g.items || []) map.set(String(it.id), it);
  }
  return map;
}

/* ─────────────── 邮件模板 ─────────────── */
// 纯内联样式，避免被邮件客户端剥掉 <style>。深色/浅色都能看清。

const WRAP_OPEN = `<div style="margin:0;padding:24px 12px;background:#f6f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7dfd5;border-radius:14px;overflow:hidden;">`;
const WRAP_CLOSE = `</div></div>`;

function head(title, sub) {
  return `<div style="padding:22px 24px 16px;border-bottom:1px solid #f0e9e0;">
    <div style="font-size:19px;font-weight:600;color:#23201c;line-height:1.4;">${title}</div>
    ${sub ? `<div style="margin-top:6px;font-size:13px;color:#8a8078;">${sub}</div>` : ''}
  </div>`;
}

function rows(pairs) {
  return `<div style="padding:8px 24px 4px;">${pairs
    .filter((p) => p && p[1])
    .map(
      (p) => `<div style="display:block;padding:9px 0;border-bottom:1px solid #f6f1ea;">
        <span style="display:inline-block;min-width:78px;font-size:12px;color:#9a9088;">${p[0]}</span>
        <span style="font-size:14px;color:#23201c;">${p[1]}</span>
      </div>`
    )
    .join('')}</div>`;
}

function button(href, text) {
  return `<div style="padding:20px 24px 24px;">
    <a href="${href}" style="display:inline-block;padding:12px 22px;background:#c2543c;color:#ffffff;text-decoration:none;border-radius:9px;font-size:14px;font-weight:600;">${text}</a>
  </div>`;
}

function note(text) {
  return `<div style="padding:0 24px 22px;font-size:13px;color:#6f675e;line-height:1.7;">${text}</div>`;
}

function foot(b) {
  return `<div style="padding:14px 24px;background:#fbf7f2;border-top:1px solid #f0e9e0;font-size:11px;color:#a89e94;">${b.footer}</div>`;
}

function dishLines(dishes) {
  if (!dishes || !dishes.length) return '';
  return dishes
    .map((d) => `${d.name}${Number(d.qty) > 1 ? ` ×${d.qty}` : ''}${d.note ? `（${d.note}）` : ''}`)
    .join('、');
}

// 1) 她提交 → 通知厨师（我），带一键深链进后台
export function mailOwnerNew({ b, order, dishes, when, site, photoCount, hasSong, resang }) {
  const title = resang ? `${order.guest_name || '她'}又唱了一首` : `${order.guest_name || '有人'}点单了`;
  return {
    subject: `【${b.nameZh}】${title}`,
    html:
      WRAP_OPEN +
      head(title, when) +
      rows([
        ['点了', dishLines(dishes) || '（只写了想吃的）'],
        ['还想吃', order.wish ? order.wish.slice(0, 200) : ''],
        ['希望时间', order.serve_at || '没写，随你'],
        ['附件', `${hasSong ? '录音 1 段' : '没录音'}${photoCount ? ` · 参考图 ${photoCount} 张` : ''}`],
        ['轮次', `第 ${order.rounds} 首`],
        ['联系', order.guest_email],
      ]) +
      button(`${site}/admin?focus=${order.id}`, '进后台听歌 + 审核') +
      note('点开就是这一单，可以听录音、看参考图，然后决定「开火」还是「再唱一首」。') +
      foot(b) +
      WRAP_CLOSE,
  };
}

// 2) 她提交 → 回执给她（带状态查询链接）
export function mailGuestReceived({ b, order, dishes, when, statusUrl }) {
  return {
    subject: `【${b.nameZh}】收到你的单了`,
    html:
      WRAP_OPEN +
      head('单子进厨房了', when) +
      rows([
        ['你点了', dishLines(dishes) || order.wish || '—'],
        ['希望时间', order.serve_at || '没写'],
        ['单号', order.id],
      ]) +
      button(statusUrl, '看看做到哪一步了') +
      note('他会听你唱的那首歌。过了就开火，不过就得再唱一首。') +
      foot(b) +
      WRAP_CLOSE,
  };
}

// 3) 审核通过 → 美食准备中
export function mailGuestCooking({ b, order, dishes, when, statusUrl }) {
  return {
    subject: `【${b.nameZh}】美食准备中`,
    html:
      WRAP_OPEN +
      head('这首歌过了，厨房开火', when) +
      rows([
        ['正在做', dishLines(dishes) || order.wish || '—'],
        ['预计', order.serve_at || '尽快'],
        ['他说', order.reply ? order.reply.slice(0, 300) : '（没留话）'],
      ]) +
      button(statusUrl, '查看进度') +
      note('别催，火候到了自然会好。') +
      foot(b) +
      WRAP_CLOSE,
  };
}

// 4) 没过 → 再唱一首
export function mailGuestRetry({ b, order, when, retryUrl }) {
  return {
    subject: `【${b.nameZh}】这首不太行，再来一首`,
    html:
      WRAP_OPEN +
      head('厨房还没开火', when) +
      rows([['他说', order.reply ? order.reply.slice(0, 300) : '（想再听一首）']]) +
      button(retryUrl, '重新唱一首') +
      note('单子还留着，菜不用重新点，只要再录一段就行。') +
      foot(b) +
      WRAP_CLOSE,
  };
}

// 5) 上菜
export function mailGuestServed({ b, order, dishes, when }) {
  return {
    subject: `【${b.nameZh}】上菜了`,
    html:
      WRAP_OPEN +
      head('好了，来吃饭', when) +
      rows([
        ['做好了', dishLines(dishes) || order.wish || '—'],
        ['他说', order.reply ? order.reply.slice(0, 300) : ''],
      ]) +
      note('趁热。') +
      foot(b) +
      WRAP_CLOSE,
  };
}
