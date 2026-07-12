# 🎹 Muse Machine

**A musical instrument your AI can play — and a band, a producer, and a music teacher in one HTML file.**

Muse Machine is a self-contained browser studio (pure Web Audio API, zero dependencies, no build step) wired to Claude through [MCP](https://modelcontextprotocol.io). You can play it like an instrument, read and practice sheet music on it, record and autotune yourself in it — or ask Claude to compose a full multitrack production and watch the band perform it live on your speakers: piano keys fingering every part in per-instrument colors, sheet music following the lead with a moving playhead, the drum grid rewriting itself bar by bar, and fireworks sized to the music's dynamics.

Hum four seconds of melody into the mic and say *"finish my thought"* — Claude transcribes it, treats it as a musical question, and writes the answer.

## 🎬 Demo



https://github.com/user-attachments/assets/607c642c-699d-4e70-b44e-ce299ac35299


---

## Quick start

```sh
git clone <this-repo> muse-machine
cd muse-machine
./start.sh          # serves the app + optional bridges
```

Open **http://localhost:8778**, click the page once (browsers require a gesture to unlock audio), and play.

No server needed for the instrument itself — you can also just open `index.html` directly. Serving is recommended so the microphone works everywhere.

### Connect Claude (Claude Code)

Register the MCP server in `~/.mcp.json`:

```json
{
  "mcpServers": {
    "muse-machine": {
      "command": "node",
      "args": ["/path/to/muse-machine/mcp/server.js"]
    }
  }
}
```

Keep the app open in a browser tab; the header shows **🤖 Claude connected** when the bridge (a local WebSocket on `:8779`) is live. Then just talk:

> *"play something upbeat"*
> *"make me a synthwave track with a build and a drop"*
> *"produce my hum as a lofi song"* (after recording a hum in the Studio)
> *"finish my thought"* (after humming a fragment)
> *"make the bass louder in Neon Skyline and change the lead to marimba"*
> *"put Nightdrive's lead on the waterfall so I can learn it"*

### Connect Claude Desktop

The Desktop app's Connectors UI needs an HTTPS URL, so use the Streamable-HTTPS entrypoint with a locally-trusted cert from [mkcert](https://github.com/FiloSottile/mkcert):

```sh
brew install mkcert
mkcert -install
mkdir -p mcp/certs
mkcert -cert-file mcp/certs/localhost-cert.pem -key-file mcp/certs/localhost-key.pem localhost 127.0.0.1 ::1
node mcp/server-http.js
```

Settings → Connectors → Add custom connector → `https://localhost:8790/mcp`. Only one entrypoint can hold the browser bridge at a time; the other reports it clearly instead of failing silently.

---

## What's in the box

### 🎛️ Band Mode — the flagship
Claude's `play_arrangement` tool performs as a **full band on one sample-accurate clock**: up to 12 melodic/chordal tracks (each with its own synth voice, gain, stereo pan, and entry beat), a step-programmable drum kit, and vocal lines dropped into the mix at exact beats.

- **Chords** are pitch arrays; `startBeat` writes intros, builds, and drops.
- **Drums** take preset grooves (`rock`, `trap`, `house`, `funk`, `disco`, `boombap`, `bossa`, `shuffle`) or custom per-lane step strings — `kick: "x..x....x..x...."`, `X` = accent — across **8 lanes** (kick, snare, hat, clap, ride, conga, shaker, tambourine) of any length, so a groove can be *through-composed* and morph verse→build→chorus with zero seams. Swing is dialable (0.5–0.7).
- **Production polish**: `pump` (sidechain ducking on every kick), `humanize` (±12 ms timing and velocity wobble so the band breathes).
- **The stage show**: a floating Now-Performing HUD with per-track activity dots; the on-screen piano fingers every part live (each of the 35 instruments has a **signature color** — unison notes blend); the engraved staff renders the lead line and follows it with a moving playhead; the Beat Lab grid mirrors the actual groove bar by bar; and key-press fireworks scale with each note's length and velocity.

### 🎤 Sing → Song
- **🪄 Songify** (Studio tab): one button, zero AI — records → transcribes → infers your key from a pitch-class histogram → fits a diatonic chord to every bar → the band plays your tune **with your own voice singing it**, then an instrument echoes it.
- **🤖 Produce my hum** (Studio tab): the same, but Claude writes the whole production — type a style, and the reverse bridge (see Riff → Song below) has Claude compose a full arrangement whose `vocalStartBeats` place **your actual voice** singing the hook exactly where the production wants it. Subscription-billed, no API key.
- **Hum → full production**: Claude reads your melody via `transcribe_recording` / `get_sheet` and arranges a real production around it in any style.
- **Finish my thought**: hum a fragment; Claude analyzes it as an antecedent phrase and composes the consequent — your idea opens the song, gets developed (sequences, octave answers), and comes home.
- **You are the vocalist**: arrangement vocals accept `source: "studio"` — your mic take is pitch-forced onto the written melody by the PSOLA vocal engine (autotuned, stackable to a 5-voice choir of you), mixed through a proper vocal channel strip. **No TTS anywhere in the chain.** Speak the words flat; they come out sung.

### 🎸 Riff → Song
Hit **🎸 Riff**, play a few notes on the keyboard, type a style or artist — then pick your tier:
- **🤖 Claude completes it**: the bridge composes a full production around your motif — idiomatic voices, through-composed drums, a real arc — and the band performs it (takes a few minutes). It's a **reverse bridge**: the MCP server spawns headless Claude Code (`claude -p`) on your **Claude subscription — no API key**. (Claude Code strips its auth from MCP server environments, so the bridge borrows the `CLAUDE_CODE_OAUTH_TOKEN` from your own running Claude Code process — your token, your machine, your request. Set the token explicitly in the server's env to skip the borrowing.) Fallbacks, in order: a `claude` CLI login, a token from `claude setup-token` placed in the server's env, or `ANTHROPIC_API_KEY` (direct Opus 4.8 API call with a structured-output schema).
- **⚡ Instant**: a zero-AI music-theory engine (key inference, diatonic motif development, style templates) — works offline, never burns a token.

Enter in the style box picks 🤖 when the bridge is connected, ⚡ otherwise.

### 🌊 Waterfall play-along
Synthesia-style falling notes that land on the real on-screen keys, for anything the staff can hold (built-ins, imports, Band Mode leads, your transcribed hums). Flow mode scores your timing (hit/miss/streak, gold bursts on hits); **✋ wait-for-me** holds each note at the line until you play it. Works with mouse, computer keyboard, or a real MIDI keyboard, and pauses itself when you switch tabs.

### 📜 Sheet music
Parses an ABC-style notation format and renders a real engraved staff as SVG (key signatures, accidentals, ledger lines, flags, dotted notes, rests). Five built-in pieces plus a live notation editor. **🎯 Practice Mode** teaches note-by-note with scoring. Upload (or drag & drop) `.abc`/`.txt`, MusicXML (`.musicxml`/`.xml`/`.mxl` — unzipped in-browser), or `.mid` — everything lands in the editor as editable text.

### 🎙️ Studio
Record from the mic or the instrument itself. Live tuner (note/frequency/cents). **Autotune Lab**: YIN pitch detection → snap-to-scale → time-varying pitch shifter, from gentle correction to full T-Pain. **Harmonizer** turns one take into 3-part harmony. **Sing → Sheet** transcription. Export takes as WAV.

### 🎹 Instrument
3-octave on-screen piano (mouse/touch/glissando/computer keys/Web MIDI) with **35 synthesized voices** across keys, mallets, plucked strings (Karplus-Strong guitars incl. overdrive and auto-wah funk), winds, brass, strings, pads (incl. a formant-filtered gospel choir), and synths (incl. wobble bass, a true 808 sub with pitch-drop and drive, and 8-bit chip) — per-voice vibrato, tremolo, attack transients, pitch scoops, convolution reverb, and a master glue-compressor chain.

### 💾 Exports
- **⬇ Band MIDI**: the last band performance as a **multitrack format-1 MIDI file** — one named track per instrument with General MIDI programs and pans, drums on channel 10 with accents. Opens as a real production in GarageBand/Logic/Ableton.
- **⬇ WAV**: bounce the last performance offline through the identical bus chain into a 16-bit stereo WAV (~25× faster than realtime), including your studio vocals.
- **⬇ MIDI**: the current sheet as a single-track `.mid` (round-trips through the uploader).

### 🎼 Songbook
Songs live in `songs/*.json` and replay anytime via the **▶ Perform** button or the `play_song` tool — no AI required after composition. Two ways in: Claude saves via `save_song`, or hit **💾 Save Song** after any band performance (it appears next to ⬇ Band MIDI) — name collisions auto-suffix instead of overwriting. Songs are plain JSON you can read, diff, and version-control.

---

## MCP tool reference

| Tool | What it does |
|---|---|
| `play_arrangement` | Perform a full multitrack production live (tracks, drums, vocals, pump, humanize, live sheet) |
| `play_melody` | Play ABC notation with live engraved sheet music |
| `play_notes` | Quick note sequences without notation |
| `get_sheet` | **Read** the current staff: key, tempo, ABC, parsed notes, recording state |
| `transcribe_recording` | Turn the user's latest mic take into notation (the hum→song entry point) |
| `save_song` / `list_songs` / `play_song` | Persist, list, and perform Songbook songs |
| `get_song` | Read a saved song — compact structural summary, or drill into one part/track |
| `delete_song` | Remove a song (recoverably — it moves to `songs/.trash/`) |
| `edit_song` | Surgical dot-path edits (`set`/`delete`/`append`/`insert`) — e.g. `parts.0.tracks.2.gain` — without resending the song |
| `start_waterfall` | Launch falling-notes play-along on the current sheet (optional wait-mode) |
| `drum_groove` | Start/stop a looping drum pattern |
| `set_voice` | Switch the instrument voice (32 options) |
| `get_status` | Connection, audio, and bridge diagnostics |
| `stop_music` | Stop everything |
| `sing` / `speak` | TTS vocals/announcements — optional, gated behind `MUSE_VOICE=1` (studio-voice vocals don't need it) |

**A typical composing loop:** `play_arrangement` (hear a draft) → `save_song` → `get_song` (see the structure) → `edit_song` ("gain 0.65 on track 3", "swap the kick lane") → `play_song` — iterate without ever resending full arrangements.

## Optional: TTS voice

Text-to-speech singing (`sing`, `speak`, `tts` vocals) is opt-in — set `"env": { "MUSE_VOICE": "1" }` on the server in `~/.mcp.json`. It uses a local [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) neural TTS daemon (`mcp/tts_daemon.py`, model in `mcp/models/`) with macOS `say` as fallback. **Your own voice via `source: "studio"` works without any of this** — and sounds better.

## Ports

| Port | What |
|---|---|
| 8778 | the web app (`python3 -m http.server`) |
| 8779 | browser ⇄ MCP WebSocket bridge |
| 8790 | Streamable-HTTPS MCP (Claude Desktop connector) |
| 8793 | optional neural TTS daemon |

## Architecture

- `index.html` — the entire app: synth engine, sheet renderer, Band Mode scheduler, waterfall, effects, exports. No frameworks, no build.
- `vocal-engine.js` — MuseVocal: epoch-aligned PSOLA melodizer/autotune (pure DSP; also runs under Node for tests).
- `mcp/bridge.js` — shared bridge + tool definitions; `mcp/server.js` (stdio) and `mcp/server-http.js` (HTTPS) are thin entrypoints. The WebSocket hub fails over across tabs, heartbeats out zombies, and replays audio-blocked commands after the user's first click.
- `songs/` — the Songbook (plain JSON).

## Verified behavior

- 430 Hz input detects as 430.01 Hz and tunes to 440.00 Hz (chromatic snap); ±31¢ vibrato flattens to ±10¢.
- A synthesized 8-note hum transcribes note-for-note and round-trips into an arrangement.
- Band WAV bounces render ~25× realtime and byte-match the live bus chain (reverb, glue comp, soft clip).
- Multitrack MIDI exports parse back with correct track names, GM programs, and channel-10 drums.
