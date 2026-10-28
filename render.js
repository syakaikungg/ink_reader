// Copyright (C) 2026 syakaikungg. All rights reserved.
// md（$…$ / $$…$$ の数式つき）を HTML にする。
// 書き込みは「何番目の段落か」で結びつけているので、段落の分け方を変えると既存の書き込みがずれる。変えるときは注意
window.renderMarkdown = function renderMarkdown(md, images) {
  const math = [];
  const put = (tex, display) => {
    // data-tex に元の TeX を残す（「Claudeに聞く」で本文を md に戻すため）
    const esc = tex.trim().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    math.push(katex.renderToString(tex.trim(), { displayMode: display, output: 'html', throwOnError: false, strict: false })
      .replace('<span class="katex"', `<span class="katex" data-tex="${esc}"`));
    return `@@M${math.length - 1}@@`;
  };
  md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => '\n\n' + put(t, true) + '\n\n');
  md = md.replace(/\$([^$\n]+?)\$/g, (_, t) => put(t, false));
  let html = marked.parse(md);
  html = html.replace(/@@M(\d+)@@/g, (_, i) => math[+i]);
  html = html.replace(/<p>(<span class="katex-display">)/g, '$1').replace(/(<\/span><\/span><\/span>)<\/p>/g, '$1');
  html = html.replace(/<img src="([^"]+)" alt="([^"]*)">/g, (_, f) => {
    const [w, h] = (images && images[f]) || [400, 300];
    const page = (f.match(/page_(\d+)/) || [])[1];
    return `<img data-img="${f}" width="${w}" height="${h}" alt="図${page ? `（原書${page}ページ）` : ''}">`;
  });
  html = html.replace(/<p>FIG\. /g, '<p class="cap">FIG. ');
  return html;
};
window.renderMarkdown.version = 2;   // 出力を変えたら上げる（端末内のキャッシュを作り直す）
