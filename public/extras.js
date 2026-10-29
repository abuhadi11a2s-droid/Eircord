/* Samar extras: accounts, profiles, presence, DMs, private calls, images, background music */
(() => {
const ls = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d } catch (e) { return d } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch (e) {} }
};
const ss = {
  get: k => { try { return sessionStorage.getItem(k) || '' } catch (e) { return '' } },
  set: (k, v) => { try { sessionStorage.setItem(k, v) } catch (e) {} },
  del: k => { try { sessionStorage.removeItem(k) } catch (e) {} }
};

/* ---------- login: name + password. Session lives per tab, so each tab can be a different account ---------- */
$('go').insertAdjacentHTML('beforebegin',
  '<label>Password (a new name creates a new account)<input id="pw" type="password" maxlength="100" autocomplete="current-password"></label><div class="err" id="lerr" role="alert"></div>');
async function login() {
  const name = $('nm').value.trim(), pass = $('pw').value;
  $('lerr').textContent = '';
  if (!name || !pass) { $('lerr').textContent = 'Enter a name and password'; return }
  $('go').disabled = true;
  try {
    const r = await fetch('/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pass }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.m || 'Login failed');
    ss.set('samar-session', j.token); ss.set('samar-name', name);
    location.reload();
  } catch (e) { $('lerr').textContent = e.message; $('go').disabled = false }
}
const logout = () => { ss.del('samar-session'); ss.del('samar-name'); location.reload() };
$('go').onclick = login;
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.target.id === 'nm' || e.target.id === 'pw')) { e.preventDefault(); e.stopImmediatePropagation(); login() }
}, true);

/* ---------- background music ---------- */
const bgm = $('bgm');
let bgOn = ls.get('samar-bg', '1') !== '0';
const bgVol = () => Number(ls.get('samar-bgv', '15')) / 100;
bgm.volume = bgVol();
const bgApply = () => { if (bgOn) bgm.play().catch(() => {}); else bgm.pause(); };
const bgSet = on => { bgOn = on; ls.set('samar-bg', on ? '1' : '0'); bgApply(); };
document.addEventListener('pointerdown', () => { if (bgOn && bgm.paused) bgm.play().catch(() => {}) }, true);
$('sx').insertAdjacentHTML('beforebegin',
  `<label class="row"><input type="checkbox" id="bgc" ${bgOn ? 'checked' : ''}>Background music</label>` +
  `<label>Music volume<input id="bgv" type="range" min="0" max="100" value="${Math.round(bgVol() * 100)}"></label>` +
  `<button class="gb rd" id="lo">Log out</button>`);
$('bgc').onchange = e => bgSet(e.target.checked);
$('bgv').oninput = e => { bgm.volume = e.target.value / 100; ls.set('samar-bgv', e.target.value) };
$('lo').onclick = logout;

/* ---------- state ---------- */
let dmRecent = {};
try { dmRecent = JSON.parse(ls.get('samar-dm', '{}')) } catch (e) {}
const saveRecent = () => ls.set('samar-dm', JSON.stringify(dmRecent));
const DMS = {};
let DMU = null, pendImg = null, CALL = null, RING = null;

const pres = u => u.deaf ? 'Deafened' : u.mute ? 'Muted' : 'Online';
const findU = id => { for (const s of Object.values(S)) for (const u of s.users || []) if (u.id == id) return u; return null; };
const uName = uid => { for (const s of Object.values(S)) for (const u of s.users || []) if (u.uid === uid) return u.name; return dmRecent[uid] || 'user'; };

/* ---------- socket ---------- */
function onWs(e) {
  let m; try { m = JSON.parse(e.data) } catch (x) { return }
  if (m.t === 'needlogin') { ss.del('samar-session'); return location.reload() }
  if (m.t === 'init') out({ t: 'pstate', mute, deaf });
  else if (m.t === 'dm') {
    const k = m.with, list = (DMS[k] = DMS[k] || []);
    list.push(m.m); if (list.length > 200) list.shift();
    if (!dmRecent[k]) { dmRecent[k] = m.mine ? uName(k) : m.m[1]; saveRecent() }
    if (view == 'd' && DMU == k) all(); else rSide();
  }
  else if (m.t === 'dmh') { DMS[m.with] = m.list; if (view == 'd' && DMU == m.with) all() }
  else if (m.t === 'users') {
    for (const u of m.users) if (dmRecent[u.uid] && dmRecent[u.uid] !== u.name) { dmRecent[u.uid] = u.name; saveRecent() }
  }
  /* private calls */
  else if (m.t === 'dring') {
    if (CALL || RING) return out({ t: 'ddec', to: m.from });
    RING = { from: m.from, name: m.name }; renderRing(); fx('join');
  }
  else if (m.t === 'dacc') {
    if (CALL && CALL.uid === m.from && CALL.state === 'calling') { clearTimeout(CALL.timer); CALL.state = 'connecting'; makePC(true); renderCall() }
  }
  else if (m.t === 'ddec') { if (CALL && CALL.uid === m.from) { alert(CALL.name + ' declined the call'); endCall(false) } }
  else if (m.t === 'dend') {
    if (RING && RING.from === m.from) { RING = null; renderRing() }
    if (CALL && CALL.uid === m.from) endCall(false);
  }
  else if (m.t === 'csig') onCsig(m.from, m.data);
  else if (m.t === 'err') { if (CALL && CALL.state === 'calling') endCall(false) }
}
const _connect = connect;
connect = function (name) { _connect(name); ws.addEventListener('message', onWs) };

/* ---------- message rendering (images) ---------- */
mh = m => `<div class="msg">${av(m[0], 40)}<div><b>${E(m[0])}</b><small>${tm(m[2])}</small>${m[1] ? `<div dir="auto">${E(m[1])}</div>` : ''}${m[3] ? `<img class="pic" src="${m[3]}" alt="image">` : ''}</div></div>`;

const pendHTML = () => pendImg ? `<div class="pend"><img src="${pendImg}" alt=""><button class="gb rd sm" data-a="pendx" aria-label="Remove image">✕</button></div>` : '';
const compHTML = ph => `<div class="comp"><button class="gb bl" data-a="att" aria-label="Attach image" style="width:38px;height:38px">📎</button><input id="in" placeholder="${E(ph)}" aria-label="Message" autocomplete="off" maxlength="2000"><button class="gb bl" data-a="send" aria-label="Send message" style="width:44px;height:38px">${ic('send')}</button></div>`;

const _rMain = rMain;
rMain = function () {
  if (view == 'd') { renderDM(); return }
  _rMain();
  decorate();
  if (view == 't') {
    const c = document.querySelector('.comp');
    if (c) {
      c.insertAdjacentHTML('afterbegin', '<button class="gb bl" data-a="att" aria-label="Attach image" style="width:38px;height:38px">📎</button>');
      c.insertAdjacentHTML('beforebegin', pendHTML());
    }
  }
};

function renderDM() {
  const name = uName(DMU);
  const list = (DMS[DMU] || []).map(m => mh([m[1], m[2], m[4], m[3]])).join('');
  $('main').innerHTML = `<div class="head">@ ${E(name)}<span class="tp">Direct message</span><span style="flex:1"></span>` +
    `<button class="gb gr sm" data-a="callst" data-v="${DMU}" aria-label="Voice call" title="Voice call">${ic('spk', 0, 16)}</button></div>` +
    `<div class="msgs" id="msgs">${list}</div>${pendHTML()}${compHTML('Message @' + name)}`;
  const g = $('msgs'); g.scrollTop = g.scrollHeight;
}
function openDM(uid) {
  DMU = uid; view = 'd';
  dmRecent[uid] = uName(uid); saveRecent();
  out({ t: 'dmopen', uid }); closeProf(); all();
  setTimeout(() => { const i = $('in'); if (i) i.focus() }, 0);
}

sendMsg = function () {
  const i = $('in'); if (!i) return;
  const t = i.value.trim(); if (!t && !pendImg) return;
  pop();
  if (view == 'd' && DMU) out({ t: 'dm', to: DMU, text: t, img: pendImg || '' });
  else out({ t: 'msg', s: cur, ch: T, text: t, img: pendImg || '' });
  i.value = ''; pendImg = null; all(); i.focus();
};

/* ---------- members list with presence dots ---------- */
rMem = function () {
  const m = $('mem'), us = (S[cur] || {}).users || [];
  m.style.display = showMem ? '' : 'none';
  m.innerHTML = `<div class="cat">ONLINE — ${us.length}</div>` + us.map(u =>
    `<div class="mm" data-u="${u.id}" data-a="pf" data-v="${u.id}" role="button" tabindex="0">${av(u.name, 32)}${E(u.name)}${u.id == me.id ? ' <small style="color:var(--mu)">(you)</small>' : ''}<span class="gem ${u.deaf ? 'dn' : u.mute ? 'off' : ''}" title="${pres(u)}"></span></div>`
  ).join('');
  decorate();
};

/* ---------- sidebar: music toggle, voice row ids, DM list ---------- */
const _rSide = rSide;
rSide = function () {
  _rSide();
  const sn = $('sname'), chs = $('chs');
  if (!sn || !chs || !S[cur]) return;
  const s = S[cur], vus = chs.querySelectorAll('.vu'); let i = 0;
  for (const r of s.rooms) for (const u of (s.voice[r.id] || [])) { const el = vus[i++]; if (el) el.dataset.u = u.id }
  decorate();
  sn.insertAdjacentHTML('beforeend', `<button class="gb ${bgOn ? 'bl' : 'rd'} sm" data-a="bgt" aria-label="Background music" title="Background music">♪</button>`);
  const ids = Object.keys(dmRecent);
  if (ids.length) chs.insertAdjacentHTML('beforeend', '<div class="cat">DIRECT MESSAGES</div>' +
    ids.map(u => `<button class="ch ${view == 'd' && DMU == u ? 'on' : ''}" data-a="dmo" data-v="${u}">@ ${E(dmRecent[u])}</button>`).join(''));
};

/* ---------- mute / deafen badges on avatars ---------- */
function decorate() {
  document.querySelectorAll('.tile[data-u], .vu[data-u]').forEach(el => {
    el.querySelectorAll('.sbadge').forEach(b => b.remove());
    const u = findU(el.dataset.u); if (!u || !(u.mute || u.deaf)) return;
    el.insertAdjacentHTML('beforeend', `<span class="sbadge ${u.deaf ? 'dn' : ''}" title="${pres(u)}">${ic(u.deaf ? 'hp' : 'mic', true, 11)}</span>`);
  });
}

/* ---------- profile modal ---------- */
const prof = document.createElement('div');
prof.className = 'modal'; prof.id = 'prof'; prof.hidden = true;
prof.innerHTML = '<div class="pane box" id="profb"></div>';
document.body.appendChild(prof);
const closeProf = () => { prof.hidden = true };
function openProf(u) {
  const self = u.id == me.id;
  $('profb').innerHTML = `<div class="pfh">${av(u.name, 64)}<div><h3>${E(u.name)}</h3><div class="pfs">${pres(u)}</div></div></div>` +
    (self
      ? `<label>About me (max 160)<textarea id="bio" maxlength="160" rows="3">${E(u.bio || '')}</textarea></label><button class="gb gr" data-a="bio-save" style="align-self:flex-end">Save</button>`
      : `<div class="pfb">${E(u.bio || 'No bio yet.')}</div>` + (u.uid
          ? `<div class="mrow" style="justify-content:flex-end"><button class="gb gr" data-a="callst" data-v="${u.uid}">Call</button><button class="gb bl" data-a="dmo" data-v="${u.uid}">Message</button></div>`
          : '')) +
    `<button class="gb rd" data-a="pfx" style="align-self:flex-end">Close</button>`;
  prof.hidden = false;
}

/* ---------- image compression ---------- */
function squeeze(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, 1000 / Math.max(im.width, im.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      x.drawImage(im, 0, 0, c.width, c.height);
      for (const q of [.8, .65, .5, .35]) { const d = c.toDataURL('image/jpeg', q); if (d.length <= 480000) return res(d) }
      res(null);
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('bad image')) };
    im.src = url;
  });
}
const fi = document.createElement('input');
fi.type = 'file'; fi.accept = 'image/*'; fi.hidden = true; document.body.appendChild(fi);
fi.onchange = async () => {
  const f = fi.files && fi.files[0]; fi.value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) return alert('Choose an image file');
  try {
    const d = await squeeze(f);
    if (!d) return alert('This image is too large even after compressing. Try a smaller one.');
    pendImg = d; all();
  } catch (e) { alert('Could not read that image') }
};

/* ---------- private voice calls ---------- */
function renderCall() {
  let bar = document.getElementById('callbar');
  if (!CALL) { if (bar) bar.remove(); return }
  if (!bar) { bar = document.createElement('div'); bar.id = 'callbar'; document.body.appendChild(bar) }
  const lbl = CALL.state === 'live' ? 'In call' : CALL.state === 'connecting' ? 'Connecting…' : 'Calling…';
  bar.innerHTML = `<span>📞 ${E(CALL.name)} · ${lbl}</span><button class="gb rd sm" data-a="callend" aria-label="Hang up">${ic('leave', 0, 16)}</button>`;
}
function renderRing() {
  let box = document.getElementById('ringbox');
  if (!RING) { if (box) box.remove(); return }
  if (!box) { box = document.createElement('div'); box.id = 'ringbox'; document.body.appendChild(box) }
  box.innerHTML = `<div class="rb"><b>${E(RING.name)}</b> is calling you<div class="rbtn"><button class="gb gr" data-a="callacc">Accept</button><button class="gb rd" data-a="calldec">Decline</button></div></div>`;
}
const getMic = () => navigator.mediaDevices.getUserMedia({ audio: mc() });
async function callStart(uid) {
  if (CALL) return alert('You are already in a call');
  let stream; try { stream = await getMic() } catch (e) { return alert('Allow microphone access to make calls') }
  CALL = { uid, name: uName(uid), stream, pc: null, audio: null, state: 'calling', timer: null };
  CALL.timer = setTimeout(() => { if (CALL && CALL.state === 'calling') { alert('No answer'); endCall(true) } }, 30000);
  out({ t: 'dcall', to: uid }); renderCall(); applyCall();
  closeProf();
}
function acceptCall() {
  const r = RING; RING = null; renderRing();
  if (!r || CALL) return;
  getMic().then(stream => {
    CALL = { uid: r.from, name: r.name, stream, pc: null, audio: null, state: 'connecting', timer: null };
    makePC(false); out({ t: 'dacc', to: r.from }); renderCall(); applyCall();
  }).catch(() => { out({ t: 'ddec', to: r.from }); alert('Allow microphone access to take calls') });
}
function makePC(init) {
  const pc = new RTCPeerConnection(ICE); CALL.pc = pc;
  CALL.stream.getAudioTracks().forEach(t => pc.addTrack(t, CALL.stream));
  pc.onicecandidate = e => { if (e.candidate) out({ t: 'csig', to: CALL.uid, data: { c: e.candidate } }) };
  pc.ontrack = e => { const a = new Audio(); a.srcObject = e.streams[0]; a.muted = deaf; a.play().catch(() => {}); CALL.audio = a };
  pc.onconnectionstatechange = () => {
    if (!CALL || CALL.pc !== pc) return;
    if (pc.connectionState === 'connected') { CALL.state = 'live'; renderCall() }
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') endCall(false);
  };
  if (init) pc.createOffer().then(d => pc.setLocalDescription(d)).then(() => out({ t: 'csig', to: CALL.uid, data: { d: pc.localDescription } })).catch(() => {});
}
async function onCsig(from, d) {
  if (!CALL || CALL.uid !== from || !CALL.pc) return;
  const pc = CALL.pc;
  try {
    if (d.d) {
      await pc.setRemoteDescription(d.d);
      if (d.d.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); out({ t: 'csig', to: from, data: { d: pc.localDescription } }) }
    } else if (d.c) await pc.addIceCandidate(d.c);
  } catch (e) {}
}
function endCall(notify) {
  if (!CALL) return;
  const c = CALL; CALL = null; clearTimeout(c.timer);
  if (notify) out({ t: 'dend', to: c.uid });
  try { c.pc && c.pc.close() } catch (e) {}
  if (c.stream) c.stream.getTracks().forEach(t => t.stop());
  if (c.audio) c.audio.srcObject = null;
  renderCall();
}
function applyCall() {
  if (!CALL) return;
  if (CALL.stream) CALL.stream.getAudioTracks().forEach(t => t.enabled = !(mute || deaf));
  if (CALL.audio) CALL.audio.muted = deaf;
}

/* ---------- clicks + keys ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a, v = b.dataset.v;
  if (a === 'pf') { const u = findU(v); if (u) openProf(u); return }
  if (a === 'pfx') return closeProf();
  if (a === 'bio-save') { const t = $('bio'); out({ t: 'bio', text: t ? t.value : '' }); return closeProf() }
  if (a === 'dmo') return openDM(v);
  if (a === 'callst') return callStart(v);
  if (a === 'callend') return endCall(true);
  if (a === 'callacc') return acceptCall();
  if (a === 'calldec') { if (RING) out({ t: 'ddec', to: RING.from }); RING = null; return renderRing() }
  if (a === 'att') return fi.click();
  if (a === 'pendx') { pendImg = null; return all() }
  if (a === 'bgt') { bgSet(!bgOn); return all() }
  if (a === 'mute' || a === 'deaf') { applyCall(); setTimeout(() => out({ t: 'pstate', mute, deaf }), 0) }
  else if (a === 'v' || a === 'leave') setTimeout(() => out({ t: 'pstate', mute, deaf }), 0);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeProf() });

/* keep the typed draft when the view re-renders (voice/presence updates no longer wipe your message) */
const _rMainFinal = rMain;
rMain = function () {
  const draft = $('in') ? $('in').value : '', focused = document.activeElement && document.activeElement.id === 'in';
  _rMainFinal();
  const i = $('in');
  if (i) { i.value = draft; if (focused) i.focus() }
};

/* ---------- start: go straight in if this tab already has a session ---------- */
if (ss.get('samar-session')) { $('login').hidden = true; connect(ss.get('samar-name') || 'User') }
})();
