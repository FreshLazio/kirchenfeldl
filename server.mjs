// KIRCHENFELDL online: ein Node-Server für alles – Website (public/), Mehrspieler-Lobby (WebSocket /ws, Logik: lobby.mjs)
// und Tages-Rangliste (/api/scores, Logik: scores.mjs). Keine fremden Pakete nötig: «node server.mjs».
// Umgebung: PORT (vom Hoster) · SCORES_FILE (Pfad für die Rangliste, sonst ./data/scores.json)
//           UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (Rangliste online speichern, wenn der Hoster keine feste Festplatte hat)
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLobby } from './lobby.mjs';
import { createScores } from './scores.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), PUB = join(HERE, 'public');
const PORT = +process.env.PORT || 8080;
const lobby = createLobby();
const scores = createScores({
  file: process.env.SCORES_FILE || join(HERE, 'data', 'scores.json'),
  upstash: { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN },
});

// ───────── Website: Dateien aus public/ (vorgepackt als .gz, wenn der Browser das kann) ─────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const cache = new Map();
function serveFile(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(PUB, p));
  if (!file.startsWith(PUB)) { res.statusCode = 403; return res.end(); }
  const real = existsSync(file) && statSync(file).isFile() ? file : join(PUB, 'index.html');   // unbekannter Pfad → Startseite (z. B. /?join=ABCD)
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && existsSync(real + '.gz');
  const key = real + (gz ? '.gz' : '');
  if (!cache.has(key)) cache.set(key, readFileSync(key));
  res.setHeader('Content-Type', TYPES[extname(real)] || 'application/octet-stream');
  // Dateien mit Hash im Namen (assets/) dürfen lange im Browser bleiben, die Startseite nie (sonst alte Version)
  res.setHeader('Cache-Control', real.includes(`${join(PUB, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (gz) { res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding'); }
  res.end(cache.get(key));
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/scores')) return scores.handle(req, res).catch(() => { res.statusCode = 500; res.end(); });
  if (req.url === '/healthz') return res.end('ok');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
  try { serveFile(req, res); } catch { res.statusCode = 404; res.end(); }
});

// ───────── WebSocket (RFC 6455, nur das Nötige: Text, Ping/Pong, Close) ─────────
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const acc = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  socket.setNoDelay(true);
  const ev = new EventEmitter();
  let buf = Buffer.alloc(0), parts = [], alive = true;
  const frame = (op, payload = Buffer.alloc(0)) => {
    const n = payload.length; let h;
    if (n < 126) h = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    if (!socket.destroyed) socket.write(Buffer.concat([h, payload]));
  };
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > 4194304n) return socket.destroy(); len = Number(big); off = 10; }
      if (len > 4194304) return socket.destroy();   // mehr als 4 MB von einem Spieler → weg
      const mOff = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      let data = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < data.length; i++) data[i] ^= buf[mOff + (i & 3)];
      buf = buf.subarray(off + len);
      if (op === 8) { frame(8); socket.end(); return; }
      if (op === 9) { frame(10, data); continue; }
      if (op === 10) { alive = true; continue; }
      parts.push(data);
      if (fin) { const msg = Buffer.concat(parts).toString('utf8'); parts = []; ev.emit('message', msg); }
    }
  });
  // alle 25 s anpingen (Hoster schliessen stille Verbindungen) – keine Antwort → Verbindung tot
  const beat = setInterval(() => { if (!alive) return socket.destroy(); alive = false; frame(9); }, 25000);
  socket.on('close', () => { clearInterval(beat); ev.emit('close'); });
  socket.on('error', () => socket.destroy());
  return { send: s => frame(1, Buffer.from(s)), on: (e, f) => ev.on(e, f) };
}

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const conn = accept(req, socket); if (!conn) return;
  // so sieht ein Spieler für lobby.mjs aus (wie bei Vite): send(event, daten) + socket.on('close')
  const client = { send: (e, d) => conn.send(JSON.stringify({ e, d })), socket: { on: (e, f) => conn.on(e, f) } };
  let n = 0, t0 = Date.now();
  conn.on('message', raw => {
    if (Date.now() - t0 > 1000) { n = 0; t0 = Date.now(); }
    if (++n > 60) return;   // mehr als 60 Nachrichten pro Sekunde: ignorieren
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.e !== 'string' || !lobby.events.includes(m.e) || !m.d || typeof m.d !== 'object') return;
    try { lobby.handle(m.e, m.d, client); } catch (e) { console.error('[lobby]', m.e, e.message); }   // kaputte Nachricht darf den Server nicht umwerfen
  });
});

// ───────── «--tunnel»: Website vom eigenen PC ins Internet (cloudflared.exe, ohne Konto; Link ändert sich bei jedem Start) ─────────
const children = [];
function startTunnel() {
  const exe = [join(HERE, 'cloudflared.exe'), join(HERE, '..', '..', 'kirchenfeld-parkour', 'cloudflared.exe')].find(existsSync);
  if (!exe) return console.log('  (Kein cloudflared.exe gefunden – nur auf diesem PC / im WLAN erreichbar.)');
  console.log('  Tunnel startet … der Link erscheint gleich hier.');
  const cf = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true });
  children.push(cf);
  let url = '';
  const scan = chunk => {
    const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m || url) return;
    url = m[0];
    try { spawn('clip', [], { windowsHide: true, shell: true }).stdin.end(url); } catch { /* egal */ }
    // Spiel gleich über den Internet-Link öffnen → «LINK KOPIEREN» in der Lobby gibt dann auch diesen Link
    setTimeout(() => { try { spawn('cmd', ['/c', 'start', '', url], { windowsHide: true }); } catch { /* egal */ } }, 3000);
    console.log(`\n  ============================================================\n   LINK ZUM SPIEL (schon kopiert – im Chat Strg+V):\n\n     ${url}\n  ============================================================\n`);
  };
  cf.stdout.on('data', scan); cf.stderr.on('data', scan);
  cf.on('exit', code => { if (!url) console.log(`  Tunnel ging nicht (Code ${code}). Internet prüfen.`); });
  // Wächter: Fenster mit X zu → Server weg → Tunnel auch beenden (und solange PC wach halten)
  if (process.platform === 'win32') {
    const ps = 'Add-Type -Name P -Namespace W -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);\'; '
      + `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 5 }; Stop-Process -Id ${cf.pid} -Force -ErrorAction SilentlyContinue`;
    children.push(spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true }));
  }
}
const stopAll = () => { for (const c of children) try { c.kill(); } catch { /* egal */ } process.exit(0); };
process.on('SIGINT', stopAll); process.on('SIGTERM', stopAll);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  KIRCHENFELDL online: http://localhost:${PORT}`);
  if (process.argv.includes('--tunnel')) { console.log('  Fenster offen lassen – schliessen = Website aus.'); startTunnel(); }
});
