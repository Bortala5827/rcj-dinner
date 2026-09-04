/* rcj-dinner · 水单（外卖小票风格）渲染
   纯前端：传入订单数据，返回 thermal-receipt 风格 HTML。
   由 order.js（访客端）调用，不依赖任何全局函数。
   打印：window.DinnerReceipt.print() 走系统打印对话框，
   配合 dinner.css 的 @media print 只输出这张小票（适配 80mm 热敏纸）。 */

(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmt(ts) {
    var d = new Date(ts), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 一行：左标签 / 右值，两端对齐（小票常见的点阵排布）
  function line(left, right) {
    return '<div class="r-line"><span class="r-l">' + esc(left) + '</span>' +
      '<span class="r-r">' + esc(right || '') + '</span></div>';
  }

  function render(data) {
    data = data || {};
    var br = data.brand || {};
    var shop = br.nameZh || br.name || '今晚吃什么';
    var dishes = data.dishes || [];
    var totalMin = 0;
    dishes.forEach(function (d) { totalMin += (Number(d.mins) || 0) * (Number(d.qty) || 1); });

    var rows = dishes.map(function (d, i) {
      var head = (i + 1) + '. ' + d.name + (Number(d.qty) > 1 ? ' ×' + d.qty : '');
      var right = Number(d.mins) ? d.mins + 'min' : '';
      var note = d.note ? '<div class="r-note">↳ ' + esc(d.note) + '</div>' : '';
      return '<div class="r-item">' + line(head, right) + note + '</div>';
    }).join('');

    var extra = '';
    if (data.wish) extra += line('想吃的', '') + '<div class="r-note">' + esc(data.wish) + '</div>';
    if (data.serveAt) extra += line('希望', esc(data.serveAt));
    extra += line('录歌', data.hasSong ? ('已录 ' + (Number(data.rounds) || 1) + ' 首') : '这单没录');

    return '' +
      '<div class="receipt" id="receiptPrint">' +
        '<div class="r-head">' +
          '<div class="r-star">★ ' + esc(shop) + ' ★</div>' +
          '<div class="r-sub">— 私人订制水单 —</div>' +
        '</div>' +
        '<div class="r-meta">' +
          line('单号', data.orderId || '') +
          line('时间', data.created ? fmt(data.created) : '') +
          (data.guestName ? line('称呼', esc(data.guestName)) : '') +
        '</div>' +
        '<div class="r-sep"></div>' +
        '<div class="r-items">' + (rows || '<div class="r-note">（只写了想吃的）</div>') + '</div>' +
        (extra ? '<div class="r-sep"></div><div class="r-extra">' + extra + '</div>' : '') +
        '<div class="r-sep"></div>' +
        line('本单估时', totalMin ? ('约 ' + totalMin + ' 分钟') : '—') +
        '<div class="r-foot">' +
          '<div>' + esc(br.footer || '这是一间只有两个人的厨房') + '</div>' +
          '<div class="r-thanks">— 谢谢惠顾，等他开火 —</div>' +
        '</div>' +
        '<button type="button" class="btn sm block r-print" onclick="window.DinnerReceipt.print()">打印水单</button>' +
      '</div>';
  }

  function mount(slot, data) {
    if (!slot) return;
    slot.innerHTML = render(data);
    slot.classList.remove('hide');
  }

  function print() { window.print(); }

  window.DinnerReceipt = { render: render, mount: mount, print: print };
})();
