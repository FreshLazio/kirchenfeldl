// Tages-Ranglisten für KIRCHENFELDL (Server-Seite): Nickname + Punkte der Tages-Challenge.
// Speicher: JSON-Datei (lokal / eigener Server) oder – online ohne feste Festplatte – Upstash Redis (REST),
// wenn UPSTASH_REDIS_REST_URL und UPSTASH_REDIS_REST_TOKEN gesetzt sind.
// API:  GET  /api/scores?kind=nearl&day=2026-11-02   → { today: [...], best: [...] }
//       GET  /api/scores?all=1&day=2026-11-02        → { day, days, kinds: { <kind>: { today, total, best, players } } }   (Ranglisten-Seite)
//       Profil: GET ?me=1&dev=… → { nick } · POST { account: true, dev, nick } → anlegen oder umbenennen (alle Einträge ziehen mit)
//       freies Spiel: GET ?free=1&kind=trip&v=russia.r5…&nick=  → { top, players, rank, mine } · GET ?free=1&all=1 · POST { free: true, kind, v, day, nick, score, dev }
//       POST /api/scores  { kind, day, nick, score, dev }   → { ok, rank, today, best }   (dev = Zufalls-Kennung des Geräts: 1 Eintrag pro Gerät)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

// nearl = Nahe Stadt · nearl-<modus> = Tages-Challenge der anderen NEARL-Modi (teilen, zoom, reise …) · quiz-<welt>
const KIND = /^(nearl(-[a-z]{2,12})?|quiz-[a-z0-9_-]{1,30})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// grosszügige Obergrenzen (Quiz: Punkte pro Welt · NEARL: 5 Runden, Ringe/Sprint mit Tempo-Bonus mehr) – alles darüber ist sicher geschummelt
const MAX = kind => (kind === 'nearl' ? 40000 : kind.startsWith('nearl-') ? 150000 : 100000);
const KEEP_DAYS = 60, TOP = 10, ALL = 500;   // ALL: so viele Zeilen pro Modus auf der Ranglisten-Seite

export function createScores({ file = null, upstash = null, adminKey = '' } = {}) {
  let data = { days: {}, best: {} }, ready = null, saveTmr = null;
  const up = upstash && upstash.url && upstash.token ? upstash : null;

  // ───────── Spielarchiv (Mehrspieler): nur mit dem geheimen Schlüssel lesbar (Umgebung KFL_ADMIN_KEY – steht NIE im Code) ─────────
  // Eigener Speicher, damit die Ranglisten klein bleiben · höchstens 300 Spiele / 1,5 MB (die ältesten fallen weg)
  const gamesFile = file ? join(dirname(file), 'games.json') : null;
  let games = [], gamesReady = null, gamesTmr = null;
  const loadGames = async () => {
    try {
      if (up) { const r = await fetch(`${up.url}/get/kfl-games`, { headers: { Authorization: `Bearer ${up.token}` } }); if (!r.ok) throw new Error(`Upstash ${r.status}`); const j = await r.json(); if (j && j.error) throw new Error(j.error); if (j && j.result) games = JSON.parse(j.result); }
      else if (gamesFile) games = JSON.parse(readFileSync(gamesFile, 'utf8'));
    } catch (e) { if (up) { gamesReady = null; throw e; } /* Datei: noch nichts */ }   // Speicher nicht erreichbar: NICHT mit leerem Stand weitermachen
    if (!Array.isArray(games)) games = [];
  };
  const saveGames = () => {
    clearTimeout(gamesTmr);
    gamesTmr = setTimeout(async () => {
      games.sort((a, b) => a.t0 - b.t0);
      if (games.length > 300) games = games.slice(-300);
      let s = JSON.stringify(games);
      while (s.length > 1500000 && games.length > 1) { games = games.slice(Math.ceil(games.length / 10)); s = JSON.stringify(games); }
      try {
        if (up) await fetch(`${up.url}/set/kfl-games`, { method: 'POST', headers: { Authorization: `Bearer ${up.token}` }, body: s });
        else if (gamesFile) { mkdirSync(dirname(gamesFile), { recursive: true }); writeFileSync(gamesFile, s); }
      } catch (e) { console.error('[scores] Archiv speichern ging nicht:', e.message); }
    }, 5000);
  };
  // ein Spiel eintragen oder nachführen (gleiche id = gleiches Spiel)
  async function logGame(g) {
    try { gamesReady ||= loadGames(); await gamesReady; } catch (e) { console.error('[scores] Archiv nicht lesbar:', e.message); return; }
    const i = games.findIndex(x => x.id === g.id);
    if (i >= 0) games[i] = g; else games.push(g);
    saveGames();
  }
  // Schlüssel prüfen: gleich lange Hashes vergleichen · falsche Versuche pro Adresse bremsen
  const sha = s => createHash('sha256').update(String(s)).digest();
  const adminOk = k => !!adminKey && timingSafeEqual(sha(k), sha(adminKey));
  const adminFails = new Map();
  const adminBlocked = ip => { const now = Date.now(), h = (adminFails.get(ip) || []).filter(x => now - x < 3600e3); adminFails.set(ip, h); return h.length >= 10; };

  async function load() {
    try {
      if (up) {
        const r = await fetch(`${up.url}/get/kfl-scores`, { headers: { Authorization: `Bearer ${up.token}` } });
        if (!r.ok) throw new Error(`Upstash ${r.status}`);
        const j = await r.json(); if (j && j.error) throw new Error(j.error);
        if (j && j.result) data = JSON.parse(j.result);
      } else if (file) data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) { if (up) throw e; /* Datei: noch nichts gespeichert */ }   // Speicher kurz weg: NIE mit leerem Stand weitermachen, das würde alle Rekorde überschreiben
    data.days ||= {}; data.best ||= {};
    // Profile: Nickname gehört einem Gerät (nicks: name → Gerät · devNick: Gerät → name) – aus alten Einträgen nachbauen
    if (!data.nicks) {
      data.nicks = {}; data.devNick = {};
      const claim0 = (n, dev) => { const l = n.toLowerCase(); if (dev && !data.nicks[l] && !data.devNick[dev]) { data.nicks[l] = { n, dev }; data.devNick[dev] = l; } };
      for (const ds of Object.values(data.days)) for (const list of Object.values(ds)) for (const e of list) claim0(e.n, e.d);
      for (const vs of Object.values(data.free || {})) for (const b of Object.values(vs)) for (const e of Object.values(b)) claim0(e.n, e.dev);
    }
    data.devNick ||= {};
    // einmalig: alle alten Einträge OHNE Rundenverlauf löschen (ab jetzt hat jeder Eintrag einen) · Profile/Nicknames bleiben
    if (!data.logEra) {
      for (const ds of Object.values(data.days)) for (const d of Object.keys(ds)) ds[d] = ds[d].filter(e => e.l);
      for (const vs of Object.values(data.free || {})) for (const b of Object.values(vs)) for (const k of Object.keys(b)) if (!b[k].l) delete b[k];
      data.best = {}; data.users = {};
      for (const [k, ds] of Object.entries(data.days)) for (const [d, list] of Object.entries(ds)) for (const e of list) userAdd(k, e.n, e.s, d, e.l);
      data.logEra = 1; save();
    }
    // Bestwert jeder Person pro Modus (für «Insgesamt» und die Spieler-Ansicht) – aus alten Daten nachbauen, falls noch nicht da
    if (!data.users) {
      data.users = {};
      for (const [k, ds] of Object.entries(data.days)) for (const [d, list] of Object.entries(ds)) for (const e of list) userAdd(k, e.n, e.s, d);
      for (const [k, list] of Object.entries(data.best)) for (const e of list) { const u = data.users[k]?.[e.n.toLowerCase()]; if (!u) userAdd(k, e.n, e.s, e.d); else if (e.s > u.s) Object.assign(u, { n: e.n, s: e.s, d: e.d }); }
    }
  }
  // l: Rundenverlauf des Bestwerts (bleibt auch, wenn der Tag nach 60 Tagen gelöscht wird)
  function userAdd(kind, nick, score, day, l) {
    const us = (data.users[kind] ||= {}), k = nick.toLowerCase(), u = us[k];
    if (!u) us[k] = { n: nick, s: score, d: day, g: 1, l: l || undefined };
    else { u.g = (u.g || 1) + 1; if (score > u.s) Object.assign(u, { n: nick, s: score, d: day, l: l || undefined }); }
  }
  // Rundenverlauf (was jemand gespielt hat): [{ q: Aufgabe, a: Antwort, p: Punkte, d?: km }] – klein + harmlos halten
  const cleanStr = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
  const cleanLog = l => (Array.isArray(l) ? l.slice(0, 20).map(x => {
    const o = { q: cleanStr(x && x.q, 80), a: cleanStr(x && x.a, 50), p: Math.max(0, Math.min(50000, Math.round(+(x && x.p)) || 0)) };
    const d = +(x && x.d); if (Number.isFinite(d) && d >= 0 && d < 50000) o.d = Math.round(d);
    // Karte: t = Ziel [lat, lon], g = eigener Tipp [lat, lon]
    const ll = v => (Array.isArray(v) && Math.abs(+v[0]) <= 90 && Math.abs(+v[1]) <= 540 ? [+(+v[0]).toFixed(3), +(+v[1]).toFixed(3)] : null);
    const tt = ll(x && x.t), gg = ll(x && x.g); if (tt) o.t = tt; if (gg) o.g = gg;
    return o;
  }) : null);
  const dayEntry = (kind, day, nick) => (data.days[kind]?.[day] || []).find(e => e.n.toLowerCase() === String(nick).toLowerCase());
  const usersOf = kind => Object.values(data.users[kind] || {}).sort((a, b) => b.s - a.s || (a.d < b.d ? -1 : 1));
  // alles auf einmal (Ranglisten-Seite): jeder Modus mit der ganzen Tagesliste und allen Bestwerten pro Person
  const viewAll = day => {
    const kinds = new Set([...Object.keys(data.days), ...Object.keys(data.users)]), out = {};
    for (const k of kinds) {
      const today = (data.days[k]?.[day] || []), best = usersOf(k);
      if (!today.length && !best.length) continue;
      out[k] = { today: today.slice(0, ALL).map(e => ({ nick: e.n, score: e.s, log: e.l ? 1 : 0 })), total: today.length, best: best.slice(0, ALL).map(e => ({ nick: e.n, score: e.s, day: e.d, games: e.g || 1, log: e.l || dayEntry(k, e.d, e.n)?.l ? 1 : 0 })), players: best.length };
    }
    const days = [...new Set(Object.values(data.days).flatMap(ds => Object.keys(ds)))].sort().reverse();
    return { day, days, kinds: out };
  };

  // ───────── Freies Spiel: Rekordlisten pro Modus + Einstellungen (v = «russia.r5.de.sm.t60») – pro Person nur der Bestwert ─────────
  const freeList = (kind, v) => Object.values(data.free?.[kind]?.[v] || {}).sort((a, b) => b.s - a.s || (a.t || 0) - (b.t || 0));
  const freeRow = e => ({ nick: e.n, score: e.s, day: e.d, games: e.g || 1, log: e.l ? 1 : 0 });
  const freeView = (kind, v, nick = '') => {
    const l = freeList(kind, v), i = nick ? l.findIndex(e => e.n.toLowerCase() === nick.toLowerCase()) : -1;
    return { top: l.slice(0, TOP).map(freeRow), players: l.length, rank: i + 1, mine: i >= 0 ? freeRow(l[i]) : null };
  };
  const freeAll = () => {
    const out = {};
    for (const [k, vs] of Object.entries(data.free || {})) for (const v of Object.keys(vs)) { const l = freeList(k, v); if (l.length) ((out[k] ||= {})[v] = { players: l.length, top: l.slice(0, ALL).map(freeRow) }); }
    return { kinds: out };
  };
  function freeAdd(kind, v, nick, score, dev, day, log = null) {
    const b = (((data.free ||= {})[kind] ||= {})[v] ||= {}), key = nick.toLowerCase();
    let u = b[key];
    if (u && u.dev && dev && u.dev !== dev) return { error: 'taken' };   // Nickname gehört in dieser Liste schon einem anderen Gerät
    // gleiches Gerät, neuer Nickname → der alte Eintrag zieht um (ein Gerät = eine Zeile pro Liste)
    const old = dev && Object.entries(b).find(([k, e]) => k !== key && e.dev === dev);
    if (!u && old) { u = old[1]; delete b[old[0]]; u.n = nick; b[key] = u; }
    let newBest = false;
    if (!u) { b[key] = { n: nick, s: score, d: day, g: 1, t: Date.now(), dev: dev || undefined, l: log || undefined }; newBest = true; }
    else { u.g = (u.g || 1) + 1; u.n = nick; if (score > u.s) { Object.assign(u, { s: score, d: day, t: Date.now(), l: log || undefined }); newBest = true; } }
    save();
    return { ok: true, newBest };
  }
  // ───────── Profil: einmal Nickname wählen = für immer angemeldet (pro Gerät) · umbenennen ändert ALLE alten Einträge mit ─────────
  function account(dev, nick) {
    if (!dev) return { ok: true };   // ohne Gerätekennung (alter Stand): wie früher
    const nl = nick.toLowerCase(), cur = data.devNick[dev], o = data.nicks[nl];
    if (o && o.dev !== dev) return { error: 'taken' };   // gehört jemand anderem
    if (cur === nl && o && o.n === nick) return { ok: true };
    if (cur) {
      const same = (n, d) => d === dev || (!d && n.toLowerCase() === cur);   // eigene Einträge (auch alte ohne Gerätekennung)
      for (const ds of Object.values(data.days)) for (const list of Object.values(ds)) for (const e of list) if (same(e.n, e.d)) e.n = nick;
      for (const list of Object.values(data.best)) for (const e of list) if (e.n.toLowerCase() === cur) e.n = nick;
      // Bestwerte pro Person ziehen zum neuen Namen um (gibt es den schon von früher → zusammenlegen)
      const move = (b, keep) => { const u = b[cur]; if (!u) return; delete b[cur]; const v = b[nl]; b[nl] = v ? keep(v, u) : u; b[nl].n = nick; };
      for (const us of Object.values(data.users || {})) move(us, (a, b) => (b.s > a.s ? { ...b, g: (a.g || 1) + (b.g || 1) } : { ...a, g: (a.g || 1) + (b.g || 1) }));
      for (const vs of Object.values(data.free || {})) for (const b of Object.values(vs)) move(b, (a, c) => ({ ...(c.s > a.s ? c : a), g: (a.g || 1) + (c.g || 1), dev }));
      delete data.nicks[cur];
    }
    data.nicks[nl] = { n: nick, dev }; data.devNick[dev] = nl;
    save();
    return { ok: true, renamed: !!cur };
  }
  const freeHits = new Map();
  const freeLimited = ip => { const now = Date.now(), h = (freeHits.get(ip) || []).filter(x => now - x < 3600e3); h.push(now); freeHits.set(ip, h); if (freeHits.size > 50000) freeHits.clear(); return h.length > 120; };
  const FKIND = /^[a-z]{2,12}$/, FV = /^[A-Za-z0-9.-]{1,80}$/;
  function save() {
    clearTimeout(saveTmr);
    saveTmr = setTimeout(async () => {
      prune();
      const s = JSON.stringify(data);
      try {
        if (up) await fetch(`${up.url}/set/kfl-scores`, { method: 'POST', headers: { Authorization: `Bearer ${up.token}` }, body: s });
        else if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, s); }
      } catch (e) { console.error('[scores] speichern ging nicht:', e.message); }
    }, 800);
  }
  // alte Tage weg (Rekorde bleiben)
  function prune() {
    const cut = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
    for (const k of Object.keys(data.days)) for (const d of Object.keys(data.days[k])) if (d < cut) delete data.days[k][d];
  }
  // nur heute oder gestern/morgen (Zeitzonen) – keine Einträge für alte Tage
  const dayOk = d => { const t = Date.now(); return [-1, 0, 1].some(o => new Date(t + o * 864e5).toISOString().slice(0, 10) === d); };
  const cleanNick = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  const view = (kind, day) => ({
    today: (data.days[kind]?.[day] || []).slice(0, TOP).map(e => ({ nick: e.n, score: e.s, log: e.l ? 1 : 0 })),
    best: usersOf(kind).slice(0, 10).map(e => ({ nick: e.n, score: e.s, day: e.d, log: e.l || dayEntry(kind, e.d, e.n)?.l ? 1 : 0 })),   // insgesamt: die 10 besten Personen (je ihr Bestwert)
    total: (data.days[kind]?.[day] || []).length,
  });

  function add(kind, day, nick, score, dev, log = null) {
    const list = ((data.days[kind] ||= {})[day] ||= []);
    if (dev && list.some(e => e.d === dev)) return { error: 'device' };   // pro Gerät nur EIN Eintrag (nicht 100 Nicknames)
    if (list.some(e => e.n.toLowerCase() === nick.toLowerCase())) return { error: 'taken' };   // pro Tag ein Eintrag pro Nickname
    list.push({ n: nick, s: score, t: Date.now(), d: dev || undefined, l: log || undefined });
    list.sort((a, b) => b.s - a.s || a.t - b.t);
    const best = (data.best[kind] ||= []);
    best.push({ n: nick, s: score, d: day }); best.sort((a, b) => b.s - a.s); best.length = Math.min(best.length, 20);
    userAdd(kind, nick, score, day, log);
    save();
    return { ok: true, rank: list.findIndex(e => e.n === nick) + 1 };
  }

  // Bremse: pro Adresse höchstens 20 Einträge pro Stunde · und pro Adresse + Modus + Tag höchstens 40
  // (eine ganze Schulklasse teilt sich oft eine Adresse – darum nicht 1; Adressen werden nur im Speicher gezählt, nie gespeichert)
  const hits = new Map(), perDay = new Map();
  const limited = ip => { const now = Date.now(), h = (hits.get(ip) || []).filter(x => now - x < 3600e3); h.push(now); hits.set(ip, h); return h.length > 20; };
  const dayFull = (ip, kind, day) => { const k = `${ip}|${kind}|${day}`; if (perDay.size > 50000) perDay.clear(); return (perDay.get(k) || 0) >= 40; };
  const dayCount = (ip, kind, day) => { const k = `${ip}|${kind}|${day}`; perDay.set(k, (perDay.get(k) || 0) + 1); };
  const cleanDev = s => (/^[a-z0-9]{12,40}$/.test(String(s || '')) ? String(s) : '');

  const json = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };
  async function handle(req, res) {
    try { ready ||= load(); await ready; } catch (e) { ready = null; console.error('[scores] Speicher nicht erreichbar:', e.message); return json(res, 503, { error: 'store' }); }
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET') {
      const kind = u.searchParams.get('kind') || '', day = u.searchParams.get('day') || '';
      // Profil: welcher Nickname gehört zu diesem Gerät / Schlüssel? (für «auf anderem Gerät anmelden»)
      // Rundenverlauf einer Person ansehen · Tagesrunde von heute nur, wenn DIESES Gerät sie heute selbst schon gespielt hat (kein Spicken)
      if (u.searchParams.get('log')) {
        const nick = cleanNick(u.searchParams.get('nick')), dev = cleanDev(u.searchParams.get('dev'));
        if (!nick) return json(res, 400, { error: 'bad' });
        if (u.searchParams.get('free')) {
          const fv = u.searchParams.get('v') || '';
          if (!FKIND.test(kind) || !FV.test(fv)) return json(res, 400, { error: 'bad' });
          const e = data.free?.[kind]?.[fv]?.[nick.toLowerCase()];
          return e && e.l ? json(res, 200, { nick: e.n, score: e.s, day: e.d, log: e.l }) : json(res, 404, { error: 'none' });
        }
        if (!KIND.test(kind) || !DAY.test(day)) return json(res, 400, { error: 'bad' });
        let e = dayEntry(kind, day, nick);
        if (!e || !e.l) { const u = data.users[kind]?.[nick.toLowerCase()]; e = u && u.d === day && u.l ? u : null; }   // Bestwert, Tag schon gelöscht
        if (!e) return json(res, 404, { error: 'none' });
        const live = [0, 1].some(o => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10) === day);   // heute (UTC oder schon morgen in CH) = noch spielbar
        if (live && !(dev && (data.days[kind]?.[day] || []).some(x => x.d === dev))) return json(res, 403, { error: 'play' });
        return json(res, 200, { nick: e.n, score: e.s, day, log: e.l });
      }
      if (u.searchParams.get('me')) { const dev = cleanDev(u.searchParams.get('dev')), l = dev && data.devNick[dev]; return json(res, 200, { nick: l && data.nicks[l] ? data.nicks[l].n : null }); }
      if (u.searchParams.get('free')) {
        if (u.searchParams.get('all')) return json(res, 200, freeAll());
        const fv = u.searchParams.get('v') || '';
        if (!FKIND.test(kind) || !FV.test(fv)) return json(res, 400, { error: 'bad' });
        return json(res, 200, freeView(kind, fv, cleanNick(u.searchParams.get('nick'))));
      }
      if (u.searchParams.get('all') && DAY.test(day)) return json(res, 200, viewAll(day));
      if (!KIND.test(kind) || !DAY.test(day)) return json(res, 400, { error: 'bad' });
      return json(res, 200, view(kind, day));
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 12000) return json(res, 413, { error: 'big' }); }
      let d; try { d = JSON.parse(body); } catch { return json(res, 400, { error: 'bad' }); }
      const kind = String(d.kind || ''), day = String(d.day || ''), nick = cleanNick(d.nick), score = Math.round(+d.score);
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
      // Spielarchiv: alle Mehrspieler-Spiele, neueste zuerst – nur mit richtigem Schlüssel
      if (d.admin !== undefined) {
        if (adminBlocked(ip)) return json(res, 429, { error: 'slow' });
        if (!adminOk(d.admin)) { adminFails.get(ip).push(Date.now()); return json(res, 403, { error: adminKey ? 'key' : 'off' }); }
        try { gamesReady ||= loadGames(); await gamesReady; } catch { return json(res, 503, { error: 'store' }); }
        return json(res, 200, { games: [...games].sort((a, b) => b.t0 - a.t0) });
      }
      // Profil anlegen oder umbenennen
      if (d.account) {
        const dev = cleanDev(d.dev); if (!dev || !nick) return json(res, 400, { error: 'nick' });
        if (limited(ip)) return json(res, 429, { error: 'slow' });
        const r = account(dev, nick); return json(res, r.error ? 409 : 200, { ...r, nick });
      }
      // jeder Eintrag läuft über das Profil: fremder Name → «taken» · eigener neuer Name → alles zieht mit um
      if (nick && Number.isFinite(score) && score >= 0) { const a = account(cleanDev(d.dev), nick); if (a.error) return json(res, 409, { error: 'taken' }); }
      // freies Spiel: Bestwert in die Rekordliste dieser Einstellungen
      if (d.free) {
        const v = String(d.v || '');
        if (!FKIND.test(kind) || !FV.test(v) || !DAY.test(day) || !dayOk(day)) return json(res, 400, { error: 'bad' });
        if (!nick) return json(res, 400, { error: 'nick' });
        if (!Number.isFinite(score) || score < 0 || score > 200000) return json(res, 400, { error: 'score' });
        if (freeLimited(ip)) return json(res, 429, { error: 'slow' });
        const r = freeAdd(kind, v, nick, score, cleanDev(d.dev), day, cleanLog(d.log));
        return json(res, r.error ? 409 : 200, { ...r, ...freeView(kind, v, nick) });
      }
      if (!KIND.test(kind) || !DAY.test(day) || !dayOk(day)) return json(res, 400, { error: 'day' });
      if (!nick) return json(res, 400, { error: 'nick' });
      if (!Number.isFinite(score) || score < 0 || score > MAX(kind)) return json(res, 400, { error: 'score' });
      // (ip: hinter dem Proxy des Hosters steht die echte Adresse in x-forwarded-for)
      if (limited(ip) || dayFull(ip, kind, day)) return json(res, 429, { error: 'slow' });
      const r = add(kind, day, nick, score, cleanDev(d.dev), cleanLog(d.log));
      if (!r.error) dayCount(ip, kind, day);
      return json(res, r.error ? 409 : 200, { ...r, ...view(kind, day) });
    }
    json(res, 405, { error: 'method' });
  }
  return { handle, logGame };
}
