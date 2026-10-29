// テスト用の Google ドライブ API と Google のログイン（GIS）のモック。drive-sync.cjs・files-sync.cjs・gh-drive.cjs・smoke.cjs で使う
// files: id -> { name, parents, mimeType, version, content, trashed }。ログインのトークンは tok-ok だけ通す
const FOLDER = 'application/vnd.google-apps.folder';
function createDrive() {
  const files = { root: { name: 'root', mimeType: 'folder' } }, calls = [];
  let idN = 1;
  const byPath = (p) => { let id = 'root'; for (const name of p.split('/')) { const hit = Object.entries(files).find(([, f]) => f.name === name && !f.trashed && (f.parents || []).includes(id)); if (!hit) return null; id = hit[0]; } return files[id]; };
  const idOf = (f) => Object.keys(files).find((k) => files[k] === f);
  // Claude（ドライブ連携）がファイルを作ったことにする
  const add = (dir, name, content, mimeType = 'text/markdown') => { const id = 'f' + idN++; files[id] = { name, parents: [idOf(byPath(dir))], mimeType, version: 1, content: Buffer.from(content) }; return files[id]; };
  async function route(r) {
    const req = r.request(), u = new URL(req.url()), m = req.method(), json = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    calls.push(m + ' ' + u.pathname);
    if (req.headers().authorization !== 'Bearer tok-ok') return r.fulfill({ status: 401, body: '{}' });
    let mm;
    if (m === 'GET' && u.pathname === '/drive/v3/files') {
      const q = u.searchParams.get('q'), name = (q.match(/name='((?:[^'\\]|\\.)*)'/) || [])[1], pid = q.match(/'([^']+)' in parents/)[1], folder = /mimeType=/.test(q);
      const list = Object.entries(files).filter(([, f]) => !f.trashed && (f.parents || []).includes(pid) && (name == null || f.name === name.replace(/\\(.)/g, '$1')) && (!folder || f.mimeType === FOLDER));
      return json({ files: list.map(([id, f]) => ({ id, name: f.name, version: String(f.version) })) });
    }
    if (m === 'POST' && u.pathname === '/drive/v3/files') { const b = JSON.parse(req.postData()), id = 'f' + idN++; files[id] = { ...b, version: 1 }; return json({ id }); }
    if (m === 'POST' && u.pathname === '/upload/drive/v3/files') {
      const raw = req.postDataBuffer(), bd = '--' + req.headers()['content-type'].split('boundary=')[1], parts = [];
      let i = raw.indexOf(bd); while (i >= 0) { const j = raw.indexOf(bd, i + bd.length); if (j < 0) break; parts.push(raw.slice(i + bd.length, j)); i = j; }
      const body = (p) => p.slice(p.indexOf('\r\n\r\n') + 4, p.length - 2);
      const meta = JSON.parse(body(parts[0]).toString()), id = 'f' + idN++;
      files[id] = { ...meta, version: 1, content: body(parts[1]) };
      return json({ version: '1' });
    }
    if (m === 'PATCH' && (mm = u.pathname.match(/^\/upload\/drive\/v3\/files\/(\w+)$/))) { const f = files[mm[1]]; f.content = req.postDataBuffer(); f.version++; return json({ version: String(f.version) }); }
    if (m === 'PATCH' && (mm = u.pathname.match(/^\/drive\/v3\/files\/(\w+)$/))) { Object.assign(files[mm[1]], JSON.parse(req.postData())); return json({}); }
    if (m === 'GET' && u.pathname === '/drive/v3/about') return json({ user: { emailAddress: 'me@example.com' } });
    if (m === 'GET' && (mm = u.pathname.match(/^\/drive\/v3\/files\/(\w+)$/))) return r.fulfill({ status: 200, body: files[mm[1]].content });
    return r.fulfill({ status: 404, body: '{}' });
  }
  // 同じフォルダに同じ名前のファイルが二つあるか
  const twins = () => { const k = Object.values(files).filter((f) => !f.trashed).map((f) => (f.parents || []).join() + '/' + f.name); return k.length !== new Set(k).size; };
  return { files, calls, byPath, add, route, twins };
}
// Google のログイン（GIS）のモック: 押すとすぐ tok-ok を返す。window.__fail を立てると、ポップアップを閉じたことにする
const GIS = `window.google = { accounts: { oauth2: { initTokenClient: (o) => ({ requestAccessToken: (a) => { window.__logins = (window.__logins || 0) + 1; window.__cid = o.client_id; window.__last = { hint: o.login_hint, prompt: a && a.prompt };
  setTimeout(() => window.__fail ? o.error_callback({ type: 'popup_closed' }) : o.callback({ access_token: 'tok-ok', expires_in: 3600 }), 10); } }) } } };`;
// ドライブにつないだ状態で始める（ページを開く前に localStorage に入れる値）
const connected = (cfg = {}) => ({ 'ink:cfg': JSON.stringify({ drive: true, ...cfg }), 'ink:dtok': JSON.stringify({ tok: 'tok-ok', exp: Date.now() + 3600e3, who: 'me@example.com' }) });
module.exports = { createDrive, GIS, FOLDER, connected };
