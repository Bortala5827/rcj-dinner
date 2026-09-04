/* rcj-dinner · 热敏打印机（米色小巧设备 + 水单从出口缓缓滚出）渲染
   纯前端：传入订单数据，返回 thermal-receipt 风格 HTML。
   由 order.js（访客端）/ admin.js（后台）调用，不依赖任何全局函数。

   视觉：上方一台米色圆润小打印机（带品牌标签、指示灯、出纸口），
   水单从底部出口缓缓吐出来——每一行淡入并从上往下滑入位置，
   底部有闪烁打印头，打完补一条锯齿撕口。点"重新出纸"可重播。
   仅做屏幕效果，不做打印/导出 PDF（与手机端观感一致）。 */

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

  // 打印机机身上的品牌标签（取自 brand 配置）
  function brandName(data) {
    var br = (data && data.brand) || {};
    return br.nameZh || br.name || '今晚吃什么';
  }

  // 一行：左标签 / 右值，两端对齐（小票常见的点阵排布）
  function line(left, right) {
    return '<div class="r-line"><span class="r-l">' + esc(left) + '</span>' +
      '<span class="r-r">' + esc(right || '') + '</span></div>';
  }

  // 把订单拆成"逐行"数组——每行就是热敏纸从上到下吐出的一笔
  function buildLines(data) {
    data = data || {};
    var br = data.brand || {};
    var shop = br.nameZh || br.name || '今晚吃什么';
    var dishes = data.dishes || [];
    var totalMin = 0;
    dishes.forEach(function (d) { totalMin += (Number(d.mins) || 0) * (Number(d.qty) || 1); });

    var L = [];
    L.push('<div class="r-head"><div class="r-star">★ ' + esc(shop) + ' ★</div>' +
           '<div class="r-sub">— 私人订制水单 —</div></div>');
    L.push('<div class="r-sep"></div>');
    L.push(line('单号', data.orderId || '——'));
    L.push(line('时间', data.created ? fmt(data.created) : ''));
    if (data.guestName) L.push(line('称呼', esc(data.guestName)));

    L.push('<div class="r-sep"></div>');
    if (dishes.length) {
      dishes.forEach(function (d, i) {
        var head = (i + 1) + '. ' + d.name + (Number(d.qty) > 1 ? ' ×' + d.qty : '');
        var right = Number(d.mins) ? d.mins + 'min' : '';
        L.push('<div class="r-item">' + line(head, right) +
               (d.note ? '<div class="r-note">↳ ' + esc(d.note) + '</div>' : '') + '</div>');
      });
    } else {
      L.push('<div class="r-note">（只写了想吃的）</div>');
    }

    var extra = '';
    if (data.wish) extra += line('想吃的', '') + '<div class="r-note">' + esc(data.wish) + '</div>';
    if (data.serveAt) extra += line('希望', esc(data.serveAt));
    extra += line('录歌', data.hasSong ? ('已录 ' + (Number(data.rounds) || 1) + ' 首') : '这单没录');
    if (extra) { L.push('<div class="r-sep"></div>'); L.push('<div class="r-extra">' + extra + '</div>'); }

    L.push('<div class="r-sep"></div>');
    L.push(line('本单估时', totalMin ? ('约 ' + totalMin + ' 分钟') : '—'));
    L.push('<div class="r-foot"><div>' + esc(br.footer || '这是一间只有两个人的厨房') + '</div>' +
           '<div class="r-thanks">— 谢谢惠顾，等他开火 —</div></div>');
    return L;
  }

  // 静态整张（兜底用）：结构与动画版一致，只是不播动画
  function render(data) {
    return '<div class="printer">' +
      '<div class="printer-body">' +
        '<span class="printer-vent"></span>' +
        '<span class="printer-led"></span>' +
        '<span class="printer-label">' + esc(brandName(data)) + '</span>' +
        '<span class="printer-mouth"></span>' +
      '</div>' +
      '<div class="paper">' + buildLines(data).join('') + '<div class="cut"></div></div>' +
    '</div>';
  }

  // 把一行 HTML 变成真实节点（template 解析，避免 innerHTML 累积转义问题）
  function toNode(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function makeCut() {
    var c = document.createElement('div');
    c.className = 'cut';
    return c;
  }

  function mount(slot, data, opts) {
    if (!slot) return;
    opts = opts || {};
    var animate = opts.animate !== false;
    var lines = buildLines(data);

    slot.innerHTML =
      '<div class="printer">' +
        '<div class="printer-body">' +
          '<span class="printer-vent"></span>' +
          '<span class="printer-led"></span>' +
          '<span class="printer-label">' + esc(brandName(data)) + '</span>' +
          '<span class="printer-mouth"></span>' +
        '</div>' +
        '<div class="paper" id="paperSlot"></div>' +
      '</div>' +
      '<div class="r-tools">' +
        '<button type="button" class="btn ghost sm r-replay">重新出纸</button>' +
      '</div>';
    slot.classList.remove('hide');

    var paper = slot.querySelector('#paperSlot');

    function play() {
      paper.innerHTML = '';
      var cursor = document.createElement('div');
      cursor.className = 'r-cursor';
      paper.appendChild(cursor);
      var i = 0;
      (function step() {
        if (i >= lines.length) {
          if (cursor.parentNode) cursor.parentNode.removeChild(cursor);
          paper.appendChild(makeCut());
          return;
        }
        var html = lines[i];
        var pause = (html.indexOf('r-sep') !== -1) ? 260 : 180; // 缓缓吐纸，分隔线多停一下，更真
        var node = toNode(html);
        node.classList.add('r-fresh'); // 刚“打印”出来的那笔，给个淡淡的暖光一闪
        paper.insertBefore(node, cursor);
        var printed = node;
        setTimeout(function () { if (printed.parentNode) printed.classList.remove('r-fresh'); }, 420);
        i++;
        setTimeout(step, pause);
      })();
    }

    if (!animate) {
      paper.innerHTML = lines.join('');
      paper.appendChild(makeCut());
    } else {
      play();
    }

    var replay = slot.querySelector('.r-replay');
    if (replay) replay.addEventListener('click', function () { play(); });
  }

  window.DinnerReceipt = { render: render, mount: mount, buildLines: buildLines };
})();
