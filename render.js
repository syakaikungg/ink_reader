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

  window.renderMarkdown = function renderMarkdown(md, images) {
    const math = [], texs = [], code = [];
    md = md.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    md = md.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/, '');   // 前書き（YAML）は本文に出さない
    // コードの中の $ や \( は数式にしない（コードは置き換えておき、数式の後で戻す）。\$ はそのままの $
    const keep = (s) => { code.push(s); return `@@C${code.length - 1}@@`; };
    md = md.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm, keep);
    md = md.replace(/(?<!`)(`+)(?!`)((?:[^\n]|\n(?![ \t]*\n))+?)(?<!`)\1(?!`)/g, keep);
    md = md.replace(/\\\$/g, keep);
    const put = (tex, display) => {
      // data-tex に元の TeX を残す（「Claudeに聞く」で本文を md に戻すため）
      const esc = tex.trim().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      math.push(katex.renderToString(tex.trim(), { displayMode: display, output: 'html', throwOnError: false, strict: false })
        .replace('<span class="katex"', `<span class="katex" data-tex="${esc}"`));
      texs.push(tex.trim());
      return `@@M${math.length - 1}@@`;
    };
    md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => '\n\n' + put(t, true) + '\n\n');
    md = md.replace(/^[ \t]*\\\[([\s\S]+?)\\\][ \t]*$/gm, (_, t) => '\n\n' + put(t, true) + '\n\n');   // \[ \] は行の頭と終わりにあるときだけ（文中の \[1\] は角かっこ）
    md = md.replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => put(t, false));
    md = md.replace(/\$([^$\n]+?)\$/g, (_, t) => put(t, false));
    // 脚注: [^名前]: 本文 は章の終わりにまとめ、本文の [^名前] は番号にする
    const defs = new Map(), order = [];
    md = md.replace(/^\[\^([^\]\s]+)\]:[ \t]*(.*(?:\n(?: {2,}|\t)\S.*)*)/gm, (_, k, t) => { defs.set(k, t.replace(/\n\s+/g, ' ')); return ''; });
    const fid = (k) => 'md-fn-' + k.replace(/[^\w-]/g, (c) => '_' + c.charCodeAt(0));
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
    md = md.replace(/@@C(\d+)@@/g, (_, i) => code[+i]);
    let html = marked.parse(md);
    if (defs.size) {
      const keys = order.concat([...defs.keys()].filter((k) => !order.includes(k)));
      html += `<section class="footnotes"><ol>${keys.map((k) => `<li id="${fid(k)}">${marked.parseInline(defs.get(k).replace(/@@C(\d+)@@/g, (_, i) => code[+i]))}</li>`).join('')}</ol></section>`;
    }
    // 前の版と同じ段落の分け方にする（式だけの段落の <p> を外す。前は KaTeX の HTML に対して置き換えていた）
    const disp = (i) => math[i].startsWith('<span class="katex-display"'), tail = (i) => math[i].endsWith('</span></span></span>');
    html = html.replace(/<p>(@@M(\d+)@@)/g, (m, x, i) => disp(+i) ? x : m).replace(/(@@M(\d+)@@)<\/p>/g, (m, x, i) => tail(+i) ? x : m);
    html = html.replace(/<img src="([^"]+)" alt="([^"]*)">/g, (_, f) => {
      const [w, h] = (images && images[f]) || [400, 300];
      const page = (f.match(/page_(\d+)/) || [])[1];
      return `<img data-img="${f}" width="${w}" height="${h}" alt="図${page ? `（原書${page}ページ）` : ''}">`;
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
  window.renderMarkdown.version = 3;   // 出力を変えたら上げる（端末内のキャッシュを作り直す）
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
