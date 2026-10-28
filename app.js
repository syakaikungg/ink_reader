// Ink Reader: md の本を章ごとに表示し、Apple Pencil で書き込む。
// 本は iPad の「ファイル」から開くか、非公開リポジトリ（既定 syakaikungg/sakai_study）から取る。
// どちらも本・書き込みを IndexedDB に保存してオフラインで使い、GitHub の本だけ書き込みを GitHub と同期する
(() => {
  const W = 680;
  const PREF = 'ink';
  const $ = (s) => document.querySelector(s);
  const page = $('#page'), sizer = $('#sizer'), wrap = $('#wrap'), doc = $('#doc'), svg = $('#ink'), stat = $('#stat');
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
  // 色は 'k'/'r'/'b'（画面の明暗で色が変わる既定の3色）か '#rrggbb'（自分で選んだ色）
  function paint(el, s) {
    const hex = s.tool !== 'hl' && /^#/.test(s.c);
    el.setAttribute('class', s.tool === 'hl' ? 'hl' : hex ? 'x' : s.c);
    if (hex) el.style.fill = s.c; else el.style.removeProperty('fill');
  }
  function mount(s) {
    if (!s.el) {
      s.el = document.createElementNS(NS, 'path'); paint(s.el, s);
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
    p: s.pts.flatMap(([x, y, p]) => [Math.round(x * 10), Math.round(y * 10), Math.round(p * 100)]),
    // 図形に直した線は、あとで形を変えられるよう図形の形も残す（k: line・poly・ellipse・circle、v: 頂点か [中心, 半径]、a: 傾き）
    ...(s.g ? { g: { k: s.g.k, v: s.g.v.flatMap(([x, y]) => [Math.round(x * 10), Math.round(y * 10)]), a: Math.round((s.g.a || 0) * 1000), p: Math.round(s.g.p * 100) } } : {}) });
  function de(id, b, d) {
    const pts = [];
    for (let i = 0; i + 2 < d.p.length; i += 3) pts.push([d.p[i] / 10, d.p[i + 1] / 10, d.p[i + 2] / 100]);
    const s = { id, b, tool: d.t, c: d.c, s: d.s, pen: d.pen, pts };
    if (d.g) { const v = []; for (let i = 0; i + 1 < d.g.v.length; i += 2) v.push([d.g.v[i] / 10, d.g.v[i + 1] / 10]); s.g = { k: d.g.k, v, a: d.g.a / 1000, p: d.g.p / 100 }; }
    bbox(s); return s;
  }
  // 今の章の書き込みを段落ごとの形にする（GitHub の ink/<章>.json と同じ形）
  function serialize() {
    const out = {};
    for (const s of strokes.concat(Object.keys(gaps).map((b) => ({ b: +b })))) {
      // PDF は b がページ番号。ページの大きさ（pt）も残し、座標（幅 680 の紙の px）を PDF の座標に直せるようにする
      const blk = out[s.b] ||= isPdf() ? { b: s.b, pt: book.sizes[s.b - 1], strokes: {} }
        : { b: s.b, h: hashes[s.b], text: blocks[s.b] ? blocks[s.b].textContent.slice(0, 80) : '', strokes: {} };
      if (s.pts) blk.strokes[s.id] = ser(s);
      if (gaps[s.b]) blk.gap = gaps[s.b];
    }
    return out;
  }
  function showBlocks(data) {
    clearSel();
    for (const s of strokes) s.el.remove();
    strokes = [];
    for (const b of Object.keys(gaps)) setGap(+b, 0);
    for (const b in data) { if (data[b].gap) setGap(+b, data[b].gap); for (const id in data[b].strokes || {}) { const s = de(id, +b, data[b].strokes[id]); mount(s); strokes.push(s); } }
  }

  // ---------- 余白・白紙ページ ----------
  // 段落（PDF はページ）の下に高さを足して、書き込む場所を作る。新しい段落は作らないので、段落番号もページ番号もずれない。
  // 余白に書いた線はその段落に、段落の上端からの座標で結びつく。足した高さは書き込みの JSON の段落ごとの gap（紙の px）に入れ、元の md・PDF は変えない。
  // md は段落の下の余白、PDF は直前のページと同じ大きさの白紙（ページの間と同じ隙間を空けて並べる）
  let gaps = {};   // 段落番号 -> 足した高さ
  const GAP_MD = 320, PAGE_GAP = 14;
  const gapUnit = (b) => isPdf() ? pageH(b) + PAGE_GAP : GAP_MD;
  function setGap(b, px) {
    const el = blocks[b];
    if (px) gaps[b] = px; else delete gaps[b];
    if (!el) return;
    if (!isPdf()) { el.style.paddingBottom = px ? px + 'px' : ''; return; }
    const ph = pageH(b), n = Math.round(px / (ph + PAGE_GAP));
    el.style.height = ph + px + 'px';
    for (const x of el.querySelectorAll('.blank')) x.remove();
    for (let i = 1; i <= n; i++) {
      const d = document.createElement('div'); d.className = 'blank';
      d.style.cssText = `top:${i * (ph + PAGE_GAP)}px;height:${ph}px`;
      el.append(d);
    }
  }
  const gapTop = (b) => blocks[b].offsetHeight - (gaps[b] || 0);   // 足した高さの始まり（段落の上端から）
  function addGap(b) {
    const from = gaps[b] || 0;
    setGap(b, from + gapUnit(b));   // 先に変えてから記録する（記録したときに保存される）
    push({ type: 'gap', b, from, to: from + gapUnit(b), list: [] });
  }
  // 一番下の余白（白紙1ページ分）を消す。そこに書いた線も一緒に消す（戻すで戻る）
  function removeGap(b) {
    const from = gaps[b] || 0;
    if (!from) return;
    const to = Math.max(0, from - gapUnit(b)), edge = gapTop(b) + to;
    const list = strokes.filter((s) => s.b === b && (s.bbox[1] + s.bbox[3]) / 2 > edge);
    removeAll(list);
    setGap(b, to);
    push({ type: 'gap', b, from, to, list });
  }

  // PDF の白紙: i 枚目（0 はページそのもの）の後ろに白紙を1枚入れる・i 枚目の白紙を消す。
  // 白紙はページの下に同じ間隔で並ぶので、後ろの白紙に書いた線はずらす（線は作り直して、戻すで戻る）
  function blankOp(n, i, add) {
    const u = gapUnit(n), from = gaps[n] || 0, to = from + (add ? u : -u), cut = (i + 1) * u - PAGE_GAP / 2;
    if (to < 0) return;
    const mid = (x) => (x.bbox[1] + x.bbox[3]) / 2, rm = [], old = [], moved = [];
    for (const x of strokes) {
      if (x.b !== n) continue;
      if (!add && mid(x) >= cut - u && mid(x) < cut) rm.push(x);
      else if (mid(x) >= cut) {
        const dy = add ? u : -u, m = { id: newId(), b: n, tool: x.tool, c: x.c, s: x.s, pen: x.pen, pts: x.pts.map(([px, py, pp]) => [px, py + dy, pp]) };
        if (x.g) m.g = moveG(x.g, 0, dy);
        bbox(m); old.push(x); moved.push(m);
      }
    }
    removeAll(rm.concat(old)); setGap(n, to); addAll(moved);
    push({ type: 'gap', b: n, from, to, list: rm, mv: [old, moved] });
  }

  // ---------- 設定 ----------
  const DEF = { token: '', repo: 'syakaikungg/sakai_study', branch: 'master', book: 'books/nishimori', session: '' };
  let cfg = { ...DEF };
  try { cfg = { ...DEF, ...JSON.parse(store.get(PREF + ':cfg') || '{}') }; } catch {}
  const online = () => navigator.onLine !== false;
  // 開いている本: 'gh'（設定の GitHub の本）か 'local:<id>'（ファイルから開いた本）
  let src = store.get(PREF + ':book') || 'gh';
  const isLocal = () => src !== 'gh';
  const canSync = () => !isLocal() && !!cfg.token && online();

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
  const isPdf = () => !!(book && book.pdf);
  const bookKey = () => isLocal() ? src : cfg.repo + '@' + cfg.branch + ':' + cfg.book;
  // 章の位置や最後に開いた章は本ごとに覚える（GitHub の本は前からのキーのまま）
  const memKey = (k) => PREF + ':' + k + (isLocal() ? ':' + src : '');
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
    const v = renderMarkdown.version;
    if (cached && cached.sha === src.sha && cached.v === v) return cached.html;
    const html = renderMarkdown(src.md, book.images);
    kv.set(hk, { sha: src.sha, v, html }).catch(() => {});
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
    const key = inkKey(CH), st = cs;
    st.blocks = serialize();
    saveT = setTimeout(() => kv.set(key, { blocks: st.blocks, sha: st.sha, pending: [...st.pending] }).catch(() => {}), 150);
  }
  function touch(list) {
    if (!cs) return;
    if (!isLocal()) for (const s of list) cs.pending.add(s.b);
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
    const key = inkKey(id);   // 送信中に本を切り替えても、元の本に保存する
    const st = id === CH ? cs : await kv.get(key).then((v) => v && { ...v, pending: new Set(v.pending) });
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
      await kv.set(key, { blocks: st.blocks, sha: st.sha, pending: [...st.pending] });
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
  async function refreshChapter() {   // GitHub 側の書き込みと答えを取り込む（他の端末・Claude の変更）
    if (!canSync() || !cs) return;
    const id = CH, st = cs;
    pullAnswers(id);
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
    // 答えを待っているときは、戻るたびに確かめる
    else if (Date.now() - lastPull > (asks.length ? 5000 : 60000)) { lastPull = Date.now(); refreshChapter(); }
  });

  // ---------- history ----------
  // op: {type:'add'|'erase', list} か {type:'replace', from, to}（投げ縄の移動・色変更）
  const opList = (op) => op.type === 'gap' ? op.list.concat(op.mv ? op.mv[0].concat(op.mv[1]) : [], { b: op.b }) : op.list || op.from.concat(op.to);
  function push(op) { undoStack.push(op); redoStack.length = 0; syncHist(); touch(opList(op)); }
  function addAll(list) { for (const s of list) { mount(s); strokes.push(s); } }
  function removeAll(list) { const set = new Set(list); strokes = strokes.filter((s) => !set.has(s)); for (const s of list) s.el.remove(); }
  function apply(op, inverse) {
    clearSel(); setEdit(null);
    if (op.type === 'replace') { removeAll(inverse ? op.to : op.from); addAll(inverse ? op.from : op.to); }
    else if (op.type === 'gap') {
      const [a, b] = op.mv || [[], []];
      removeAll(inverse ? b : op.list.concat(a)); setGap(op.b, inverse ? op.from : op.to); addAll(inverse ? op.list.concat(a) : b);
    }
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
    zoomNow.textContent = Math.round(scale * 100) + '%';
    const next = blocks.map((el) => el.offsetTop);
    if (next.some((v, i) => v !== tops[i])) { tops = next; for (const s of strokes) place(s); placeMarks(); placeBm(); showHandles(); }
    if (sel.length) showSel();
    if (pdfDoc) pdfPump();
  }
  function fitScale() {
    const avail = document.documentElement.clientWidth - 32;
    return Math.max(.5, Math.min(1.6, avail / W));
  }
  // at: 画面上の点 {x, y}。その点の下にある紙の位置（px, py。省略すると今その点にある位置）が、拡大後も x, y に来るようにする
  function setScale(next, mode, at) {
    const r0 = page.getBoundingClientRect();
    at = at || { x: innerWidth / 2, y: innerHeight / 2 };
    const px = at.px ?? (at.x - r0.left) / scale, py = at.py ?? (at.y - r0.top) / scale;
    scale = next; zoomMode = mode;
    layout();
    const r1 = page.getBoundingClientRect();
    wrap.scrollLeft += r1.left + px * scale - at.x;
    scrollBy(0, r1.top + py * scale - at.y);
    store.set(PREF + ':zoom', mode === 'fit' ? 'fit' : String(scale));
  }
  // 拡大率の一覧。先頭の隠れた項目に今の拡大率を出し、選んだあとはそこに戻す
  const zoomSel = $('#zoomv'), zoomNow = zoomSel.options[0];
  zoomSel.onchange = () => {
    const v = zoomSel.value;
    zoomSel.selectedIndex = 0;
    if (v === 'fit') setScale(fitScale(), 'fit'); else if (v) setScale(+v, 'manual');
  };

  // 2本指のピンチ。動かしている間は #sizer を transform で伸ばすだけにして（レイアウトし直さない）、指を離したときに拡大率を決める
  let pinch = null, pinchRaf = 0;
  const fingers = (e) => [...e.touches].filter((t) => t.touchType !== 'stylus');
  const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2, d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1 });
  const pinchK = () => Math.max(.5, Math.min(3, scale * pinch.m.d / pinch.m0.d)) / scale;
  function pinchDraw() {
    pinchRaf = 0;
    if (!pinch) return;
    const { m0, m, o } = pinch, k = pinchK();
    sizer.style.transformOrigin = `${o.x}px ${o.y}px`;
    sizer.style.transform = `translate(${m.x - m0.x}px, ${m.y - m0.y}px) scale(${k})`;
    zoomNow.textContent = Math.round(scale * k * 100) + '%';
  }
  function pinchEnd() {
    if (pinchRaf) cancelAnimationFrame(pinchRaf), pinchRaf = 0;
    const { m, r0 } = pinch, next = scale * pinchK(), fit = fitScale();
    const at = { x: m.x, y: m.y, px: (pinch.m0.x - r0.left) / scale, py: (pinch.m0.y - r0.top) / scale };
    pinch = null;
    sizer.classList.remove('pinching'); sizer.style.transform = ''; sizer.style.transformOrigin = '';
    // 画面幅の近くで離したら、画面幅にぴったり合わせる
    if (Math.abs(next - fit) / fit < .04) setScale(fit, 'fit', at); else setScale(next, 'manual', at);
  }
  document.addEventListener('touchstart', (e) => {
    const t = fingers(e);
    if (t.length !== 2 || pinch || (penDown && curType !== 'touch')) return;
    if (curId !== null) abortInput();   // 指で書いているときに2本目の指が来たら、書きかけの線はやめてピンチにする
    const r0 = page.getBoundingClientRect(), rs = sizer.getBoundingClientRect(), m0 = mid(t);
    pinch = { m0, m: m0, r0, o: { x: m0.x - rs.left, y: m0.y - rs.top } };
    sizer.classList.add('pinching');
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (!pinch) return;
    e.preventDefault();
    const t = fingers(e);
    if (t.length < 2) return;
    pinch.m = mid(t);
    if (!pinchRaf) pinchRaf = requestAnimationFrame(pinchDraw);
  }, { passive: false });
  const pinchUp = (e) => { if (pinch && fingers(e).length < 2) pinchEnd(); };
  document.addEventListener('touchend', pinchUp);
  document.addEventListener('touchcancel', pinchUp);
  // Safari が画面全体を拡大しないようにする（ツールバーまで大きくなるため）
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  addEventListener('resize', () => { if (zoomMode === 'fit') setScale(fitScale(), 'fit'); });
  new ResizeObserver(layout).observe(doc);

  // ---------- toolbar ----------
  function press(group, btn) { for (const b of group) b.setAttribute('aria-pressed', String(b === btn)); }
  const toolBtns = [$('#t-pen'), $('#t-hl'), $('#t-er'), $('#t-ls')];
  toolBtns.forEach((b) => b.onclick = () => {
    tool = { 't-pen': 'pen', 't-hl': 'hl', 't-er': 'er', 't-ls': 'ls' }[b.id]; press(toolBtns, b); setEdit(null);
    page.classList.toggle('erasing', tool === 'er');
    page.classList.toggle('lassoing', tool === 'ls');
    if (tool !== 'ls') clearSel();
  });
  // 投げ縄で選んでいるときは、色・太さボタンで選んだ線を変える。
  // 選んでいるボタンをもう一度押すと、そのボタンの色・太さを変える小窓が出る（ボタンは3つのまま。端末に覚える）
  const PALETTE = ['k', 'r', 'b', '#1f8a4c', '#e07b00', '#7b3fc4', '#8a5a2b', '#0f8b8d', '#d6338a', '#6b7280', '#c9a100', '#0b2f6b'];
  const colorBtns = [...document.querySelectorAll('#colors button')];
  const sizeBtns = [...document.querySelectorAll('#sizes button')];
  const pop = $('#pop'), popColors = $('#pop-colors'), popSize = $('#pop-size'), popRange = popSize.querySelector('input');
  let popFor = null;
  const pens = (() => { try { return JSON.parse(store.get(PREF + ':pens')) || {}; } catch { return {}; } })();
  const savePens = () => store.set(PREF + ':pens', JSON.stringify({ c: colorBtns.map((b) => b.dataset.c), s: sizeBtns.map((b) => +b.dataset.s) }));
  const swatch = (el, c) => { el.className = 'sw' + (/^#/.test(c) ? '' : ' ' + c); el.style.background = /^#/.test(c) ? c : ''; };
  const dotSize = (el, s) => { const w = Math.max(3, Math.min(16, s * 2)) + 'px'; el.style.width = el.style.height = w; };
  function setColorBtn(b, c) { b.dataset.c = c; swatch(b.firstElementChild, c); }
  function setSizeBtn(b, s) { b.dataset.s = String(s); dotSize(b.firstElementChild, s); }
  (pens.c || []).forEach((c, i) => colorBtns[i] && setColorBtn(colorBtns[i], c));
  (pens.s || []).forEach((s, i) => sizeBtns[i] && setSizeBtn(sizeBtns[i], s));
  for (const b of sizeBtns) if (b.getAttribute('aria-pressed') === 'true') size = +b.dataset.s;
  for (const b of colorBtns) if (b.getAttribute('aria-pressed') === 'true') color = b.dataset.c;
  function closePop() { pop.hidden = true; popFor = null; }
  function openPop(btn, kind) {
    popFor = btn;
    popColors.hidden = kind !== 'c'; popSize.hidden = kind !== 's';
    if (kind === 'c') popColors.replaceChildren(...PALETTE.map((c) => {
      const x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-pressed', String(c === btn.dataset.c));
      const s = document.createElement('span'); swatch(s, c); x.append(s);
      x.onclick = () => { setColorBtn(btn, c); savePens(); closePop(); color = c; press(colorBtns, btn); };
      return x;
    }));
    if (kind === 'c') {   // 一覧にない色は、iPad の色の選択画面から選ぶ
      const more = document.createElement('label'), inp = document.createElement('input');
      more.className = 'more'; more.title = 'ほかの色'; inp.type = 'color';
      inp.value = /^#/.test(btn.dataset.c) ? btn.dataset.c : INK[btn.dataset.c];
      inp.oninput = () => { setColorBtn(btn, inp.value); color = inp.value; press(colorBtns, btn); };
      inp.onchange = () => { savePens(); closePop(); };
      more.append(inp); popColors.append(more);
      if (/^#/.test(btn.dataset.c) && !PALETTE.includes(btn.dataset.c)) more.style.boxShadow = '0 0 0 2px var(--accent)';
    }
    else { popRange.value = btn.dataset.s; dotSize(popSize.firstElementChild, +btn.dataset.s); }
    pop.hidden = false;
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    pop.style.top = r.bottom + 6 + 'px';
  }
  popRange.oninput = () => { const s = +popRange.value; setSizeBtn(popFor, s); dotSize(popSize.firstElementChild, s); size = s; };
  popRange.onchange = () => { savePens(); if (sel.length) restyle({ s: size }); };
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target.closest('button') !== popFor) closePop(); }, true);
  colorBtns.forEach((b) => b.onclick = () => {
    const again = color === b.dataset.c && b.getAttribute('aria-pressed') === 'true' && tool === 'pen' && !sel.length;
    color = b.dataset.c; press(colorBtns, b);
    if (sel.length) restyle({ c: color }); else if (tool !== 'pen') toolBtns[0].click();
    if (again && popFor !== b) openPop(b, 'c'); else closePop();
  });
  sizeBtns.forEach((b) => b.onclick = () => {
    const again = b.getAttribute('aria-pressed') === 'true' && tool === 'pen' && !sel.length;
    size = +b.dataset.s; press(sizeBtns, b);
    if (sel.length) restyle({ s: size }); else if (tool !== 'pen') toolBtns[0].click();
    if (again && popFor !== b) openPop(b, 's'); else closePop();
  });
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
  let hold = null, holdT = 0;   // ペンを止めた位置と、図形に直すまでのタイマー
  let cur = null, curId = null, curType = '', curTop = 0, erased = null, pending = [], predicted = [], raf = 0;
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
  // 折り返しは縦横それぞれで数える（横の往復・縦のギザギザ・くるくる、どれでも拾う）
  function turnsOn(pts, ax, minRun) {
    let turns = 0, dir = 0, anchor = pts[0][ax];
    for (const p of pts) {
      const dv = p[ax] - anchor;
      if (dir >= 0 && dv < -minRun) { if (dir > 0) turns++; dir = -1; anchor = p[ax]; }
      else if (dir <= 0 && dv > minRun) { if (dir < 0) turns++; dir = 1; anchor = p[ax]; }
      else if ((dir > 0 && dv > 0) || (dir < 0 && dv < 0)) anchor = p[ax];
    }
    return turns;
  }
  function scribbleTargets(s) {
    const pts = s.pts;
    if (pts.length < 12) return null;
    const ty = top(s);
    const [a, b0, c, d0] = s.bbox, b = b0 + ty, d = d0 + ty, w = c - a, h = d - b;
    if (Math.max(w, h) < 8) return null;
    const tx = turnsOn(pts, 0, Math.max(3, w * .3)), tz = turnsOn(pts, 1, Math.max(3, h * .3));
    // 5回以上折り返す（m・w は3回、続け書きの漢字もたいてい4回まで）。横長・縦長の範囲を長く往復するなら3回でよい
    const r = Math.max(w, h) / Math.max(1, Math.min(w, h)), long = w >= h ? tx : tz;
    if (Math.max(tx, tz) < 5 && !(r >= 2 && long >= 3)) return null;
    const pad = Math.max(6, Math.min(w, h) * .2), hit = [];
    for (const o of strokes) {
      const oy = top(o), [oa, ob, oc, od] = o.bbox;
      if (oc < a - pad || oa > c + pad || od + oy < b - pad || ob + oy > d + pad) continue;
      let inside = 0;
      for (const [x, y] of o.pts) if (x >= a - pad && x <= c + pad && y + oy >= b - pad && y + oy <= d + pad) inside++;
      if (inside / o.pts.length < .5) continue;
      // ぐちゃぐちゃが実際にその線の上を通っていること。点のような短い線は、インクが重なっているときだけ
      const dot = Math.max(oc - oa, od - ob) < 4;
      const r2 = (dot ? Math.max(o.s || 3, s.s) * 1.5 : Math.max(o.s || 8, s.s) + 6) ** 2, need = dot ? 1 : Math.min(2, o.pts.length);
      let near = 0;
      outer: for (const [x, y] of o.pts) for (const [sx, sy] of pts) if ((x - sx) ** 2 + (y + oy - sy - ty) ** 2 < r2) { near++; if (near >= need) break outer; break; }
      if (near >= need) hit.push(o);
    }
    return hit.length ? hit : null;
  }
  // ---------- 投げ縄 ----------
  // 囲んだ線を選び、ドラッグで移動・色や太さの変更・削除ができる。
  // 移動や変更は「元の線を消して新しい線を足す」操作として記録し、移動先の段落に付け直す
  let sel = [], picked = [], lassoBox = null, lasso = null, drag = null;   // picked: 囲んだ段落の番号
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
    if (!sel.length && !picked.length) { selEl.remove(); selMenu.hidden = true; return; }
    const [a, b, c, d] = sel.length ? selBox() : lassoBox;
    selEl.setAttribute('x', a + dx); selEl.setAttribute('y', b + dy);
    selEl.setAttribute('width', c - a); selEl.setAttribute('height', d - b);
    svg.appendChild(selEl);
    selMenu.hidden = false;
    selMenu.style.left = Math.max(0, (a + dx) * scale) + 'px';
    selMenu.style.top = Math.max(0, (b + dy) * scale - selMenu.offsetHeight - 8) + 'px';
    $('#sel-n').textContent = sel.length ? `${sel.length}画` : `${picked.length}${isPdf() ? 'ページ' : '段落'}`;
    $('#sel-del').hidden = !sel.length;
    // 余白・白紙: 囲んだ最後の段落（ページ）の下に足す。囲んだ範囲が足した部分にかかっていれば、消すこともできる
    const last = picked[picked.length - 1], box = sel.length ? selBox() : lassoBox;
    $('#sel-gap').hidden = isPdf() || sel.length > 0 || !last;
    $('#sel-ungap').hidden = isPdf() || !last || !gaps[last] || !box || box[3] < tops[last] + gapTop(last);
  }
  function clearSel() { sel = []; picked = []; drag = null; lassoEl.remove(); showSel(); if (tool === 'ls') setEdit(null); }
  function finishLasso() {
    const poly = lasso; lasso = null; lassoEl.remove();
    if (poly.length < 3) return;
    sel = strokes.filter((s) => {
      const ty = top(s); let n = 0;
      for (const [x, y] of s.pts) if (inPoly(x, y + ty, poly)) n++;
      return n >= s.pts.length / 2;
    });
    // 囲んだ範囲にかかる段落と、選んだ線の段落（「Claudeに聞く」で渡す本文）
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of poly) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    lassoBox = [a, b, c, d];
    const set = new Set(sel.map((s) => s.b));
    blocks.forEach((el, i) => { if (i > 0 && tops[i] < d && tops[i] + el.offsetHeight > b) set.add(i); });
    picked = [...set].sort((x, y) => x - y);
    showSel(); setEdit(sel.length === 1 ? sel[0] : null);
    stat.textContent = sel.length ? `${sel.length}画を選択（ドラッグで移動・色や太さのボタンで変更）` : picked.length ? `${picked.length}${isPdf() ? 'ページ' : '段落'}を選択` : '囲んだ中に何もありません';
  }
  // 選んだ線を作り直す（移動量 dx,dy と、色・太さの変更 patch）
  function rebuild(dx, dy, patch) {
    const from = sel, to = from.map((s) => {
      const ty = top(s);
      const abs = s.pts.map(([x, y, p]) => [x + dx, y + ty + dy, p]);
      let minY = Infinity; for (const q of abs) minY = Math.min(minY, q[1]);
      const b = blockAt(minY), t = tops[b];
      const n = { id: newId(), b, tool: s.tool, c: s.c, s: s.s, pen: s.pen, pts: abs.map(([x, y, p]) => [x, y - t, p]), ...patch };
      if (s.g) n.g = moveG(s.g, dx, ty + dy - t);
      bbox(n); return n;
    });
    removeAll(from); addAll(to);
    push({ type: 'replace', from, to });
    sel = to; showSel(); setEdit(sel.length === 1 ? sel[0] : null);
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
  $('#sel-gap').onclick = () => { const b = picked[picked.length - 1]; clearSel(); addGap(b); stat.textContent = '余白を入れました'; };
  $('#sel-ungap').onclick = () => { const b = picked[picked.length - 1]; clearSel(); removeGap(b); stat.textContent = '余白を消しました'; };
  function lassoDown(e) {
    const [x, y] = toPage(e);
    if (sel.length) {
      const [a, b, c, d] = selBox();
      if (x >= a && x <= c && y >= b && y <= d) { drag = { x, y, dx: 0, dy: 0 }; selMenu.hidden = true; return; }
    }
    if (sel.length || picked.length) clearSel();
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
      picked = [...new Set([...picked, ...sel.map((s) => s.b)])].sort((x, y) => x - y);
      stat.textContent = `${sel.length}画を移動しました`;
      return;
    }
    if (lasso) finishLasso();
  }

  // ---------- Claudeに聞く ----------
  // 選んだ段落の本文（数式は TeX に戻す）と手書きの画像を、質問と一緒に Claude アプリへ渡す。
  // サブスクの範囲で使うため API は呼ばず、共有シート・クリップボード・claude.ai/new?q= を使う
  const INK = { k: '#15181f', r: '#d0302a', b: '#1d56d8' };
  function blockMd(el) {
    const c = el.cloneNode(true);
    for (const k of c.querySelectorAll('.katex-display')) { const t = k.querySelector('[data-tex]'); k.replaceWith(`\n$$${t ? t.dataset.tex : ''}$$\n`); }
    for (const k of c.querySelectorAll('.katex[data-tex]')) k.replaceWith(`$${k.dataset.tex}$`);
    for (const i of c.querySelectorAll('img')) i.replaceWith(`[${i.alt || '図'}]`);
    const t = c.textContent.trim();
    return /^H[1-6]$/.test(el.tagName) ? '#'.repeat(+el.tagName[1]) + ' ' + t : t;
  }
  const pagesText = () => picked[0] + (picked.length > 1 ? '〜' + picked[picked.length - 1] : '') + 'ページ';
  function passage() {
    if (isPdf()) return `${pagesText()}（囲んだ範囲を画像で送ります）`;
    const out = [];
    const first = picked[0];
    for (let i = first - 1; i > 0; i--) if (/^H[1-6]$/.test(blocks[i].tagName)) { out.push(blockMd(blocks[i])); if (i < first - 1) out.push('…'); break; }
    for (const i of picked) out.push(blockMd(blocks[i]));
    return out.join('\n\n');
  }
  function inkImage() {   // 選んだ段落の書き込み（なければ選んだ線）を白地の PNG に
    const list = strokes.filter((s) => picked.includes(s.b) || sel.includes(s));
    if (!list.length) return null;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const s of list) { const ty = top(s); a = Math.min(a, s.bbox[0]); b = Math.min(b, s.bbox[1] + ty); c = Math.max(c, s.bbox[2]); d = Math.max(d, s.bbox[3] + ty); }
    const pad = 20, k = 2, cv = document.createElement('canvas');
    cv.width = Math.ceil((c - a + 2 * pad) * k); cv.height = Math.ceil((d - b + 2 * pad) * k);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.scale(k, k); g.translate(pad - a, pad - b);
    drawInk(g, list);
    return cv;
  }
  function drawInk(g, list) {
    for (const s of [...list].sort((x, y) => (y.tool === 'hl') - (x.tool === 'hl'))) {
      g.save(); g.translate(0, top(s));
      g.fillStyle = s.tool === 'hl' ? 'rgba(255,213,61,.45)' : INK[s.c] || (/^#/.test(s.c) ? s.c : INK.k);
      g.fill(new Path2D(s.el.getAttribute('d')));
      g.restore();
    }
  }
  // PDF は本文の文字を取らず、囲んだ範囲をページの絵と書き込みごと画像にする
  function pdfImage() {
    let [a, b, c, d] = lassoBox;
    if (sel.length) { const q = selBox(); a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[2]); d = Math.max(d, q[3]); }
    a = Math.max(0, a); c = Math.min(W, c);
    if (c - a < 4 || d - b < 4) return null;
    const k = Math.min(3, Math.sqrt(4e6 / ((c - a) * (d - b)))), cv = document.createElement('canvas');
    cv.width = Math.ceil((c - a) * k); cv.height = Math.ceil((d - b) * k);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.scale(k, k); g.translate(-a, -b);
    for (const n of picked) { const p = drawn.get(n); if (p && p.cv.width) g.drawImage(p.cv, 0, tops[n], W, pageH(n)); }
    drawInk(g, strokes.filter((s) => { const ty = top(s); return s.bbox[2] > a && s.bbox[0] < c && s.bbox[3] + ty > b && s.bbox[1] + ty < d; }));
    return cv;
  }
  let askImg = null, askId = '';
  function askText(withImg) {
    const ch = book && book.chapters.find((c) => c.id === CH);
    const q = $('#ask-q').value.trim();
    if (isPdf()) return [
      `PDF「${book.title}」の${pagesText()}を読んでいて質問があります。`, '',
      withImg ? '添付の画像は、その箇所を切り出したものです（私の手書きの書き込みも入っています）。' : '該当箇所の画像は別に貼り付けます。',
      `質問: ${q || '（この箇所を分かりやすく説明してください）'}`,
    ].join('\n');
    return [
      `「${book.title || book.source || ''}」${ch ? ' ' + ch.label : ''} を読んでいて質問があります。`,
      '', '該当箇所（Markdown、数式は TeX）:', '"""', passage(), '"""', '',
      withImg ? '添付の画像は、この箇所に私が手書きで書き込んだものです。' : null,
      `質問: ${q || '（この箇所を分かりやすく説明してください）'}`,
    ].filter((v) => v != null).join('\n');
  }
  $('#sel-ask').onclick = () => {
    if (!picked.length) return;
    askId = Math.random().toString(36).slice(2, 8);
    askImg = isPdf() ? pdfImage() : inkImage();
    $('#ask-pv').textContent = passage();
    $('#ask-img').hidden = !askImg;
    if (askImg) $('#ask-img').src = askImg.toDataURL('image/png');
    $('#ask-msg').textContent = '';
    $('#ask-sess').value = cfg.session || ''; syncSess();
    $('#ask').showModal();
    links();
  };
  async function copy(t) { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } }
  // Claude を開くボタンは本物のリンク（新しいタブを使うと、iPad の Chrome に空のタブが残るため）。
  // href は質問を書き換えるたびに作り直し、押したときは質問文のコピーだけをする
  const newUrl = () => 'https://claude.ai/code/new?' + new URLSearchParams({ q: codeText(), repo: cfg.repo, branch: cfg.branch });
  function links() {
    if (!picked.length) return;
    $('#ask-open').href = 'https://claude.ai/new?q=' + encodeURIComponent(askText(false));
    $('#ask-code').href = sessUrl() || newUrl();
    $('#ask-new').href = newUrl();
  }
  $('#ask-q').addEventListener('input', links);
  $('#ask-open').onclick = async () => {
    const ok = await copy(askText(false));
    $('#ask-msg').textContent = (ok ? '質問文をコピーしました。' : '') + (askImg ? '手書きの画像も送るときは「共有」を使ってください。' : '');
  };
  // sakai_study のリポジトリで Claude Code のセッションを開く。本文と書き込みはリポジトリにあるので、場所を伝える
  // いつものセッション（claude.ai/code/<id>）があればそれを開いて質問文を貼ってもらう。なければ新しいセッションを質問文つきで開く
  const sessUrl = () => { const v = (cfg.session || '').trim(), m = v.match(/\/code\/([\w-]+)/); const id = m ? m[1] : /^[\w-]+$/.test(v) ? v : ''; return id && id !== 'new' ? 'https://claude.ai/code/' + id : ''; };
  function syncSess() {
    $('#ask-code').textContent = sessUrl() ? 'いつものセッションで聞く' : 'sakai_studyで聞く（新しいセッション）';
    $('#ask-new').hidden = !sessUrl() || isLocal();
    // ファイルから開いた本はリポジトリにないので、Claude アプリに渡す方だけ
    $('#ask-code').hidden = $('.sess').hidden = isLocal();
    // PDF は画像がないと伝わらないので、画像を渡せる「共有」を主にする
    $('#ask-open').classList.toggle('primary', isLocal() && !isPdf());
    $('#ask-share').classList.toggle('primary', isPdf());
  }
  $('#ask-sess').onchange = () => { cfg.session = $('#ask-sess').value.trim(); store.set(PREF + ':cfg', JSON.stringify(cfg)); syncSess(); links(); };
  function codeText() {
    const ch = book.chapters.find((c) => c.id === CH);
    const q = $('#ask-q').value.trim();
    const hasInk = strokes.some((s) => picked.includes(s.b));
    return [
      `Ink Reader からの質問です（CLAUDE.md の「Ink Reader からの質問」を参照。先に git pull して最新の書き込みを取り込んでください）。`,
      `本: ${cfg.book}（${book.title || ''}） 章: ${CH}「${ch ? ch.label : ''}」 本文: ${cfg.book}/${ch ? ch.file : ''}`,
      `段落番号: ${picked.join(', ')}` + (hasInk ? `（手書きあり: python scripts/ink_view.py ${cfg.book} ${CH} ${picked.join(' ')}）` : ''),
      '', '該当箇所:', '"""', passage(), '"""', '',
      `質問: ${q || 'この箇所を分かりやすく説明してください'}`,
      '', `答えは ${cfg.book}/answers/${CH}.md に追記して push してください（質問ID: ${askId}）。`,
    ].join('\n');
  }
  async function askCode(fresh) {
    const t = codeText(), url = fresh ? '' : sessUrl();
    if (cs && cs.pending.size) pushChapter(CH);   // 手書きを先に GitHub へ
    addAsk({ id: askId, b: picked.slice(), q: $('#ask-q').value.trim() });
    const ok = await copy(t);
    $('#ask-msg').textContent = (url ? (ok ? '質問文をコピーしました。セッションに貼り付けて送ってください。' : 'コピーできませんでした。') : (ok ? '質問文をコピーしました。' : '') + '開いたセッションのURLを下に入れておくと、次から同じセッションで聞けます。')
      + (cs && cs.pending.size && !canSync() ? '（未送信の書き込みはまだ GitHub にありません）' : '');
  }
  $('#ask-code').onclick = () => askCode(false);
  $('#ask-new').onclick = () => askCode(true);
  $('#ask-share').onclick = async () => {
    const t = askText(!!askImg);
    try {
      const files = askImg ? [new File([await new Promise((r) => askImg.toBlob(r, 'image/png'))], 'ink.png', { type: 'image/png' })] : [];
      const data = files.length && navigator.canShare && navigator.canShare({ files }) ? { text: t, files } : { text: t };
      await copy(t);
      await navigator.share(data);
      $('#ask-msg').textContent = '共有シートで Claude を選んでください（質問文はコピー済みです）';
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      $('#ask-msg').textContent = (await copy(t)) ? 'この端末では共有できないので、質問文をコピーしました' : '共有できませんでした';
    }
  };

  // ---------- Claude の答え ----------
  // 「sakai_studyで聞く」で送った質問に、sakai_study のセッションが <本>/answers/<章>.md へ答えを追記する。
  // 答えごとに `<!-- ink-answer id=<質問ID> b=<段落番号,…> -->` の行で始め、その下が答えの md（数式つき）。
  // 質問した段落の右余白に「Q」を出し（答え待ちは薄く）、押すと段落の下に答えを開く。答えの要素は blocks に入れない
  const ansKey = (id) => 'ans:' + bookKey() + ':' + id, askKey = (id) => 'asks:' + bookKey() + ':' + id;
  const qs = $('#qs');
  let answers = [], asks = [], ansMd = null, openQ = new Set();   // 今の章の答え [{id,b,md}]・答え待ち [{id,b,q}]・開いている段落
  function parseAnswers(md) {
    const out = []; let cur = null;
    for (const line of (md || '').split('\n')) {
      const m = line.match(/^<!--\s*ink-answer\s+(.*?)\s*-->\s*$/);
      if (m) {
        const a = Object.fromEntries([...m[1].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
        cur = { id: a.id || '', b: (a.b || '').split(',').map(Number).filter((n) => n > 0), lines: [] };
        if (cur.b.length) out.push(cur);
      } else if (cur) cur.lines.push(line);
    }
    return out.map((a) => ({ id: a.id, b: a.b, md: a.lines.join('\n').trim() })).reverse();   // 新しい順
  }
  const anchor = (x) => Math.min(...x.b);   // 何段落かにまたがる質問は、最初の段落に付ける
  function setAnswers(md, list) {
    ansMd = md; answers = parseAnswers(md); asks = list || asks;
    const n = asks.length;
    asks = asks.filter((q) => !answers.some((a) => a.id === q.id));   // 答えが届いた質問は答え待ちから外す
    if (asks.length !== n) kv.set(askKey(CH), asks).catch(() => {});
    showMarks();
  }
  function addAsk(q) {
    if (!CH || isLocal() || asks.some((x) => x.id === q.id)) return;
    asks.push(q); kv.set(askKey(CH), asks).catch(() => {});
    showMarks();
  }
  function showMarks() {
    for (const el of doc.querySelectorAll('.ans')) el.remove();
    const g = new Map();
    for (const x of [...asks].reverse().concat(answers)) { const k = anchor(x); if (blocks[k]) g.set(k, (g.get(k) || 0) + 1); }
    qs.replaceChildren(...[...g].map(([k, n]) => {
      const m = document.createElement('button');
      m.type = 'button'; m.className = 'qm'; m.dataset.b = k; m.textContent = n > 1 ? 'Q' + n : 'Q';
      m.classList.toggle('wait', !answers.some((a) => anchor(a) === k));
      m.setAttribute('aria-expanded', String(openQ.has(k)));
      m.setAttribute('aria-label', 'Claudeの答え');
      return m;
    }));
    for (const k of openQ) if (g.has(k)) openAns(k);
    placeMarks();
  }
  function placeMarks() { for (const m of qs.children) m.style.top = (tops[+m.dataset.b] || 0) + 'px'; }
  function openAns(k) {
    const box = document.createElement('aside');
    box.className = 'ans'; box.dataset.b = k;
    for (const q of asks.filter((x) => anchor(x) === k).reverse()) {
      const d = document.createElement('div'); d.className = 'wait';
      d.textContent = `答えを待っています${q.q ? '：' + q.q : ''}`;
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '取り消す';
      x.onclick = () => { asks = asks.filter((a) => a !== q); kv.set(askKey(CH), asks).catch(() => {}); showMarks(); };
      d.append(x); box.append(d);
    }
    for (const a of answers.filter((x) => anchor(x) === k)) {
      const d = document.createElement('div'); d.className = 'a';
      d.innerHTML = renderMarkdown(a.md, book && book.images);
      box.append(d);
    }
    blocks[k].after(box);
  }
  function toggleAns(k) {
    if (openQ.has(k)) openQ.delete(k); else openQ.add(k);
    showMarks();
  }
  // Pencil で押したときは click が来ない（書くために touchstart を止めている）ので pointerup で開閉する
  let qDown = null;
  qs.addEventListener('pointerdown', (e) => { qDown = e.target.closest('.qm'); });
  qs.addEventListener('pointerup', (e) => { const m = e.target.closest('.qm'); if (m && m === qDown) toggleAns(+m.dataset.b); qDown = null; });
  qs.addEventListener('click', (e) => { const m = e.target.closest('.qm'); if (m && e.detail === 0) toggleAns(+m.dataset.b); });   // キーボード
  async function pullAnswers(id) {
    if (!canSync()) return;
    try {
      const md = (await gh(cfg.book + '/answers/' + id + '.md', { raw: true })) || '';
      if (id !== CH || md === ansMd) return;
      kv.set(ansKey(id), md).catch(() => {});
      setAnswers(md);
      if (asks.length === 0 && answers.length) stat.textContent = 'Claudeの答えが届いています（右の「Q」）';
    } catch {}
  }

  function frame() {
    raf = 0; frames++;
    if (!cur) return;
    if (pending.length) { cur.pts.push(...pending); pending = []; }
    render(cur, predicted.length ? cur.pts.concat(predicted) : cur.pts, false);
  }

  // 図形（g）から線の点の列を作る。g = { k: 'line'|'poly'|'ellipse'|'circle', v, a（傾き）, p（筆圧） }
  // line・poly の v は頂点、ellipse・circle の v は [中心, [横の半径, 縦の半径]]。座標は線と同じ（段落の上端から）
  function genPts(g) {
    const p = g.p, out = [];
    if (g.k === 'line' || g.k === 'poly') {
      const list = g.v, closed = g.k === 'poly', n = closed ? list.length : list.length - 1;
      for (let i = 0; i < n; i++) {
        const [x0, y0] = list[i], [x1, y1] = list[(i + 1) % list.length], k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3));
        for (let j = 0; j < k; j++) out.push([x0 + (x1 - x0) * j / k, y0 + (y1 - y0) * j / k, p]);
      }
      const last = closed ? list[0] : list[list.length - 1]; out.push([last[0], last[1], p]);
      return out;
    }
    const [[cx, cy], [rx, ry]] = g.v, a = g.a || 0, ca = Math.cos(a), sa = Math.sin(a);
    for (let i = 0; i <= 72; i++) { const t = i / 72 * 2 * Math.PI, x = rx * Math.cos(t), y = ry * Math.sin(t); out.push([cx + x * ca - y * sa, cy + x * sa + y * ca, p]); }
    return out;
  }
  const NAMES = { line: '直線', poly: '多角形', ellipse: '楕円', circle: '円' };
  const moveG = (g, dx, dy) => ({ ...g, v: g.k === 'ellipse' || g.k === 'circle' ? [[g.v[0][0] + dx, g.v[0][1] + dy], g.v[1]] : g.v.map(([x, y]) => [x + dx, y + dy]) });
  // 水平・垂直・斜め45度に近い向きはそろえる
  function snapAngle(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], ang = Math.atan2(dy, dx), step = Math.PI / 4, r = Math.round(ang / step) * step;
    if (Math.abs(ang - r) > 4 * Math.PI / 180) return b;
    const l = Math.hypot(dx, dy); return [a[0] + l * Math.cos(r), a[1] + l * Math.sin(r)];
  }
  // 手書きの線を図形に直す。点の列 [[x,y,p]] から、直線・円（楕円）・三角形・四角形のどれかに近ければその図形 g を返す
  function fitShape(pts) {
    if (pts.length < 6) return null;
    // ペンを止めている間の細かいぶれで長さが増えないよう、2.5px より近い点は飛ばす
    const ds = [pts[0]]; for (const q of pts) { const l = ds[ds.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= 2.5) ds.push(q); }
    ds.push(pts[pts.length - 1]);
    let len = 0; for (let i = 1; i < ds.length; i++) len += Math.hypot(ds[i][0] - ds[i - 1][0], ds[i][1] - ds[i - 1][1]);
    if (len < 24) return null;
    const ps = pts.map((q) => q[2]).sort((x, y) => x - y), p = ps[ps.length >> 1];
    const A = pts[0], B = pts[pts.length - 1], chord = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const dist = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / l; };
    // 直線: 始点と終点を結んだ線から大きく外れない（書き始めの小さなはねは許す）
    if (chord > len * .7) {
      let dev = 0; for (const q of ds) dev = Math.max(dev, dist(q, A, B));
      if (dev < Math.max(7, chord * .1)) return { k: 'line', v: [A.slice(0, 2), snapAngle(A, B)], p };
      return null;
    }
    if (chord > len * .25) return null;   // 閉じていない曲線はそのまま
    // 閉じた形: 角を探す（ダグラス・ポイカー法）。3つなら三角形、4つなら四角形、角がなければ円
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    const size = Math.max(c - a, d - b);
    if (size < 12) return null;
    const simplify = (list, eps) => {
      let far = 0, at = 0;
      for (let i = 1; i < list.length - 1; i++) { const h = dist(list[i], list[0], list[list.length - 1]); if (h > far) { far = h; at = i; } }
      if (far <= eps) return [list[0], list[list.length - 1]];
      return simplify(list.slice(0, at + 1), eps).slice(0, -1).concat(simplify(list.slice(at), eps));
    };
    // 始点から一番遠い点で2つに分けてから角を探す（閉じた線のまま探すと始点と終点が重なって探せない）
    let fi = 0, fd = 0; ds.forEach((q, i) => { const h = Math.hypot(q[0] - A[0], q[1] - A[1]); if (h > fd) { fd = h; fi = i; } });
    const eps = size * .1;
    const corners = simplify(ds.slice(0, fi + 1), eps).slice(0, -1).concat(simplify(ds.slice(fi), eps).slice(0, -1));
    const cs = []; for (const q of corners) if (!cs.some((r) => Math.hypot(r[0] - q[0], r[1] - q[1]) < size * .2)) cs.push(q);   // 近すぎる角はまとめる
    if (cs.length === 3) return { k: 'poly', v: cs.map((q) => q.slice(0, 2)), p };
    if (cs.length === 4) {
      // 辺がほぼ水平・垂直なら、きれいな長方形にする
      const axis = cs.every((q, i) => { const r = cs[(i + 1) % 4], ang = Math.atan2(r[1] - q[1], r[0] - q[0]); return Math.min(Math.abs(Math.sin(ang)), Math.abs(Math.cos(ang))) < .17; });
      return { k: 'poly', v: axis ? [[a, b], [c, b], [c, d], [a, d]] : cs.map((q) => q.slice(0, 2)), p };
    }
    const cx = (a + c) / 2, cy = (b + d) / 2, rx = (c - a) / 2, ry = (d - b) / 2;
    let err = 0; for (const [x, y] of pts) err += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
    if (err / pts.length > .14) return null;
    if (Math.abs(rx - ry) < Math.max(rx, ry) * .12) { const r = (rx + ry) / 2; return { k: 'circle', v: [[cx, cy], [r, r]], a: 0, p }; }
    return { k: 'ellipse', v: [[cx, cy], [rx, ry]], a: 0, p };
  }
  const shapeName = (g) => g.k === 'poly' ? (g.v.length === 3 ? '三角形' : '四角形') : NAMES[g.k];
  // 図形に直したあと、ペンを離さずに動かすと形が変わる。直線は終わりの点がペンについてくる。
  // ほかの図形は、中心から見たペンの向き・距離に合わせて回して大きさを変える
  function adjustLive(q) {
    const { g0, q0 } = cur.live, g = cur.g;
    if (g.k === 'line') g.v = [g0.v[0], snapAngle(g0.v[0], q)];
    else {
      const c = g.k === 'poly' ? g0.v.reduce((m, [x, y]) => [m[0] + x / g0.v.length, m[1] + y / g0.v.length], [0, 0]) : g0.v[0];
      const r0 = Math.hypot(q0[0] - c[0], q0[1] - c[1]);
      if (r0 < 6) return;
      const k = Math.max(.1, Math.hypot(q[0] - c[0], q[1] - c[1]) / r0), rot = g.k === 'circle' ? 0 : Math.atan2(q[1] - c[1], q[0] - c[0]) - Math.atan2(q0[1] - c[1], q0[0] - c[0]);
      if (g.k === 'poly') { const cr = Math.cos(rot), sr = Math.sin(rot); g.v = g0.v.map(([x, y]) => { const dx = (x - c[0]) * k, dy = (y - c[1]) * k; return [c[0] + dx * cr - dy * sr, c[1] + dx * sr + dy * cr]; }); }
      else { g.v = [c, [g0.v[1][0] * k, g0.v[1][1] * k]]; g.a = (g0.a || 0) + rot; }
    }
    cur.pts = genPts(g);
    if (!raf) raf = requestAnimationFrame(frame);
  }

  // ---------- 図形の形を変える ----------
  // 図形に直した線（g がある線）は、書いた直後か投げ縄で1本だけ選んだとき、頂点などに丸いつまみが出る。
  // つまみをペンや指で動かすと形が変わる（直線: 両端、多角形: 各頂点、楕円: 横と縦の半径と傾き、円: 半径）
  let edit = null, hdrag = null;
  const hdG = document.createElementNS(NS, 'g'); hdG.setAttribute('class', 'hd');
  function handlePts(s) {
    const g = s.g, ty = top(s);
    if (g.k === 'line' || g.k === 'poly') return g.v.map(([x, y]) => [x, y + ty]);
    const [[cx, cy], [rx, ry]] = g.v, a = g.a || 0;
    const pts = [[cx + rx * Math.cos(a), cy + rx * Math.sin(a) + ty]];
    if (g.k === 'ellipse') pts.push([cx - ry * Math.sin(a), cy + ry * Math.cos(a) + ty]);
    return pts;
  }
  function showHandles() {
    if (!edit || !strokes.includes(edit)) { edit = null; hdG.remove(); return; }
    hdG.replaceChildren(...handlePts(edit).map(([x, y]) => {
      const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 7 / scale); return c;
    }));
    svg.appendChild(hdG);
  }
  function setEdit(s) { edit = s && s.g ? s : null; showHandles(); }
  function hitHandle(x, y) {
    if (!edit) return -1;
    const r = 18 / scale;
    return handlePts(edit).findIndex(([hx, hy]) => Math.hypot(hx - x, hy - y) < r);
  }
  function dragHandle(x, y) {   // x, y は紙の座標
    const s = edit, g = hdrag.g, ty = top(s), q = [x, y - ty];
    if (g.k === 'line') { g.v[hdrag.i] = snapAngle(g.v[1 - hdrag.i], q); }
    else if (g.k === 'poly') g.v[hdrag.i] = q;
    else {
      const [c, [rx, ry]] = g.v, dx = q[0] - c[0], dy = q[1] - c[1], l = Math.max(2, Math.hypot(dx, dy));
      if (g.k === 'circle') g.v = [c, [l, l]];
      else if (hdrag.i === 0) { g.v = [c, [l, ry]]; g.a = Math.atan2(dy, dx); }
      else g.v = [c, [rx, l]];
    }
    s.g = g; s.pts = genPts(g);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (!hdrag) return; render(s, null, true); showHandles(); });
  }
  function endHandle() {
    const s = edit, { g0, pts0 } = hdrag; hdrag = null;
    if (JSON.stringify(s.g) === JSON.stringify(g0)) { s.g = g0; s.pts = pts0; render(s, null, true); showHandles(); return; }   // 触っただけ
    const n = { id: newId(), b: s.b, tool: s.tool, c: s.c, s: s.s, pen: s.pen, g: s.g, pts: s.pts };
    s.g = g0; s.pts = pts0; render(s, null, true);
    bbox(n); removeAll([s]); addAll([n]); push({ type: 'replace', from: [s], to: [n] });
    if (sel.includes(s)) { sel = [n]; showSel(); }
    setEdit(n);
    stat.textContent = shapeName(n.g) + 'の形を変えました';
  }
  const cloneG = (g) => ({ ...g, v: g.v.map((q) => q.slice()) });

  page.addEventListener('pointerdown', (e) => {
    if (!accepts(e) || curId !== null || pinch || e.target.closest('.qm, .ans')) return;   // 「Q」と答えの上には書かない
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    page.setPointerCapture(e.pointerId);
    curId = e.pointerId; curType = e.pointerType; penDown = true;
    t0 = e.timeStamp; samples = 1; frames = 0;
    if (edit && (tool === 'pen' || tool === 'ls')) {
      const [x, y] = toPage(e), i = hitHandle(x, y);
      if (i >= 0) { hdrag = { i, g: cloneG(edit.g), g0: edit.g, pts0: edit.pts }; selMenu.hidden = true; return; }
      if (tool === 'pen') setEdit(null);
    }
    if (tool === 'er') { erased = []; eraseAt(toPage(e)); return; }
    if (tool === 'ls') { lassoDown(e); return; }
    const b = blockAt(toPage(e)[1]);
    curTop = tops[b];
    cur = { id: newId(), b, tool, c: color, s: size, pen: e.pointerType === 'pen', pts: [toRel(e)] };
    cur.el = document.createElementNS(NS, 'path'); paint(cur.el, cur);
    hold = null; holdT = 0;
    mount(cur); render(cur, null, false);
  });
  page.addEventListener('pointermove', (e) => {
    if (e.pointerId !== curId) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    samples += list.length;
    if (hdrag) { const [x, y] = toPage(list[list.length - 1]); dragHandle(x, y); return; }
    if (tool === 'er' && erased) { for (const ev of list) eraseAt(toPage(ev)); return; }
    if (tool === 'ls') { lassoMove(list); return; }
    if (!cur) return;
    if (cur.shape) { adjustLive(toRel(list[list.length - 1])); return; }
    for (const ev of list) pending.push(toRel(ev));
    predicted = e.getPredictedEvents ? e.getPredictedEvents().map(toRel) : [];
    if (!raf) raf = requestAnimationFrame(frame);
    // ペンを止めたまま押さえていたら、図形に直す（直線・円・三角・四角）
    if (cur.tool === 'pen') {
      const q = pending[pending.length - 1];
      if (!hold || Math.hypot(q[0] - hold[0], q[1] - hold[1]) > 3) { hold = q; clearTimeout(holdT); holdT = setTimeout(snapShape, 450); }
    }
  });
  function snapShape() {
    if (!cur || cur.shape || curId === null) return;
    if (pending.length) { cur.pts.push(...pending); pending = []; }
    const g = fitShape(cur.pts);
    if (!g) return;
    cur.g = g; cur.pts = genPts(g); cur.shape = true; predicted = [];
    cur.live = { g0: cloneG(g), q0: hold };
    render(cur, null, false);
    stat.textContent = shapeName(g) + 'に直しました（離さずに動かすと向きや大きさが変わります）';
  }
  function end(e) {
    if (e.pointerId !== curId) return;
    curId = null; penDown = false; clearTimeout(holdT);
    if (hdrag) { endHandle(); return; }
    if (pdfDoc) pdfPump();
    const dt = (e.timeStamp - t0) / 1000;
    if (erased) { if (erased.length) push({ type: 'erase', list: erased }); erased = null; return; }
    if (tool === 'ls') { lassoUp(); return; }
    if (!cur) return;
    if (pending.length) { cur.pts.push(...pending); pending = []; }
    predicted = [];
    bbox(cur);
    const victims = cur.tool === 'pen' && !cur.shape ? scribbleTargets(cur) : null;
    if (victims) {
      cur.el.remove(); removeAll(victims); push({ type: 'erase', list: victims });
      stat.textContent = `ぐちゃぐちゃ消し: ${victims.length}画を消しました`;
      cur = null; return;
    }
    render(cur, null, true); strokes.push(cur);
    push({ type: 'add', list: [cur] });
    const tag = cur.pen ? 'Pencil入力' : '入力';
    if (dt > .25 && !cur.shape) stat.textContent = `${tag} ${Math.round(samples / dt)}Hz・描画 ${Math.round(frames / dt)}fps`;
    const shaped = cur.shape; delete cur.shape; delete cur.live;
    if (shaped) setEdit(cur);
    cur = null;
  }
  // 書いている途中でやめる（指で書いているときにピンチが始まったとき）。消しゴムで消した分はそのまま残す
  function abortInput() {
    clearTimeout(holdT);
    if (hdrag) { const s = edit; s.g = hdrag.g0; s.pts = hdrag.pts0; render(s, null, true); hdrag = null; showHandles(); }
    try { page.releasePointerCapture(curId); } catch {}
    curId = null; penDown = false;
    if (erased) { if (erased.length) push({ type: 'erase', list: erased }); erased = null; }
    if (drag) { drag = null; for (const s of sel) place(s); showSel(); }
    if (lasso) { lasso = null; lassoEl.remove(); }
    if (cur) { cur.el.remove(); cur = null; pending = []; predicted = []; }
  }
  page.addEventListener('pointerup', end);
  page.addEventListener('pointercancel', end);


  // ---------- PDF ----------
  // PDF はページを紙の切れ目として縦に並べる。1ページを #doc の子要素1つにし、段落と同じ仕組みで書き込みを結びつける
  // （段落番号 = ページ番号、座標はページの上端から測った幅 680 の紙の px）。
  // 描くのは画面の近くのページだけで、離れたページの canvas は捨てる（数百ページでも Safari のメモリに収める）。
  // PDF.js は PDF を開くときに初めて読み込む（md だけ読むときは重くしない）
  const PDFJS = 'vendor/pdfjs/';
  let pdfjs = null, pdfDoc = null, pdfOpening = null, pdfIO = null, pdfBusy = false, outline = null;
  const near = new Set(), drawn = new Map();   // 画面の近くのページ番号 / 描いたページ -> { cv, k（紙 1px あたりの canvas の画素） }
  async function openPdf(data) {
    pdfjs ||= await import('./' + PDFJS + 'pdf.min.mjs');
    const base = new URL(PDFJS, location.href).href;
    pdfjs.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
    return pdfjs.getDocument({ data, cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/',
      wasmUrl: base + 'wasm/', iccUrl: base + 'iccs/', isEvalSupported: false, enableHWA: true }).promise;
  }
  const pdfBytes = async (v) => new Uint8Array(v instanceof Blob ? await v.arrayBuffer() : v);
  const pageH = (n) => Math.round(W * book.sizes[n - 1][1] / book.sizes[n - 1][0]);
  async function pdfHtml() {
    if (!pdfDoc) {
      const key = src;
      pdfOpening ||= kv.get('pdf:' + key).then(async (v) => v ? openPdf(await pdfBytes(v)) : null);
      const d = await pdfOpening;
      if (key !== src) { if (d) d.destroy(); return null; }
      pdfDoc = d; outline = null;
    }
    if (!pdfDoc) return null;
    return book.sizes.map((_, i) => `<div class="pg" data-n="${i + 1}" style="height:${pageH(i + 1)}px;--ph:${pageH(i + 1)}px"></div>`).join('');
  }
  function startPdf() {
    stopPdf(); showPgno();
    if (!isPdf() || !pdfDoc) return;
    pdfIO = new IntersectionObserver((es) => {
      for (const e of es) { const n = +e.target.dataset.n; if (e.isIntersecting) near.add(n); else { near.delete(n); dropPage(n); } }
      pdfPump();
    }, { rootMargin: '100% 0px' });   // 上下 1 画面分先まで描いておく
    for (const el of blocks) if (el.dataset.n) pdfIO.observe(el);
  }
  function dropPage(n) {
    const p = drawn.get(n);
    if (!p) return;
    p.cv.width = p.cv.height = 0; p.cv.remove(); drawn.delete(n); dropHd(n);   // 幅を 0 にすると Safari がすぐメモリを返す
    if (pdfDoc) pdfDoc.getPage(n).then((pg) => pg.cleanup()).catch(() => {});
  }
  function stopPdf() { if (pdfIO) pdfIO.disconnect(); pdfIO = null; for (const n of [...drawn.keys()]) dropPage(n); near.clear(); }
  function closePdf() { stopPdf(); if (pdfDoc) pdfDoc.destroy(); pdfDoc = pdfOpening = outline = ptext = null; }
  // 拡大率に合わせた解像度で描く。拡大しすぎたときは、1ページの画素数を上限で止める（Safari の canvas の上限とメモリのため）
  const MAXPX = 6e6;
  const resOf = (n) => Math.min(scale * (devicePixelRatio || 1), Math.sqrt(MAXPX / (W * pageH(n))));
  const curPage = () => Math.max(1, blockAt((innerHeight / 2 - page.getBoundingClientRect().top) / scale));
  // 1ページずつ、画面の真ん中に近いページから描く。書いている間とピンチの間は描かない（ペンの描画を待たせない）
  // 1ページずつ、画面の真ん中に近いページから描く。書いている間とピンチの間は描かない（ペンの描画を待たせない）
  async function pdfPump() {
    if (pdfBusy || !pdfDoc || penDown || pinch) return;
    const c = curPage();
    const todo = [...near].filter((n) => { const p = drawn.get(n); return !p || Math.abs(p.k / resOf(n) - 1) > .05; })
      .sort((x, y) => Math.abs(x - c) - Math.abs(y - c));
    if (!todo.length) return pdfHd();
    const n = todo[0], k = resOf(n);
    const cv = await drawPdf(n, k);
    if (!cv) return pdfPump();
    const old = drawn.get(n);
    if (old) { old.cv.replaceWith(cv); old.cv.width = old.cv.height = 0; } else blocks[n].prepend(cv);
    drawn.set(n, { cv, k });
    pdfPump();
  }
  // ページ n の範囲 r（ページ内の紙の px。省略するとページ全体）を、紙 1px あたり k 画素で canvas に描く。
  // 描いている間に本やページが変わったら null
  async function drawPdf(n, k, r) {
    const pd = pdfDoc, [x0, y0, x1, y1] = r || [0, 0, W, pageH(n)], cv = document.createElement('canvas');
    pdfBusy = true;
    try {
      const pg = await pd.getPage(n), w1 = pg.getViewport({ scale: 1 }).width;
      const vp = pg.getViewport({ scale: k * W / w1, offsetX: -x0 * k, offsetY: -y0 * k });
      cv.width = Math.ceil((x1 - x0) * k); cv.height = Math.ceil((y1 - y0) * k);
      await pg.render({ canvas: cv, viewport: vp }).promise;
    } catch { cv.width = cv.height = 0; }   // 描けないページは白いままにする（何度も描き直さない）
    pdfBusy = false;
    if (pd !== pdfDoc || !near.has(n) || !blocks[n]) { cv.width = cv.height = 0; return null; }
    return cv;
  }
  // 拡大してページ全体の絵では細かさが足りないときは、画面に見えている部分だけを細かく描いて上に重ねる
  // （hd: ページ -> { cv, k, r }）。少し広めに描いておき、少しのスクロールでは描き直さない
  const hd = new Map(), HDPX = 8e6;   // 重ねる絵の画素数の合計の上限
  function dropHd(n) { const h = hd.get(n); if (!h) return; h.cv.width = h.cv.height = 0; h.cv.remove(); hd.delete(n); }
  async function pdfHd() {
    const K0 = scale * (devicePixelRatio || 1), pr = page.getBoundingClientRect();
    const v = [-pr.left / scale, -pr.top / scale, (innerWidth - pr.left) / scale, (innerHeight - pr.top) / scale];
    const want = new Map();
    for (const n of near) {
      const t = tops[n], h = pageH(n), p = drawn.get(n);
      if (!p || p.k >= K0 * .95 || t >= v[3] || t + h <= v[1]) continue;
      const a = [Math.max(0, v[0]), Math.max(0, v[1] - t), Math.min(W, v[2]), Math.min(h, v[3] - t)];
      if (a[2] > a[0] && a[3] > a[1]) want.set(n, a);
    }
    for (const n of [...hd.keys()]) if (!want.has(n)) dropHd(n);
    for (const [n, a] of want) {
      const w = a[2] - a[0], h = a[3] - a[1], cap = HDPX / want.size;
      const k = Math.min(K0, Math.sqrt(cap / (w * h))), e = Math.max(0, Math.min(.25, (Math.sqrt(cap / (w * h * k * k)) - 1) / 2));
      const old = hd.get(n);
      if (old && Math.abs(old.k / k - 1) < .05 && old.r[0] <= a[0] + .5 && old.r[1] <= a[1] + .5 && old.r[2] >= a[2] - .5 && old.r[3] >= a[3] - .5) continue;
      const r = [Math.max(0, a[0] - w * e), Math.max(0, a[1] - h * e), Math.min(W, a[2] + w * e), Math.min(pageH(n), a[3] + h * e)];
      const cv = await drawPdf(n, k, r);
      if (!cv) return pdfPump();
      dropHd(n);
      cv.className = 'hd';
      cv.style.cssText = `left:${r[0]}px;top:${r[1]}px;width:${r[2] - r[0]}px;height:${r[3] - r[1]}px`;
      blocks[n].append(cv); hd.set(n, { cv, k, r });
      return pdfPump();
    }
  }
  // 端の「12 / 300」。押すとページの一覧（目次の画面の「ページ」）を開く
  const pgno = $('#pgno'), pgIn = $('#pg-in');
  let pgRaf = 0;
  function showPgno() {
    pgno.hidden = !isPdf();
    if (!isPdf()) return;
    $('#pg-c').textContent = curPage(); $('#pg-n').textContent = $('#pg-all').textContent = blocks.length - 1;
  }
  pgno.onclick = () => openToc('pages');
  let hdT = 0;
  const onScroll = () => {
    if (!isPdf()) return;
    if (!pgRaf) pgRaf = requestAnimationFrame(() => { pgRaf = 0; showPgno(); });
    clearTimeout(hdT); hdT = setTimeout(pdfPump, 150);   // 拡大しているときは、止まったところを細かく描き直す
  };
  addEventListener('scroll', onScroll, { passive: true });
  wrap.addEventListener('scroll', onScroll, { passive: true });
  pgIn.onfocus = () => pgIn.select();
  pgIn.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const n = Math.round(+pgIn.value.replace(/[０-９]/g, (d) => d.charCodeAt(0) - 0xff10));
    if (n >= 1 && n < blocks.length) { pgIn.blur(); goTo(CH, n); }
    else pgIn.select();
  };
  // PDF の本文（検索用）。ページごとに文字と、文字のかたまりの位置（ページ内の紙の px）を一度だけ取り出し、端末に覚えておく。
  // [{ t: 本文, r: [[t の中の位置, x, y, 幅, 高さ], …] }]。スキャンした PDF は文字がないので空になる
  let ptext = null, ptextCb = null;   // ptextCb: 読み込みの進み具合を出す先（最後に検索したもの）
  function pdfTexts(progress) {
    if (progress) ptextCb = progress;
    return ptext ||= (async () => {
      const pd = pdfDoc, key = 'ptext:' + src, saved = await kv.get(key).catch(() => null);
      if (saved) return saved;
      const out = [];
      for (let n = 1; n <= pd.numPages; n++) {
        const pg = await pd.getPage(n), vp = pg.getViewport({ scale: W / pg.getViewport({ scale: 1 }).width });
        let t = ''; const r = [];
        for (const it of (await pg.getTextContent()).items) {
          const str = (it.str || '').replace(/\s+/g, ' ');
          if (str) {
            const m = pdfjs.Util.transform(vp.transform, it.transform), h = Math.hypot(m[2], m[3]);
            r.push([t.length, Math.round(m[4]), Math.round(m[5] - h), Math.round(it.width * vp.scale), Math.round(h)]);
            t += str;
          }
          if (it.hasEOL && !t.endsWith(' ')) t += ' ';
        }
        out.push({ t, r });
        pg.cleanup();
        if (ptextCb && n % 10 === 0) ptextCb(n, pd.numPages);
      }
      kv.set(key, out).catch(() => {});
      return out;
    })().catch(() => { ptext = null; return null; });
  }
  // 見つかった文字（t の at から len 文字）のおおよその位置: [x, y, 幅, 高さ]
  function pdfHitBox({ t, r }, at, len) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    r.forEach(([i, x, y, w, h], j) => {
      const end = j + 1 < r.length ? r[j + 1][0] : t.length, n = Math.max(1, end - i);
      if (end <= at || i >= at + len) return;
      const f0 = Math.max(0, at - i) / n, f1 = Math.min(n, at + len - i) / n;   // かたまりの中は、文字数の割合で位置を決める
      a = Math.min(a, x + w * f0); c = Math.max(c, x + w * f1); b = Math.min(b, y); d = Math.max(d, y + h);
    });
    return a < c ? [a, b, c - a, d - b] : null;
  }
  // PDF のしおり（目次）。目次を開いたときに一度だけ読む: [{ t: 題, n: ページ, d: 深さ }]
  async function pdfOutline() {
    if (outline || !pdfDoc) return outline || [];
    const out = [], pd = pdfDoc;
    const walk = async (items, d) => {
      for (const it of items || []) {
        let n = 0;
        try {
          const dest = typeof it.dest === 'string' ? await pd.getDestination(it.dest) : it.dest;
          if (dest && dest[0] != null) n = (typeof dest[0] === 'number' ? dest[0] : await pd.getPageIndex(dest[0])) + 1;
        } catch {}
        out.push({ t: it.title, n, d });
        if (d < 2) await walk(it.items, d + 1);
      }
    };
    try { await walk(await pd.getOutline(), 0); } catch {}
    if (pd === pdfDoc) outline = out;
    return out;
  }

  // ---------- chapters ----------
  const chapSel = $('#chap');   // 押すと目次・しおりが開く
  const srcLine = doc.firstElementChild;
  let ids = [];
  let opening = null;
  function fillChapters() {
    ids = book.chapters.map((c) => c.id);
    srcLine.textContent = book.source || book.title || '';
    document.body.classList.toggle('pdf', isPdf());
  }
  async function openChapter(id, restore) {
    if (!ids.includes(id)) id = ids.includes('ch1') ? 'ch1' : ids[0];
    const my = opening = {};
    syncNav(id);
    if (CH) store.set(memKey('pos:' + CH), String(scrollY));
    if (cs && cs.pending.size) pushChapter(CH);
    doc.classList.add('loading');
    let html = isPdf() ? await pdfHtml().catch(() => null) : await chapterHtml(id);
    if (html == null && canSync()) { try { await syncBook(); html = await chapterHtml(id); } catch {} }
    if (my !== opening) return;
    if (html == null) { stat.textContent = isPdf() ? 'PDF を開けませんでした' : 'この章はまだiPadに保存されていません。通信できるときに開いてください'; doc.classList.remove('loading'); if (CH) syncNav(CH); return; }
    const [saved, ans, wait] = await Promise.all([kv.get(inkKey(id)), kv.get(ansKey(id)), kv.get(askKey(id))]);
    if (my !== opening) return;
    for (const s of strokes) s.el.remove();
    strokes = []; setEdit(null); undoStack.length = 0; redoStack.length = 0; syncHist();
    CH = id;
    cs = { blocks: (saved && saved.blocks) || {}, sha: saved ? saved.sha : null, pending: new Set(saved ? saved.pending : []) };
    store.set(memKey('chapter'), id);
    doc.replaceChildren(srcLine);
    doc.insertAdjacentHTML('beforeend', html);
    initBlocks(); markBm(); layout(); startPdf();
    showBlocks(cs.blocks);
    openQ = new Set(); setAnswers(ans || '', wait || []);
    doc.classList.remove('loading');
    scrollTo(0, restore ? +(store.get(memKey('pos:' + id)) || 0) : 0);
    fillImages();
    if (document.fonts) document.fonts.ready.then(layout);
    showPending();
    lastPull = Date.now(); refreshChapter();
  }
  function syncNav(id) {
    const i = ids.indexOf(id);
    $('#chap-t').textContent = (book.chapters[i] || {}).label || '';
    for (const b of [$('#prev'), $('#prev2')]) b.disabled = i <= 0;
    for (const b of [$('#next'), $('#next2')]) b.disabled = i >= ids.length - 1;
  }
  const step = (d) => { const i = ids.indexOf(CH) + d; if (ids[i]) openChapter(ids[i], false); };
  $('#prev').onclick = $('#prev2').onclick = () => step(-1);
  $('#next').onclick = $('#next2').onclick = () => step(1);
  addEventListener('pagehide', () => { if (CH) store.set(memKey('pos:' + CH), String(scrollY)); });

  // ---------- 目次・しおり ----------
  // しおりは本ごとに端末へ保存する: [{ c: 章, b: 段落の番号, t: 段落の書き出し }]
  const toc = $('#toc');
  // 目次の外（暗くなった部分）を触ったら閉じる
  toc.addEventListener('click', (e) => {
    if (e.target !== toc) return;
    const r = toc.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) toc.close();
  });
  const loadBm = () => { try { return JSON.parse(store.get(memKey('bm')) || '[]'); } catch { return []; } };
  const blockTitle = (el) => blockMd(el).replace(/^#+ /, '').replace(/\$+/g, '').replace(/\s+/g, ' ').slice(0, 60);
  const bmsEl = $('#bms');
  function markBm() { for (const m of loadBm()) if (m.c === CH && blocks[m.b]) blocks[m.b].classList.add('bm'); showBm(); }
  function showBm() {
    bmsEl.replaceChildren(...blocks.flatMap((el, b) => {
      if (!el.classList.contains('bm')) return [];
      const i = document.createElement('i'); i.dataset.b = b; return [i];
    }));
    placeBm();
  }
  function placeBm() { for (const m of bmsEl.children) m.style.top = (tops[+m.dataset.b] || 0) + 'px'; }
  function toggleBm(b) {
    if (!CH || !blocks[b]) return;
    const list = loadBm(), i = list.findIndex((m) => m.c === CH && m.b === b);
    if (i >= 0) list.splice(i, 1); else list.push({ c: CH, b, t: isPdf() ? b + 'ページ' : blockTitle(blocks[b]) });
    store.set(memKey('bm'), JSON.stringify(list));
    blocks[b].classList.toggle('bm', i < 0); showBm();
    stat.textContent = i < 0 ? 'しおりを付けました' : 'しおりを外しました';
  }
  // box: PDF の検索で見つかった文字の位置（ページ内の紙の px）。そこが画面の上の方に来るようにして、一瞬だけ色を付ける
  async function goTo(c, b, flash, box) {
    toc.close();
    if (c !== CH) await openChapter(c, false);
    if (c !== CH) return;
    if (!b || !blocks[b]) { scrollTo(0, 0); return; }
    const barB = $('#bar').getBoundingClientRect().bottom;
    if (box) {
      const r = blocks[b].getBoundingClientRect();
      scrollBy(0, r.top + box[1] * scale - barB - (innerHeight - barB) * .3);
      const x = r.left + box[0] * scale;
      if (x < 0 || x + box[2] * scale > innerWidth) wrap.scrollLeft += x - innerWidth * .2;
      const m = document.createElement('div'); m.className = 'hitbox';
      m.style.cssText = `left:${box[0] - 3}px;top:${box[1] - 2}px;width:${box[2] + 6}px;height:${box[3] + 4}px`;
      blocks[b].append(m); setTimeout(() => m.remove(), 2000);
      return;
    }
    scrollBy(0, blocks[b].getBoundingClientRect().top - barB - 12);
    if (flash) { const el = blocks[b]; el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 1900); }
  }
  function tocItem(text, cls, go, at) {
    const li = document.createElement('li'), btn = document.createElement('button');
    btn.type = 'button'; btn.className = cls; btn.onclick = go;
    if (at) { const s = document.createElement('span'); s.className = 'bm-at'; s.textContent = at; btn.append(s); }
    if (text.nodeType) btn.append(...text.childNodes); else btn.append(text);   // 見出しは数式を描いたまま並べる
    li.append(btn); return li;
  }
  chapSel.onclick = () => openToc('main');
  // tab: 'main'（目次・しおり・検索）か 'pages'（PDF のページの一覧）
  async function openToc(tab) {
    if (!book) return;
    if (!isPdf()) tab = 'main';
    $('#toc-head').hidden = !isPdf();
    const ol = isPdf() ? await pdfOutline() : [];
    const label = (c) => (book.chapters.find((x) => x.id === c) || {}).label || c;
    const bms = loadBm().filter((m) => ids.includes(m.c)).sort((x, y) => ids.indexOf(x.c) - ids.indexOf(y.c) || x.b - y.b);
    $('#toc-bm').hidden = !bms.length;
    $('#toc-bms').replaceChildren(...bms.map((m) => tocItem(m.t, '', () => goTo(m.c, m.b), label(m.c))));
    const rows = [];
    for (const c of book.chapters) {
      rows.push(tocItem(c.label, c.id === CH ? 'cur' : '', () => goTo(c.id, 0)));
      // 開いている章だけ、見出しも並べる（章の最初の見出しは章の名前と同じなので飛ばす）
      if (c.id === CH) blocks.forEach((el, b) => { if (/^H[2-4]$/.test(el.tagName)) rows.push(tocItem(el.cloneNode(true), el.tagName.toLowerCase(), () => goTo(CH, b))); });
      // PDF は PDF に入っている目次（しおり）を並べる
      if (c.id === CH) for (const o of ol) rows.push(tocItem(o.t, 'h' + (o.d + 2), () => goTo(CH, o.n), o.n ? String(o.n) : ''));
    }
    $('#toc-list').replaceChildren(...rows);
    $('#toc-q').value = ''; showHits('');
    if (!toc.open) toc.showModal();
    showTab(tab);
    pgIn.value = '';
    if (toc.contains(document.activeElement)) document.activeElement.blur();   // 開いただけでキーボードが出ないようにする
  }
  function showTab(tab) {
    for (const b of $('#toc-tabs').children) b.setAttribute('aria-selected', String(b.dataset.t === tab));
    $('#toc-tab-main').hidden = tab !== 'main'; $('#toc-pages').hidden = $('#pg-go').hidden = tab !== 'pages';
    toc.classList.toggle('pages', tab === 'pages');
    if (tab === 'pages') buildPages(); else stopThumbs();
    const cur = toc.querySelector(tab === 'pages' ? '.th.cur' : '#toc-list .cur'); if (cur) cur.scrollIntoView({ block: 'center' });
  }
  $('#toc-tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.t); };
  toc.addEventListener('close', () => { stopThumbs(); thMenu.hidden = true; });

  // ---------- ページの一覧（PDF） ----------
  // ページと白紙の縮小画像を並べる。画像は一覧で見えているものだけ作り、離れたら捨てる。
  // 押すとそのページへ。「…」から後ろに白紙を入れる・白紙を消す
  const grid = $('#pg-grid'), thMenu = $('#th-menu');
  let thIO = null, thQ = [], thBusy = false, thAt = null;
  function stopThumbs() {
    if (thIO) thIO.disconnect(); thIO = null; thQ = [];
    for (const c of grid.querySelectorAll('canvas')) { c.width = c.height = 0; }
    grid.replaceChildren();
  }
  function buildPages() {
    stopThumbs();
    const cur = curPage(), items = [];
    for (let n = 1; n < blocks.length; n++) {
      const k = Math.round((gaps[n] || 0) / gapUnit(n));
      for (let i = 0; i <= k; i++) items.push(thItem(n, i, k, n === cur && !i));
    }
    grid.replaceChildren(...items);
    thIO = new IntersectionObserver((es) => {
      for (const e of es) {
        const el = e.target;
        if (e.isIntersecting) { if (!el.dataset.d) { thQ.push(el); thPump(); } }
        else if (el.dataset.d) { const c = el.querySelector('canvas'); if (c) { c.width = c.height = 0; c.remove(); } delete el.dataset.d; }
      }
    }, { root: toc, rootMargin: '400px 0px' });
    for (const el of items) thIO.observe(el);
  }
  function thItem(n, i, k, cur) {
    const el = document.createElement('div'), [w, h] = book.sizes[n - 1];
    el.className = 'th' + (i ? ' blank' : '') + (cur ? ' cur' : ''); el.dataset.n = n; el.dataset.i = i;
    const im = document.createElement('button'); im.type = 'button'; im.className = 'im'; im.style.aspectRatio = `${w} / ${h}`;
    im.setAttribute('aria-label', i ? `${n}ページの後ろの白紙へ` : `${n}ページへ`);
    const lb = document.createElement('div'); lb.className = 'lb';
    const t = document.createElement('span'); t.textContent = i ? `白紙${k > 1 ? i : ''}` : n;
    const m = document.createElement('button'); m.type = 'button'; m.className = 'th-m'; m.textContent = '…'; m.setAttribute('aria-label', 'このページの操作');
    lb.append(t, m); el.append(im, lb);
    return el;
  }
  // 縮小画像は1枚ずつ作る（ページの絵 + 書き込み）
  async function thPump() {
    if (thBusy || !thIO) return;
    const el = thQ.shift();
    if (!el) return;
    if (!el.isConnected || el.dataset.d) return thPump();
    thBusy = true;
    try {
      const n = +el.dataset.n, i = +el.dataset.i, im = el.firstChild, ph = pageH(n);
      const k = (im.clientWidth || 100) * (devicePixelRatio || 1) / W, cv = document.createElement('canvas');
      cv.width = Math.round(W * k); cv.height = Math.round(ph * k);
      if (!i) { const pg = await pdfDoc.getPage(n); await pg.render({ canvas: cv, viewport: pg.getViewport({ scale: k * W / pg.getViewport({ scale: 1 }).width }) }).promise; }
      const g = cv.getContext('2d'), y0 = i * gapUnit(n);
      if (i) { g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); }
      g.save(); g.scale(k, k); g.translate(0, -(tops[n] + y0));
      drawInk(g, strokes.filter((s) => s.b === n && s.bbox[3] > y0 && s.bbox[1] < y0 + ph));
      g.restore();
      if (el.isConnected && thIO) { im.append(cv); el.dataset.d = 1; } else cv.width = cv.height = 0;
    } catch {}
    thBusy = false;
    thPump();
  }
  grid.addEventListener('click', (e) => {
    const th = e.target.closest('.th');
    if (!th) return;
    const n = +th.dataset.n, i = +th.dataset.i;
    if (e.target.closest('.th-m')) {
      thAt = { n, i };
      $('#th-del').hidden = !i;
      const r = e.target.getBoundingClientRect();
      thMenu.hidden = false;
      thMenu.style.left = Math.max(8, Math.min(innerWidth - thMenu.offsetWidth - 8, r.right - thMenu.offsetWidth)) + 'px';
      thMenu.style.top = Math.min(innerHeight - thMenu.offsetHeight - 8, r.bottom + 4) + 'px';
      return;
    }
    if (!e.target.closest('.im')) return;
    toc.close();
    if (!i) { goTo(CH, n); return; }
    scrollBy(0, blocks[n].getBoundingClientRect().top + i * gapUnit(n) * scale - $('#bar').getBoundingClientRect().bottom - 12);
  });
  toc.addEventListener('click', (e) => { if (!thMenu.hidden && !e.target.closest('#th-menu, .th-m')) thMenu.hidden = true; });
  const thKeep = () => { const t = toc.scrollTop; buildPages(); toc.scrollTop = t; };
  $('#th-add').onclick = () => { thMenu.hidden = true; blankOp(thAt.n, thAt.i, true); stat.textContent = `${thAt.n}ページの後ろに白紙を入れました`; thKeep(); };
  $('#th-del').onclick = () => { thMenu.hidden = true; blankOp(thAt.n, thAt.i, false); stat.textContent = '白紙を消しました'; thKeep(); };

  // 本文の検索。章ごとの段落の文字（数式は TeX）を一度だけ作って覚えておく。段落の番号は #doc の子要素の番号（先頭は出典の行）
  const searchText = new Map();   // '<本>:<章>' -> { html, texts }
  async function chapterTexts(id, progress) {
    if (isPdf()) { const p = await pdfTexts(progress); return p && p.map((x) => x.t); }
    const html = await chapterHtml(id);
    if (html == null) return null;
    const k = bookKey() + ':' + id, hit = searchText.get(k);
    if (hit && hit.html === html) return hit.texts;
    const t = document.createElement('template'); t.innerHTML = html;
    const texts = [...t.content.children].map((el) => blockMd(el).replace(/^#+ /, '').replace(/\s+/g, ' '));
    searchText.set(k, { html, texts });
    return texts;
  }
  let searchSeq = 0, searchT = 0;
  const note = (t) => { const li = document.createElement('li'); li.className = 'none'; li.textContent = t; return li; };
  async function showHits(q) {
    const my = ++searchSeq;
    q = q.trim();
    $('#toc-hits').hidden = !q; $('#toc-main').hidden = !!q;
    if (!q) return;
    const ql = q.toLowerCase(), hits = [];
    for (const c of book.chapters) {
      const texts = await chapterTexts(c.id, (n, all) => { if (my === searchSeq) $('#toc-hits').replaceChildren(note(`本文を読み込み中 ${n}/${all}ページ（初めての検索だけ）`)); });
      if (my !== searchSeq) return;
      if (isPdf() && texts && !texts.some((t) => t.trim())) { $('#toc-hits').replaceChildren(note('この PDF には文字の情報がないので、検索できません（スキャンした PDF など）')); return; }
      (texts || []).forEach((t, i) => {
        const at = t.toLowerCase().indexOf(ql);
        if (at >= 0 && hits.length < 200) hits.push({ c, b: i + 1, t, at });
      });
    }
    const rows = hits.map((h) => {
      const s = Math.max(0, h.at - 18), frag = document.createElement('span'), m = document.createElement('mark');
      m.textContent = h.t.slice(h.at, h.at + q.length);
      frag.append((s ? '…' : '') + h.t.slice(s, h.at), m, h.t.slice(h.at + q.length, h.at + q.length + 60));
      const li = isPdf() ? tocItem(frag, '', async () => goTo(CH, h.b, true, pdfHitBox((await ptext)[h.b - 1], h.at, q.length)), h.b + 'ページ')
        : tocItem(frag, '', () => goTo(h.c.id, h.b, true), h.c.label);
      li.querySelector('.bm-at').className = 'at';
      return li;
    });
    if (!rows.length) rows.push(note('見つかりませんでした'));
    else if (hits.length >= 200) rows.push(note('200件まで表示しています'));
    $('#toc-hits').replaceChildren(...rows);
  }
  $('#toc-q').oninput = () => { clearTimeout(searchT); searchT = setTimeout(() => showHits($('#toc-q').value), 200); };
  $('#toc-q').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchT); showHits($('#toc-q').value); $('#toc-q').blur(); } };

  // 段落を指で長押しすると、しおりを付ける・外す。しおりの印を指でタップしても外れる（「指で書く」がオフのとき）
  let lp = null;
  const lpStop = () => { if (lp) { clearTimeout(lp.t); lp = null; } };
  page.addEventListener('touchstart', (e) => {
    lpStop();
    const t = e.touches[0];
    if (finger || e.touches.length !== 1 || t.touchType === 'stylus') return;
    const x = t.clientX, y = t.clientY;
    lp = { x, y, t: setTimeout(() => { lp = null; toggleBm(blockAt((y - page.getBoundingClientRect().top) / scale)); }, 550) };
  }, { passive: true });
  page.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (lp && Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > 8) lpStop(); }, { passive: true });
  page.addEventListener('touchend', () => {
    if (!lp) return;
    const r = page.getBoundingClientRect(), x = (lp.x - r.left) / scale, y = (lp.y - r.top) / scale;
    lpStop();
    // 印は紙の左余白、段落の上端あたりにある。指で押しやすいよう、余白全体と上端から 36px までを当たりにする
    const b = blockAt(y);
    if (x < 48 && blocks[b] && blocks[b].classList.contains('bm') && y - tops[b] < 36) toggleBm(b);
  });
  page.addEventListener('touchcancel', lpStop);

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
      if (isLocal()) await switchBook('gh');
      await syncBook(force);
      msg.textContent = '本をダウンロードしました';
      fillChapters(); $('#empty').hidden = true; chapSel.disabled = false;
      await openChapter(CH && ids.includes(CH) ? CH : (store.get(memKey('chapter')) || 'ch1'), true);
      pushAll();
      return true;
    } catch (e) {
      msg.textContent = e.status === 401 ? 'トークンが無効です' : e.status === 403 || e.status === 404 ? 'リポジトリか本のフォルダが見つからないか、トークンに権限がありません' : (e.message || '接続できませんでした');
      return false;
    }
  }
  $('#cfg-save').onclick = async () => {
    cfg = { token: $('#cfg-token').value.trim(), repo: $('#cfg-repo').value.trim() || DEF.repo,
      branch: $('#cfg-branch').value.trim() || DEF.branch, session: cfg.session, book: $('#cfg-book').value.trim().replace(/\/+$/, '') || DEF.book };
    store.set(PREF + ':cfg', JSON.stringify(cfg));
    if (await connect(false)) setTimeout(() => dlg.close(), 600);
  };
  $('#cfg-sync').onclick = () => connect(true);

  // ---------- 本（ファイルから開く・切り替え） ----------
  // ファイルから開いた本: kv 'book:local:<id>' = { title, local:true, chapters:[{id,label,file}] }、本文は 'md:local:<id>:<章>'
  // 一覧は kv 'books' = [{ id, title }]（新しい順）
  function setSrc(v) { src = v; store.set(PREF + ':book', v); }
  function leaveBook() {   // 今の章を保存してから本を切り替える
    if (CH) store.set(memKey('pos:' + CH), String(scrollY));
    if (cs) persist();
    if (cs && cs.pending.size) pushChapter(CH);
    CH = null; cs = null;
    closePdf();
  }
  async function switchBook(v) {
    leaveBook(); setSrc(v);
    if (!await loadBook()) { $('#empty').hidden = false; chapSel.disabled = true; document.body.classList.remove('pdf'); doc.replaceChildren(srcLine); srcLine.textContent = ''; initBlocks(); showBlocks({}); setAnswers('', []); layout(); showPgno(); return; }
    $('#empty').hidden = true; chapSel.disabled = false;
    fillChapters();
    await openChapter(store.get(memKey('chapter')) || ids[0], true);
    if (!isLocal()) { pushAll(); if (canSync()) syncBook(false).catch(() => {}); }
  }
  const mdTitle = (md, name) => ((md.match(/^#{1,3}\s+(.+)$/m) || [])[1] || name.replace(/\.[^.]+$/, '')).replace(/[*_`$]/g, '').trim();
  async function addBook(id, meta) {
    await kv.set('book:' + id, meta);
    await kv.set('books', [{ id, title: meta.title }, ...((await kv.get('books')) || [])]);
    return { id, title: meta.title };
  }
  async function importMd(files) {
    const id = 'local:' + newId(), chapters = [];
    for (const [i, f] of files.entries()) {
      const md = await f.text(), c = { id: 'c' + (i + 1), label: mdTitle(md, f.name), file: f.name };
      await kv.set('md:' + id + ':' + c.id, { sha: f.name + ':' + f.size + ':' + f.lastModified, md });
      chapters.push(c);
    }
    const title = chapters[0].label + (chapters.length > 1 ? ` ほか${chapters.length - 1}章` : '');
    return addBook(id, { title, local: true, chapters, images: {} });
  }
  // PDF は1ファイルを1冊にする。PDF そのものは 'pdf:<本>' に置き、ページの大きさだけ先に調べておく（開くたびに全ページを読まないため）
  async function importPdf(f) {
    const id = 'local:' + newId();
    stat.textContent = `「${f.name}」を読み込み中…`;
    try { await kv.set('pdf:' + id, f); } catch { await kv.set('pdf:' + id, await f.arrayBuffer()); }
    let pd = null;
    try {
      pd = await openPdf(new Uint8Array(await f.arrayBuffer()));
      const sizes = [];
      for (let i = 1; i <= pd.numPages; i++) {
        const v = (await pd.getPage(i)).getViewport({ scale: 1 });
        sizes.push([Math.round(v.width * 100) / 100, Math.round(v.height * 100) / 100]);
        if (i % 25 === 0) stat.textContent = `PDF を読み込み中 ${i}/${pd.numPages}ページ`;
      }
      const title = f.name.replace(/\.pdf$/i, '');
      return await addBook(id, { title, local: true, pdf: true, chapters: [{ id: 'pdf', label: title, file: f.name }], sizes, images: {} });
    } catch (e) { kv.del('pdf:' + id).catch(() => {}); throw e; }
    finally { if (pd) pd.destroy(); }
  }
  const isPdfFile = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
  async function openFiles(files) {
    files = [...files].sort((x, y) => x.name.localeCompare(y.name, 'ja', { numeric: true }));
    if (!files.length) return;
    const opened = [];
    for (const f of files.filter(isPdfFile)) opened.push(await importPdf(f));
    const mds = files.filter((f) => !isPdfFile(f));
    if (mds.length) opened.push(await importMd(mds));
    shelf.close();
    await switchBook(opened[opened.length - 1].id);
    stat.textContent = `「${opened.map((b) => b.title).join('」「')}」をこのiPadに保存しました`;
  }
  for (const el of document.querySelectorAll('.open-file')) el.onchange = () => { openFiles(el.files).catch((e) => { stat.textContent = '開けませんでした: ' + (e.message || ''); }); el.value = ''; };
  const shelf = $('#shelf');
  async function showShelf() {
    const list = (await kv.get('books')) || [];
    const gh = cfg.token || await kv.get('book:' + cfg.repo + '@' + cfg.branch + ':' + cfg.book);
    const rows = (gh ? [{ id: 'gh', title: 'GitHub: ' + cfg.book.split('/').pop() }] : []).concat(list);
    $('#shelf-list').replaceChildren(...rows.map((r) => {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.className = 'open'; b.textContent = r.title; b.setAttribute('aria-current', String(r.id === src));
      b.onclick = () => { shelf.close(); if (r.id !== src || !CH) switchBook(r.id); };
      li.append(b);
      if (r.id !== 'gh') {   // ファイルから開いた本だけ消せる（2回押す）
        const d = document.createElement('button'); d.type = 'button'; d.className = 'del'; d.textContent = '削除';
        d.onclick = async () => {
          if (!d.classList.contains('arm')) { d.classList.add('arm'); d.textContent = 'もう一度押すと削除'; return; }
          const meta = await kv.get('book:' + r.id);
          for (const c of (meta && meta.chapters) || []) for (const k of ['md:', 'html:', 'ink:']) await kv.del(k + r.id + ':' + c.id);
          await kv.del('book:' + r.id); await kv.del('pdf:' + r.id); await kv.del('ptext:' + r.id);
          await kv.set('books', ((await kv.get('books')) || []).filter((x) => x.id !== r.id));
          if (r.id === src) { CH = null; cs = null; await switchBook('gh'); }
          showShelf();
        };
        li.append(d);
      }
      return li;
    }));
    if (!shelf.open) shelf.showModal();
  }
  $('#books').onclick = showShelf;

  // ---------- boot ----------
  const z = store.get(PREF + ':zoom');
  scale = z && z !== 'fit' ? +z : fitScale();
  zoomMode = z && z !== 'fit' ? 'manual' : 'fit';
  layout();
  (async () => {
    if (isLocal() && !await loadBook()) setSrc('gh');
    await loadBook();
    if (!book && canSync()) { try { await syncBook(); } catch (e) { stat.textContent = '本をダウンロードできませんでした: ' + (e.message || ''); } }
    if (!book) { $('#empty').hidden = false; chapSel.disabled = true; return; }
    fillChapters();
    const fromHash = location.hash.slice(1);
    await openChapter(ids.includes(fromHash) ? fromHash : (store.get(memKey('chapter')) || 'ch1'), true);
    pushAll();
    // 起動のたびに本の更新を確認（変わった章だけ取り直す）
    if (canSync()) syncBook(false).then(() => { stat.textContent = ''; }).catch(() => {});
  })();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
