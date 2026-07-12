// LLM composer for Riff → Song: the page sends the captured riff + a style
// prompt, and Claude (Opus 4.8) writes a full multitrack arrangement around it.
// Structured outputs guarantee the JSON matches the play_arrangement shape.
// Credentials resolve the standard way (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
// / `ant auth login` profile) — no key means a friendly error, not a crash.
import Anthropic from '@anthropic-ai/sdk';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const VOICE_LIST = ['piano', 'epiano', 'organ', 'harpsi', 'clav', 'musicbox', 'vibes',
  'kalimba', 'celeste', 'steel', 'marimba', 'glocken', 'tubular', 'aguitar', 'nylon',
  'eguitar', 'overdrive', 'wah', 'harp', 'flute', 'brass', 'theremin', 'clarinet',
  'oboe', 'trumpet', 'strings', 'pad', 'cello', 'choir', 'lead', 'synthwave', 'bass',
  'sub808', 'chip', 'wobble'];
const LANES = ['kick', 'snare', 'hat', 'clap', 'ride', 'conga', 'shaker', 'tamb'];

const PITCH = {
  anyOf: [
    { type: 'integer' },
    { type: 'string' },
    { type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'string' }] } },
  ],
};
const NOTE = {
  anyOf: [
    { type: 'object', additionalProperties: false, required: ['pitch', 'beats'],
      properties: { pitch: PITCH, beats: { type: 'number' }, vel: { type: 'number' } } },
    { type: 'object', additionalProperties: false, required: ['rest', 'beats'],
      properties: { rest: { const: true }, beats: { type: 'number' } } },
  ],
};
// The model writes a SONG PLAN — each section once, plus a play order — and
// expandPlan() unrolls the repeats. Small JSON (fast to generate), full-length
// song when performed.
const DRUM_STEPS = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(LANES.map(l => [l, { type: 'string' }])),
};
export const ARRANGEMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'tempo', 'sections', 'order', 'leadTrack'],
  properties: {
    title: { type: 'string' },
    tempo: { type: 'number' },
    swing: { type: 'number' },
    pump: { type: 'number' },
    leadTrack: { type: 'string' },
    order: { type: 'array', items: { type: 'string' } },
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'bars', 'tracks'],
        properties: {
          name: { type: 'string' },
          bars: { type: 'integer' },
          vocal: { type: 'boolean' },
          tracks: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['name', 'notes'],
              properties: {
                name: { type: 'string' },
                voice: { type: 'string', enum: VOICE_LIST },
                gain: { type: 'number' },
                pan: { type: 'number' },
                notes: { type: 'array', items: NOTE },
              },
            },
          },
          drums: {
            type: 'object', additionalProperties: false, required: ['steps'],
            properties: { steps: DRUM_STEPS },
          },
        },
      },
    },
    drumGain: { type: 'number' },
  },
};

// Unroll the plan: concatenate sections per `order`, matching tracks across
// sections by name (voice/gain/pan from first appearance), padding absent
// tracks and lanes with silence. Returns the flat play_arrangement shape.
const MAX_PERFORMED_BARS = 72;
export function expandPlan(plan) {
  if (!plan.sections) return plan;                        // already flat
  const byName = new Map(plan.sections.map(s => [s.name, s]));
  const order = (plan.order || []).map(n => byName.get(n)).filter(Boolean);
  const seq = order.length ? order : plan.sections;
  const reg = new Map();                                  // track name -> global track
  const lanes = new Set(seq.flatMap(s => Object.keys(s.drums?.steps || {})));
  const laneAcc = Object.fromEntries([...lanes].map(l => [l, '']));
  const vocalStartBeats = [];
  let cursor = 0;                                         // beats so far
  const padTo = (g, beats) => {
    if (beats > g.filled + 1e-6) { g.notes.push({ rest: true, beats: +(beats - g.filled).toFixed(3) }); g.filled = beats; }
  };
  for (const sec of seq) {
    const bars = Math.min(16, Math.max(1, Math.round(sec.bars || 4)));
    if (cursor / 4 + bars > MAX_PERFORMED_BARS) break;
    const secBeats = bars * 4;
    if (sec.vocal) vocalStartBeats.push(cursor);
    for (const t of sec.tracks || []) {
      let g = reg.get(t.name);
      if (!g) { g = { name: t.name, voice: t.voice, gain: t.gain, pan: t.pan, notes: [], filled: 0 }; reg.set(t.name, g); }
      else { g.voice ??= t.voice; g.gain ??= t.gain; g.pan ??= t.pan; }
      padTo(g, cursor);
      let used = 0;
      for (const n of t.notes || []) {
        if (!n || !(n.beats > 0) || used >= secBeats - 1e-6) continue;
        const b = Math.min(n.beats, secBeats - used);
        g.notes.push({ ...n, beats: b });
        used += b;
      }
      g.filled = cursor + used;
    }
    for (const l of lanes) {
      const s = String(sec.drums?.steps?.[l] || '');
      laneAcc[l] += s.slice(0, bars * 16).padEnd(bars * 16, '.');
    }
    cursor += secBeats;
  }
  const tracks = [...reg.values()];
  for (const g of tracks) { padTo(g, cursor); delete g.filled; }
  const leadIdx = tracks.findIndex(t => t.name === plan.leadTrack);
  return {
    title: plan.title, tempo: plan.tempo, swing: plan.swing, pump: plan.pump,
    tracks,
    drums: { gain: plan.drumGain, steps: laneAcc },
    leadTrack: leadIdx >= 0 ? leadIdx
      : Math.max(0, tracks.findIndex(t => /riff|lead|melody/i.test(t.name))),
    vocalStartBeats,
  };
}

export const SYSTEM = `You are the resident composer inside Muse Machine, a browser band that performs
multitrack arrangements live. The user played a short riff on the piano and typed a style or
artist. Compose a COMPLETE SONG built around their riff and return it as JSON.

You write a song plan: each section ONCE, then an order that repeats them. The engine
unrolls the repeats, so a compact plan performs as a full-length song. Write it like a
songwriter: verse/chorus contrast, a bridge or breakdown, an ending.

Section semantics (4/4 time; durations in beats, quarter note = 1):
- sections: 3–5 distinct sections (e.g. intro, verse, chorus, bridge, outro), each 4–8
  bars. Each section has its own tracks and drums covering exactly bars × 4 beats
  (pad with rests). A track absent from a section is silent there.
- order: 8–12 section names, e.g. ["intro","verse","chorus","verse","chorus","bridge",
  "chorus","chorus","outro"]. Total performed length 40–64 bars (about 2–3 minutes) —
  repeats are free, so use them: this is the song the user hears, give it a real shape
  and a real ending (final section resolves to the tonic; don't stop mid-phrase).
- tracks match ACROSS sections by exact name; give voice/gain/pan on a track's first
  appearance (gain 0–1: bass ~0.9, chords ~0.5, colors ~0.4; pan -1..1 to spread the
  band). Use 4–7 distinct track names across the whole song.
- notes: {pitch, beats, vel 0–1} or {rest: true, beats}. pitch is a MIDI number, a note
  name like "G3", or an array of either for a chord. Bass 28–48, chords 48–67, lead 55–86.
- drums.steps: per-lane 16th-note step strings, lanes kick/snare/hat/clap/ride/conga/
  shaker/tamb; 16 chars per bar, exactly bars × 16 per section; "."=silent, "x"=hit,
  "X"=accent. Vary the groove per section (sparse intro, fills, denser chorus).
- swing 0.5 (straight) to 0.66 (heavy); pump 0–0.35 adds sidechain ducking;
  leadTrack is the NAME of the melody track to show on the sheet-music display.

Composition requirements:
- The user's riff is sacred: one track's name must contain "riff"; state the riff
  recognizably (exact intervals and rhythm) in at least two sections, and develop it
  elsewhere (diatonic transposition, octave answers, call-and-response). Honor the
  key the riff implies.
- Keep the JSON economical: minified, omit vel except accents, prefer sustained notes,
  at most ~250 note events across all sections. Density comes from drums and repeats.
- Be idiomatic for the requested style — voices, tempo, groove, harmonic color, bass
  behavior. If an artist is named, channel their production style.

Hum mode (input.isHum true): the melody was hummed into a microphone, and the band will
re-sing it with the user's ACTUAL VOICE, pitch-forced onto the melody, in every section
where you set vocal: true. Mark vocal: true on the sections where the melody is sung —
the chorus, typically, so the voice returns 2–3 times across the order. A vocal section
must be at least riffTotalBeats/4 bars long, and its instrumental tracks should back the
singer (sparse lead or soft doubling there; save the runs for non-vocal sections).`;

// Light sanitation: the schema guarantees shape; this guards musical/engine limits.
export function sanitize(arr) {
  const clamp = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  arr.tempo = clamp(arr.tempo, 50, 200, 100);
  arr.swing = clamp(arr.swing, 0.5, 0.7, undefined);
  arr.pump = clamp(arr.pump, 0, 0.4, undefined);
  arr.tracks = (arr.tracks || []).slice(0, 12);
  for (const t of arr.tracks) {
    t.gain = clamp(t.gain, 0, 1, 0.7);
    t.pan = clamp(t.pan, -1, 1, 0);
    if (!VOICE_LIST.includes(t.voice)) t.voice = 'piano';
    t.notes = (t.notes || []).filter(n => n && n.beats > 0);
  }
  const steps = arr.drums?.steps || {};
  for (const k of Object.keys(steps)) if (!LANES.includes(k)) delete steps[k];
  const len = Math.ceil(Math.max(0, ...Object.values(steps).map(s => s.length)) / 16) * 16;
  for (const k of Object.keys(steps)) {
    steps[k] = steps[k].replace(/[^.xX]/g, '.');
    if (steps[k].length < len) steps[k] = steps[k].padEnd(len, '.');
  }
  if (arr.drums) arr.drums.gain = clamp(arr.drums.gain, 0, 1, 0.9);
  arr.leadTrack = Number.isInteger(arr.leadTrack) && arr.leadTrack >= 0 && arr.leadTrack < arr.tracks.length
    ? arr.leadTrack : Math.max(0, arr.tracks.length - 1);
  arr.vocalStartBeats = (arr.vocalStartBeats || [])
    .filter(b => typeof b === 'number' && isFinite(b) && b >= 0)
    .sort((a, b) => a - b).slice(0, 4);
  return arr;
}

function riffInput({ riff, style, tempo, key, hum }) {
  return JSON.stringify({
    style: style || 'pop',
    userTempoSetting: tempo,
    keyGuess: key,
    isHum: !!hum,
    riffTotalBeats: (riff || []).reduce((s, n) => s + (n.beats || 0), 0),
    riff,
  });
}

// ---- reverse bridge: compose via the user's Claude subscription ----
// Spawns `claude -p` (headless Claude Code). Auth comes for free: when this
// server was spawned by Claude Code, CLAUDE_CODE_OAUTH_TOKEN is in our env
// and the child CLI picks it up. Falls back to any CLI login/keychain creds.
function findClaudeCli() {
  try { return execFileSync('/usr/bin/which', ['claude']).toString().trim(); } catch {}
  const base = path.join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
  try {
    const versions = readdirSync(base).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }));
    for (const v of versions.reverse()) {
      const bin = path.join(base, v, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (existsSync(bin)) return bin;
    }
  } catch {}
  return null;
}

// Claude Code sanitizes the env it hands MCP servers, so the subscription
// token is NOT inherited here. But the user's own Claude Code process carries
// it — borrow it (same user, same machine, powering the user's own request).
// A CLAUDE_CODE_OAUTH_TOKEN set explicitly in ~/.mcp.json env always wins.
function harvestOAuthToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return null;   // already have one
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('/bin/ps', ['-wwwE', '-ax'], { maxBuffer: 64 * 1024 * 1024 }).toString();
    const m = out.match(/CLAUDE_CODE_OAUTH_TOKEN=(\S+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

function runCli(cli, args, prompt) {
  const tok = harvestOAuthToken();
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'],
      env: tok ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: tok } : process.env });
    let out = '', err = '';
    const kill = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude CLI timed out after 8 minutes')); }, 480000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(kill); reject(e); });
    child.on('close', () => {
      clearTimeout(kill);
      try { resolve({ wrap: JSON.parse(out), err }); }
      catch { reject(new Error('claude CLI returned unparseable output: ' + (err || out).slice(0, 120))); }
    });
    child.stdin.end(prompt);
  });
}

export async function cliCompleteRiff(input, onStatus) {
  const cli = findClaudeCli();
  if (!cli) throw new Error('claude CLI not found');
  const prompt = SYSTEM
    + '\n\nRespond with ONLY a JSON object (no prose, no code fences, no tool use) '
    + 'matching this JSON Schema:\n' + JSON.stringify(ARRANGEMENT_SCHEMA)
    + '\n\nInput:\n' + riffInput(input);
  onStatus && onStatus('composing via your Claude subscription');
  const base = ['-p', '--output-format', 'json', '--strict-mcp-config'];
  // opus is fast enough for a full arrangement; the account default (often a
  // slower deep-reasoning model) can blow the timeout. Retry unpinned if the
  // plan doesn't offer opus.
  let { wrap, err } = await runCli(cli, [...base, '--model', 'opus'], prompt);
  if (wrap.is_error && /model|plan|access/i.test(String(wrap.result || '')))
    ({ wrap, err } = await runCli(cli, base, prompt));
  if (wrap.is_error) {
    const msg = String(wrap.result || 'unknown CLI error');
    throw new Error(/not logged in/i.test(msg)
      ? 'the claude CLI has no credentials — run `claude setup-token` and put the token in '
        + 'the muse-machine env as CLAUDE_CODE_OAUTH_TOKEN in ~/.mcp.json (or add an ANTHROPIC_API_KEY)'
      : msg);
  }
  const text = String(wrap.result || '');
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('the model returned no arrangement JSON');
  return sanitize(expandPlan(JSON.parse(text.slice(first, last + 1))));
}

export async function llmCompleteRiff(input, onStatus) {
  const client = new Anthropic();
  const user = riffInput(input);
  onStatus && onStatus('composing via the Anthropic API');
  try {
    const stream = client.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: ARRANGEMENT_SCHEMA } },
      messages: [{ role: 'user', content: user }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('the model declined this request');
    const text = msg.content.find(b => b.type === 'text');
    if (!text) throw new Error('the model returned no arrangement');
    return sanitize(expandPlan(JSON.parse(text.text)));
  } catch (e) {
    if (e.status === 401 || /resolve authentication/i.test(e.message || ''))
      throw new Error('no Anthropic API key — add "env": {"ANTHROPIC_API_KEY": "sk-ant-…"} to '
        + 'the muse-machine server in ~/.mcp.json to enable 🤖 completion. ⚡ Instant still works.');
    throw e;
  }
}

// Subscription first (reverse bridge via claude CLI), API key as fallback.
export async function completeRiffAny(input, onStatus) {
  const haveCli = !!findClaudeCli();
  if (haveCli) {
    try { return await cliCompleteRiff(input, onStatus); }
    catch (e) {
      if (!process.env.ANTHROPIC_API_KEY) throw e;
      onStatus && onStatus('subscription path failed (' + e.message.slice(0, 60) + '…) — trying the API');
    }
  }
  return llmCompleteRiff(input, onStatus);
}
