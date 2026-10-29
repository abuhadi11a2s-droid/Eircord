const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const root = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'servers.json');
const EXTRA_FILE = path.join(DATA_DIR, 'extra.json');
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');
const MAIN = 'main';
const LIM = { ownedServers: 5, totalServers: 500, textCh: 20, voiceRooms: 10, history: 200, bio: 160, text: 2000, img: 500000 };

/* ---------- static files + /ice ---------- */
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg'
};
const ice = () => {
  const s = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const u = (process.env.TURN_URLS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (u.length) s.push({ urls: u, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  return { iceServers: s };
};
const srv = http.createServer((q, s) => {
  if (q.url === '/ice') { s.writeHead(200, { 'Content-Type': 'application/json' }); return s.end(JSON.stringify(ice())); }
  if (q.method === 'POST' && q.url === '/auth') return handleAuth(q, s);
  if (q.url === '/health') { s.writeHead(200); return s.end('ok'); }
  let u; try { u = decodeURIComponent(q.url.split('?')[0]); } catch { u = '/'; }
  const f = path.join(root, path.normalize(u === '/' ? '/index.html' : u));
  if (f !== root && !f.startsWith(root + path.sep)) { s.writeHead(403); return s.end('Forbidden'); }
  fs.readFile(f, (e, d) => {
    if (e) { s.writeHead(404); return s.end('Not found'); }
    const ext = path.extname(f);
    s.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
    });
    s.end(d);
  });
});

/* ---------- data (servers are saved to disk) ---------- */
const servers = new Map();
const rid = n => crypto.randomBytes(n).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => {
  let c;
  do { c = Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join(''); } while (findByCode(c));
  return c;
};
const findByCode = code => { code = String(code || '').trim().toUpperCase(); if (!code) return null; for (const s of servers.values()) if (s.code === code) return s; return null; };
const member = (s, token) => s.id === MAIN || s.members.has(token);

/* ---------- profiles (bios) + direct messages: public id = hash of token, token never leaves server ---------- */
const bios = new Map(), dms = new Map();
const uidOf = token => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
const dmKey = (a, b) => [a, b].sort().join('|');
const okImg = x => (typeof x === 'string' && x.length <= LIM.img && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(x)) ? x : '';

function mkMain() {
  return {
    id: MAIN, name: 'Samar Al-Arab', code: '', owner: null, members: new Set(),
    channels: [
      { id: 'general', name: 'general', topic: 'Welcome to Samar, the hangout for everyone' },
      { id: 'chat-ar', name: 'chat-ar', topic: 'سوالف وسمر بالعربي' },
      { id: 'games', name: 'games', topic: 'Find a squad and play' }
    ],
    rooms: [{ id: 'majlis', name: 'Majlis' }, { id: 'chill', name: 'Chill Corner' }],
    text: { general: [['Samar', 'Welcome to Samar! Pick a room and say hi.', Date.now(), '']], 'chat-ar': [], games: [] }
  };
}
function load() {
  try {
    for (const s of JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) { s.members = new Set(s.members || []); servers.set(s.id, s); }
  } catch { /* first run */ }
  if (!servers.has(MAIN)) servers.set(MAIN, mkMain());
}
function loadExtra() {
  try {
    const d = JSON.parse(fs.readFileSync(EXTRA_FILE, 'utf8'));
    for (const [k, v] of Object.entries(d.bios || {})) bios.set(k, v);
    for (const [k, v] of Object.entries(d.dms || {})) dms.set(k, v);
  } catch { /* first run */ }
}
let saveT = null;
function save() { if (!saveT) saveT = setTimeout(saveNow, 1500); }
function saveNow() {
  clearTimeout(saveT); saveT = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const d = JSON.stringify([...servers.values()].map(s => ({ ...s, members: [...s.members] })));
    fs.writeFileSync(DATA_FILE + '.tmp', d); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { console.error('save failed:', e.message); }
}
let exT = null;
function saveExtraNow() {
  clearTimeout(exT); exT = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(EXTRA_FILE + '.tmp', JSON.stringify({ bios: Object.fromEntries(bios), dms: Object.fromEntries(dms) }));
    fs.renameSync(EXTRA_FILE + '.tmp', EXTRA_FILE);
  } catch (e) { console.error('extra save failed:', e.message); }
}
const saveExtra = () => { if (!exT) exT = setTimeout(saveExtraNow, 1500); };
load();
loadExtra();

/* ---------- live connections ---------- */
const clients = new Map(); let nid = 1;
const send = (c, o) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); };
const toServer = (s, o) => { const j = JSON.stringify(o); for (const c of clients.values()) if (c.ws.readyState === 1 && member(s, c.token)) c.ws.send(j); };
const usersOf = s => {
  const a = [];
  for (const [id, c] of clients) if (member(s, c.token)) a.push({ id, uid: c.uid, name: c.name, bio: bios.get(c.uid) || '', mute: !!c.mute, deaf: !!c.deaf });
  return a;
};
const voiceOf = s => {
  const o = {}; for (const r of s.rooms) o[r.id] = [];
  for (const [id, c] of clients) if (c.vroom && c.vroom.s === s.id && o[c.vroom.r]) o[c.vroom.r].push({ id, name: c.name, share: c.share, mute: !!c.mute, deaf: !!c.deaf });
  return o;
};
const sendUsers = s => toServer(s, { t: 'users', s: s.id, users: usersOf(s) });
const sendVoice = s => toServer(s, { t: 'voice', s: s.id, voice: voiceOf(s) });
const meta = s => ({ t: 'meta', s: s.id, name: s.name, channels: s.channels, rooms: s.rooms });
const full = (s, c) => ({
  id: s.id, name: s.name, code: s.code, main: s.id === MAIN, owner: !!s.owner && s.owner === c.token,
  channels: s.channels, rooms: s.rooms, text: s.text, users: usersOf(s), voice: voiceOf(s)
});
function vleave(c) {
  const v = c.vroom; if (!v) return;
  c.vroom = null; c.share = false;
  const s = servers.get(v.s); if (s) sendVoice(s);
}
function addTo(c, s, focus) { send(c, { t: 'sadd', server: full(s, c), focus: !!focus }); }
function addToAll(token, s, from) { for (const c of clients.values()) if (c.token === token) addTo(c, s, c === from); }
function rate(c, n, ms) {
  const now = Date.now(); c.hits = (c.hits || []).filter(t => now - t < ms);
  if (c.hits.length >= n) return false; c.hits.push(now); return true;
}
const cleanName = (x, n = 24) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanCh = x => String(x || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 24);
const err = (c, m) => send(c, { t: 'err', m });


/* ---------- accounts: name + password (scrypt). A new name creates a new account ---------- */
const accounts = new Map(), byToken = new Map();   // lowercase name -> account, token -> account
function loadAccounts() {
  try { for (const a of JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'))) { accounts.set(a.name.toLowerCase(), a); byToken.set(a.token, a); } }
  catch { /* first run */ }
}
function saveAccounts() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACC_FILE + '.tmp', JSON.stringify([...accounts.values()]));
    fs.renameSync(ACC_FILE + '.tmp', ACC_FILE);
  } catch (e) { console.error('accounts save failed:', e.message); }
}
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k)));
const authHits = new Map();
function authLimited(ip) {
  const now = Date.now(), a = (authHits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); authHits.set(ip, a); return a.length > 12;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of authHits) if (!a.some(t => now - t < 60000)) authHits.delete(k); }, 60000);
const jsonOut = (s, code, o) => { s.writeHead(code, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)); };

function handleAuth(q, s) {
  const ip = String(q.headers['x-forwarded-for'] || q.socket.remoteAddress || '').split(',')[0].trim();
  if (authLimited(ip)) return jsonOut(s, 429, { m: 'Too many attempts, wait a minute' });
  let body = '';
  q.on('data', d => { body += d; if (body.length > 4096) q.destroy(); });
  q.on('end', async () => {
    try {
      let j; try { j = JSON.parse(body); } catch { return jsonOut(s, 400, { m: 'Bad request' }); }
      const name = cleanName(j.name), pass = String(j.pass || '');
      if (name.length < 2) return jsonOut(s, 400, { m: 'Name must be at least 2 characters' });
      if (pass.length < 4 || pass.length > 100) return jsonOut(s, 400, { m: 'Password must be at least 4 characters' });
      const key = name.toLowerCase(), acc = accounts.get(key);
      if (acc) {
        const h = await scrypt(pass, acc.salt), good = Buffer.from(acc.hash, 'hex');
        if (h.length !== good.length || !crypto.timingSafeEqual(h, good)) return jsonOut(s, 401, { m: 'Wrong password for this name' });
        return jsonOut(s, 200, { token: acc.token, name: acc.name });
      }
      if (key === 'samar') return jsonOut(s, 400, { m: 'This name is reserved' });
      if (accounts.size >= 20000) return jsonOut(s, 503, { m: 'Account limit reached' });
      const salt = rid(16), hash = (await scrypt(pass, salt)).toString('hex');
      const na = { name, salt, hash, token: rid(24), created: Date.now() };
      accounts.set(key, na); byToken.set(na.token, na); saveAccounts();
      jsonOut(s, 200, { token: na.token, name: na.name, created: true });
    } catch (e) { console.error('auth error:', e.message); jsonOut(s, 500, { m: 'Server error' }); }
  });
}

loadAccounts();

/* ---------- websocket ---------- */
const wss = new WebSocketServer({ server: srv, maxPayload: 3 * 1024 * 1024 });
setInterval(() => { for (const ws of wss.clients) { if (ws.alive === false) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch { } } }, 30000);

wss.on('connection', ws => {
  let id = null; ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  setTimeout(() => { if (!id) ws.close(); }, 10000);

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello' && !id) {
      const acc = byToken.get(String(m.token || ''));
      if (!acc) { ws.send(JSON.stringify({ t: 'needlogin' })); return ws.close(); }
      id = String(nid++);
      const token = acc.token;
      const c = { ws, name: acc.name, token, uid: uidOf(token), share: false, vroom: null, mute: false, deaf: false };
      clients.set(id, c);
      const mine = [...servers.values()].filter(s => member(s, token));
      send(c, { t: 'init', id, servers: mine.map(s => full(s, c)) });
      mine.forEach(sendUsers);
      return;
    }
    const c = clients.get(id); if (!c) return;
    const s = servers.get(m.s);

    if (m.t === 'msg') {
      if (!s || !member(s, c.token) || !s.channels.some(x => x.id === m.ch)) return;
      const t = String(m.text || '').trim().slice(0, LIM.text), img = okImg(m.img);
      if ((!t && !img) || !rate(c, 8, 5000)) return;
      const msg = [c.name, t, Date.now(), img], list = s.text[m.ch] || (s.text[m.ch] = []);
      list.push(msg); if (list.length > LIM.history) list.shift();
      save(); toServer(s, { t: 'msg', s: s.id, ch: m.ch, m: msg });
    }
    else if (m.t === 'vjoin') {
      if (!s || !member(s, c.token) || !s.rooms.some(r => r.id === m.room)) return;
      vleave(c); c.vroom = { s: s.id, r: m.room }; sendVoice(s);
    }
    else if (m.t === 'vleave') vleave(c);
    else if (m.t === 'share') { if (!c.vroom) return; c.share = !!m.on; const vs = servers.get(c.vroom.s); if (vs) sendVoice(vs); }
    else if (m.t === 'sig') {
      const o = clients.get(String(m.to));
      if (o && c.vroom && o.vroom && o.vroom.s === c.vroom.s && o.vroom.r === c.vroom.r) send(o, { t: 'sig', from: id, data: m.data });
    }

    /* --- presence, profile --- */
    else if (m.t === 'pstate') {
      c.mute = !!m.mute; c.deaf = !!m.deaf;
      const vs = c.vroom && servers.get(c.vroom.s); if (vs) sendVoice(vs);
      for (const x of servers.values()) if (member(x, c.token)) sendUsers(x);
    }
    else if (m.t === 'bio') {
      const t = String(m.text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, LIM.bio);
      bios.set(c.uid, t); saveExtra();
      for (const x of servers.values()) if (member(x, c.token)) sendUsers(x);
    }

    /* --- direct messages --- */
    else if (m.t === 'dm') {
      const to = String(m.to || ''), text = String(m.text || '').trim().slice(0, LIM.text), img = okImg(m.img);
      if (!to || to === c.uid || (!text && !img)) return;
      if (!rate(c, 10, 5000)) return err(c, 'Slow down a little');
      const peers = [...clients.values()].filter(x => x.uid === to);
      if (!peers.length) return err(c, 'That person is offline right now');
      const key = dmKey(c.uid, to), msg = [c.uid, c.name, text, img, Date.now()];
      const list = dms.get(key) || []; list.push(msg); if (list.length > LIM.history) list.shift();
      dms.set(key, list); saveExtra();
      send(c, { t: 'dm', with: to, mine: true, m: msg });
      for (const p of peers) send(p, { t: 'dm', with: c.uid, m: msg });
    }
    else if (m.t === 'dmopen') {
      const to = String(m.uid || '');
      send(c, { t: 'dmh', with: to, list: dms.get(dmKey(c.uid, to)) || [] });
    }


    /* --- private 1-to-1 calls (signalling only, audio goes peer to peer) --- */
    else if (m.t === 'dcall' || m.t === 'dacc' || m.t === 'ddec' || m.t === 'dend' || m.t === 'csig') {
      const to = String(m.to || ''); if (!to || to === c.uid) return;
      const peers = [...clients.values()].filter(x => x.uid === to);
      if (!peers.length) { if (m.t === 'dcall') err(c, 'That person is offline right now'); return; }
      const o = m.t === 'dcall' ? { t: 'dring', from: c.uid, name: c.name }
        : m.t === 'csig' ? { t: 'csig', from: c.uid, data: m.data }
        : { t: m.t, from: c.uid };
      for (const p of peers) send(p, o);
    }

    /* --- servers --- */
    else if (m.t === 'screate') {
      const name = cleanName(m.name); if (!name) return err(c, 'Give your server a name');
      let owned = 0; for (const x of servers.values()) if (x.owner === c.token) owned++;
      if (owned >= LIM.ownedServers) return err(c, `You can own up to ${LIM.ownedServers} servers`);
      if (servers.size >= LIM.totalServers) return err(c, 'Server limit reached');
      if (!rate(c, 3, 60000)) return err(c, 'Slow down a little');
      const gid = rid(4), ch = rid(3);
      const ns = {
        id: gid, name, code: newCode(), owner: c.token, members: new Set([c.token]),
        channels: [{ id: ch, name: 'general', topic: 'Welcome to ' + name }],
        rooms: [{ id: rid(3), name: 'Lounge' }],
        text: { [ch]: [['Samar', 'Welcome to ' + name + '! Share the invite code to bring people in.', Date.now(), '']] }
      };
      servers.set(gid, ns); save(); addToAll(c.token, ns, c); sendUsers(ns);
    }
    else if (m.t === 'sjoin') {
      const t = findByCode(m.code); if (!t) return err(c, 'Invalid invite code');
      const had = t.members.has(c.token); t.members.add(c.token);
      if (had) return send(c, { t: 'sfocus', s: t.id });
      save(); addToAll(c.token, t, c); sendUsers(t);
    }
    else if (m.t === 'sleave') {
      if (!s || s.id === MAIN || s.owner === c.token || !s.members.has(c.token)) return;
      s.members.delete(c.token); save();
      for (const x of clients.values()) if (x.token === c.token) { if (x.vroom && x.vroom.s === s.id) vleave(x); send(x, { t: 'sgone', s: s.id }); }
      sendUsers(s);
    }
    else if (m.t === 'sdelete') {
      if (!s || s.id === MAIN || s.owner !== c.token) return;
      toServer(s, { t: 'sgone', s: s.id });
      for (const x of clients.values()) if (x.vroom && x.vroom.s === s.id) { x.vroom = null; x.share = false; }
      servers.delete(s.id); save();
    }
    else if (m.t === 'chadd') {
      if (!s || s.owner !== c.token) return;
      if (m.kind === 'text') {
        const name = cleanCh(m.name); if (!name) return err(c, 'Invalid channel name');
        if (s.channels.length >= LIM.textCh) return err(c, 'Too many text channels');
        const ch = { id: rid(3), name, topic: '' }; s.channels.push(ch); s.text[ch.id] = [];
      } else {
        const name = cleanName(m.name); if (!name) return err(c, 'Invalid room name');
        if (s.rooms.length >= LIM.voiceRooms) return err(c, 'Too many voice rooms');
        s.rooms.push({ id: rid(3), name });
      }
      save(); toServer(s, meta(s)); sendVoice(s);
    }
    else if (m.t === 'chdel') {
      if (!s || s.owner !== c.token) return;
      if (m.kind === 'text') {
        if (s.channels.length <= 1) return err(c, 'Keep at least one text channel');
        s.channels = s.channels.filter(x => x.id !== m.id); delete s.text[m.id];
      } else {
        s.rooms = s.rooms.filter(r => r.id !== m.id);
        for (const x of clients.values()) if (x.vroom && x.vroom.s === s.id && x.vroom.r === m.id) { x.vroom = null; x.share = false; }
      }
      save(); toServer(s, meta(s)); sendVoice(s);
    }
  });

  ws.on('close', () => {
    if (!id) return;
    const c = clients.get(id); if (!c) return;
    vleave(c); clients.delete(id);
    for (const s of servers.values()) if (member(s, c.token)) sendUsers(s);
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveNow(); saveExtraNow(); process.exit(0); });
srv.listen(PORT, () => console.log('Samar is running on http://localhost:' + PORT));
