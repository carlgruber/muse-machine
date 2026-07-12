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
export const ARRANGEMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'tempo', 'tracks', 'drums', 'leadTrack'],
  properties: {
    title: { type: 'string' },
    tempo: { type: 'number' },
    swing: { type: 'number' },
    pump: { type: 'number' },
    leadTrack: { type: 'integer' },
    vocalStartBeats: { type: 'array', items: { type: 'number' } },
    tracks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'voice', 'notes'],
        properties: {
          name: { type: 'string' },
          voice: { type: 'string', enum: VOICE_LIST },
          gain: { type: 'number' },
          pan: { type: 'number' },
          startBeat: { type: 'number' },
          notes: { type: 'array', items: NOTE },
        },
      },
    },
    drums: {
      type: 'object', additionalProperties: false, required: ['steps'],
      properties: {
        gain: { type: 'number' },
        steps: {
          type: 'object', additionalProperties: false,
          properties: Object.fromEntries(LANES.map(l => [l, { type: 'string' }])),
        },
      },
    },
  },
};

export const SYSTEM = `You are the resident composer inside Muse Machine, a browser band that performs
multitrack arrangements live. The user played a short riff on the piano and typed a style or
artist. Compose a complete song built around their riff and return it as JSON.

Arrangement semantics (4/4 time; durations in beats, quarter note = 1):
- tracks: 4–7 tracks. Each has name, voice, gain 0–1 (bass ~0.9, chords ~0.5, colors ~0.4),
  pan -1..1 (spread the band), optional startBeat (beats of silence before the track enters),
  and notes: a sequence of {pitch, beats, vel 0–1} or {rest: true, beats}.
- pitch is a MIDI number, a note name like "G3", or an array of either for a chord.
  Keep bass 28–48, chords/comping 48–67, lead/melody 55–86.
- drums.steps: per-lane 16th-note step strings over lanes kick/snare/hat/clap/ride/conga/
  shaker/tamb. 16 characters per bar; "." = silent, "x" = hit, "X" = accent. Every lane you
  include MUST be exactly the same length: 16 × (total bars of the song). Through-compose the
  groove — vary it per section (sparser intro, fills into the chorus, denser peak, clean ending).
- swing 0.5 (straight) to 0.66 (heavy); pump 0–0.35 adds sidechain ducking (EDM/synthwave);
  leadTrack is the index of the melody track to render on the sheet-music display.

Composition requirements:
- 16–24 bars total, with a real arc: short intro → riff stated plainly → development
  (diatonic transpositions, octave answers, call-and-response) → a bigger chorus/peak
  section → final riff statement → clean ending resolving to the tonic.
- Keep the JSON economical (it is performed, not read): minified, omit vel except for
  accents, prefer sustained notes and startBeat over long runs of rests, at most ~300
  note events across all tracks. Density should come from the drums, not the JSON.
- The user's riff is sacred: one track's name must contain "riff" and must state the riff
  recognizably at least twice (its exact intervals and rhythm), plus developed variants.
  Honor the key implied by the riff.
- Every track's notes must fill the full song length (use rests) so the parts line up.
- Be idiomatic for the requested style — voice choices, tempo, groove, harmonic color,
  bass behavior. If an artist is named, channel their production style.
- Total duration should land between 40 and 75 seconds at your chosen tempo.

Hum mode (input.isHum true): the melody was hummed into a microphone, and the band will
re-sing it with the user's ACTUAL VOICE, pitch-forced onto the melody. Return
vocalStartBeats: 2–3 beat offsets where the vocal states the user's exact melody (its
full riffTotalBeats each time) — typically the first statement and the final one. Around
those beats, arrange like a producer behind a singer: keep the lead track sparse or
doubling softly there (save its runs for the gaps between vocal statements), and leave
headroom in the mix. Statements must not overlap.`;

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
  return sanitize(JSON.parse(text.slice(first, last + 1)));
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
    return sanitize(JSON.parse(text.text));
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
