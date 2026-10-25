// Ink Reader: md の本を章ごとに表示し、Apple Pencil で書き込む。
// 本文と書き込みは非公開リポジトリ（既定 syakaikungg/sakai_study）に置き、iPad の IndexedDB にも保存してオフラインで使う
(() => {
  const W = 680;
  const PREF = 'ink';
  const $ = (s) => document.querySelector(s);
  const page = $('#page'), sizer = $('#sizer'), doc = $('#doc'), svg = $('#ink'), stat = $('#stat');
  const NS = 'http://www.w3.org/2000/svg';
  let CH = null;   // 開いている章の id

  // ---------- state ----------
  let tool = 'pen', color = 'k', size = 3.4, finger = false;
  let scale = 1, zoomMode = 'fit';
  // 線は段落（#docの子要素）ごとに結びつけ、座標はその段落の上端からの相対値で持つ
  // {id,b,tool,c,s,pen,pts:[[x,yRel,p]],bbox,el}
  let strokes = [];
  const undoStack = [], redoStack = [];
  let blocks = [], tops = [], hashes = [];
  function initBlocks() {
    blocks = [...doc.children];
    tops = blocks.map(() => -1);
    hashes = blocks.map((el) => {
      let h = 5381; const t = el.textContent.slice(0, 300);
      for (let i = 0; i < t.length; i++) h = (h * 33 + t.charCodeAt(i)) >>> 0;
      return h.toString(36);
    });
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- IndexedDB（本・図・書き込みの端末内保存） ----------
  const kv = (() => {
    let dbp;
    const open = () => dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open('ink-reader', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const tx = async (mode, f) => {
      const d = await open();
      return new Promise((res, rej) => { const q = f(d.transaction('kv', mode).objectStore('kv')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    };
    return {
      get: (k) => tx('readonly', (s) => s.get(k)),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
      del: (k) => tx('readwrite', (s) => s.delete(k)),
    };
  })();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------- geometry ----------
  function opts(s, last) {
    if (s.tool === 'hl') return { size: 16, thinning: 0, smoothing: .5, streamline: .45, simulatePressure: false, last,
      start: { cap: false }, end: { cap: false } };
    return { size: s.s, thinning: .62, smoothing: .55, streamline: .28, simulatePressure: !s.pen, last,
      easing: (t) => t };
  }
  function pathD(outline) {
    const n = outline.length;
    if (n < 2) return '';
    const r = (v) => Math.round(v * 100) / 100;
    let d = `M${r(outline[0][0])},${r(outline[0][1])}Q`;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = outline[i], [x1, y1] = outline[(i + 1) % n];
      d += `${r(x0)},${r(y0)} ${r((x0 + x1) / 2)},${r((y0 + y1) / 2)} `;
    }
    return d + 'Z';
  }
  const top = (s) => tops[Math.min(s.b, tops.length - 1)] || 0;
  function place(s) { s.el.setAttribute('transform', `translate(0 ${top(s)})`); }
  function render(s, pts, last) { s.el.setAttribute('d', pathD(getStroke(pts || s.pts, opts(s, last)))); }
  function bbox(s) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of s.pts) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
    s.bbox = [a, b, c, d];
  }
  function mount(s) {
    if (!s.el) {
      s.el = document.createElementNS(NS, 'path'); s.el.setAttribute('class', s.tool === 'hl' ? 'hl' : s.c);
      render(s, null, true);
    }
    place(s);
    if (s.tool === 'hl') svg.insertBefore(s.el, svg.firstChild); else svg.appendChild(s.el);
  }
  function blockAt(y) {
    let lo = 0, hi = tops.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tops[m] <= y) lo = m; else hi = m - 1; }
    return lo;
  }

  // ---------- serialize ----------
  const ser = (s) => ({ t: s.tool, c: s.c, s: s.s, pen: !!s.pen,
    p: s.pts.flatMap(([x, y, p]) => [Math.round(x * 10), Math.round(y * 10), Math.round(p * 100)]) });
  function de(id, b, d) {
    const pts = [];
    for (let i = 0; i + 2 < d.p.length; i += 3) pts.push([d.p[i] / 10, d.p[i + 1] / 10, d.p[i + 2] / 100]);
    const s = { id, b, tool: d.t, c: d.c, s: d.s, pen: d.pen, pts };
    bbox(s); return s;
  }
  // 今の章の書き込みを段落ごとの形にする（GitHub の ink/<章>.json と同じ形）
  function serialize() {
    const out = {};
    for (const s of strokes) {
      const blk = out[s.b] ||= { b: s.b, h: hashes[s.b], text: blocks[s.b] ? blocks[s.b].textContent.slice(0, 80) : '', strokes: {} };
      blk.strokes[s.id] = ser(s);
    }
    return out;
  }
  function showBlocks(data) {
    clearSel();
    for (const s of strokes) s.el.remove();
    strokes = [];
    for (const b in data) for (const id in data[b].strokes) { const s = de(id, +b, data[b].strokes[id]); mount(s); strokes.push(s); }
  }

  // ---------- 設定 ----------
  const DEF = { token: '', repo: 'syakaikungg/sakai_study', branch: 'master', book: 'books/nishimori' };
  let cfg = { ...DEF };
  try { cfg = { ...DEF, ...JSON.parse(store.get(PREF + ':cfg') || '{}') }; } catch {}
  const online = () => navigator.onLine !== false;
  const canSync = () => !!cfg.token && online();

  // ---------- GitHub ----------
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const b64 = { from(s) { const b = new TextEncoder().encode(s); let t = ''; for (let i = 0; i < b.length; i += 0x8000) t += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(t); },
    to(s) { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0))); } };
  async function gh(path, { raw = false, blob = false, method = 'GET', body } = {}) {
    const url = `https://api.github.com/repos/${cfg.repo}/contents/${enc(path)}` + (method === 'GET' ? `?ref=${encodeURIComponent(cfg.branch)}` : '');
    const r = await fetch(url, { method, cache: 'no-store', headers: {
      Authorization: 'Bearer ' + cfg.token, 'X-GitHub-Api-Version': '2022-11-28',
      Accept: raw || blob ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    }, body: body && JSON.stringify(body) });
    if (r.status === 404 && method === 'GET') return null;
    if (!r.ok) { const e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
    return blob ? r.blob() : raw ? r.text() : r.json();
  }

  // ---------- 本のダウンロード（端末に保存） ----------
  let book = null;
  const bookKey = () => cfg.repo + '@' + cfg.branch + ':' + cfg.book;
  async function loadBook() { book = await kv.get('book:' + bookKey()); return book; }
  // 変わったファイルだけ取り直す。図は一度取れば取り直さない
  async function syncBook(force) {
    if (!canSync()) return false;
    stat.textContent = '本を確認中…';
    const meta = JSON.parse(await gh(cfg.book + '/book.json', { raw: true }) || 'null');
    if (!meta) throw new Error('本が見つかりません（' + cfg.book + '/book.json）');
    const list = await gh(cfg.book + '/chapters') || [];
    const shas = Object.fromEntries(list.map((f) => [f.name, f.sha]));
    let i = 0;
    for (const c of meta.chapters) {
      i++;
      const name = c.file.split('/').pop(), key = 'md:' + bookKey() + ':' + c.id;
      const have = await kv.get(key);
      if (!force && have && have.sha === shas[name]) continue;
      stat.textContent = `本をダウンロード中 ${i}/${meta.chapters.length}`;
      const md = await gh(cfg.book + '/' + c.file, { raw: true });
      await kv.set(key, { sha: shas[name], md });
      await kv.del('html:' + bookKey() + ':' + c.id);
    }
    const names = Object.keys(meta.images || {});
    let j = 0;
    for (const f of names) {
      j++;
      const key = 'img:' + meta.imageDir + '/' + f;
      if (!force && await kv.get(key)) continue;
      stat.textContent = `図をダウンロード中 ${j}/${names.length}`;
      const bl = await gh(meta.imageDir + '/' + f, { blob: true });
      if (bl) await kv.set(key, bl);
    }
    await kv.set('book:' + bookKey(), meta);
    book = meta;
    stat.textContent = '本をこのiPadに保存しました（通信なしでも開けます）';
    return true;
  }
  const imgUrls = {};
  async function fillImages() {
    for (const el of doc.querySelectorAll('img[data-img]')) {
      const key = 'img:' + book.imageDir + '/' + el.dataset.img;
      if (!imgUrls[key]) { const bl = await kv.get(key); if (bl) imgUrls[key] = URL.createObjectURL(bl); }
      if (imgUrls[key]) el.src = imgUrls[key];
    }
  }
  async function chapterHtml(id) {
    const hk = 'html:' + bookKey() + ':' + id, src = await kv.get('md:' + bookKey() + ':' + id);
    if (!src) return null;
    const cached = await kv.get(hk);
    if (cached && cached.sha === src.sha) return cached.html;
    const html = renderMarkdown(src.md, book.images);
    kv.set(hk, { sha: src.sha, html }).catch(() => {});
    return html;
  }

  // ---------- 書き込みの保存と同期 ----------
  // 端末: kv 'ink:<本>:<章>' = { blocks, sha, pending:[段落番号] }。GitHub: <本>/ink/<章>.json = { chapter, blocks }
  // pending の段落は端末側を正とし、それ以外は GitHub 側を正としてまとめる
  let cs = null;   // 今の章の { blocks, sha, pending:Set }
  const inkKey = (id) => 'ink:' + bookKey() + ':' + id;
  const inkPath = (id) => cfg.book + '/ink/' + id + '.json';
  let saveT = 0;
  function persist() {
    clearTimeout(saveT);
    const id = CH, st = cs;
    st.blocks = serialize();
    saveT = setTimeout(() => kv.set(inkKey(id), { blocks: st.blocks, sha: st.sha, pending: [...st.pending] }).catch(() => {}), 150);
  }
  function touch(list) {
    if (!cs) return;
    for (const s of list) cs.pending.add(s.b);
    persist(); schedulePush(); showPending();
  }
  function showPending() {
    if (!cs || !cs.pending.size) return;
    stat.textContent = !cfg.token ? `未送信 ${cs.pending.size}段落（設定でトークンを入れると送れます）`
      : online() ? `未送信 ${cs.pending.size}段落` : `オフライン: ${cs.pending.size}段落分をiPadに保存中`;
  }
  let pushT = 0;
  function schedulePush(ms = 4000) { clearTimeout(pushT); pushT = setTimeout(() => pushChapter(CH), ms); }
  function merge(st, remote) {   // remote: {b: block}
    const out = {};
    for (const b in remote || {}) if (!st.pending.has(+b)) out[b] = remote[b];
    for (const b of st.pending) if (st.blocks[b]) out[b] = st.blocks[b];
    return out;
  }
  async function pullInk(id, st) {
    const meta = await gh(inkPath(id));
    if (!meta) return { sha: null, blocks: {} };
    const text = meta.content ? b64.to(meta.content) : await gh(inkPath(id), { raw: true });
    return { sha: meta.sha, blocks: (JSON.parse(text || '{}').blocks) || {} };
  }
  let pushing = false;
  async function pushChapter(id) {
    if (pushing || !canSync()) { showPending(); return; }
    const st = id === CH ? cs : await kv.get(inkKey(id)).then((v) => v && { ...v, pending: new Set(v.pending) });
    if (!st || !st.pending.size) return;
    pushing = true;
    try {
      for (let tryNo = 0; tryNo < 2; tryNo++) {
        const sent = new Set(st.pending);
        if (id === CH) st.blocks = serialize();
        const body = JSON.stringify({ chapter: id, blocks: st.blocks }, null, 0);
        try {
          const r = await gh(inkPath(id), { method: 'PUT', body: { message: `ink: ${cfg.book.split('/').pop()} ${id}`, branch: cfg.branch,
            content: b64.from(body), ...(st.sha ? { sha: st.sha } : {}) } });
          st.sha = r.content.sha;
          for (const b of sent) if (id !== CH || sameBlock(b, st.blocks[b])) st.pending.delete(b);
          break;
        } catch (e) {
          if (e.status !== 409 && e.status !== 422) throw e;
          // 他の端末が先に保存していた: 取り直してまとめ、もう一度
          const remote = await pullInk(id, st);
          st.sha = remote.sha;
          st.blocks = merge(st, remote.blocks);
          if (id === CH) { showBlocks(st.blocks); undoStack.length = redoStack.length = 0; syncHist(); }
        }
      }
      await kv.set(inkKey(id), { blocks: st.blocks, sha: st.sha, pending: [...st.pending] });
      if (id === CH && !st.pending.size) stat.textContent = 'GitHubに保存しました';
    } catch (e) {
      stat.textContent = e.status === 401 || e.status === 403 ? 'GitHubに保存できません（トークンを確認してください）' : 'GitHubに送れませんでした（iPadには保存済み）';
    } finally {
      pushing = false;
      if (id === CH && cs.pending.size && canSync()) schedulePush(8000);
    }
  }
  // 送信中に書き足された段落は送信済みにしない
  function sameBlock(b, sentBlock) {
    const now = strokes.filter((s) => s.b === b).map((s) => s.id).sort().join();
    return now === Object.keys((sentBlock && sentBlock.strokes) || {}).sort().join();
  }
  async function pushAll() {
    if (!canSync() || !book) return;
    for (const c of book.chapters) await pushChapter(c.id);
  }
  async function refreshChapter() {   // GitHub 側の書き込みを取り込む（他の端末・Claude の変更）
    if (!canSync() || !cs) return;
    const id = CH, st = cs;
    try {
      const remote = await pullInk(id, st);
      if (id !== CH || remote.sha === st.sha) return;
      st.sha = remote.sha; st.blocks = merge(st, remote.blocks);
      showBlocks(st.blocks); undoStack.length = redoStack.length = 0; syncHist();
      persist();
      if (st.pending.size) schedulePush(500);
    } catch {}
  }
  addEventListener('online', () => { pushAll(); refreshChapter(); });
  addEventListener('offline', showPending);
  let lastPull = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (cs && cs.pending.size) pushChapter(CH); }
    else if (Date.now() - lastPull > 60000) { lastPull = Date.now(); refreshChapter(); }
  });

  // ---------- history ----------
  // op: {type:'add'|'erase', list} か {type:'replace', from, to}（投げ縄の移動・色変更）
  const opList = (op) => op.list || op.from.concat(op.to);
  function push(op) { undoStack.push(op); redoStack.length = 0; syncHist(); touch(opList(op)); }
  function addAll(list) { for (const s of list) { mount(s); strokes.push(s); } }
  function removeAll(list) { const set = new Set(list); strokes = strokes.filter((s) => !set.has(s)); for (const s of list) s.el.remove(); }
  function apply(op, inverse) {
    clearSel();
    if (op.type === 'replace') { removeAll(inverse ? op.to : op.from); addAll(inverse ? op.from : op.to); }
    else ((op.type === 'add') !== inverse) ? addAll(op.list) : removeAll(op.list);
    touch(opList(op));
  }
  function syncHist() { $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length; }
  $('#undo').onclick = () => { const op = undoStack.pop(); if (!op) return; apply(op, true); redoStack.push(op); syncHist(); };
  $('#redo').onclick = () => { const op = redoStack.pop(); if (!op) return; apply(op, false); undoStack.push(op); syncHist(); };

  // ---------- zoom / layout ----------
  function layout() {
    const h = page.offsetHeight;
    svg.setAttribute('height', h); svg.style.height = h + 'px';
    sizer.style.width = W * scale + 'px';
    sizer.style.height = h * scale + 'px';
    page.style.transform = `scale(${scale})`;
    $('#zoomv').textContent = Math.round(scale * 100) + '%';
    const next = blocks.map((el) => el.offsetTop);
    if (next.some((v, i) => v !== tops[i])) { tops = next; for (const s of strokes) place(s); }
    if (sel.length) showSel();
  }
  function fitScale() {
    const avail = document.documentElement.clientWidth - 32;
    return Math.max(.5, Math.min(1.6, avail / W));
  }
  function setScale(next, mode) {
    const r0 = page.getBoundingClientRect();
    const cy = (innerHeight / 2 - r0.top) / scale;
    scale = next; zoomMode = mode;
    layout();
    const r1 = page.getBoundingClientRect();
    scrollBy(0, r1.top + cy * scale - innerHeight / 2);
    store.set(PREF + ':zoom', mode === 'fit' ? 'fit' : String(scale));
  }
  const steps = [.5, .75, .9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5];
  $('#zin').onclick = () => setScale(steps.find((v) => v > scale + .01) || scale, 'manual');
  $('#zout').onclick = () => setScale([...steps].reverse().find((v) => v < scale - .01) || scale, 'manual');
  $('#zoomv').onclick = () => setScale(fitScale(), 'fit');
  addEventListener('resize', () => { if (zoomMode === 'fit') setScale(fitScale(), 'fit'); });
  new ResizeObserver(layout).observe(doc);

  // ---------- toolbar ----------
  function press(group, btn) { for (const b of group) b.setAttribute('aria-pressed', String(b === btn)); }
  const toolBtns = [$('#t-pen'), $('#t-hl'), $('#t-er'), $('#t-ls')];
  toolBtns.forEach((b) => b.onclick = () => {
    tool = { 't-pen': 'pen', 't-hl': 'hl', 't-er': 'er', 't-ls': 'ls' }[b.id]; press(toolBtns, b);
    page.classList.toggle('erasing', tool === 'er');
    page.classList.toggle('lassoing', tool === 'ls');
    if (tool !== 'ls') clearSel();
  });
  // 投げ縄で選んでいるときは、色・太さボタンで選んだ線を変える
  const colorBtns = [...document.querySelectorAll('#colors button')];
  colorBtns.forEach((b) => b.onclick = () => { color = b.dataset.c; press(colorBtns, b); if (sel.length) restyle({ c: color }); else if (tool !== 'pen') toolBtns[0].click(); });
  const sizeBtns = [...document.querySelectorAll('#sizes button')];
  sizeBtns.forEach((b) => b.onclick = () => { size = +b.dataset.s; press(sizeBtns, b); if (sel.length) restyle({ s: size }); else if (tool !== 'pen') toolBtns[0].click(); });
  $('#finger').onclick = (e) => { finger = !finger; e.currentTarget.setAttribute('aria-pressed', String(finger)); page.classList.toggle('finger', finger); };
  let armT = 0;
  $('#clear').onclick = (e) => {
    const b = e.currentTarget;
    if (!b.classList.contains('arm')) {
      b.classList.add('arm'); b.textContent = 'もう一度押すと全消去';
      armT = setTimeout(() => { b.classList.remove('arm'); b.textContent = '全消去'; }, 3000);
      return;
    }
    clearTimeout(armT); b.classList.remove('arm'); b.textContent = '全消去';
    if (!strokes.length) return;
    clearSel();
    const list = strokes.slice(); removeAll(list); push({ type: 'erase', list });
  };
  $('#hint-x').onclick = () => { $('#hint').hidden = true; store.set(PREF + ':hint', '0'); };
  if (store.get(PREF + ':hint') === '0') $('#hint').hidden = true;

  // ---------- input ----------
  let penDown = false;
  const stylusGuard = (e) => {
    if (penDown) { e.preventDefault(); return; }
    for (const t of e.changedTouches) if (t.touchType === 'stylus' && page.contains(e.target)) { e.preventDefault(); return; }
  };
  document.addEventListener('touchstart', stylusGuard, { passive: false });
  document.addEventListener('touchmove', stylusGuard, { passive: false });

  const accepts = (e) => e.pointerType === 'pen' || e.pointerType === 'mouse' || (finger && e.pointerType === 'touch');
  let cur = null, curId = null, curTop = 0, erased = null, pending = [], predicted = [], raf = 0;
  let t0 = 0, samples = 0, frames = 0;

  function toPage(ev) {
    const r = page.getBoundingClientRect();
    const p = ev.pointerType === 'pen' ? (ev.pressure || .05) : .5;
    return [(ev.clientX - r.left) / scale, (ev.clientY - r.top) / scale, p];
  }
  const toRel = (ev) => { const q = toPage(ev); q[1] -= curTop; return q; };
  function eraseAt([x, y]) {
    const rad = 9 / scale;
    const hit = [];
    for (const s of strokes) {
      const ty = top(s), [a, b, c, d] = s.bbox, pad = rad + (s.tool === 'hl' ? 8 : s.s);
      if (x < a - pad || x > c + pad || y < b + ty - pad || y > d + ty + pad) continue;
      for (const [px, py] of s.pts) { if ((px - x) ** 2 + (py + ty - y) ** 2 < pad * pad) { hit.push(s); break; } }
    }
    if (hit.length) { removeAll(hit); erased.push(...hit); }
  }
  // 往復の多い線（ぐちゃぐちゃ）なら、その範囲にほぼ収まる既存の線を返す。該当なしなら null
  function scribbleTargets(s) {
    const pts = s.pts;
    if (pts.length < 12) return null;
    const ty = top(s);
    const [a, b0, c, d0] = s.bbox, b = b0 + ty, d = d0 + ty, w = c - a, h = d - b;
    if (Math.max(w, h) < 8) return null;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (len < 3.5 * Math.max(w, h)) return null;
    const ax = w >= h ? 0 : 1, minRun = Math.max(w, h) * .25;
    let turns = 0, dir = 0, anchor = pts[0][ax];
    for (const p of pts) {
      const dv = p[ax] - anchor;
      if (dir >= 0 && dv < -minRun) { if (dir > 0) turns++; dir = -1; anchor = p[ax]; }
      else if (dir <= 0 && dv > minRun) { if (dir < 0) turns++; dir = 1; anchor = p[ax]; }
      else if ((dir > 0 && dv > 0) || (dir < 0 && dv < 0)) anchor = p[ax];
    }
    if (turns < 3) return null;
    const pad = 4, hit = [];
    for (const o of strokes) {
      const oy = top(o), [oa, ob, oc, od] = o.bbox;
      if (oc < a - pad || oa > c + pad || od + oy < b - pad || ob + oy > d + pad) continue;
      let inside = 0;
      for (const [x, y] of o.pts) if (x >= a - pad && x <= c + pad && y + oy >= b - pad && y + oy <= d + pad) inside++;
      if (inside / o.pts.length < .6) continue;
      const r2 = (Math.max(o.s || 8, s.s) + 6) ** 2;
      let near = 0;
      outer: for (const [x, y] of o.pts) for (const [sx, sy] of pts) if ((x - sx) ** 2 + (y + oy - sy - ty) ** 2 < r2) { near++; if (near >= 2) break outer; break; }
      if (near >= 2 || o.pts.length < 3) hit.push(o);
    }
    return hit.length ? hit : null;
  }
  // ---------- 投げ縄 ----------
  // 囲んだ線を選び、ドラッグで移動・色や太さの変更・削除ができる。
  // 移動や変更は「元の線を消して新しい線を足す」操作として記録し、移動先の段落に付け直す
  let sel = [], lasso = null, drag = null;
  const lassoEl = document.createElementNS(NS, 'path'); lassoEl.setAttribute('class', 'lasso');
  const selEl = document.createElementNS(NS, 'rect'); selEl.setAttribute('class', 'sel'); selEl.setAttribute('rx', 6);
  const selMenu = $('#selmenu');
  function inPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function selBox() {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const s of sel) { const ty = top(s), pad = s.tool === 'hl' ? 8 : s.s; a = Math.min(a, s.bbox[0] - pad); b = Math.min(b, s.bbox[1] + ty - pad); c = Math.max(c, s.bbox[2] + pad); d = Math.max(d, s.bbox[3] + ty + pad); }
    return [a - 6, b - 6, c + 6, d + 6];
  }
  function showSel(dx = 0, dy = 0) {
    if (!sel.length) { selEl.remove(); selMenu.hidden = true; return; }
    const [a, b, c, d] = selBox();
    selEl.setAttribute('x', a + dx); selEl.setAttribute('y', b + dy);
    selEl.setAttribute('width', c - a); selEl.setAttribute('height', d - b);
    svg.appendChild(selEl);
    selMenu.hidden = false;
    selMenu.style.left = Math.max(0, (a + dx) * scale) + 'px';
    selMenu.style.top = Math.max(0, (b + dy) * scale - selMenu.offsetHeight - 8) + 'px';
    $('#sel-n').textContent = `${sel.length}画`;
  }
  function clearSel() { sel = []; drag = null; lassoEl.remove(); showSel(); }
  function finishLasso() {
    const poly = lasso; lasso = null; lassoEl.remove();
    if (poly.length < 3) return;
    sel = strokes.filter((s) => {
      const ty = top(s); let n = 0;
      for (const [x, y] of s.pts) if (inPoly(x, y + ty, poly)) n++;
      return n >= s.pts.length / 2;
    });
    showSel();
    stat.textContent = sel.length ? `${sel.length}画を選択（ドラッグで移動・色や太さのボタンで変更）` : '囲んだ中に線がありません';
  }
  // 選んだ線を作り直す（移動量 dx,dy と、色・太さの変更 patch）
  function rebuild(dx, dy, patch) {
    const from = sel, to = from.map((s) => {
      const ty = top(s);
      const abs = s.pts.map(([x, y, p]) => [x + dx, y + ty + dy, p]);
      let minY = Infinity; for (const q of abs) minY = Math.min(minY, q[1]);
      const b = blockAt(minY), t = tops[b];
      const n = { id: newId(), b, tool: s.tool, c: s.c, s: s.s, pen: s.pen, pts: abs.map(([x, y, p]) => [x, y - t, p]), ...patch };
      bbox(n); return n;
    });
    removeAll(from); addAll(to);
    push({ type: 'replace', from, to });
    sel = to; showSel();
  }
  function restyle(patch) {
    const sub = patch.s != null ? { s: patch.s } : { c: patch.c };
    if (!sel.some((s) => s.tool !== 'hl')) return;
    const keep = sel.filter((s) => s.tool === 'hl');
    const all = sel; sel = all.filter((s) => s.tool !== 'hl');
    rebuild(0, 0, sub);
    sel = sel.concat(keep); showSel();
  }
  $('#sel-del').onclick = () => { if (!sel.length) return; const list = sel; removeAll(list); push({ type: 'erase', list }); clearSel(); stat.textContent = `${list.length}画を消しました`; };
  $('#sel-x').onclick = clearSel;
  function lassoDown(e) {
    const [x, y] = toPage(e);
    if (sel.length) {
      const [a, b, c, d] = selBox();
      if (x >= a && x <= c && y >= b && y <= d) { drag = { x, y, dx: 0, dy: 0 }; selMenu.hidden = true; return; }
      clearSel();
    }
    lasso = [[x, y]];
    lassoEl.setAttribute('d', ''); svg.appendChild(lassoEl);
  }
  function lassoMove(list) {
    const last = toPage(list[list.length - 1]);
    if (drag) {
      drag.dx = last[0] - drag.x; drag.dy = last[1] - drag.y;
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0; if (!drag) return;
        for (const s of sel) s.el.setAttribute('transform', `translate(${drag.dx} ${top(s) + drag.dy})`);
        showSel(drag.dx, drag.dy); selMenu.hidden = true;
      });
      return;
    }
    if (!lasso) return;
    for (const ev of list) { const [x, y] = toPage(ev); lasso.push([x, y]); }
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0; if (!lasso) return;
      lassoEl.setAttribute('d', 'M' + lasso.map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join('L') + 'Z');
    });
  }
  function lassoUp() {
    if (drag) {
      const { dx, dy } = drag; drag = null;
      if (Math.hypot(dx, dy) < 2) { for (const s of sel) place(s); showSel(); return; }
      rebuild(dx, dy, {});
      stat.textContent = `${sel.length}画を移動しました`;
      return;
    }
    if (lasso) finishLasso();
  }

  function frame() {
    raf = 0; frames++;
    if (!cur) return;
    if (pending.length) { cur.pts.push(...pending); pending = []; }
    render(cur, predicted.length ? cur.pts.concat(predicted) : cur.pts, false);
  }

  page.addEventListener('pointerdown', (e) => {
    if (!accepts(e) || curId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    page.setPointerCapture(e.pointerId);
    curId = e.pointerId; penDown = true;
    t0 = e.timeStamp; samples = 1; frames = 0;
    if (tool === 'er') { erased = []; eraseAt(toPage(e)); return; }
    if (tool === 'ls') { lassoDown(e); return; }
    const b = blockAt(toPage(e)[1]);
    curTop = tops[b];
    cur = { id: newId(), b, tool, c: color, s: size, pen: e.pointerType === 'pen', pts: [toRel(e)] };
    cur.el = document.createElementNS(NS, 'path'); cur.el.setAttribute('class', tool === 'hl' ? 'hl' : color);
    mount(cur); render(cur, null, false);
  });
  page.addEventListener('pointermove', (e) => {
    if (e.pointerId !== curId) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    samples += list.length;
    if (tool === 'er' && erased) { for (const ev of list) eraseAt(toPage(ev)); return; }
    if (tool === 'ls') { lassoMove(list); return; }
    if (!cur) return;
    for (const ev of list) pending.push(toRel(ev));
    predicted = e.getPredictedEvents ? e.getPredictedEvents().map(toRel) : [];
    if (!raf) raf = requestAnimationFrame(frame);
  });
  function end(e) {
    if (e.pointerId !== curId) return;
    curId = null; penDown = false;
    const dt = (e.timeStamp - t0) / 1000;
    if (erased) { if (erased.length) push({ type: 'erase', list: erased }); erased = null; return; }
    if (tool === 'ls') { lassoUp(); return; }
    if (!cur) return;
    if (pending.length) { cur.pts.push(...pending); pending = []; }
    predicted = [];
    bbox(cur);
    const victims = cur.tool === 'pen' ? scribbleTargets(cur) : null;
    if (victims) {
      cur.el.remove(); removeAll(victims); push({ type: 'erase', list: victims });
      stat.textContent = `ぐちゃぐちゃ消し: ${victims.length}画を消しました`;
      cur = null; return;
    }
    render(cur, null, true); strokes.push(cur);
    push({ type: 'add', list: [cur] });
    const tag = cur.pen ? 'Pencil入力' : '入力';
    if (dt > .25) stat.textContent = `${tag} ${Math.round(samples / dt)}Hz・描画 ${Math.round(frames / dt)}fps`;
    cur = null;
  }
  page.addEventListener('pointerup', end);
  page.addEventListener('pointercancel', end);


  // ---------- chapters ----------
  const chapSel = $('#chap');
  const srcLine = doc.firstElementChild;
  let ids = [];
  let opening = null;
  function fillChapters() {
    chapSel.replaceChildren(...book.chapters.map((c) => new Option(c.label, c.id)));
    ids = book.chapters.map((c) => c.id);
    srcLine.textContent = book.source || book.title || '';
  }
  async function openChapter(id, restore) {
    if (!ids.includes(id)) id = ids.includes('ch1') ? 'ch1' : ids[0];
    const my = opening = {};
    chapSel.value = id; syncNav(id);
    if (CH) store.set(PREF + ':pos:' + CH, String(scrollY));
    if (cs && cs.pending.size) pushChapter(CH);
    doc.classList.add('loading');
    let html = await chapterHtml(id);
    if (html == null && canSync()) { try { await syncBook(); html = await chapterHtml(id); } catch {} }
    if (my !== opening) return;
    if (html == null) { stat.textContent = 'この章はまだiPadに保存されていません。通信できるときに開いてください'; doc.classList.remove('loading'); if (CH) { chapSel.value = CH; syncNav(CH); } return; }
    const saved = await kv.get(inkKey(id));
    if (my !== opening) return;
    for (const s of strokes) s.el.remove();
    strokes = []; undoStack.length = 0; redoStack.length = 0; syncHist();
    CH = id;
    cs = { blocks: (saved && saved.blocks) || {}, sha: saved ? saved.sha : null, pending: new Set(saved ? saved.pending : []) };
    store.set(PREF + ':chapter', id);
    doc.replaceChildren(srcLine);
    doc.insertAdjacentHTML('beforeend', html);
    initBlocks(); layout();
    showBlocks(cs.blocks);
    doc.classList.remove('loading');
    scrollTo(0, restore ? +(store.get(PREF + ':pos:' + id) || 0) : 0);
    fillImages();
    if (document.fonts) document.fonts.ready.then(layout);
    showPending();
    lastPull = Date.now(); refreshChapter();
  }
  function syncNav(id) {
    const i = ids.indexOf(id);
    for (const b of [$('#prev'), $('#prev2')]) b.disabled = i <= 0;
    for (const b of [$('#next'), $('#next2')]) b.disabled = i >= ids.length - 1;
  }
  const step = (d) => { const i = ids.indexOf(chapSel.value) + d; if (ids[i]) openChapter(ids[i], false); };
  chapSel.onchange = () => openChapter(chapSel.value, true);
  $('#prev').onclick = $('#prev2').onclick = () => step(-1);
  $('#next').onclick = $('#next2').onclick = () => step(1);
  addEventListener('pagehide', () => { if (CH) store.set(PREF + ':pos:' + CH, String(scrollY)); });

  // ---------- 設定画面 ----------
  const dlg = $('#cfg'), msg = $('#cfg-msg');
  function openCfg() {
    $('#cfg-token').value = cfg.token; $('#cfg-repo').value = cfg.repo; $('#cfg-branch').value = cfg.branch; $('#cfg-book').value = cfg.book;
    msg.textContent = cfg.token ? '接続先を変えるときだけ書き換えてください' : '';
    dlg.showModal();
  }
  $('#gear').onclick = openCfg;
  async function connect(force) {
    msg.textContent = '接続中…';
    try {
      if (!online()) throw new Error('通信できません');
      await syncBook(force);
      msg.textContent = '本をダウンロードしました';
      fillChapters(); $('#empty').hidden = true; chapSel.disabled = false;
      await openChapter(CH && ids.includes(CH) ? CH : (store.get(PREF + ':chapter') || 'ch1'), true);
      pushAll();
      return true;
    } catch (e) {
      msg.textContent = e.status === 401 ? 'トークンが無効です' : e.status === 403 || e.status === 404 ? 'リポジトリか本のフォルダが見つからないか、トークンに権限がありません' : (e.message || '接続できませんでした');
      return false;
    }
  }
  $('#cfg-save').onclick = async () => {
    cfg = { token: $('#cfg-token').value.trim(), repo: $('#cfg-repo').value.trim() || DEF.repo,
      branch: $('#cfg-branch').value.trim() || DEF.branch, book: $('#cfg-book').value.trim().replace(/\/+$/, '') || DEF.book };
    store.set(PREF + ':cfg', JSON.stringify(cfg));
    if (await connect(false)) setTimeout(() => dlg.close(), 600);
  };
  $('#cfg-sync').onclick = () => connect(true);

  // ---------- boot ----------
  const z = store.get(PREF + ':zoom');
  scale = z && z !== 'fit' ? +z : fitScale();
  zoomMode = z && z !== 'fit' ? 'manual' : 'fit';
  layout();
  (async () => {
    await loadBook();
    if (!book && canSync()) { try { await syncBook(); } catch (e) { stat.textContent = '本をダウンロードできませんでした: ' + (e.message || ''); } }
    if (!book) { $('#empty').hidden = false; chapSel.disabled = true; if (!cfg.token) openCfg(); return; }
    fillChapters();
    const fromHash = location.hash.slice(1);
    await openChapter(ids.includes(fromHash) ? fromHash : (store.get(PREF + ':chapter') || 'ch1'), true);
    pushAll();
    // 起動のたびに本の更新を確認（変わった章だけ取り直す）
    if (canSync()) syncBook(false).then(() => { stat.textContent = ''; }).catch(() => {});
  })();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
