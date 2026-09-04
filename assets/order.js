/* rcj-dinner · 点餐端
   1) 邀请码门禁：没有有效 code 什么都看不到（菜单也是从服务端拿的，前端不硬编码）
   2) 参考图一律先走 canvas 压缩再上传 —— 手机随手拍 4MB，压完约 100KB
   3) 录音用 MediaRecorder，48kbps opus，最长 60 秒
   4) 提交后可查进度；被要求「再唱一首」时只需重录，菜不用重点

   注意：所有多行 HTML 都用反引号模板字符串。单引号跨行会让整个脚本 SyntaxError。 */

(function () {
  'use strict';

  var MAX_SECONDS = 60;
  var state = {
    code: '',
    cfg: null,
    picked: {},          // id -> { qty, note }
    photos: [],          // { b64, mime, bytes, url }
    song: null,          // { b64, mime, bytes, seconds, url }
    startedAt: Date.now(),
    rec: null,
    stream: null,
    chunks: [],
    timer: null,
    seconds: 0,
    audioCtx: null,
    raf: 0,
  };

  /* ─────────── 工具 ─────────── */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function kb(n) { return (n / 1024).toFixed(0) + 'KB'; }
  function mmss(s) {
    var m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function fmt(ts) {
    var d = new Date(ts), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function show(el, on) { if (el) el.classList[on ? 'remove' : 'add']('hide'); }
  function say(el, text, kind) {
    if (!el) return;
    if (!text) { el.className = 'hide'; el.textContent = ''; return; }
    el.className = 'msg ' + (kind || 'info');
    el.textContent = text;
  }
  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {})).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
    });
  }
  function blobToB64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result); res(s.slice(s.indexOf(',') + 1)); };
      r.onerror = function () { rej(new Error('读取失败')); };
      r.readAsDataURL(blob);
    });
  }

  /* ─────────── canvas 图片压缩 ───────────
     手机拍的图动辄 3~6MB，直接传会拖垮 D1 且很慢。
     策略：长边缩到 1280 → 优先 WebP（体积比 JPEG 小 25% 左右）→
           还超标就交替「降画质 / 再缩尺寸」，最多 8 轮，一定收敛。 */

  var webpOK = (function () {
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { return false; }
  })();

  function loadBitmap(file) {
    // createImageBitmap 能顺手把手机照片的 EXIF 旋转拍平，避免横竖颠倒
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
        return createImageBitmap(file);
      }).catch(fallbackImage);
    }
    return fallbackImage();

    function fallbackImage() {
      return new Promise(function (res, rej) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); res(img); };
        img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('图片读不出来')); };
        img.src = url;
      });
    }
  }

  function drawToBlob(src, w, h, type, quality) {
    var cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    var cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    if (type === 'image/jpeg') { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, w, h); } // JPEG 不支持透明
    cx.drawImage(src, 0, 0, w, h);
    return new Promise(function (res) {
      if (cv.toBlob) cv.toBlob(function (b) { res(b); }, type, quality);
      else {
        var d = cv.toDataURL(type, quality);
        var bin = atob(d.slice(d.indexOf(',') + 1));
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        res(new Blob([arr], { type: type }));
      }
    });
  }

  async function compressImage(file, maxBytes) {
    var maxEdge = 1280;
    var bmp = await loadBitmap(file);
    var sw = bmp.width || bmp.naturalWidth;
    var sh = bmp.height || bmp.naturalHeight;
    if (!sw || !sh) throw new Error('图片尺寸读不到');

    var scale = Math.min(1, maxEdge / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * scale));
    var h = Math.max(1, Math.round(sh * scale));
    var type = webpOK ? 'image/webp' : 'image/jpeg';
    var quality = 0.82;

    var blob = await drawToBlob(bmp, w, h, type, quality);
    var guard = 0;
    while (blob.size > maxBytes && guard < 8) {
      guard++;
      if (quality > 0.46) quality = Math.max(0.4, quality - 0.12);
      else { w = Math.max(320, Math.round(w * 0.82)); h = Math.max(320, Math.round(h * 0.82)); }
      blob = await drawToBlob(bmp, w, h, type, quality);
    }
    if (bmp.close) { try { bmp.close(); } catch (e) { /* ignore */ } }
    return { blob: blob, type: type, w: w, h: h };
  }

  async function addPhotos(files) {
    var lim = state.cfg.limits;
    var msg = $('picMsg');
    var room = lim.maxPhotos - state.photos.length;
    if (room <= 0) { say(msg, '最多 ' + lim.maxPhotos + ' 张', 'err'); return; }

    var list = Array.prototype.slice.call(files).filter(function (f) { return /^image\//.test(f.type); }).slice(0, room);
    if (!list.length) { say(msg, '只能传图片', 'err'); return; }

    say(msg, '压缩中…', 'info');
    for (var i = 0; i < list.length; i++) {
      try {
        var before = list[i].size;
        var out = await compressImage(list[i], lim.maxPhotoBytes);
        if (out.blob.size > lim.maxPhotoBytes) { say(msg, '有张图实在压不下来，换一张', 'err'); continue; }
        var b64 = await blobToB64(out.blob);
        state.photos.push({
          b64: b64, mime: out.type, bytes: out.blob.size,
          url: URL.createObjectURL(out.blob),
          from: before,
        });
      } catch (e) {
        say(msg, '有张图处理失败：' + e.message, 'err');
      }
    }
    renderPhotos();
    var total = state.photos.reduce(function (a, p) { return a + p.bytes; }, 0);
    var raw = state.photos.reduce(function (a, p) { return a + (p.from || 0); }, 0);
    if (state.photos.length) {
      say(msg, '已压缩：' + kb(raw) + ' → ' + kb(total) + (webpOK ? '（WebP）' : '（JPEG）'), 'ok');
    } else say(msg, '', '');
  }

  function renderPhotos() {
    var box = $('pics');
    if (!state.photos.length) { box.innerHTML = ''; return; }
    box.innerHTML = state.photos.map(function (p, i) {
      return `<div class="pic">
        <img src="${p.url}" alt="参考图">
        <span class="kb">${kb(p.bytes)}</span>
        <button class="x" type="button" data-i="${i}" title="删掉">&times;</button>
      </div>`;
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.x'), function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-i'));
        try { URL.revokeObjectURL(state.photos[i].url); } catch (e) { /* ignore */ }
        state.photos.splice(i, 1);
        renderPhotos();
      });
    });
  }

  /* ─────────── 录音 ─────────── */

  function pickAudioMime() {
    var c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < c.length; i++) if (MediaRecorder.isTypeSupported(c[i])) return c[i];
    return '';
  }

  function stopMeter() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    if (state.audioCtx) { try { state.audioCtx.close(); } catch (e) { /* ignore */ } state.audioCtx = null; }
    var m = $('recMeter');
    if (m) m.style.width = '0%';
  }

  function startMeter(stream) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      state.audioCtx = ctx;
      var an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      var buf = new Uint8Array(an.frequencyBinCount);
      var bar = $('recMeter');
      var tick = function () {
        an.getByteFrequencyData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) sum += buf[i];
        var lv = Math.min(100, (sum / buf.length / 128) * 100 * 1.6);
        if (bar) bar.style.width = lv.toFixed(0) + '%';
        state.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { /* 音量条只是锦上添花 */ }
  }

  async function startRec() {
    var msg = $('songMsg');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say(msg, '这个浏览器不支持录音，换 Chrome 或 Safari 试试', 'err');
      return;
    }
    var mime = pickAudioMime();
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      say(msg, '拿不到麦克风权限：' + (e.name === 'NotAllowedError' ? '你拒绝了授权' : e.message), 'err');
      return;
    }

    state.chunks = [];
    state.seconds = 0;
    try {
      state.rec = new MediaRecorder(state.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    } catch (e) {
      say(msg, '录音器起不来：' + e.message, 'err');
      cleanupStream();
      return;
    }

    state.rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) state.chunks.push(ev.data); };
    state.rec.onstop = onRecStop;
    state.rec.start(250);

    $('recBox').classList.add('live');
    $('btnRec').textContent = '停止';
    show($('btnRedo'), false);
    say(msg, '在录，最长 ' + MAX_SECONDS + ' 秒', 'info');
    startMeter(state.stream);

    state.timer = setInterval(function () {
      state.seconds++;
      $('recTime').textContent = mmss(state.seconds);
      if (state.seconds >= MAX_SECONDS) stopRec();
    }, 1000);
  }

  function cleanupStream() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
      state.stream = null;
    }
    stopMeter();
  }

  function stopRec() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.rec && state.rec.state !== 'inactive') { try { state.rec.stop(); } catch (e) { /* ignore */ } }
    $('recBox').classList.remove('live');
    $('btnRec').textContent = '重新录';
    cleanupStream();
  }

  async function onRecStop() {
    var msg = $('songMsg');
    var type = (state.rec && state.rec.mimeType) || 'audio/webm';
    var blob = new Blob(state.chunks, { type: type });
    state.chunks = [];
    if (!blob.size) { say(msg, '没录到声音，再试一次', 'err'); return; }

    var lim = state.cfg.limits;
    if (blob.size > lim.maxSongBytes) {
      say(msg, '录得太长了（' + kb(blob.size) + '，上限 ' + kb(lim.maxSongBytes) + '），短一点', 'err');
      return;
    }

    var b64 = await blobToB64(blob);
    if (state.song && state.song.url) { try { URL.revokeObjectURL(state.song.url); } catch (e) { /* ignore */ } }
    state.song = { b64: b64, mime: type.split(';')[0], bytes: blob.size, seconds: state.seconds, url: URL.createObjectURL(blob) };

    var pl = $('player');
    pl.src = state.song.url;
    show(pl, true);
    show($('btnRedo'), true);
    say(msg, '录好了：' + mmss(state.seconds) + ' · ' + kb(blob.size) + '，先听一遍', 'ok');
  }

  function resetSong() {
    if (state.song && state.song.url) { try { URL.revokeObjectURL(state.song.url); } catch (e) { /* ignore */ } }
    state.song = null;
    state.seconds = 0;
    $('recTime').textContent = '0:00';
    var pl = $('player');
    pl.removeAttribute('src');
    show(pl, false);
    show($('btnRedo'), false);
    $('btnRec').textContent = '开始录';
    say($('songMsg'), '', '');
  }

  /* ─────────── 菜单 ─────────── */

  function renderMenu() {
    var box = $('menu');
    box.innerHTML = state.cfg.menu.map(function (g) {
      var items = (g.items || []).map(function (it) {
        return `<div class="dish" data-id="${esc(it.id)}">
          <div class="info">
            <div class="nm">${esc(it.name)}</div>
            ${it.desc ? `<div class="ds">${esc(it.desc)}</div>` : ''}
          </div>
          ${it.mins ? `<span class="mins">${Number(it.mins)}分</span>` : ''}
          <div class="step">
            <button type="button" data-act="minus" aria-label="少一份">-</button>
            <span class="q zero" data-q="1">0</span>
            <button type="button" data-act="plus" aria-label="多一份">+</button>
          </div>
        </div>`;
      }).join('');
      return `<div class="cat"><div class="cat-name">${esc(g.cat || '')}</div>${items}</div>`;
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.dish'), function (row) {
      var id = row.getAttribute('data-id');
      row.querySelector('[data-act="plus"]').addEventListener('click', function () { bump(id, row, 1); });
      row.querySelector('[data-act="minus"]').addEventListener('click', function () { bump(id, row, -1); });
    });
  }

  function bump(id, row, delta) {
    var cur = state.picked[id] ? state.picked[id].qty : 0;
    var next = Math.max(0, Math.min(9, cur + delta));
    if (next === 0) delete state.picked[id];
    else state.picked[id] = { qty: next, note: (state.picked[id] && state.picked[id].note) || '' };

    var q = row.querySelector('[data-q]');
    q.textContent = String(next);
    q.classList[next ? 'remove' : 'add']('zero');
    row.classList[next ? 'add' : 'remove']('on');
    updateSummary();
  }

  function updateSummary() {
    var ids = Object.keys(state.picked);
    var n = ids.reduce(function (a, k) { return a + state.picked[k].qty; }, 0);
    $('pickCount').textContent = n ? '已点 ' + n + ' 份' : '还没点';
  }

  /* ─────────── 提交 ─────────── */

  function collectDishes() {
    return Object.keys(state.picked).map(function (id) {
      return { id: id, qty: state.picked[id].qty, note: state.picked[id].note || '' };
    });
  }

  // 把当前选择 + 菜单元数据拼成小票数据（下单前用 state）
  function receiptDataFromState() {
    var idx = {};
    (state.cfg.menu || []).forEach(function (c) {
      (c.items || []).forEach(function (it) { idx[it.id] = it; });
    });
    var dishes = Object.keys(state.picked).map(function (id) {
      var it = idx[id] || { name: id };
      return { name: it.name, qty: state.picked[id].qty, note: state.picked[id].note || '', mins: it.mins || 0 };
    });
    return {
      brand: state.cfg.brand,
      orderId: '',
      created: Date.now(),
      guestName: $('gname').value.trim(),
      dishes: dishes,
      wish: $('wish').value.trim(),
      serveAt: $('serveAt').value.trim(),
      hasSong: !!state.song,
      rounds: 1,
    };
  }

  // 用已落库的单子拼小票数据（重看进度时用，名字都是下单时快照的）
  function receiptDataFromOrder(o, hasSong) {
    return {
      brand: state.cfg.brand,
      orderId: o.id,
      created: o.created,
      guestName: o.guestName || '',
      dishes: (o.dishes || []).map(function (d) {
        return { name: d.name, qty: d.qty, note: d.note || '', mins: d.mins || 0 };
      }),
      wish: o.wish || '',
      serveAt: o.serveAt || '',
      hasSong: !!hasSong,
      rounds: o.rounds || 1,
    };
  }

  async function submit() {
    var msg = $('submitMsg');
    var btn = $('btnSubmit');
    var dishes = collectDishes();
    var wish = $('wish').value.trim();
    var email = $('email').value.trim();

    if (!dishes.length && !wish) { say(msg, '至少点一个菜，或者写一句想吃什么', 'err'); return; }
    if (!state.cfg.invite.emailLocked && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      say(msg, '邮箱填一下，做好了发给你', 'err');
      return;
    }
    if (state.cfg.limits.songRequired && !state.song) { say(msg, '还差一首歌', 'err'); return; }

    btn.disabled = true;
    say(msg, '在送进厨房…', 'info');

    var payload = {
      k: state.code,
      name: $('gname').value.trim(),
      email: email,
      dishes: dishes,
      wish: wish,
      serveAt: $('serveAt').value.trim(),
      photos: state.photos.map(function (p) { return { data: p.b64, mime: p.mime }; }),
      hp: $('hp').value,
      elapsed: Date.now() - state.startedAt,
    };
    if (state.song) payload.song = { data: state.song.b64, mime: state.song.mime };

    var r = await api('/api/order', { method: 'POST', body: JSON.stringify(payload) });
    btn.disabled = false;
    if (!r.ok) { say(msg, r.error || '提交失败', 'err'); return; }

    show($('panelOrder'), false);
    show($('panelDone'), true);
    $('doneId').textContent = r.id;
    window.scrollTo(0, 0);
    if (window.DinnerReceipt) DinnerReceipt.mount($('receiptSlot'), receiptDataFromState());
    loadStatus(r.id);
  }

  /* ─────────── 状态 / 重唱 ─────────── */

  var TL_TEXT = {
    submitted: '单子提交了',
    resang: '又唱了一首',
    cooking: '厨房开火',
    retry: '他想再听一首',
    served: '上菜',
    purge: '录音和图片已按期清理',
  };

  async function loadStatus(id) {
    var r = await api('/api/order/status?k=' + encodeURIComponent(state.code) + (id ? '&id=' + encodeURIComponent(id) : ''));
    var box = $('statusBox');
    if (!r.ok) { box.innerHTML = `<div class="msg err">${esc(r.error || '查不到')}</div>`; return; }

    if (r.list) {
      if (!r.list.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<div class="sec-h"><h2>你的单子</h2></div>` + r.list.map(function (o) {
        return `<div class="card soft">
          <div class="o-head">
            <span class="tag ${esc(o.status)}">${esc(o.statusText)}</span>
            <span class="dim tiny">${esc(dishText(o))}</span>
            <span class="when">${fmt(o.created)}</span>
          </div>
        </div>`;
      }).join('');
      return;
    }

    var o = r.order;
    var songId = (r.media || []).filter(function (m) { return m.kind === 'song'; })[0];
    var pics = (r.media || []).filter(function (m) { return m.kind === 'photo'; });

    box.innerHTML = `<div class="card">
      <div class="o-head">
        <span class="tag ${esc(o.status)}">${esc(o.statusText)}</span>
        <span class="who">${esc(dishText(o))}</span>
        <span class="when">${fmt(o.created)}</span>
      </div>
      <div class="o-body">
        ${o.wish ? `<div class="kv"><span class="k">还想吃</span><span>${esc(o.wish)}</span></div>` : ''}
        ${o.serveAt ? `<div class="kv"><span class="k">希望</span><span>${esc(o.serveAt)}</span></div>` : ''}
        ${o.reply ? `<div class="kv"><span class="k">他说</span><span>${esc(o.reply)}</span></div>` : ''}
        <div class="kv"><span class="k">第几首</span><span>第 ${Number(o.rounds)} 首</span></div>
      </div>
      ${songId ? `<audio controls preload="none" src="/api/order/media/${esc(songId.id)}?k=${encodeURIComponent(state.code)}"></audio>` : ''}
      ${pics.length ? `<div class="thumbs">${pics.map(function (p) {
        return `<img src="/api/order/media/${esc(p.id)}?k=${encodeURIComponent(state.code)}" alt="参考图">`;
      }).join('')}</div>` : ''}
      <ul class="tl">${(r.timeline || []).map(function (e, i) {
        return `<li class="${i === r.timeline.length - 1 ? 'hi' : ''}">${esc(TL_TEXT[e.type] || e.type)}${e.detail ? ' · ' + esc(e.detail) : ''}<span class="t">${fmt(e.created)}</span></li>`;
      }).join('')}</ul>
      ${o.purged ? `<div class="msg info">录音和参考图已经按 ${Number(state.cfg.limits.retentionDays)} 天的约定清掉了，菜单记录还留着。</div>` : ''}
    </div>`;

    // 小票（热敏打印风格）：用落库后的真实单子渲染，覆盖提交瞬间那张（不重播动画，避免每次轮询再吐一遍）
    if (window.DinnerReceipt) DinnerReceipt.mount($('receiptSlot'), receiptDataFromOrder(o, !!songId), { animate: false });

    // 被要求再唱一首 → 把录音区整块搬进重唱卡片（同一个实例，不复制 DOM/id）
    if (o.status === 'retry' && !o.purged) {
      var slot = $('retryRecSlot');
      var sec = $('recSection');
      if (sec && slot && sec.parentNode !== slot) {
        sec.classList.remove('card'); // 外层已经是卡片了
        slot.appendChild(sec);
        resetSong(); // 只在首次搬过来时清空，避免刷新状态把刚录的歌抹掉
      }
      show($('retryBox'), true);
      $('retryId').textContent = o.id;
      $('btnRetry').onclick = function () { resubmit(o.id); };
    } else {
      show($('retryBox'), false);
    }
  }

  function dishText(o) {
    var d = o.dishes || [];
    if (!d.length) return o.wish || '（只写了想吃的）';
    return d.map(function (x) { return x.name + (Number(x.qty) > 1 ? '×' + x.qty : ''); }).join('、');
  }

  async function resubmit(id) {
    var msg = $('retryMsg');
    if (!state.song) { say(msg, '先录一首新的', 'err'); return; }
    $('btnRetry').disabled = true;
    say(msg, '在送过去…', 'info');
    var r = await api('/api/order', {
      method: 'POST',
      body: JSON.stringify({ k: state.code, resubmit: id, song: { data: state.song.b64, mime: state.song.mime } }),
    });
    $('btnRetry').disabled = false;
    if (!r.ok) { say(msg, r.error || '提交失败', 'err'); return; }
    say(msg, r.msg || '送过去了', 'ok');
    resetSong();
    loadStatus(id);
  }

  /* ─────────── 启动 ─────────── */

  function readCode() {
    var u = new URL(location.href);
    var k = u.searchParams.get('k') || '';
    if (!k && location.hash.indexOf('k=') >= 0) {
      k = decodeURIComponent(location.hash.replace(/^#/, '').split('k=')[1].split('&')[0] || '');
    }
    if (k) {
      // 用 localStorage 长期保存：她第一次点开带码链接后，以后在这台设备上直接开站点就能进，
      // 不用每次都带 ?k=。换码时只要再点一次带新码的链接，URL 优先并会覆盖这里的值。
      try { localStorage.setItem('dinner_k', k); } catch (e) { /* 无痕模式 / 禁用存储时忽略 */ }
      return k;
    }
    try { return localStorage.getItem('dinner_k') || ''; } catch (e) { return ''; }
  }

  async function boot() {
    state.code = readCode();
    var r = await api('/api/config?k=' + encodeURIComponent(state.code));

    if (!r.ok) {
      var b = r.brand || {};
      $('gateTitle').textContent = b.nameZh || b.name || '私人厨房';
      $('gateMsg').textContent = r.msg || (r.gate === 'nokey' ? '这间厨房只对一个人开门。' : '这扇门不认识你。');
      show($('gate'), true);
      return;
    }

    state.cfg = r;
    var br = r.brand;
    document.title = (br.nameZh || br.name) + ' · ' + (r.invite.label || '');
    $('brandName').textContent = br.nameZh || br.name;
    $('tagline').textContent = br.tagline || '';
    $('whoLine').textContent = r.invite.label ? '这间厨房为 ' + r.invite.label + ' 开着' : '';
    $('footText').textContent = br.footer || '';
    $('retentionNote').textContent = '录音和参考图会在 ' + r.limits.retentionDays + ' 天后自动清掉，只留菜单记录。';
    $('picLimit').textContent = '最多 ' + r.limits.maxPhotos + ' 张，自动压缩到 ' + kb(r.limits.maxPhotoBytes) + ' 以内';

    if (r.invite.emailLocked) {
      $('email').value = r.invite.email;
      $('email').readOnly = true;
      $('emailNote').textContent = '已经绑定这个邮箱了，换邮箱要找他改';
    }
    if (r.invite.label) $('gname').value = r.invite.label;
    if (!r.limits.songRequired) $('songReq').textContent = '（可选）';

    renderMenu();
    updateSummary();
    show($('app'), true);

    // 事件绑定
    $('btnRec').addEventListener('click', function () {
      if ($('recBox').classList.contains('live')) stopRec();
      else startRec();
    });
    $('btnRedo').addEventListener('click', resetSong);
    $('btnSubmit').addEventListener('click', submit);

    var drop = $('drop');
    var input = $('file');
    drop.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { addPhotos(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) addPhotos(e.dataTransfer.files);
    });

    // 深链 ?order=<id> → 直接看那张单
    var oid = new URL(location.href).searchParams.get('order');
    if (oid) {
      show($('panelOrder'), false);
      show($('panelDone'), true);
      $('doneId').textContent = oid;
      $('doneTitle').textContent = '这张单的进度';
      $('doneNote').textContent = '';
      loadStatus(oid);
    } else if (r.orders && r.orders.length) {
      var open = r.orders.filter(function (o) { return o.status !== 'served'; })[0];
      if (open) {
        $('openHint').innerHTML = `你还有一张单在进行中 · <a href="?k=${encodeURIComponent(state.code)}&order=${encodeURIComponent(open.id)}">去看看</a>`;
        show($('openHint'), true);
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
