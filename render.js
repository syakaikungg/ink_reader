// Copyright (C) 2026 syakaikungg. All rights reserved.
// md（$…$ / $$…$$ / \(…\) / \[…\] の数式つき）を HTML にする。
// 書き込みは「何番目の段落か」で結びつけているので、段落の分け方を変えると既存の書き込みがずれる。変えるときは注意
// md の中の HTML は、動くもの（script・on〜・javascript: など）を除いてから使う（友達の md や Claude の答えをそのまま入れるため）
(() => {
  const SVG = 'http://www.w3.org/2000/svg', HTML = 'http://www.w3.org/1999/xhtml';
  const words = (s) => new Set(s.split(' '));
  // 残す要素。ここにない HTML の要素は中身だけ残して span にする（段落の数は変えない）。DROP は中身ごと消す
  const OK = words('a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img input ins kbd li main mark nav ol p pre q rp rt ruby s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr');
  const SVG_OK = words('svg a g path circle ellipse line polyline polygon rect text tspan textpath defs marker use lineargradient radialgradient stop clippath mask pattern symbol title desc');
  const DROP = words('script style iframe frame frameset object embed applet link meta base form button textarea select option optgroup datalist output noscript noembed noframes template audio video source track canvas math xmp plaintext dialog portal slot head title');
  const BAD = words('srcset target form formaction action autofocus contenteditable accesskey popover popovertarget popovertargetaction is slot ping download http-equiv nonce tabindex srcdoc sandbox allow attributename values from to by begin');
  const URLS = words('href xlink:href src background poster cite longdesc lowsrc dynsrc data codebase');
  const CLASS_OK = /^(language-[\w+#-]+|footnotes|fnref|wiki)$/;
  const pre = (v) => v.startsWith('md-') ? v : 'md-' + v;   // md の中の id はアプリの id とぶつからないよう頭に md- を付ける
  const safeUrl = (v, src) => {
    const s = v.replace(/[\u0000- \u007f-\u009f]/g, '');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return true;   // 相対・#
    return /^(https?|mailto|tel):/i.test(s) || (src && /^data:image\/[\w.+-]+[;,]/i.test(s));
  };
  // style は、画面の上に重ねる・外から読み込む・動かす指定だけ除く
  const safeStyle = (v) => v.split(';').filter((d) => {
    const i = d.indexOf(':');
    if (i < 1) return false;
    const p = d.slice(0, i).trim().toLowerCase(), val = d.slice(i + 1).toLowerCase();
    return !/^(position|z-index|inset.*|top|left|right|bottom|transform|translate|scale|rotate|animation.*|transition.*|behavior|-moz-binding|content|offset.*)$/.test(p)
      && !/url\s*\(|image-set|expression|javascript:|@import|\\/.test(val);
  }).map((d) => d.trim()).join('; ');
  function attrs(el, svg, name) {
    for (const { name: a0, value } of [...el.attributes]) {
      const a = a0.toLowerCase();
      let v = value, keep = true;
      if (a.startsWith('on') || BAD.has(a) || (a.startsWith('data-') && !(a === 'data-img' && name === 'img'))) keep = false;
      else if (a === 'style') keep = !!(v = safeStyle(v));
      else if (a === 'class') keep = !!(v = v.split(/\s+/).filter((c) => CLASS_OK.test(c)).join(' '));
      else if (a === 'id' || (a === 'name' && name === 'a')) v = pre(v);
      else if (URLS.has(a)) {
        const t = v.trim();
        keep = svg && name !== 'a' ? t.startsWith('#') : safeUrl(v, a === 'src');   // SVG の use などは同じ図の中だけ
        if (keep && t.startsWith('#') && t.length > 1) v = '#' + pre(t.slice(1));
      } else if (/url\s*\(/i.test(v)) {   // SVG の fill="url(#…)" など。図の外を指すものは除く
        v = v.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/gi, (_, q, x) => `url(#${pre(x)})`);
        keep = !/url\(\s*['"]?(?!#)/i.test(v);
      }
      if (!keep) el.removeAttribute(a0);
      else if (v !== value) el.setAttribute(a0, v);
    }
    if (name === 'input') el.setAttribute('disabled', '');
    if (name === 'details') el.setAttribute('open', '');   // たたむと中の書き込みが浮くので、いつも開いておく
  }
  function clean(root) {
    for (const n of [...root.childNodes]) {
      if (n.nodeType === 3) continue;
      if (n.nodeType !== 1) { n.remove(); continue; }
      const name = n.localName.toLowerCase(), svg = n.namespaceURI === SVG;
      if (svg ? !SVG_OK.has(name) : n.namespaceURI !== HTML || DROP.has(name)) { n.remove(); continue; }
      if (name === 'input' && (n.getAttribute('type') || '').toLowerCase() !== 'checkbox') { n.remove(); continue; }
      let el = n;
      if (!svg && !OK.has(name)) { el = document.createElement('span'); el.append(...n.childNodes); n.replaceWith(el); }
      else attrs(el, svg, name);
      clean(el);
    }
  }
  const tpl = (html) => { const t = document.createElement('template'); t.innerHTML = html; return t; };
  const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const CALLOUT = { note: 'メモ', info: '情報', tip: 'ヒント', hint: 'ヒント', important: '重要', warning: '注意', caution: '注意', attention: '注意', danger: '危険', error: '危険',
    example: '例', question: '問い', faq: '問い', help: '問い', quote: '引用', cite: '引用', abstract: '要約', summary: '要約', tldr: '要約', success: 'できた', check: 'できた', done: 'できた',
    failure: 'だめ', fail: 'だめ', missing: 'だめ', bug: 'バグ', todo: 'TODO' };

  // marked に渡す前の下ごしらえ（前書きを除く・コードをよける・数式を put で置き換える・脚注の定義を抜き出す）。
  // inline: 脚注の番号と Obsidian の書き方も直す（段落の分け方には関係しないので、renderMarkdown.source では飛ばす）
  function prep(md, put, inline) {
    const code = [];
    md = md.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    md = md.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/, '');   // 前書き（YAML）は本文に出さない
    // コードの中の $ や \( は数式にしない（コードは置き換えておき、数式の後で戻す）。\$ はそのままの $
    const keep = (s) => { code.push(s); return `@@C${code.length - 1}@@`; };
    md = md.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm, keep);
    md = md.replace(/(?<!`)(`+)(?!`)((?:[^\n]|\n(?![ \t]*\n))+?)(?<!`)\1(?!`)/g, keep);
    md = md.replace(/\\\$/g, keep);
    md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => '\n\n' + put(t, true) + '\n\n');
    md = md.replace(/^[ \t]*\\\[([\s\S]+?)\\\][ \t]*$/gm, (_, t) => '\n\n' + put(t, true) + '\n\n');   // \[ \] は行の頭と終わりにあるときだけ（文中の \[1\] は角かっこ）
    md = md.replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => put(t, false));
    md = md.replace(/\$([^$\n]+?)\$/g, (_, t) => put(t, false));
    // 脚注: [^名前]: 本文 は章の終わりにまとめ、本文の [^名前] は番号にする
    const defs = new Map(), order = [];
    md = md.replace(/^\[\^([^\]\s]+)\]:[ \t]*(.*(?:\n(?: {2,}|\t)\S.*)*)/gm, (_, k, t) => { defs.set(k, t.replace(/\n\s+/g, ' ')); return ''; });
    const fid = (k) => 'md-fn-' + k.replace(/[^\w-]/g, (c) => '_' + c.charCodeAt(0));
    if (inline) {
      if (defs.size) md = md.replace(/\[\^([^\]\s]+)\](?!:)/g, (m, k) => {
        if (!defs.has(k)) return m;
        if (!order.includes(k)) order.push(k);
        return `<sup class="fnref"><a href="#${fid(k)}">${order.indexOf(k) + 1}</a></sup>`;
      });
      // Obsidian の書き方: ==印== と [[ほかのノート]]・![[画像]]
      md = md.replace(/==(?=[^\s=])([^\n=]*?[^\s=])==/g, '<mark>$1</mark>');
      md = md.replace(/(!?)\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/g, (_, img, to, name) => img
        ? `![${(name || '').replace(/[[\]]/g, '')}](<${to.trim()}>)`
        : `<a href="${escHtml(to.trim())}" class="wiki">${escHtml((name || to).trim())}</a>`);
    }
    md = md.replace(/@@C(\d+)@@/g, (_, i) => code[+i]);
    return { md, code, defs, order, fid };
  }
  window.renderMarkdown = function renderMarkdown(md, images) {
    const math = [], texs = [];
    const put = (tex, display) => {
      // data-tex に元の TeX を残す（「Claudeに聞く」で本文を md に戻すため）
      const esc = tex.trim().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      math.push(katex.renderToString(tex.trim(), { displayMode: display, output: 'html', throwOnError: false, strict: false })
        .replace('<span class="katex"', `<span class="katex" data-tex="${esc}"`));
      texs.push(tex.trim());
      return `@@M${math.length - 1}@@`;
    };
    const pr = prep(md, put, true), { code, defs, order, fid } = pr;
    let html = marked.parse(pr.md);
    if (defs.size) {
      const keys = order.concat([...defs.keys()].filter((k) => !order.includes(k)));
      html += `<section class="footnotes"><ol>${keys.map((k) => `<li id="${fid(k)}">${marked.parseInline(defs.get(k).replace(/@@C(\d+)@@/g, (_, i) => code[+i]))}</li>`).join('')}</ol></section>`;
    }
    // 前の版と同じ段落の分け方にする（式だけの段落の <p> を外す。前は KaTeX の HTML に対して置き換えていた）
    const disp = (i) => math[i].startsWith('<span class="katex-display"'), tail = (i) => math[i].endsWith('</span></span></span>');
    html = html.replace(/<p>(@@M(\d+)@@)/g, (m, x, i) => disp(+i) ? x : m).replace(/(@@M(\d+)@@)<\/p>/g, (m, x, i) => tail(+i) ? x : m);
    // 図: 本の図（images にあるもの。名前だけ合えばよい）は、端末に入れた絵を data-img で入れる（app.js の fillImages）。
    // ウェブの画像（https:）と data: はそのまま。まだない図は名前だけ入れておく（あとで図を選ぶと出る）
    const base = (f) => { let x = f; try { x = decodeURIComponent(f); } catch {} return x.replace(/&amp;/g, '&').split(/[\\/]/).pop().split(/[?#]/)[0]; };
    const findImg = (f) => {
      if (!images) return null;
      if (images[f]) return f;
      const b = base(f), l = b.toLowerCase();
      return images[b] ? b : Object.keys(images).find((k) => k.toLowerCase() === l) || null;
    };
    html = html.replace(/<img src="([^"]+)" alt="([^"]*)"(?: title="[^"]*")?>/g, (m, f, alt) => {
      if (/^(https?:|data:)/i.test(f)) return m;
      const k = findImg(f), [w, h] = k ? images[k] : [400, 160];
      const page = (f.match(/page_(\d+)/) || [])[1];
      return `<img data-img="${escHtml(k || base(f))}" width="${w}" height="${h}" alt="図${page ? `（原書${page}ページ）` : alt ? `（${alt}）` : ''}">`;
    });
    // 掃除は 2 回（1 回目の書き出しを読み直したときに形が変わる書き方があるため）
    let t = tpl(html);
    clean(t.content);
    t = tpl(t.innerHTML);
    clean(t.content);
    const root = t.content;
    for (const el of root.querySelectorAll('*')) for (const a of [...el.attributes]) if (a.value.includes('@@M')) el.setAttribute(a.name, a.value.replace(/@@M(\d+)@@/g, (_, i) => texs[+i]));
    // 囲み（> [!note] 題）
    for (const q of root.querySelectorAll('blockquote')) {
      const p = q.firstElementChild, n = p && p.tagName === 'P' && p.firstChild;
      const m = n && n.nodeType === 3 && n.data.match(/^\s*\[!(\w+)\][+-]?[ \t]*([^\n]*)\n?/);
      if (!m) continue;
      const kind = m[1].toLowerCase(), h = document.createElement('div');
      q.className = 'callout c-' + (CALLOUT[kind] ? kind : 'note');
      h.className = 'ct'; h.textContent = m[2].trim() || CALLOUT[kind] || m[1];
      n.data = n.data.slice(m[0].length);
      if (!p.textContent.trim() && !p.querySelector('img, svg')) p.remove();
      q.prepend(h);
    }
    // 枠や背景のある段落（表・コード・引用・区切り線）は div で包む。段落の下の余白（padding-bottom）を、枠の外に足すため
    for (const el of [...root.children]) if (/^(TABLE|PRE|BLOCKQUOTE|HR)$/.test(el.tagName)) { const d = document.createElement('div'); d.className = 'blk'; el.replaceWith(d); d.append(el); }
    html = t.innerHTML.replace(/@@M(\d+)@@/g, (_, i) => math[+i]);
    html = html.replace(/<p>FIG\. /g, '<p class="cap">FIG. ');
    return html;
  };
  // 段落ごとの元の md（「Claudeに聞く」・いま.md で本文をそのまま渡すため）。renderMarkdown の段落（#doc の子要素。出典の行は除く）と同じ順の配列。
  // 段落の数が合わない書き方（HTML の中に md を書いたなど）のときは null（画面の字から作る）
  window.renderMarkdown.source = (md) => {
    const raw = [];
    const put = (tex, display) => { raw.push(display ? `$$${tex.trim()}$$` : `$${tex.trim()}$`); return `@@M${raw.length - 1}@@`; };
    const pr = prep(md, put, false), out = [];
    const back = (t) => t.replace(/@@M(\d+)@@/g, (_, i) => raw[+i]).trim();
    // HTML の中に md を書いた所（<details> … </details> など）は、閉じるまでを一つの段落にする
    const depth = (t) => { let d = 0; for (const m of t.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) if (!m[3] && !/^(area|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i.test(m[2])) d += m[1] ? -1 : 1; return d; };
    let open = null, d = 0;
    for (const tk of marked.lexer(pr.md)) {
      if (open) { open.push(tk.raw); if (tk.type === 'html' && (d += depth(tk.raw)) <= 0) { out.push(back(open.join(''))); open = null; } continue; }
      if (tk.type === 'space' || tk.type === 'def') continue;
      let n = 1;
      if (tk.type === 'html') {
        if ((d = depth(tk.raw)) > 0) { open = [tk.raw]; continue; }
        const t = tpl(tk.raw); clean(t.content); n = t.content.children.length;
      }
      for (let i = 0; i < n; i++) out.push(back(tk.raw));
    }
    if (open) out.push(back(open.join('')));
    if (pr.defs.size) out.push([...pr.defs].map(([k, t]) => `[^${k}]: ${back(t.replace(/@@C(\d+)@@/g, (_, i) => pr.code[+i]))}`).join('\n'));
    return out;
  };
  // 段落の途中の余白（md）。段落 el の行の切れ目に、高さ h の空き（span.msp）を入れる。list: [[at, h], …]（at は余白を入れる前の段落の上端からの位置。上から順）。
  // at に一番近い行の切れ目（段落の上端か、2 行目から下の行の頭）に入れ、行がなければ段落の終わりに入れる。返すもの: 入れた所の、余白を入れる前の位置の配列。
  // 端末で行の折り返しが違っても、近い行の切れ目に入る（書き込みも位置で結びついているので、それに合う）。scale: 画面の拡大率
  window.renderMarkdown.space = (el, list, scale = 1) => {
    for (const x of [...el.querySelectorAll('.msp')]) { const p = x.parentNode; x.remove(); p.normalize(); }
    if (!list.length) return [];
    const top = el.getBoundingClientRect().top, rows = [{ y: 0, at: null }], rg = document.createRange();
    // 行の頭: 字（数式の外）と、数式・図はひとかたまりで見て、前の行より下に来たものを行の頭とする
    let cur = null;
    const see = (r, at) => {
      if (!r || !r.height) return;
      const y0 = (r.top - top) / scale, y1 = (r.bottom - top) / scale, c = (y0 + y1) / 2;
      if (!cur) { cur = { y0, y1 }; return; }
      if (c > cur.y1) { rows.push({ y: (cur.y1 + y0) / 2, at }); cur = { y0, y1 }; }
      else { cur.y0 = Math.min(cur.y0, y0); cur.y1 = Math.max(cur.y1, y1); }
    };
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n;) {
      if (n.nodeType === 1 && (n.matches('.katex, img, svg, br') || getComputedStyle(n).display.startsWith('inline-'))) {
        see(n.getClientRects()[0], { el: n });
        let nx = n; while (nx && !nx.nextSibling && nx !== el) nx = nx.parentNode;   // 中は見ない
        n = nx && nx !== el ? (tw.currentNode = nx.nextSibling) : null;
        continue;
      }
      if (n.nodeType === 3) for (let i = 0; i < n.data.length; i++) {
        if (!n.data[i].trim()) continue;
        rg.setStart(n, i); rg.setEnd(n, i + 1);
        see(rg.getClientRects()[0], { node: n, i });
      }
      n = tw.nextNode();
    }
    const picks = list.map(([at]) => rows.reduce((a, r) => (!a || Math.abs(r.y - at) < Math.abs(a.y - at) ? r : a), null));
    const els = [];
    for (let k = list.length - 1; k >= 0; k--) {   // 下から入れる（上の字の場所が変わらないように）
      const sp = document.createElement('span'), r = picks[k];
      sp.className = 'msp'; sp.setAttribute('aria-hidden', 'true'); sp.style.height = list[k][1] + 'px'; sp.dataset.k = k;
      if (!r || picks.indexOf(r) !== k) el.append(sp);   // 同じ行の切れ目にもう入れる余白がある
      else if (!r.at) el.prepend(sp);   // 段落の上端
      else if (r.at.el) r.at.el.before(sp);
      else { const t = r.at.i ? r.at.node.splitText(r.at.i) : r.at.node; t.before(sp); }
      els[k] = sp;
    }
    let acc = 0;
    return els.map((sp, k) => { const y = (sp.getBoundingClientRect().top - top) / scale - acc; acc += list[k][1]; return Math.round(y * 64) / 64; });
  };
  window.renderMarkdown.version = 4;   // 出力を変えたら上げる（端末内のキャッシュを作り直す）
  // 横にはみ出す長い式は、紙の幅に収まるまで小さくする（横にスクロールさせると、書き込みと式がずれる）。本文を置いたあとと字体を読んだあとに呼ぶ
  window.renderMarkdown.fit = (root) => {
    const ks = [...root.querySelectorAll('.katex-display')];
    if (!ks.length) return;
    for (const k of ks) k.style.fontSize = '';
    for (let n = 0; n < 2; n++) {
      const r = ks.map((k) => k.clientWidth && k.scrollWidth > k.clientWidth + 1 ? k.clientWidth / k.scrollWidth : 1);
      if (r.every((x) => x === 1)) return;
      ks.forEach((k, i) => { if (r[i] < 1) k.style.fontSize = Math.max(.5, Math.floor(r[i] * (parseFloat(k.style.fontSize) || 1) * 100) / 100) + 'em'; });
    }
  };
})();
