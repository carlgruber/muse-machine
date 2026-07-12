// Shared logic for both muse-machine MCP entrypoints (stdio and HTTP):
// the WebSocket bridge to the browser, and the tool definitions.

import { z } from 'zod';
import { WebSocketServer } from 'ws';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- Songbook: saved performances, replayable from Claude or the page ----
const SONGS_DIR = path.join(MCP_DIR, '..', 'songs');

async function songList() {
  await mkdir(SONGS_DIR, { recursive: true });
  const out = [];
  for (const f of (await readdir(SONGS_DIR)).filter(f => f.endsWith('.json'))) {
    try {
      const s = JSON.parse(await readFile(path.join(SONGS_DIR, f), 'utf8'));
      out.push({ name: s.name, title: s.title || s.name, parts: (s.parts || []).length, tempo: s.tempo });
    } catch (e) { /* skip corrupt file */ }
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

async function songLoad(name) {
  const f = path.join(SONGS_DIR, String(name).replace(/[^\w-]/g, '') + '.json');
  return JSON.parse(await readFile(f, 'utf8'));
}

async function songSave(song) {
  await mkdir(SONGS_DIR, { recursive: true });
  await writeFile(path.join(SONGS_DIR, song.name + '.json'), JSON.stringify(song, null, 2));
}

// Deleting moves the file into songs/.trash/ (timestamped) — recoverable by hand.
async function songDelete(name) {
  const clean = String(name).replace(/[^\w-]/g, '');
  const from = path.join(SONGS_DIR, clean + '.json');
  const song = JSON.parse(await readFile(from, 'utf8'));   // throws if it doesn't exist
  const trash = path.join(SONGS_DIR, '.trash');
  await mkdir(trash, { recursive: true });
  await rename(from, path.join(trash, `${clean}-${Date.now()}.json`));
  return song;
}

function arrangementBeats(p) {
  let end = 0;
  for (const tr of p.tracks || [])
    end = Math.max(end, (tr.startBeat || 0) + (tr.notes || []).reduce((t, n) => t + (n.beats || 1), 0));
  if (p.drums && p.drums.bars) end = Math.max(end, (p.drums.startBeat || 0) + p.drums.bars * 4);
  for (const v of p.vocals || [])
    end = Math.max(end, (v.startBeat || 0) + (v.notes || []).reduce((t, n) => t + (n.beats || 1), 0));
  return end || 16;
}

// dot-path helpers for edit_song: "parts.0.tracks.2.gain" → surgical edits
export function applySongOps(song, ops) {
  for (const [i, o] of ops.entries()) {
    const segs = String(o.path).split('.').filter(s => s.length);
    if (!segs.length) throw new Error(`op ${i}: empty path`);
    if (segs[0] === 'name') throw new Error(`op ${i}: "name" is the song's id and cannot change`);
    let parent = song;
    for (const s of segs.slice(0, -1)) {
      parent = parent[/^\d+$/.test(s) ? +s : s];
      if (parent == null || typeof parent !== 'object')
        throw new Error(`op ${i}: path "${o.path}" broken at "${s}" — use get_song to check the structure`);
    }
    const leaf = segs[segs.length - 1];
    const key = /^\d+$/.test(leaf) && Array.isArray(parent) ? +leaf : leaf;
    if (o.op === 'set') {
      parent[key] = o.value;
    } else if (o.op === 'delete') {
      if (Array.isArray(parent)) {
        if (typeof key !== 'number' || key >= parent.length) throw new Error(`op ${i}: no index ${leaf} to delete`);
        parent.splice(key, 1);
      } else delete parent[key];
    } else if (o.op === 'append') {
      const arr = parent[key];
      if (!Array.isArray(arr)) throw new Error(`op ${i}: "${o.path}" is not an array`);
      arr.push(o.value);
    } else if (o.op === 'insert') {
      const arr = parent[key];
      if (!Array.isArray(arr)) throw new Error(`op ${i}: "${o.path}" is not an array`);
      arr.splice(Math.max(0, Math.min(arr.length, o.index ?? arr.length)), 0, o.value);
    }
  }
  return song;
}

export function songSummary(song) {
  return {
    name: song.name, title: song.title, tempo: song.tempo,
    parts: (song.parts || []).map((p, i) => ({
      index: i, kind: p.kind, title: p.title, tempo: p.tempo, swing: p.swing,
      pump: p.pump, humanize: p.humanize, sheet: p.sheet,
      abc: p.abc ? p.abc.slice(0, 40) + '…' : undefined,
      drums: p.drums ? { pattern: p.drums.pattern, lanes: p.drums.steps ? Object.keys(p.drums.steps) : undefined,
                         steps: p.drums.steps ? Object.values(p.drums.steps)[0].length : undefined,
                         bars: p.drums.bars, startBeat: p.drums.startBeat, gain: p.drums.gain } : undefined,
      tracks: (p.tracks || []).map((t, ti) => ({
        index: ti, name: t.name, voice: t.voice, gain: t.gain, pan: t.pan,
        startBeat: t.startBeat, notes: (t.notes || []).length,
        beats: +(t.notes || []).reduce((s, n) => s + (n.beats || 1), 0).toFixed(2),
      })),
      vocals: (p.vocals || []).map((v, vi) => ({
        index: vi, source: v.source, style: v.style, startBeat: v.startBeat,
        notes: (v.notes || []).length, lyrics: v.lyrics ? v.lyrics.slice(0, 40) : undefined,
      })),
    })),
  };
}

function estimateSeconds(song) {
  const spb = 60 / (song.tempo || 100);
  let s = 0;
  for (const p of song.parts || []) {
    if (p.kind === 'speak') s += Math.max(2, (p.text || '').split(/\s+/).length / 3);
    else if (p.kind === 'melody') s += 10;
    else if (p.kind === 'arrangement') s += arrangementBeats(p) * (60 / (p.tempo || song.tempo || 100)) + 1;
    else s += ((p.notes || []).reduce((t, n) => t + (n.beats || 1), 0)) * spb + 0.8;
  }
  return Math.round(s);
}

// One show at a time; starting a new one (or stop_music) aborts the current.
let currentShow = null;
export function stopShow() { if (currentShow) currentShow.aborted = true; }

function showWait(seconds, show) {
  return new Promise(res => {
    const end = Date.now() + seconds * 1000;
    const iv = setInterval(() => {
      if (show.aborted || Date.now() >= end) { clearInterval(iv); res(); }
    }, 100);
  });
}

function singWpm(part, tempo) {
  const words = part.lyrics.trim().split(/\s+/).length;
  const totalBeats = part.notes && part.notes.length
    ? part.notes.reduce((s, n) => s + (n.beats || 1), 0) : words;
  return part.rate || Math.max(70, Math.min(220, Math.round(words * tempo / totalBeats)));
}

// Prepare an arrangement's vocal lines for the page. source 'studio' vocals
// (the user's own mic take) pass straight through — no TTS, no MUSE_VOICE
// needed. TTS vocals are synthesized here and skipped (not fatal) if voice is off.
async function synthArrangementVocals(vocals, tempo, show) {
  const out = [];
  for (const v of vocals || []) {
    if (show && show.aborted) break;
    if (v.source === 'studio') {
      out.push({ source: 'studio', notes: v.notes, startBeat: v.startBeat,
                 style: v.style, vibrato: v.vibrato, gain: v.gain, lyrics: v.lyrics });
      continue;
    }
    if (!VOICE_ENABLED || !v.lyrics) continue;
    const wav = await synthSpeech(v.lyrics, v.voice, singWpm(v, tempo));
    out.push({ wav, lyrics: v.lyrics, notes: v.notes, startBeat: v.startBeat,
               style: v.style, vibrato: v.vibrato, gain: v.gain });
  }
  return out;
}

export async function performSong(song, send, push) {
  if (currentShow) currentShow.aborted = true;
  const show = { aborted: false };
  currentShow = show;
  const tempo = song.tempo || 100;
  const drumsAt = song.drums ? (song.drums.beforePart ?? 0) : -1;
  const status = text => { try { push({ push: 'perform', text }); } catch (e) {} };
  try {
    for (let i = 0; i < song.parts.length; i++) {
      if (show.aborted) break;
      console.error(`[bridge] performSong "${song.name}" part ${i + 1}/${song.parts.length}`);
      if (i === drumsAt)
        await send({ cmd: 'drum', pattern: song.drums.pattern, bpm: song.drums.bpm || tempo });
      const part = song.parts[i];
      status(`▶ ${song.title || song.name} — part ${i + 1}/${song.parts.length}`);
      if (!VOICE_ENABLED && part.kind !== 'melody' && part.kind !== 'arrangement') {
        status(`⤼ skipping ${part.kind} part (voice disabled)`);
        continue;
      }
      if (part.kind === 'arrangement') {
        const vocals = await synthArrangementVocals(part.vocals, part.tempo || tempo, show);
        if ((part.vocals || []).some(v => v.source !== 'studio') && !VOICE_ENABLED)
          status('⤼ playing arrangement without tts vocals (voice disabled)');
        if (show.aborted) break;
        const r = await send({ cmd: 'play_arrangement', title: part.title || song.title || song.name,
          tempo: part.tempo || tempo, swing: part.swing, tracks: part.tracks, drums: part.drums,
          vocals, sheet: part.sheet, pump: part.pump, humanize: part.humanize });
        await showWait(r.seconds + (part.gap ?? 0.5), show);
      } else if (part.kind === 'speak') {
        const wav = await synthSpeech(part.text, part.voice, part.rate || 175);
        if (show.aborted) break;
        const r = await send({ cmd: 'sing_speech', wav, lyrics: part.text, mode: 'speak' });
        await showWait(r.seconds + 0.2, show);
      } else if (part.kind === 'melody') {
        const r = await send({ cmd: 'play_abc', abc: part.abc, voice: part.instrument });
        await showWait(r.seconds + 0.2, show);
      } else {
        const wav = await synthSpeech(part.lyrics, part.voice, singWpm(part, tempo));
        if (show.aborted) break;
        const r = await send({ cmd: 'sing_speech', wav, lyrics: part.lyrics, notes: part.notes, tempo, vibrato: part.vibrato, style: part.style, mode: 'sing' });
        await showWait(r.seconds + (part.gap ?? 0.3), show);
      }
    }
  } finally {
    if (drumsAt >= 0) await send({ cmd: 'drum', pattern: 'off' }).catch(() => {});
    status(show.aborted ? '■ stopped' : `✓ ${song.title || song.name}`);
    if (currentShow === show) currentShow = null;
  }
}

// Vocal features (sing/speak tools, sung song parts, TTS daemon) are opt-in:
// set MUSE_VOICE=1 in the server's environment to enable them.
export const VOICE_ENABLED = process.env.MUSE_VOICE === '1';

// ---- neural TTS (Kokoro daemon, mcp/tts_daemon.py) ----
// Much more natural than macOS `say`; the daemon loads the model once and
// serves localhost requests. `say` remains the automatic fallback.
const TTS_URL = 'http://127.0.0.1:8793';

async function ttsHealth(timeoutMs = 400) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${TTS_URL}/health`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

let daemonStarting = null;
async function ensureTtsDaemon() {
  if (await ttsHealth()) return true;
  daemonStarting ??= (async () => {
    const py = path.join(MCP_DIR, 'tts-venv', 'bin', 'python3');
    const script = path.join(MCP_DIR, 'tts_daemon.py');
    try {
      const child = spawn(py, [script], { cwd: MCP_DIR, detached: true, stdio: 'ignore' });
      child.unref();
    } catch { return false; }
    for (let i = 0; i < 40; i++) {          // model load takes ~10s
      await new Promise(res => setTimeout(res, 500));
      if (await ttsHealth()) return true;
    }
    return false;
  })();
  const ok = await daemonStarting;
  if (!ok) daemonStarting = null;            // let a later call retry
  return ok;
}

const VOICE_ALIASES = {
  heart: 'af_heart', bella: 'af_bella', nicole: 'af_nicole', sarah: 'af_sarah',
  sky: 'af_sky', nova: 'af_nova', river: 'af_river', jessica: 'af_jessica',
  kore: 'af_kore', aoede: 'af_aoede', alloy: 'af_alloy',
  adam: 'am_adam', michael: 'am_michael', liam: 'am_liam', eric: 'am_eric',
  echo: 'am_echo', onyx: 'am_onyx', puck: 'am_puck', fenrir: 'am_fenrir', santa: 'am_santa',
  alice: 'bf_alice', emma: 'bf_emma', isabella: 'bf_isabella', lily: 'bf_lily',
  daniel: 'bm_daniel', fable: 'bm_fable', george: 'bm_george', lewis: 'bm_lewis',
  female: 'af_heart', male: 'am_michael',
};

// kokoro id or friendly alias -> neural; anything else -> null (macOS say)
function resolveNeuralVoice(voice) {
  if (!voice) return 'af_heart';
  const lower = String(voice).trim().toLowerCase();
  if (VOICE_ALIASES[lower]) return VOICE_ALIASES[lower];
  if (/^[a-z]{2}_[a-z]+$/.test(lower)) return lower;
  return null;
}

async function synthNeural(text, kvoice, wpm) {
  const speed = Math.max(0.55, Math.min(1.6, (wpm || 175) / 175));
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60000);
  const r = await fetch(`${TTS_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: kvoice, speed }),
    signal: ac.signal,
  });
  clearTimeout(t);
  if (!r.ok) throw new Error('tts daemon error ' + r.status);
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

// Pick the best installed TTS voice for singing: Premium > Enhanced >
// Samantha > system default. Cached for the process lifetime.
let voicePick;
function pickVoice() {
  voicePick ??= execFileP('say', ['-v', '?']).then(({ stdout }) => {
    const lines = stdout.split('\n');
    const grab = re => {
      const hit = lines.find(l => re.test(l) && /\ben[_-]/.test(l));
      return hit ? hit.slice(0, hit.search(/\s{2}/)).trim() : null;
    };
    return grab(/\(Premium\)/) || grab(/\(Enhanced\)/) || grab(/^Samantha\s/) || null;
  }).catch(() => null);
  return voicePick;
}

// Speech synthesis. Neural (Kokoro daemon) when the requested voice is a
// neural one — or unspecified — falling back to macOS `say` otherwise or on
// any daemon failure. Returns base64 WAV (16-bit mono).
async function synthSpeech(text, voice, wpm) {
  const kvoice = resolveNeuralVoice(voice);
  if (kvoice !== null && await ensureTtsDaemon()) {
    try { return await synthNeural(text, kvoice, wpm); }
    catch (e) { /* fall through to say */ }
  }
  if (process.platform !== 'darwin')
    throw new Error("speech synthesis needs the neural TTS daemon (mcp/tts_daemon.py) or macOS `say`");
  const out = path.join(tmpdir(), `muse-say-${process.pid}-${Date.now()}.wav`);
  const chosen = (kvoice === null ? voice : null) || await pickVoice();
  for (const [v, rate] of [[chosen, 44100], [chosen, 22050], [null, 22050]]) {
    const args = ['-o', out, `--data-format=LEI16@${rate}`, '-r', String(wpm)];
    try {
      await execFileP('say', v ? [...args, '-v', v, text] : [...args, text]);
      const wav = await readFile(out);
      unlink(out).catch(() => {});
      return wav.toString('base64');
    } catch (e) {
      if (v === null) throw new Error('speech synthesis failed: ' + e.message);
    }
  }
}

export const WS_PORT = 8779;
export const APP_URL = 'http://localhost:8778';

export const VOICES = 'piano, epiano, organ, harpsi, clav, musicbox, vibes, kalimba, celeste, steel, marimba, glocken, tubular, aguitar, nylon, eguitar, overdrive, wah, harp, flute, brass, theremin, clarinet, oboe, trumpet, strings, pad, cello, choir, lead, synthwave, bass, sub808, chip, wobble';

export function createBridge() {
  const tabs = new Map();     // ws -> { fresh, version, alive }
  let browser = null;         // preferred output tab (may fail over per send)
  let wss = null;
  let wsError = null;
  let nextId = 1;
  const pending = new Map();

  const AUDIBLE = new Set(['play_abc', 'play_notes', 'sing_speech', 'drum', 'sing', 'play_arrangement']);

  // Default handling for the page's Songbook buttons — wired at bridge
  // creation so it works before any MCP client has opened a session.
  let pageReqHandler = async m => {
    try {
      if (m.pageReq === 'play_song') await performSong(await songLoad(m.name), send, push);
      else if (m.pageReq === 'stop_song') { stopShow(); await send({ cmd: 'stop' }).catch(() => {}); }
      else if (m.pageReq === 'delete_song') {
        const song = await songDelete(m.name);
        push({ push: 'songs', songs: await songList() });
        push({ push: 'perform', text: `🗑 deleted “${song.title || song.name}” (recoverable in songs/.trash/)` });
      }
    } catch (e) {
      push({ push: 'perform', text: '⚠️ ' + e.message });
    }
  };

  // push a fire-and-forget message to the active page — no reply expected
  function push(obj) {
    if (browser && browser.readyState === 1) {
      try { browser.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  // tell every tab whether it currently owns the sound
  function pushActive() {
    for (const [ws] of tabs) {
      if (ws.readyState !== 1) continue;
      try { ws.send(JSON.stringify({ push: 'active', active: ws === browser })); } catch (e) {}
    }
  }

  function claim(ws, fresh) {
    const changed = browser !== ws;
    browser = ws;
    const meta = tabs.get(ws);
    if (meta && fresh) meta.fresh = true;
    if (changed) pushActive();
  }

  // candidates for a command: the active tab first, then fresh tabs, then rest
  function candidates() {
    const live = [...tabs.keys()].filter(ws => ws.readyState === 1);
    return live.sort((a, b) => {
      if (a === browser) return -1;
      if (b === browser) return 1;
      return (tabs.get(b)?.fresh ? 1 : 0) - (tabs.get(a)?.fresh ? 1 : 0);
    });
  }

  // Bind (or re-bind) the WebSocket hub. Another muse-machine entrypoint may
  // hold the port right now (e.g. the Claude Desktop bridge), so a failed
  // bind is never cached: every send() retries while the port is busy, and
  // whichever process outlives the other picks the browser back up.
  function ensureServer() {
    if (wss) return;
    try {
      const server = new WebSocketServer({ port: WS_PORT });
      wss = server;
      wsError = null;
      // heartbeat: prune tabs that stop answering pings (sleep, crash, kill)
      // so a zombie socket never swallows commands
      const beat = setInterval(() => {
        for (const [ws, meta] of tabs) {
          if (ws.readyState !== 1) { tabs.delete(ws); continue; }
          if (!meta.alive) { try { ws.terminate(); } catch (e) {} tabs.delete(ws); continue; }
          meta.alive = false;
          try { ws.ping(); } catch (e) {}
        }
        if (browser && !tabs.has(browser)) { browser = candidates()[0] || null; pushActive(); }
      }, 15000);
      server.on('close', () => clearInterval(beat));
      server.on('error', err => {
        wsError = err.message;
        try { server.close(); } catch (e) {}
        if (wss === server) wss = null;   // retry on the next send()
      });
      server.on('connection', ws => {
        tabs.set(ws, { fresh: false, version: null, alive: true });
        ws.on('pong', () => { const m = tabs.get(ws); if (m) m.alive = true; });
        // tabs running stale page code never say hello, so they only get the
        // slot when nothing better holds it
        if (!browser || browser.readyState !== 1) claim(ws, false);
        // greet the page with the current Songbook + its ownership state
        songList().then(songs => { try { ws.send(JSON.stringify({ push: 'songs', songs })); } catch (e) {} }).catch(() => {});
        try { ws.send(JSON.stringify({ push: 'active', active: ws === browser })); } catch (e) {}
        ws.on('message', data => {
          try {
            const m = JSON.parse(data);
            if (m.pageReq) {
              const meta = tabs.get(ws);
              if (meta) { meta.alive = true; if (m.v) meta.version = m.v; }
              if (m.pageReq === 'hello') {
                if (meta) meta.fresh = true;
                // fresh tabs take the slot — but never mid-performance, so a
                // reconnecting tab can't hijack a show already playing elsewhere
                if (!browser || browser.readyState !== 1 || !tabs.get(browser)?.fresh || !currentShow) claim(ws, true);
                else pushActive();
                return;
              }
              console.error(`[bridge] pageReq: ${m.pageReq}${m.name ? ' ' + m.name : ''}`);
              claim(ws, true);              // explicit interaction always claims
              pageReqHandler && pageReqHandler(m);
              return;
            }
            const p = pending.get(m.id);
            if (p) {
              pending.delete(m.id);
              m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
            }
          } catch (e) { /* ignore malformed */ }
        });
        ws.on('close', () => {
          tabs.delete(ws);
          if (browser === ws) { browser = candidates()[0] || null; pushActive(); }
        });
      });
    } catch (err) {
      wsError = err.message;
      wss = null;
    }
  }
  ensureServer();

  function deliverTo(ws, cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try { ws.send(JSON.stringify({ id, ...cmd })); }
      catch (e) { pending.delete(id); return reject(new Error('tab went away')); }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('the browser did not respond in time'));
        }
      }, timeoutMs);
    });
  }

  // Send with failover: try the active tab, then every other connected tab,
  // instead of failing because one tab is stale, asleep, or audio-locked.
  async function send(cmd) {
    ensureServer();
    if (!wss)
      throw new Error(`bridge port ${WS_PORT} is held by another muse-machine session (${wsError}) — close it, or route this command through it instead.`);
    if (!candidates().length)   // the hub may have just (re)bound — give the page's 5s reconnect one beat
      await new Promise(res => setTimeout(res, 5500));
    const list = candidates();
    if (!list.length)
      throw new Error(`Muse Machine isn't open in a browser. Ask the user to open ${APP_URL} (serve it with: python3 -m http.server 8778 --directory ~/muse-machine) and keep the tab open.`);
    let firstErr = null;
    for (const ws of list) {
      try {
        // arrangements decode + melodize vocals in the page before replying
        const result = await deliverTo(ws, cmd, cmd.cmd === 'play_arrangement' ? 20000 : 6000);
        claim(ws, false);       // sound goes where success is — stay there
        return result;
      } catch (e) {
        firstErr = firstErr || e;
        console.error(`[bridge] ${cmd.cmd} failed on a tab (${e.message}) — ${list.indexOf(ws) < list.length - 1 ? 'failing over' : 'no tabs left'}`);
        // if that tab might wake up late and start playing, cut it off so
        // the failover tab doesn't double-play
        if (AUDIBLE.has(cmd.cmd) && e.message.includes('respond in time')) {
          deliverTo(ws, { cmd: 'stop' }, 2000).catch(() => {});
        }
      }
    }
    throw firstErr;
  }

  function info() {
    const live = candidates();
    return {
      tabs: live.length,
      activeTab: browser && browser.readyState === 1
        ? (tabs.get(browser)?.fresh ? 'fresh' : 'stale (needs a page refresh)') : 'none',
      pageVersion: browser ? tabs.get(browser)?.version || 'pre-versioning' : null,
      staleTabs: live.filter(ws => !tabs.get(ws)?.fresh).length,
    };
  }

  return { send, push, info, setPageReqHandler: fn => { pageReqHandler = fn; } };
}

const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const fail = err => ({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });

export function registerTools(server, bridge) {
  // accept either the bridge object or a bare send() for older callers
  const send = typeof bridge === 'function' ? bridge : bridge.send;
  const push = typeof bridge === 'function' ? () => {} : bridge.push;

  server.tool(
    'play_melody',
    `Play a melody on the Muse Machine instrument (audible on the user's speakers, with live sheet music). Takes ABC-style notation. Notes: C D E F G A B (middle octave), lowercase = octave up, C, = octave down, c' = higher still, ^C sharp, _B flat, z rest, | barlines. Durations: C2 = 2 beats, C/2 = half, C3/2 = dotted. Headers on their own lines: T:Title Q:tempo M:4/4 K:G L:1/8. Example: "T:Riff\\nQ:140\\nK:Am\\nA/2 c/2 e/2 a/2 | e2 z c | A4". Returns the play duration in seconds — wait that long before playing the next thing.`,
    {
      abc: z.string().describe('ABC-style notation, may include T:/Q:/M:/K:/L: header lines'),
      voice: z.string().optional().describe(`instrument voice: ${VOICES}`),
    },
    async ({ abc, voice }) => {
      try { return ok(await send({ cmd: 'play_abc', abc, voice })); } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'play_notes',
    'Play a quick sequence of notes without notation (no sheet rendering). Good for jingles, chords-as-arpeggios, sound effects.',
    {
      notes: z.array(z.object({
        pitch: z.union([z.string(), z.number()]).optional().describe('note name like "C4", "F#3", "Bb5" or MIDI number; pitches outside A0–C8 are folded by octaves into range rather than dropped'),
        beats: z.number().optional().describe('duration in beats, default 1'),
        rest: z.boolean().optional().describe('true for a rest (silence)'),
      })).describe('sequence played in order'),
      tempo: z.number().optional().describe('BPM, default 120'),
      voice: z.string().optional().describe(`instrument voice: ${VOICES}`),
    },
    async ({ notes, tempo, voice }) => {
      try { return ok(await send({ cmd: 'play_notes', notes, tempo, voice })); } catch (e) { return fail(e); }
    }
  );

  const ARR_PITCH = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])).max(6)])
    .describe('note name like "C4"/"F#3"/"Bb2", MIDI number, or an ARRAY of pitches = a chord');
  const ARR_NOTE = z.object({
    pitch: ARR_PITCH.optional(),
    beats: z.number().optional().describe('duration in beats; fractions fine (0.5, 0.25); default 1'),
    rest: z.boolean().optional().describe('true = silence for beats'),
    vel: z.number().optional().describe('velocity/accent 0.05-1.27, default 1'),
  });
  const ARR_TRACK = z.object({
    name: z.string().optional().describe('display name shown in the on-page band HUD'),
    voice: z.string().optional().describe(`instrument: ${VOICES}`),
    notes: z.array(ARR_NOTE).min(1).describe('played in sequence; rests advance time'),
    gain: z.number().optional().describe('track volume 0-1.5, default 0.9'),
    pan: z.number().optional().describe('stereo position, -1 (left) to 1 (right)'),
    startBeat: z.number().optional().describe('bring this track in after this many beats (builds/drops)'),
  });
  const ARR_DRUMS = z.object({
    pattern: z.enum(['rock', 'boombap', 'house', 'funk', 'disco', 'trap', 'bossa', 'shuffle']).optional()
      .describe('preset groove — or program your own with steps instead'),
    steps: z.object({
      kick: z.string().optional(), snare: z.string().optional(), hat: z.string().optional(),
      clap: z.string().optional(), ride: z.string().optional(),
      conga: z.string().optional().describe('hand drum; X = higher slap tone'),
      shaker: z.string().optional(), tamb: z.string().optional(),
    }).optional().describe('custom groove: per-lane step string, one char per 16th: x=hit, X=accent, .=rest — e.g. kick "x...x...x..xx..."; lanes loop. Lanes: kick snare hat clap ride conga shaker tamb'),
    swing: z.number().optional().describe('0.5 = straight (default), up to 0.7 = hard shuffle'),
    gain: z.number().optional().describe('kit volume 0-1.5, default 1'),
    bars: z.number().optional().describe('loop for exactly this many 4/4 bars (default: until the longest track ends)'),
    startBeat: z.number().optional().describe('bring the drums in after this many beats'),
  });
  const ARR_VOCAL = z.object({
    source: z.enum(['tts', 'studio']).optional()
      .describe("'studio' = THE USER'S OWN MIC RECORDING becomes the vocal — their latest Studio take is pitch-forced onto the notes (no TTS involved, works regardless of MUSE_VOICE; ask the user to record first). Default 'tts'."),
    lyrics: z.string().max(800).optional().describe('tts: ORIGINAL words to sing — never existing copyrighted lyrics. Ignored for studio source.'),
    notes: z.array(ARR_NOTE).optional().describe('vocal melody, ~one note per syllable'),
    voice: z.string().optional().describe('tts singing voice: heart (default), bella, nicole, sky, michael, adam, emma, george, fable…'),
    style: z.enum(['lead', 'soft', 'choir', 'bright', 'deep', 'robot']).optional(),
    vibrato: z.number().optional().describe('0 flat … 2 heavy, default 1'),
    rate: z.number().optional().describe('speech rate override, words/min'),
    startBeat: z.number().optional().describe('the beat this vocal line enters on'),
    gain: z.number().optional().describe('vocal volume 0-1.5, default 1'),
  });

  server.tool(
    'play_arrangement',
    `Perform as a FULL BAND: every layer plays SIMULTANEOUSLY on one sample-accurate clock — melodic/chordal tracks (each with its own instrument, volume, and stereo position), a step-programmable drum kit, and${VOICE_ENABLED ? '' : ' (currently disabled — set MUSE_VOICE=1)'} sung vocal lines mixed into the band at exact beats. This is the flagship: compose real productions (drums + bass + chords + lead + vocals), not one line at a time. Chords = pitch arrays; use startBeat on tracks/drums/vocals to write intros, builds, and drops; use pan to spread the stage (bass center, keys left, lead right). A live "Now Performing" HUD appears on the page. Returns the duration in seconds — wait that long before the next command. One arrangement at a time; stop_music cuts it.`,
    {
      title: z.string().optional().describe('shown on the band HUD'),
      tempo: z.number().optional().describe('BPM 40-240, default 100'),
      swing: z.number().optional().describe('global swing for drum off-16ths, 0.5-0.7'),
      tracks: z.array(ARR_TRACK).max(12).optional(),
      drums: ARR_DRUMS.optional(),
      vocals: z.array(ARR_VOCAL).max(6).optional().describe('sung lines layered over the band. source:"studio" uses the USER\'S OWN recorded voice' + (VOICE_ENABLED ? '; tts vocals also available' : ' (tts vocals disabled until MUSE_VOICE=1)')),
      sheet: z.number().optional().describe('track index to render as live sheet music with a moving playhead (default: auto — the highest-pitched melodic track; -1 disables)'),
      pump: z.number().optional().describe('sidechain pump: duck melodic tracks on each kick, 0 (off) to 0.8; default 0.3 whenever the groove has kicks'),
      humanize: z.number().optional().describe('timing/velocity humanization 0-1 (default 0.35); 0 = machine-tight grid'),
    },
    async ({ title, tempo, swing, tracks, drums, vocals, sheet, pump, humanize }) => {
      try {
        if ((vocals || []).some(v => v.source !== 'studio') && !VOICE_ENABLED)
          throw new Error('tts vocals are disabled (set MUSE_VOICE=1 to enable) — use source:"studio" vocals (the user\'s own recording) or an instrumental lead instead');
        if ((vocals || []).some(v => v.source !== 'studio' && !v.lyrics))
          throw new Error('tts vocals need lyrics');
        const rendered = await synthArrangementVocals(vocals, tempo || 100, null);
        return ok(await send({ cmd: 'play_arrangement', title, tempo, swing, tracks, drums, vocals: rendered, sheet, pump, humanize }));
      } catch (e) { return fail(e); }
    }
  );

  if (VOICE_ENABLED) server.tool(
    'sing',
    `Make the instrument SING lyrics with REAL, intelligible words: the lyrics are rendered by macOS text-to-speech, then pitch-forced onto your melody (songify-style) and played on the user's speakers. Each melody note consumes its beats-worth of voiced speech, so roughly one note per syllable works best; the melody is auto-transposed by octaves into the voice's natural range. Speech rate is auto-matched to the melody length (override with rate). Always write ORIGINAL lyrics — never reproduce existing copyrighted song lyrics. Returns duration in seconds; wait that long before the next command.`,
    {
      lyrics: z.string().max(800).describe('original words to sing; punctuation creates natural pauses'),
      notes: z.array(z.object({
        pitch: z.union([z.string(), z.number()]).optional().describe('note name like "C4", "F#3" or MIDI number'),
        beats: z.number().optional().describe('duration in beats, default 1'),
        rest: z.boolean().optional().describe('true for a breath rest'),
      })).optional().describe('melody; extra notes become melisma runs on the nearest vowel'),
      tempo: z.number().optional().describe('BPM, default 90'),
      voice: z.string().optional().describe('singing voice. Neural (best): heart (default, warm female), bella, nicole (soft), sky, sarah, michael (male), adam (deep male), puck, santa (jolly), emma/alice (British female), george/daniel/fable (British male). Any macOS say voice (Samantha, Fred…) works as a fallback.'),
      style: z.enum(['lead', 'soft', 'choir', 'bright', 'deep', 'robot']).optional()
        .describe('vocal character: lead (default, doubled pop vocal), soft (breathy), choir (wide 5-voice stack), bright, deep, robot'),
      rate: z.number().optional().describe('speech rate in words/min; default auto-matched to the melody'),
      vibrato: z.number().optional().describe('0 = flat robotic, 1 = normal (default), 2 = heavy'),
    },
    async ({ lyrics, notes, tempo = 90, voice, style, rate, vibrato }) => {
      try {
        const words = lyrics.trim().split(/\s+/).length;
        const totalBeats = notes && notes.length
          ? notes.reduce((s, n) => s + (n.beats || 1), 0)
          : words;
        const wpm = rate || Math.max(70, Math.min(220, Math.round(words * tempo / totalBeats)));
        const wav = await synthSpeech(lyrics, voice, wpm);
        return ok(await send({ cmd: 'sing_speech', wav, lyrics, notes, tempo, vibrato, style, mode: 'sing' }));
      } catch (e) { return fail(e); }
    }
  );

  if (VOICE_ENABLED) server.tool(
    'speak',
    "Make the instrument SPEAK text out loud (real text-to-speech through the user's speakers, no melody). Good for announcements between songs.",
    {
      text: z.string().max(800).describe('what to say'),
      voice: z.string().optional().describe('neural: heart (default), bella, nicole, sky, michael, adam, santa, emma, george, fable…; or a macOS say voice name'),
      rate: z.number().optional().describe('speech rate in words/min, default 175'),
    },
    async ({ text, voice, rate }) => {
      try {
        const wav = await synthSpeech(text, voice, rate || 175);
        return ok(await send({ cmd: 'sing_speech', wav, lyrics: text, mode: 'speak' }));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'get_sheet',
    "READ what's currently on the Muse Machine sheet: title, key, meter, tempo, the ABC text, the parsed note list (pitch/beats/rests), and whether a mic recording exists in the Studio. Use this to see the user's melody — e.g. after they hum a tune and transcribe it — so you can arrange around it.",
    {},
    async () => {
      try { return ok(await send({ cmd: 'get_sheet' })); } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'transcribe_recording',
    "Transcribe the user's latest Studio mic recording (their hummed or sung take) into notation: pitch-tracks it, quantizes it, loads it onto the sheet, and returns the ABC + parsed notes. THE hum-to-song flow: user records a hum → call this → arrange a full production around their melody with play_arrangement (keep their tune recognizable, usually as the lead track).",
    {},
    async () => {
      try { return ok(await send({ cmd: 'transcribe' })); } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'start_waterfall',
    "Start (or stop) Waterfall play-along mode: the current sheet's notes fall Synthesia-style onto the on-screen piano so the user can play along, with hit/miss/streak scoring. wait=true holds each note at the hit line until the user plays it (learning mode). Great after arranging their hummed melody: 'now learn to play it'. The tune on the sheet is what falls — load one first (play_melody, transcribe_recording, or a played arrangement's lead).",
    {
      on: z.boolean().optional().describe('false = stop the waterfall (default true = start)'),
      wait: z.boolean().optional().describe('true = pause at each note until the user plays it; false (default) = continuous scroll with timing scores'),
      guide: z.boolean().optional().describe('play each note softly as it crosses the line (default true; ignored in wait mode)'),
    },
    async ({ on, wait, guide }) => {
      try { return ok(await send({ cmd: 'waterfall', on, wait, guide })); } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'set_voice',
    `Switch the instrument voice. Options: ${VOICES}.`,
    { voice: z.string() },
    async ({ voice }) => {
      try { return ok(await send({ cmd: 'set_voice', voice })); } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'drum_groove',
    'Start or stop the drum machine. It keeps looping until turned off, so you can play melodies over it.',
    {
      pattern: z.enum(['rock', 'boombap', 'house', 'funk', 'disco', 'trap', 'bossa', 'shuffle', 'off']),
      bpm: z.number().optional().describe('tempo 40-220 (also affects melody playback tempo)'),
    },
    async ({ pattern, bpm }) => {
      try { return ok(await send({ cmd: 'drum', pattern, bpm })); } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'stop_music',
    'Stop everything: melody playback, singing, held notes, the drum machine, and any running Songbook performance.',
    {},
    async () => {
      try { stopShow(); return ok(await send({ cmd: 'stop' })); } catch (e) { return fail(e); }
    }
  );

  const NOTE = z.object({
    pitch: z.union([z.string(), z.number()]).optional().describe('note name like "C4" or MIDI number'),
    beats: z.number().optional().describe('duration in beats, default 1'),
    rest: z.boolean().optional().describe('true for a rest'),
  });

  server.tool(
    'save_song',
    'Save a performance to the Songbook (persisted on disk, listed in the page UI, replayable anytime via play_song or the page\'s ▶ Perform button). Parts run in order.',
    {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/).describe('kebab-case id, e.g. "little-voice"'),
      title: z.string().optional().describe('display title'),
      tempo: z.number().optional().describe('BPM for sung parts, default 100'),
      drums: z.object({
        pattern: z.enum(['rock', 'boombap', 'house', 'funk', 'disco', 'trap', 'bossa', 'shuffle']),
        bpm: z.number().optional(),
        beforePart: z.number().optional().describe('start the groove before this part index (default 0); it stops when the song ends'),
      }).optional(),
      parts: z.array(z.object({
        kind: z.enum(['sing', 'speak', 'melody', 'arrangement']),
        lyrics: z.string().max(800).optional().describe('sing: original words'),
        notes: z.array(NOTE).optional().describe('sing: melody'),
        voice: z.string().optional().describe('sing/speak: neural voice (heart, bella, michael, fable…)'),
        style: z.enum(['lead', 'soft', 'choir', 'bright', 'deep', 'robot']).optional(),
        vibrato: z.number().optional(),
        text: z.string().max(800).optional().describe('speak: what to say'),
        abc: z.string().optional().describe('melody: ABC notation'),
        instrument: z.string().optional().describe(`melody: instrument voice (${VOICES})`),
        gap: z.number().optional().describe('extra seconds of silence after this part'),
        rate: z.number().optional().describe('speech rate override in words/min'),
        title: z.string().optional().describe('arrangement: HUD title for this section'),
        sheet: z.number().optional().describe('arrangement: track index to show as live sheet music (-1 disables, default auto)'),
        tempo: z.number().optional().describe('arrangement: BPM override for this section'),
        swing: z.number().optional().describe('arrangement: drum swing 0.5-0.7'),
        tracks: z.array(ARR_TRACK).max(12).optional().describe('arrangement: simultaneous melodic tracks'),
        drums: ARR_DRUMS.optional().describe('arrangement: drum groove'),
        vocals: z.array(ARR_VOCAL).max(6).optional().describe('arrangement: sung lines over the band (source:"studio" = the user\'s own recording; tts vocals skipped when voice is off)'),
        pump: z.number().optional().describe('arrangement: sidechain pump depth 0-0.8'),
        humanize: z.number().optional().describe('arrangement: humanization 0-1'),
      })).min(1),
    },
    async (song) => {
      try {
        for (const p of song.parts) {
          if (!VOICE_ENABLED && p.kind !== 'melody' && p.kind !== 'arrangement') throw new Error(`${p.kind} parts are disabled (voice is off; set MUSE_VOICE=1 to enable)`);
          if (p.kind === 'sing' && !p.lyrics) throw new Error('sing part needs lyrics');
          if (p.kind === 'speak' && !p.text) throw new Error('speak part needs text');
          if (p.kind === 'melody' && !p.abc) throw new Error('melody part needs abc');
          if (p.kind === 'arrangement' && !(p.tracks || []).length && !p.drums) throw new Error('arrangement part needs tracks and/or drums');
        }
        await songSave(song);
        push({ push: 'songs', songs: await songList() });
        return ok({ saved: song.name, parts: song.parts.length, estSeconds: estimateSeconds(song) });
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'get_song',
    "Read a saved Songbook song. Default returns a compact SUMMARY (parts, tracks with name/voice/gain/pan/startBeat/note counts, drums shape, vocals) — the map you need before editing. Pass part (and optionally track) to fetch actual note data for one slice, or full=true for the entire JSON (can be large). The composing loop: get_song → edit_song → play_song.",
    {
      name: z.string().describe('kebab-case id from list_songs'),
      part: z.number().optional().describe('return full data for just this part index'),
      track: z.number().optional().describe('with part: just this track index (its notes included)'),
      full: z.boolean().optional().describe('return the complete song JSON'),
    },
    async ({ name, part, track, full }) => {
      try {
        const song = await songLoad(name);
        if (full) return ok(song);
        if (part != null) {
          const p = song.parts[part];
          if (!p) throw new Error(`no part ${part} (song has ${song.parts.length})`);
          if (track != null) {
            const t = (p.tracks || [])[track];
            if (!t) throw new Error(`no track ${track} in part ${part}`);
            return ok(t);
          }
          return ok(p);
        }
        return ok(songSummary(song));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'edit_song',
    'Surgically edit a saved song WITHOUT resending it — apply dot-path operations, save, refresh the page Songbook. Paths index into the song JSON: "tempo", "title", "parts.0.tempo", "parts.0.tracks.2.gain", "parts.0.tracks.1.voice", "parts.0.drums.steps.kick", "parts.0.tracks.1.notes" (set a whole notes array), "parts.0.tracks.1.notes.4.pitch" (one note). Ops: set (assign value), delete (remove key / splice array index), append (push to array), insert (splice value at index). Ops apply in order — for multiple deletes from one array, delete highest indices first. Use get_song for the structure; play_song to hear the result. "name" is immutable.',
    {
      name: z.string().describe('kebab-case id from list_songs'),
      ops: z.array(z.object({
        op: z.enum(['set', 'delete', 'append', 'insert']),
        path: z.string(),
        value: z.any().optional(),
        index: z.number().optional().describe('insert position (insert op only)'),
      })).min(1).max(50),
    },
    async ({ name, ops }) => {
      try {
        const song = applySongOps(await songLoad(name), ops);
        if (!Array.isArray(song.parts) || !song.parts.length) throw new Error('edit left the song with no parts — rejected');
        for (const p of song.parts) {
          if (p.kind === 'arrangement' && !(p.tracks || []).length && !p.drums)
            throw new Error('edit left an arrangement part with no tracks or drums — rejected');
        }
        await songSave(song);
        push({ push: 'songs', songs: await songList() });
        return ok({ edited: name, ops: ops.length, estSeconds: estimateSeconds(song) });
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'delete_song',
    'Delete a saved Songbook song. Not destructive-forever: the file moves to songs/.trash/ (timestamped) and can be restored by hand. The page Songbook updates immediately. Confirm with the user before deleting anything they might care about.',
    { name: z.string().describe('kebab-case id from list_songs') },
    async ({ name }) => {
      try {
        const song = await songDelete(name);
        push({ push: 'songs', songs: await songList() });
        return ok({ deleted: name, title: song.title || name, recoverable: 'songs/.trash/' });
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'list_songs',
    'List the saved Songbook performances.',
    {},
    async () => {
      try { return ok({ songs: await songList() }); } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'play_song',
    'Perform a saved Songbook song on the instrument. Returns immediately with an estimated duration while playback runs; stop_music aborts it.',
    { name: z.string().describe('the song\'s kebab-case id from list_songs') },
    async ({ name }) => {
      try {
        const song = await songLoad(name);
        performSong(song, send, push).catch(() => {});
        return ok({ playing: song.title || song.name, parts: song.parts.length, estSeconds: estimateSeconds(song) });
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    'get_status',
    'Check whether the instrument is connected and what it is doing (current voice, tempo, whether audio is unlocked), plus bridge diagnostics: how many tabs are connected, whether the active one is fresh or needs a refresh.',
    {},
    async () => {
      try {
        const s = await send({ cmd: 'status' });
        return ok(typeof bridge === 'function' ? s : { ...s, bridge: bridge.info() });
      } catch (e) { return fail(e); }
    }
  );
}
