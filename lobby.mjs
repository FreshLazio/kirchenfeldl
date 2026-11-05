// Mehrspieler-Lobby für KIRCHENFELDL (Server-Seite). client = Objekt mit send(event, payload).
// Mehrere Lobbys gleichzeitig (je 4-Buchstaben-Code), 1 gegen 1 oder bis zu 30 Spieler (ganze Schulklasse).
import os from 'node:os';

const MAX_PLAYERS = 30;
const PALETTE = ['#ff4d79', '#5fd8ff', '#ffd166', '#7bed9f', '#c78bff', '#ff9f43', '#f8f8f8', '#ff6bd6'];
// freie Farbe: zuerst die 8 festen, danach gut unterscheidbare (Farbkreis im goldenen Winkel)
const hex = (h, s, l) => { const f = n => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); }; return `#${f(0)}${f(8)}${f(4)}`; };
const freeColor = L => {
  const used = new Set([...L.players.values()].map(p => p.color));
  for (const c of PALETTE) if (!used.has(c)) return c;
  for (let k = 0; k < 200; k++) { const c = hex((k * 137.508 + 20) % 360, 0.75, k % 2 ? 0.62 : 0.72); if (!used.has(c)) return c; }
  return null;
};

export function createLobby({ onGame = null } = {}) {
  const lobbies = new Map();
  // Spielarchiv: Stand dieses Spiels melden (wer, wann, jede Antwort mit Punkten) – nichts von Adressen oder Geräten
  const record = L => {
    if (!onGame || !L.gid) return;
    const ps = [...L.players.values()].filter(p => p.id !== L.outId), nearl = L.settings.mode === 'nearl';
    const score = (p, r) => {   // Quiz: gleiche Antwort wie jemand anderes = halbe Punkte (wie im Spiel)
      const a = p.answers[r]; if (!a) return 0;
      if (nearl || !(a.idx >= 0)) return a.pts || 0;
      return ps.some(o => o !== p && o.answers[r]?.idx === a.idx) ? Math.round((a.pts || 0) / 2) : a.pts || 0;
    };
    const rows = ps.map(p => {
      const a = {}; let tot = 0;
      for (const r of Object.keys(p.answers)) { const x = p.answers[r], s = score(p, r); tot += s; a[r] = { n: x.name, p: s, ...(x.dist != null ? { d: Math.round(x.dist) } : {}) }; }
      return { n: p.name, c: p.color, team: L.settings.nearl?.teams ? p.team || 'A' : undefined, gone: !!p.gone, tot, a };
    }).sort((x, y) => y.tot - x.tot);
    // auch ohne Antworten melden: jedes gestartete Spiel steht im Archiv (wer gehostet hat, wann)
    onGame({ id: L.gid, code: L.code, t0: L.t0, t1: Date.now(), done: L.phase === 'done', mode: L.settings.mode, title: L.title || '', labels: L.labels || [], rounds: L.qs.length, host: L.hostName || '', led: !!L.outId, players: rows });
  };
  const ips = () => Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);

  const view = L => ({
    code: L.code, hostId: L.hostId, outId: L.outId || null, phase: L.phase, settings: L.settings,
    teamNames: L.teamNames || {}, qs: L.qs, shapes: L.shapes || null, sprints: L.sprints || null, seen: L.seen || [], seenCities: L.seenCities || [], round: L.round, roundStart: L.roundStart, now: Date.now(), ips: ips(),
    players: [...L.players.values()].map(({ client, tmr, ...p }) => p),
  });
  const send = L => { const v = view(L); for (const p of L.players.values()) { if (p.gone) continue; try { p.client?.send('kfl:state', v); } catch { /* weg */ } } };
  // Verbindung weg (Tab zu, WLAN weg, Seite neu geladen): kurz warten – kommt man zurück, geht's weiter.
  // Sonst: in der Lobby raus · im Spiel «gone» (Punkte bleiben, aber niemand wartet mehr auf ihn) · Host geht an den nächsten
  const GRACE = 8000;
  const live = L => [...L.players.values()].filter(p => !p.gone);
  function fixHost(L) {
    const h = L.players.get(L.hostId);
    if (h && !h.gone) return;
    const next = live(L)[0]; if (next) L.hostId = next.id;
  }
  function drop(L, p) {
    if (L.players.get(p.id) !== p || !p.off) return;
    if (L.phase === 'lobby') L.players.delete(p.id); else p.gone = true;
    if (!live(L).length) return empty(L);
    fixHost(L); send(L);
  }
  // Alle weg: Lobby im Spiel noch 5 min aufheben (wer nur neu lädt oder kurz offline ist, kommt zurück)
  function empty(L) {
    if (L.phase === 'lobby' || !L.players.size) return lobbies.delete(L.code);
    clearTimeout(L.dieTmr); L.dieTmr = setTimeout(() => { if (!live(L).length) lobbies.delete(L.code); }, 300000);
  }
  function bind(L, p, client) {
    p.client = client; p.off = 0; p.gone = false; clearTimeout(p.tmr); clearTimeout(L.dieTmr);
    const sock = client && client.socket;
    if (!sock || sock.__kfl === p) return;
    sock.__kfl = p;
    sock.on('close', () => {
      if (p.client !== client) return;   // längst neu verbunden
      p.off = Date.now(); clearTimeout(p.tmr); p.tmr = setTimeout(() => drop(L, p), GRACE);
    });
  }
  const newCode = () => {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let c;
    do c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); while (lobbies.has(c));
    return c;
  };
  const err = (client, msg) => client.send('kfl:error', { msg });
  const clean = s => String(s || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 14) || 'Gast';
  // Spielfigur (Tier/Kopf/Ding): nur kurze Kennungen, gezeichnet wird im Browser
  const cleanAv = v => { if (!v || typeof v !== 'object') return null; const k = x => (typeof x === 'string' && /^[a-z0-9]{1,12}$/.test(x) ? x : ''); return { a: k(v.a), h: k(v.h), x: k(v.x), b: k(v.b) }; };
  const player = (d, client) => ({ id: d.id, name: clean(d.name), color: /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#ff4d79', av: cleanAv(d.av), team: 'A', answers: {}, client });

  const handlers = {
    'kfl:create'(d, client) {
      const code = newCode();
      const L = { code, hostId: d.id, phase: 'lobby', settings: { world: 'kirchenfeld', cats: null, opts: { style: 'mix', diff: 'all', rounds: 7, time: 20 } }, qs: [], round: -1, roundStart: 0, players: new Map() };
      L.players.set(d.id, player(d, client)); bind(L, L.players.get(d.id), client);
      lobbies.set(code, L);
      if (d.mode === 'nearl') { L.settings.mode = 'nearl'; if (d.nearl) handlers['kfl:settings']({ code, id: d.id, nearl: d.nearl }); }
      send(L);
    },
    'kfl:join'(d, client) {
      const L = lobbies.get(String(d.code || '').toUpperCase().trim());
      if (!L) return err(client, 'nolobby');
      const known = L.players.get(d.id);
      if (known) { bind(L, known, client); fixHost(L); return send(L); }   // zurück (neu geladen / WLAN wieder da) → weiterspielen
      if (L.banned && L.banned.has(d.id)) return err(client, 'kicked');
      if (L.phase !== 'lobby') return err(client, 'started');
      if (L.players.size >= MAX_PLAYERS) return err(client, 'full');
      if ([...L.players.values()].some(p => p.color === d.color)) d.color = freeColor(L) || d.color;
      L.players.set(d.id, player(d, client)); bind(L, L.players.get(d.id), client);
      send(L);
    },
    'kfl:profile'(d) {
      const L = lobbies.get(d.code); const p = L?.players.get(d.id);
      if (!p || L.phase !== 'lobby') return;
      if (d.name) p.name = clean(d.name);
      if (/^#[0-9a-f]{6}$/i.test(d.color || '') && ![...L.players.values()].some(o => o !== p && o.color === d.color)) p.color = d.color;
      if (d.team === 'A' || d.team === 'B') p.team = d.team;
      if (d.av) p.av = cleanAv(d.av);
      send(L);
    },
    // Host wirft jemanden raus (darf danach nicht mehr in diese Lobby)
    'kfl:kick'(d) {
      const L = lobbies.get(d.code);
      if (!L || L.hostId !== d.id || d.target === d.id) return;
      const p = L.players.get(d.target);
      if (!p) return;
      (L.banned ||= new Set()).add(d.target);
      try { p.client?.send('kfl:kicked', { code: L.code }); } catch { /* weg */ }
      L.players.delete(d.target);
      send(L);
    },
    // Host teilt Teams ein (NEARL 5 gegen 5)
    'kfl:team'(d) {
      const L = lobbies.get(d.code); const p = L?.players.get(d.target);
      // Host darf alle einteilen, jeder Spieler sich selbst
      if (!p || (L.hostId !== d.id && d.target !== d.id) || L.phase !== 'lobby') return;
      p.team = ['A', 'B', 'C', 'D', 'E'].includes(d.team) ? d.team : 'A';
      send(L);
    },
    // Teamname: Host für alle Teams, sonst jeder für sein eigenes Team (leer = wieder «Team A»)
    'kfl:teamname'(d) {
      const L = lobbies.get(d.code); const p = L?.players.get(d.id);
      const k = ['A', 'B', 'C', 'D', 'E'].includes(d.team) ? d.team : null;
      if (!p || !k || L.phase !== 'lobby' || (L.hostId !== d.id && p.team !== k)) return;
      const name = String(d.name || '').replace(/[^\p{L}\p{N}\p{Emoji_Presentation} ._!-]/gu, '').trim().slice(0, 18);
      L.teamNames ||= {};
      if (name) L.teamNames[k] = name; else delete L.teamNames[k];
      send(L);
    },
    'kfl:settings'(d) {
      const L = lobbies.get(d.code);
      if (!L || L.hostId !== d.id || L.phase !== 'lobby') return;
      if (typeof d.world === 'string') L.settings.world = d.world.slice(0, 20);
      if (d.mode === 'quiz' || d.mode === 'nearl') L.settings.mode = d.mode;
      if (d.nearl && typeof d.nearl === 'object') {
        const n = d.nearl;
        // genau ein Modus: Ringe > Reise > Zoom > Sprint > Nadel > Formen > nahe Stadt
        const kind = ['border', 'puzzle', 'more', 'rings', 'trip', 'zoom', 'radar', 'compass', 'box', 'count', 'half', 'sprint', 'pin', 'shapes'].find(k => n[k]) || 'near';
        L.settings.nearl = {
          region: ['world', 'europe', 'asia', 'africa', 'namerica', 'samerica', 'oceania', 'switzerland', 'switzerlandAll', 'italy', 'italyAll', 'germany', 'usa', 'russia'].includes(n.region) ? n.region : 'world',
          hostOut: !!n.hostOut, autoNext: [5, 10, 20].includes(+n.autoNext) ? +n.autoNext : 0,   // Lehrperson leitet nur · nach der Auflösung automatisch weiter
          diff: n.diff === 'hard' ? 'hard' : 'easy', shapes: kind === 'shapes', pin: kind === 'pin', sprint: kind === 'sprint', rings: kind === 'rings', trip: kind === 'trip', zoom: kind === 'zoom', radar: kind === 'radar', compass: kind === 'compass', box: kind === 'box', count: kind === 'count', half: kind === 'half', border: kind === 'border', puzzle: kind === 'puzzle', more: kind === 'more', rare: false, teams: !!n.teams,   // «Selten = mehr Punkte» gibt es nicht mehr
          shapeSize: ['easy', 'medium', 'hard'].includes(n.shapeSize) ? n.shapeSize : 'medium', perRing: [1, 2, 3].includes(+n.perRing) ? +n.perRing : 2, parts: [0, 2, 3, 4].includes(+n.parts) ? +n.parts : 0, popCities: !!n.popCities, coarse: !!n.coarse, canton: Number.isInteger(+n.canton) && +n.canton >= 0 && +n.canton <= 26 ? +n.canton : 0,
          teamCount: [2, 3, 4, 5].includes(+n.teamCount) ? +n.teamCount : 2, teamScore: ['sum', 'avg', 'best', 'lives'].includes(n.teamScore) ? n.teamScore : 'lives',
          rounds: Number.isInteger(+n.rounds) && +n.rounds >= 1 && +n.rounds <= 20 ? +n.rounds : 7, time: +n.time === 0 ? 0 : Number.isFinite(+n.time) && +n.time > 0 ? Math.max(5, Math.min(600, Math.round(+n.time))) : 30, timeCustom: !!n.timeCustom,   // 0 = ohne Zeit · eigene Zahl gilt genau
        };
        // weniger Teams: wer in einem weggefallenen Team war, kommt ins letzte noch vorhandene
        const letters = ['A', 'B', 'C', 'D', 'E'].slice(0, L.settings.nearl.teamCount);
        for (const p of L.players.values()) if (!letters.includes(p.team)) p.team = letters[letters.length - 1];
      }
      if (Array.isArray(d.cats) || d.cats === null) L.settings.cats = d.cats ? d.cats.slice(0, 120).map(String) : null;
      if (d.opts && typeof d.opts === 'object') {
        const o = d.opts;
        L.settings.opts = {
          style: ['mix', 'precise', 'abc', 'swissle'].includes(o.style) ? o.style : 'mix',
          diff: ['all', 'easy', 'hard'].includes(o.diff) ? o.diff : 'all',
          rounds: [5, 7, 10].includes(+o.rounds) ? +o.rounds : 7,
          time: [15, 20, 30].includes(+o.time) ? +o.time : 20,
        };
      }
      send(L);
    },
    'kfl:start'(d) {
      const L = lobbies.get(d.code);
      if (!L || L.hostId !== d.id || L.phase !== 'lobby' || !Array.isArray(d.qs) || !d.qs.length) return;
      const nearl = L.settings.mode === 'nearl';
      L.qs = d.qs.slice(0, nearl ? 20 : 12).map(Number);
      if (Array.isArray(d.shapes)) L.shapes = d.shapes.slice(0, 20); else L.shapes = null;
      L.sprints = Array.isArray(d.sprints) ? d.sprints.slice(0, 20) : null;   // Kreis-Sprint: Kreise
      if (nearl) L.seenCities = [...(L.seenCities || []), ...L.qs].slice(-400);
      else L.seen = [...(L.seen || []), ...L.qs].slice(-400); // Fragen dieser Lobby merken → nächste Runde andere
      L.phase = 'play'; L.round = 0; L.roundStart = Date.now() + 4500;
      for (const p of L.players.values()) p.answers = {};
      // «nur leiten»: Host zählt nicht als Spieler · Archiv: neues Spiel
      L.outId = nearl && L.settings.nearl?.hostOut ? L.hostId : null;
      L.gid = `${Date.now().toString(36)}-${L.code}`; L.t0 = Date.now(); L.hostName = L.players.get(L.hostId)?.name || '';
      L.title = String(d.title || '').slice(0, 120); L.labels = Array.isArray(d.labels) ? d.labels.slice(0, 20).map(x => String(x).slice(0, 120)) : [];
      record(L);   // sofort im Archiv: wer wann was gehostet hat – auch wenn danach niemand antwortet
      send(L);
    },
    'kfl:answer'(d) {
      const L = lobbies.get(d.code); const p = L?.players.get(d.id);
      if (!p || L.phase !== 'play' || d.round !== L.round || p.answers[d.round]) return;
      const a = d.ans || {};
      // NEARL: jede Stadt nur einmal pro Runde – wer zuerst kommt; die anderen müssen eine andere finden
      const ns = L.settings.nearl || {};
      if (L.settings.mode === 'nearl' && !(ns.pin || ns.sprint || ns.rings || ns.trip || ns.zoom || ns.radar || ns.compass || ns.box || ns.count || ns.half || ns.border || ns.puzzle || ns.more) && a.name && a.name !== '—') {   // Nadel-Modus: alle setzen ihre eigene Nadel
        const k = Number.isInteger(a.idx) && a.idx >= 0 ? 'i' + a.idx : 'n' + String(a.name).toLowerCase();
        const taken = [...L.players.values()].some(o => { const b = o.answers[d.round]; return b && b.name !== '—' && (b.idx >= 0 ? 'i' + b.idx : 'n' + b.name.toLowerCase()) === k; });
        if (taken) { try { p.client?.send('kfl:taken', { code: L.code, round: d.round, name: String(a.name).slice(0, 60) }); } catch { /* weg */ } return; }
      }
      const num = (v, lo, hi) => (v != null && v !== '' && Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : null);
      p.answers[d.round] = { idx: Number.isInteger(a.idx) ? a.idx : -1, name: String(a.name || '').slice(0, 60), tier: Number(a.tier), pts: Math.max(0, Math.min(10000, Number(a.pts) || 0)),   // Seltenheits-Bonus: bis ×2
        lat: num(a.lat, -90, 90), lon: num(a.lon, -180, 180), dist: num(a.dist, 0, 40000), mult: num(a.mult, 1, 2) };
      // Sprint/Ringe: welche Städte (und wer sie gefunden hat) – für die Auflösung
      if (Array.isArray(a.found)) {
        p.answers[d.round].found = a.found.slice(0, 60).map(f => ({ k: String(f.k || '').slice(0, 80), n: String(f.n || '').slice(0, 60), lat: num(f.lat, -90, 90), lon: num(f.lon, -180, 180), l: num(f.l, 0, 9) || 0, by: L.players.has(f.by) ? f.by : d.id }))
          .filter(f => f.lat != null && f.lon != null);
        p.answers[d.round].level = num(a.level, 0, 9) || 0;
      }
      record(L);
      send(L);
    },
    // Host beendet die Runde (ohne Zeit oder wenn jemand nicht mehr antwortet): wer noch nichts hat, bekommt 0
    'kfl:force'(d) {
      const L = lobbies.get(d.code);
      if (!L || L.hostId !== d.id || L.phase !== 'play' || d.round !== L.round) return;
      for (const p of L.players.values()) if (!p.gone && !p.answers[d.round]) p.answers[d.round] = { idx: -1, name: '—', tier: -1, pts: 0, lat: null, lon: null, dist: null, mult: null };
      record(L);
      send(L);
    },
    // Sprint/Ringe im Teammodus: gefundene Stadt sofort an die Teamkameraden (man sammelt zusammen)
    'kfl:found'(d) {
      const L = lobbies.get(d.code); const p = L?.players.get(d.id);
      if (!p || L.phase !== 'play' || d.round !== L.round || !d.f) return;
      const f = { k: String(d.f.k || '').slice(0, 80), n: String(d.f.n || '').slice(0, 60), lat: +d.f.lat, lon: +d.f.lon, m: Math.max(1, Math.min(2, +d.f.m || 1)) };
      if (!f.k || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) return;
      // ab 3 Teams (bzw. 3 Spielern): dieselbe Stadt wie ein anderes Team (das sie früher hatte) zählt nur halb
      const ns = L.settings.nearl || {}, teams = !!ns.teams;
      if (!L.rf || L.rf.round !== d.round) L.rf = { round: d.round, by: new Map() };
      const first = L.rf.by.get(f.k), many = teams ? (ns.teamCount || 2) >= 3 : L.players.size >= 3;
      const dup = many && !ns.trip && first != null && first !== (teams ? p.team : p.id);
      if (first == null) L.rf.by.set(f.k, teams ? p.team : p.id);
      if (dup) { try { p.client?.send('kfl:dup', { code: L.code, round: d.round, k: f.k, n: f.n }); } catch { /* weg */ } }
      if (!teams) return;   // jeder gegen jeden: nur mitzählen
      for (const o of L.players.values()) if (o !== p && o.team === p.team) { try { o.client?.send('kfl:found', { code: L.code, round: d.round, by: p.id, who: p.name, color: p.color, f, dup }); } catch { /* weg */ } }
    },
    'kfl:next'(d) {
      const L = lobbies.get(d.code);
      if (!L || L.hostId !== d.id || L.phase !== 'play' || d.round !== L.round) return;
      L.round++;
      if (L.round >= L.qs.length || d.end) L.phase = 'done';   // NEARL-Teams: Ende, sobald ein Team keine Leben mehr hat
      else L.roundStart = Date.now() + (L.settings.mode === 'nearl' ? 5000 : 1200);   // NEARL: kurz der Zwischenstand
      record(L);
      send(L);
    },
    'kfl:again'(d) {
      const L = lobbies.get(d.code);
      if (!L || L.hostId !== d.id) return;
      record(L); L.gid = null; L.outId = null;
      L.phase = 'lobby'; L.round = -1; L.qs = [];
      for (const p of [...L.players.values()]) { if (p.gone) L.players.delete(p.id); else p.answers = {}; }   // wer weg ist, fliegt bei der Revanche aus der Liste
      send(L);
    },
    'kfl:leave'(d) {
      const L = lobbies.get(d.code);
      const p = L && L.players.get(d.id); if (!p) return;
      clearTimeout(p.tmr);
      // im Spiel: Punkte bleiben in der Rangliste, aber niemand wartet mehr auf ihn
      if (L.phase === 'lobby') L.players.delete(d.id); else { p.gone = true; p.off = Date.now(); }
      if (!live(L).length) return lobbies.delete(L.code);
      fixHost(L); send(L);
    },
  };
  return {
    events: Object.keys(handlers),
    handle(ev, data, client) { if (handlers[ev] && data && typeof data.id === 'string') handlers[ev](data, client); },
  };
}
