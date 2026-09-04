/* rcj-dinner · 厨师后台
   邮件里的深链是 /admin?focus=<单号> —— 打开就自动定位并高亮那张单。
   三个动作各自触发一封给她的邮件：开火 / 再唱一首 / 上菜。

   注意：多行 HTML 一律反引号模板字符串。 */

(function () {
  'use strict';

  var state = { tab: 'orders', filter: 'open', focus: '', orders: [], stats: null, invites: [], site: '' };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function show(el, on) { if (el) el.classList[on ? 'remove' : 'add']('hide'); }
  function say(el, text, kind) {
    if (!el) return;
    if (!text) { el.className = 'hide'; el.textContent = ''; return; }
    el.className = 'msg ' + (kind || 'info');
    el.textContent = text;
  }
  function fmt(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts)), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function size(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + 'B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + 'KB';
    return (b / 1024 / 1024).toFixed(2) + 'MB';
  }
  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }

  var STATUS_TEXT = { pending: '待听歌', cooking: '做饭中', served: '已上菜', retry: '让她重唱' };
  // 收银台头：与 _config.js DEFAULT_BRAND 对齐（白牌改 BRAND_JSON / 后台未来接 brand 接口再同步）
  var BRAND = { name: 'Dinner for You', nameZh: '今晚吃什么', footer: '这是一间只有两个人的厨房' };
  var TL_TEXT = {
    submitted: '提交', resang: '重唱', cooking: '开火', retry: '打回重唱',
    served: '上菜', purge: '媒体清理', mail: '通知',
  };

  /* ─────────── 登录 ─────────── */

  async function boot() {
    var r = await api('/api/admin/login');
    if (!r.configured) {
      show($('login'), true);
      say($('loginMsg'), '还没设置后台密码：wrangler pages secret put ADMIN_PASSWORD --project-name rcj-dinner', 'err');
      return;
    }
    if (r.authed) return enter();
    show($('login'), true);
    $('btnLogin').addEventListener('click', doLogin);
    $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  }

  async function doLogin() {
    var msg = $('loginMsg');
    say(msg, '在验…', 'info');
    var r = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('pw').value }) });
    if (!r.ok) { say(msg, r.error || '登录失败', 'err'); return; }
    show($('login'), false);
    enter();
  }

  function enter() {
    show($('login'), false);
    show($('dash'), true);
    state.focus = new URL(location.href).searchParams.get('focus') || '';
    if (state.focus) state.filter = 'all';

    $('tabOrders').addEventListener('click', function () { switchTab('orders'); });
    $('tabInvites').addEventListener('click', function () { switchTab('invites'); });
    $('tabTools').addEventListener('click', function () { switchTab('tools'); });
    $('btnLogout').addEventListener('click', async function () {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ logout: true }) });
      location.reload();
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (b) {
      b.addEventListener('click', function () {
        state.filter = b.getAttribute('data-filter');
        Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        loadOrders();
      });
    });
    $('btnNewInvite').addEventListener('click', createInvite);
    $('btnGc').addEventListener('click', runGc);
    $('btnSaveOwnerEmail').addEventListener('click', saveOwnerEmail);

    loadSettings();
    loadOrders();
  }

  function switchTab(t) {
    state.tab = t;
    ['orders', 'invites', 'tools'].forEach(function (x) {
      $('tab' + x.charAt(0).toUpperCase() + x.slice(1)).classList[x === t ? 'add' : 'remove']('on');
      show($('pane' + x.charAt(0).toUpperCase() + x.slice(1)), x === t);
    });
    if (t === 'invites') loadInvites();
    if (t === 'orders') loadOrders();
  }

  /* ─────────── 订单 ─────────── */

  async function loadOrders() {
    var box = $('orderList');
    box.innerHTML = '<div class="dim tiny">读取中…</div>';
    var qs = state.filter === 'all' ? '' : '?only=' + state.filter;
    var r = await api('/api/admin/orders' + qs);
    if (!r.ok) { box.innerHTML = `<div class="msg err">${esc(r.error || '读取失败')}</div>`; return; }

    state.orders = r.list || [];
    state.stats = r.stats || {};
    renderStats();
    renderOrders();

    if (state.focus) {
      var el = $('o_' + state.focus);
      if (el) {
        el.classList.add('focus');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      state.focus = '';
    }
  }

  function renderStats() {
    var s = state.stats || {};
    var b = s.byStatus || {};
    $('stats').innerHTML = [
      ['待听歌', b.pending || 0],
      ['做饭中', b.cooking || 0],
      ['让她重唱', b.retry || 0],
      ['已上菜', b.served || 0],
      ['媒体占用', size(s.mediaBytes) + ' / ' + (s.mediaRows || 0) + ' 件'],
    ].map(function (x) {
      return `<div class="stat"><div class="v">${esc(String(x[1]))}</div><div class="k">${esc(x[0])}</div></div>`;
    }).join('');

    $('envLine').innerHTML = [
      `存储：<b>${esc(s.storage || '-')}</b>`,
      `媒体保留 <b>${Number(s.retentionDays || 0)}</b> 天 · 订单 <b>${Number(s.orderRetentionDays || 0)}</b> 天`,
      `邮件：<b>${s.mailReady ? '已接 Resend' : '未配置 RESEND_API_KEY'}</b>`,
      s.ownerEmail ? `通知到 <b>${esc(s.ownerEmail)}</b>` : '<b>未设通知邮箱，收不到提醒</b>',
      s.lastGcText ? `上次清理 ${esc(s.lastGcText)}` : '还没清理过',
    ].join(' &nbsp;·&nbsp; ');
  }

  function dishText(o) {
    var d = o.dishes || [];
    if (!d.length) return '（只写了想吃的）';
    return d.map(function (x) {
      return esc(x.name) + (Number(x.qty) > 1 ? ' ×' + Number(x.qty) : '') + (x.note ? '（' + esc(x.note) + '）' : '');
    }).join('、');
  }

  function renderOrders() {
    var box = $('orderList');
    if (!state.orders.length) {
      box.innerHTML = '<div class="card soft"><span class="dim">这里还没有单子。</span></div>';
      return;
    }
    box.innerHTML = state.orders.map(function (o) {
      var songTag = o.song
        ? `<audio controls preload="none" src="/api/order/media/${esc(o.song.id)}"></audio>
           <div class="tiny dim">第 ${Number(o.rounds)} 首 · ${esc(size(o.song.bytes))} · ${esc(o.song.mime || '')}</div>`
        : `<div class="tiny dim">${o.status === 'retry' ? '这一轮录音已删（等她重唱）' : o.purged ? '录音已按期清理' : '没有录音'}</div>`;

      var pics = (o.photos || []).length
        ? `<div class="thumbs">${o.photos.map(function (p) {
            return `<img src="/api/order/media/${esc(p.id)}" alt="参考图" data-full="/api/order/media/${esc(p.id)}">`;
          }).join('')}</div>`
        : '';

      return `<div class="card" id="o_${esc(o.id)}">
        <div class="o-head">
          <span class="tag ${esc(o.status)}">${esc(STATUS_TEXT[o.status] || o.status)}</span>
          <span class="who">${esc(o.guestName || o.guestEmail)}</span>
          <span class="id">${esc(o.id)}</span>
          <span class="when">${esc(fmt(o.created))}</span>
        </div>
        <div class="o-body">
          <div class="kv"><span class="k">点了</span><span>${dishText(o)}</span></div>
          ${o.wish ? `<div class="kv"><span class="k">还想吃</span><span>${esc(o.wish)}</span></div>` : ''}
          ${o.serveAt ? `<div class="kv"><span class="k">希望</span><span>${esc(o.serveAt)}</span></div>` : ''}
          <div class="kv"><span class="k">邮箱</span><span class="mono">${esc(o.guestEmail)}</span></div>
          ${o.reply ? `<div class="kv"><span class="k">上次留言</span><span>${esc(o.reply)}</span></div>` : ''}
        </div>
        <div style="margin-top:12px">${songTag}</div>
        ${pics}
        <div data-receipt class="admReceipt"></div>
        <div style="margin-top:14px">
          <input type="text" id="rp_${esc(o.id)}" placeholder="给她的留言（会出现在邮件里）" value="">
        </div>
        <div class="o-acts">
          <button class="btn sm" data-act="cooking" data-id="${esc(o.id)}">开火，做这些</button>
          <button class="btn warn sm" data-act="retry" data-id="${esc(o.id)}">再唱一首</button>
          <button class="btn ok sm" data-act="served" data-id="${esc(o.id)}">上菜了</button>
          <button class="btn ghost sm" data-act="delete" data-id="${esc(o.id)}">删掉</button>
          <span class="tiny dim" id="am_${esc(o.id)}"></span>
        </div>
      </div>`;
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () { act(b.getAttribute('data-id'), b.getAttribute('data-act'), b); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.thumbs img'), function (im) {
      im.addEventListener('click', function () { lightbox(im.getAttribute('data-full')); });
    });

    // 给每张单挂一张同款水单（外卖店家的撕单），点"打印水单"直接出纸
    if (window.DinnerReceipt) {
      Array.prototype.forEach.call(box.querySelectorAll('[data-receipt]'), function (slot) {
        var oid = slot.parentNode && slot.parentNode.id.replace(/^o_/, '');
        var o = state.orders.find(function (x) { return x.id === oid; });
        if (!o) return;
        DinnerReceipt.mount(slot, {
          brand: BRAND,
          orderId: o.id,
          created: o.created,
          guestName: o.guestName,
          dishes: (o.dishes || []).map(function (d) {
            return { name: d.name, qty: d.qty, note: d.note || '', mins: d.mins || 0 };
          }),
          wish: o.wish || '',
          serveAt: o.serveAt || '',
          hasSong: !!o.song,
          rounds: o.rounds || 1,
        });
      });
    }
  }

  async function act(id, action, btn) {
    var note = $('am_' + id);
    if (action === 'delete' && !confirm('整单删掉（录音、图片、时间线一起删），不可恢复。确定？')) return;
    var reply = '';
    var inp = $('rp_' + id);
    if (inp) reply = inp.value.trim();

    btn.disabled = true;
    if (note) note.textContent = '处理中…';
    var r = await api('/api/admin/orders?id=' + encodeURIComponent(id) + '&action=' + encodeURIComponent(action), {
      method: 'POST',
      body: JSON.stringify({ reply: reply }),
    });
    btn.disabled = false;
    if (!r.ok) { if (note) note.textContent = '失败：' + (r.error || ''); return; }
    if (note) note.textContent = r.deleted ? '已删除' : '已处理 · 邮件 ' + (r.mail === 'sent' ? '已发' : '失败(' + r.mail + ')');
    setTimeout(loadOrders, 700);
  }

  function lightbox(src) {
    var d = document.createElement('div');
    d.className = 'lb';
    d.innerHTML = `<img src="${esc(src)}" alt="参考图">`;
    d.addEventListener('click', function () { document.body.removeChild(d); });
    document.body.appendChild(d);
  }

  /* ─────────── 邀请码 ─────────── */

  async function loadInvites() {
    var box = $('inviteList');
    box.innerHTML = '<div class="dim tiny">读取中…</div>';
    var r = await api('/api/admin/invites');
    if (!r.ok) { box.innerHTML = `<div class="msg err">${esc(r.error || '读取失败')}</div>`; return; }
    state.invites = r.list || [];
    state.site = r.site || '';

    if (!state.invites.length) {
      box.innerHTML = '<div class="msg info">还没有邀请码。下面生成一个，把链接发给她 —— 这就是白名单。</div>';
      return;
    }

    box.innerHTML = `<table class="tb">
      <thead><tr><th>给谁</th><th>邀请码</th><th>绑定邮箱</th><th>用量</th><th>状态</th><th></th></tr></thead>
      <tbody>${state.invites.map(function (v) {
        var st = !v.active ? '已停用' : v.expires && Date.now() > v.expires ? '已过期'
          : v.maxUses && v.used >= v.maxUses ? '次数用尽' : '可用';
        return `<tr>
          <td>${esc(v.label || '—')}</td>
          <td><code>${esc(v.code)}</code></td>
          <td class="tiny">${esc(v.email || '（未绑定）')}</td>
          <td class="tiny">${Number(v.used)}${v.maxUses ? ' / ' + Number(v.maxUses) : ''} 次 · ${Number(v.orders)} 单</td>
          <td class="tiny">${esc(st)}</td>
          <td style="white-space:nowrap">
            <button class="btn ghost sm" data-iv="copy" data-code="${esc(v.code)}">复制链接</button>
            <button class="btn ghost sm" data-iv="toggle" data-code="${esc(v.code)}">${v.active ? '停用' : '启用'}</button>
            <button class="btn ghost sm" data-iv="reset" data-code="${esc(v.code)}">解绑</button>
            <button class="btn ghost sm" data-iv="del" data-code="${esc(v.code)}">删除</button>
          </td>
        </tr>`;
      }).join('')}</tbody></table>
      <div class="hide" id="ivMsg"></div>`;

    Array.prototype.forEach.call(box.querySelectorAll('[data-iv]'), function (b) {
      b.addEventListener('click', function () { inviteAct(b.getAttribute('data-code'), b.getAttribute('data-iv')); });
    });
  }

  async function inviteAct(code, what) {
    var msg = $('ivMsg');
    var v = state.invites.filter(function (x) { return x.code === code; })[0];

    if (what === 'copy') {
      var link = (v && v.link) || (state.site + '/?k=' + code);
      try {
        await navigator.clipboard.writeText(link);
        say(msg, '链接已复制：' + link, 'ok');
      } catch (e) {
        say(msg, '复制不了，手动抄：' + link, 'info');
      }
      return;
    }
    if (what === 'toggle') {
      var r = await api('/api/admin/invites?action=update&code=' + encodeURIComponent(code), {
        method: 'POST', body: JSON.stringify({ active: !(v && v.active) }),
      });
      say(msg, r.ok ? '改好了' : r.error, r.ok ? 'ok' : 'err');
      return loadInvites();
    }
    if (what === 'reset') {
      if (!confirm('解绑邮箱并把使用次数清零？（下次谁用这个码，谁的邮箱就绑上）')) return;
      var r2 = await api('/api/admin/invites?action=reset&code=' + encodeURIComponent(code), { method: 'POST', body: '{}' });
      say(msg, r2.ok ? '已解绑' : r2.error, r2.ok ? 'ok' : 'err');
      return loadInvites();
    }
    if (what === 'del') {
      if (!confirm('删掉这个邀请码？（历史订单会保留）')) return;
      var r3 = await api('/api/admin/invites?action=delete&code=' + encodeURIComponent(code), { method: 'POST', body: '{}' });
      if (!r3.ok && r3.orders) {
        if (!confirm(r3.error + '\n\n继续删除？')) return;
        r3 = await api('/api/admin/invites?action=delete&force=1&code=' + encodeURIComponent(code), { method: 'POST', body: '{}' });
      }
      say(msg, r3.ok ? '已删除' : r3.error, r3.ok ? 'ok' : 'err');
      return loadInvites();
    }
  }

  async function createInvite() {
    var msg = $('newMsg');
    say(msg, '生成中…', 'info');
    var r = await api('/api/admin/invites?action=create', {
      method: 'POST',
      body: JSON.stringify({
        label: $('ivLabel').value.trim(),
        email: $('ivEmail').value.trim(),
        maxUses: Number($('ivMax').value) || 0,
        expiresDays: Number($('ivDays').value) || 0,
        lockEmail: $('ivLock').checked,
      }),
    });
    if (!r.ok) { say(msg, r.error || '生成失败', 'err'); return; }
    say(msg, '生成好了，把这个链接发给她：' + r.link, 'ok');
    $('ivLabel').value = '';
    $('ivEmail').value = '';
    loadInvites();
  }

  /* ─────────── 维护 ─────────── */

  async function runGc() {
    var msg = $('gcMsg');
    say(msg, '清理中…', 'info');
    var r = await api('/api/gc');
    if (!r.ok) { say(msg, r.error || '失败', 'err'); return; }
    say(msg, `清了 ${r.mediaPurgedOrders} 张单的媒体（${r.mediaRows} 件），删了 ${r.ordersDeleted} 张过期单。`, 'ok');
    if (state.tab === 'orders') loadOrders();
  }

  async function loadSettings() {
    var r = await api('/api/admin/settings');
    if (!r.ok || !$('setOwnerEmail')) return;
    $('setOwnerEmail').value = r.ownerEmail || '';
  }
  async function saveOwnerEmail() {
    var msg = $('oeMsg');
    say(msg, '保存中…', 'info');
    var r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ ownerEmail: ($('setOwnerEmail').value || '').trim() }) });
    say(msg, r.ok ? '已保存' : (r.error || '失败'), r.ok ? 'ok' : 'err');
    if (r.ok && state.tab === 'orders') loadOrders();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
