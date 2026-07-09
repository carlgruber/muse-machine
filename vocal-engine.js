/* ================================================================
   MUSE VOCAL ENGINE v3.1 — TD-PSOLA singing synthesis.

   Turns spoken audio (e.g. macOS `say` output) into singing:

   1. pitch-track the speech with YIN on a 4x-decimated copy
   2. mark glottal epochs (pitch-synchronous pulse positions) at full rate
   3. segment into syllable nuclei (voiced runs, split at energy valleys)
   4. map nuclei to melody notes on a strict beat grid — with melisma:
      when there are more notes than syllables, one vowel carries a chain
      of notes, re-articulated at each pitch change like a real singer
   5. re-render each vowel with epoch-aligned Hann grains placed at the
      target pitch period (formants preserved), time-stretched with the
      attack and release kept at natural speed
   6. drive pitch from a musical contour: legato portamento, onset scoop,
      delayed-onset vibrato (with coupled loudness vibrato), phrase-end
      fall, micro-jitter, and phrase-level dynamics that follow the
      melodic arc
   7. splice consonants back in at natural speed with raised-cosine fades
   8. produce a doubled, stereo-spread vocal (styles: lead, soft, choir,
      bright, deep, robot — formant shift, breathiness, detune per style)
   9. polish offline: breath layer, de-esser, high-pass, presence EQ,
      soft limiter

   Pure DSP on Float32Arrays — no Web Audio. Loaded by index.html as a
   <script> (window.MuseVocal) and by Node tests via require().
   ================================================================ */
(function () {
'use strict';

// deterministic PRNG so a given (lyrics, melody, style) renders identically
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
const CENT = Math.pow(2, 1 / 1200);

function nameToMidi(name) {
  if (typeof name === 'number') return Math.round(name);
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d)$/.exec(String(name).trim());
  if (!m) return null;
  const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return 12 * (+m[3] + 1) + SEMI[m[1].toUpperCase()] + acc;
}

// Vocal characters. formant scales the spectral envelope (1 = as spoken),
// doubles = extra detuned/offset takes mixed under the lead, breath = level
// of the pitch-following aspiration layer, octave biases the auto-transpose.
const STYLES = {
  lead:   { formant: 1.0,  doubles: 2, detune: 9,  spread: 12, breath: 0.05, vibScale: 1.0,  jitter: 1, human: true,  octave: 0 },
  soft:   { formant: 1.03, doubles: 2, detune: 6,  spread: 10, breath: 0.16, vibScale: 0.75, jitter: 1, human: true,  octave: 0 },
  choir:  { formant: 1.0,  doubles: 4, detune: 16, spread: 28, breath: 0.07, vibScale: 0.7,  jitter: 1, human: true,  octave: 0 },
  bright: { formant: 1.10, doubles: 2, detune: 8,  spread: 12, breath: 0.04, vibScale: 1.1,  jitter: 1, human: true,  octave: 0 },
  deep:   { formant: 0.88, doubles: 2, detune: 7,  spread: 12, breath: 0.05, vibScale: 0.9,  jitter: 1, human: true,  octave: -12 },
  robot:  { formant: 1.0,  doubles: 0, detune: 0,  spread: 0,  breath: 0.0,  vibScale: 0,    jitter: 0, human: false, octave: 0 },
};

// ---------------- analysis: decimated YIN pitch track ----------------

function decimate4(x) {
  const n = Math.floor(x.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    out[i] = (x[j] + 2 * (x[j + 1] || 0) + 2 * (x[j + 2] || 0) + (x[j + 3] || 0)) / 6;
  }
  return out;
}

function yinFrame(x, sr, off, W, minHz, maxHz) {
  const maxTau = Math.min(Math.floor(sr / minHz), Math.floor((x.length - off - 1) / 2), W);
  const minTau = Math.max(2, Math.floor(sr / maxHz));
  if (maxTau - minTau < 4) return null;
  const L = maxTau;
  if (off + L + maxTau >= x.length) return null;

  const d = new Float32Array(maxTau + 1);
  for (let tau = minTau; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = off; i < off + L; i++) {
      const diff = x[i] - x[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  const cm = new Float32Array(maxTau + 1).fill(1);
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau] || 0;
    cm[tau] = running > 0 ? (d[tau] || 0) * tau / running : 1;
  }
  let tauEst = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cm[tau] < 0.16) {
      while (tau + 1 <= maxTau && cm[tau + 1] < cm[tau]) tau++;
      tauEst = tau; break;
    }
  }
  if (tauEst < 0) {
    let best = minTau;
    for (let tau = minTau; tau <= maxTau; tau++) if (cm[tau] < cm[best]) best = tau;
    if (cm[best] > 0.4) return null;
    tauEst = best;
  }
  let tau = tauEst;
  if (tau > minTau && tau < maxTau) {
    const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) tau += 0.5 * (a - c) / denom;
  }
  return { hz: sr / tau, clarity: 1 - cm[tauEst] };
}

function analyze(input, sr) {
  const dec = decimate4(input);
  const dsr = sr / 4;
  const AH = Math.round(sr * 0.010);
  const dAH = Math.round(AH / 4);
  const dW = Math.round(dsr * 0.035);
  const nF = Math.max(1, Math.floor(input.length / AH));

  const f0s = new Float32Array(nF);
  const rms = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    const off = f * AH, end = Math.min(off + AH, input.length);
    let e = 0;
    for (let i = off; i < end; i++) e += input[i] * input[i];
    rms[f] = Math.sqrt(e / Math.max(1, end - off));
    const p = yinFrame(dec, dsr, f * dAH, dW, 60, 420);
    f0s[f] = p && p.clarity > 0.5 ? p.hz : 0;
  }

  const sorted = Array.from(rms).sort((a, b) => a - b);
  const gate = 0.06 * (sorted[Math.floor(sorted.length * 0.95)] || 0.01);

  const med = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    const w = [];
    for (let k = -2; k <= 2; k++) {
      const v = f0s[Math.max(0, Math.min(nF - 1, f + k))];
      if (v > 0) w.push(v);
    }
    med[f] = f0s[f] > 0 && w.length ? w.sort((a, b) => a - b)[w.length >> 1] : 0;
  }
  for (let f = 1; f < nF - 2; f++) {
    if (med[f] === 0 && med[f - 1] > 0) {
      let g = f;
      while (g < nF && med[g] === 0) g++;
      if (g < nF && g - f <= 2 && rms[f] > gate * 0.5) {
        for (let k = f; k < g; k++) med[k] = med[f - 1] + (med[g] - med[f - 1]) * (k - f + 1) / (g - f + 1);
      }
      f = g;
    }
  }

  const voicedAt = f => med[f] > 0 && rms[f] > gate;
  const voiced = [];
  for (let f = 0; f < nF; f++) if (voicedAt(f)) voiced.push(med[f]);
  const medF = voiced.length ? voiced.slice().sort((a, b) => a - b)[voiced.length >> 1] : 0;

  const f0At = pos => {
    const f = Math.max(0, Math.min(nF - 1, Math.round(pos / AH)));
    return med[f] || medF || 140;
  };
  return { f0s: med, rms, AH, nF, gate, voicedAt, f0At, medF };
}

// ---------------- glottal epoch marking ----------------
function markEpochs(x, s0, s1, f0At, sr) {
  let skew = 0;
  for (let i = s0; i < s1; i++) skew += x[i] * x[i] * x[i];
  const sign = skew >= 0 ? 1 : -1;

  const T0 = sr / f0At(s0);
  let e = s0, best = -Infinity;
  const seedEnd = Math.min(s1, s0 + Math.ceil(T0 * 1.5));
  for (let i = s0; i < seedEnd; i++) {
    const v = sign * x[i];
    if (v > best) { best = v; e = i; }
  }
  const epochs = [e];
  while (true) {
    const T = sr / f0At(e);
    const lo = e + Math.floor(0.75 * T), hi = Math.min(s1, e + Math.ceil(1.35 * T));
    if (lo >= s1 || hi - lo < 2) break;
    let bi = -1, bv = -Infinity;
    for (let i = lo; i < hi; i++) {
      const w = 1 - 0.4 * Math.abs(i - (e + T)) / (0.35 * T + 1);
      const v = sign * x[i] * Math.max(0.2, w);
      if (v > bv) { bv = v; bi = i; }
    }
    if (bi < 0) break;
    epochs.push(bi);
    e = bi;
  }
  return epochs;
}

// ---------------- syllable nuclei ----------------
function findNuclei(an) {
  const { rms, nF, voicedAt } = an;
  const runs = [];
  let rs = -1, gap = 0;
  for (let f = 0; f < nF; f++) {
    if (voicedAt(f)) { if (rs < 0) rs = f; gap = 0; }
    else if (rs >= 0 && ++gap > 2) { runs.push([rs, f - gap + 1]); rs = -1; }
  }
  if (rs >= 0) runs.push([rs, nF]);

  const nuclei = [];
  const splitRun = (a, b, depth) => {
    if (depth > 4 || b - a < 18) { nuclei.push([a, b]); return; }
    let best = -1, bestVal = Infinity;
    for (let j = a + 6; j < b - 6; j++) {
      const v = (rms[j - 1] + rms[j] + rms[j + 1]) / 3;
      if (v < bestVal) { bestVal = v; best = j; }
    }
    let lp = 0, rp = 0;
    for (let j = a; j < best; j++) lp = Math.max(lp, rms[j]);
    for (let j = best; j < b; j++) rp = Math.max(rp, rms[j]);
    if (best > 0 && bestVal < 0.55 * Math.min(lp, rp)) { splitRun(a, best, depth + 1); splitRun(best, b, depth + 1); }
    else nuclei.push([a, b]);
  };
  for (const [a, b] of runs) if (b - a >= 4) splitRun(a, b, 0);
  nuclei.sort((p, q) => p[0] - q[0]);
  return nuclei;
}

// ---------------- melody slots & melisma chains ----------------
function buildSlots(notes, tempo, medF, octaveBias) {
  const spb = 60 / tempo;
  const PAD = 0.3;
  const slots = [];
  let beat = 0;
  for (const n of notes || []) {
    const beats = n.beats || 1;
    if (n.rest) {
      if (slots.length) slots[slots.length - 1].restAfter = true;
    } else {
      const midi = nameToMidi(n.pitch);
      if (midi !== null) slots.push({ startSec: PAD + beat * spb, durSec: beats * spb, midi, restAfter: false });
    }
    beat += beats;
  }
  if (!slots.length) return { slots, shift: 0 };
  const mids = slots.map(s => s.midi).sort((a, b) => a - b);
  const shift = (medF > 0 ? 12 * Math.round(Math.log2(medF / midiToFreq(mids[mids.length >> 1]))) : 0) + (octaveBias || 0);
  return { slots, shift };
}

// Group slots into one chain per nucleus. Extra notes become melismas on the
// longest vowels; extra syllables keep singing the last pitch, half a beat each.
function buildChains(slots, nuclei, tempo) {
  const spb = 60 / tempo;
  const chains = [];
  if (slots.length >= nuclei.length) {
    const per = new Array(nuclei.length).fill(1);
    let extra = slots.length - nuclei.length;
    // hand extra notes to the longest nuclei first
    const order = nuclei.map((n, i) => [n[1] - n[0], i]).sort((a, b) => b[0] - a[0]);
    let oi = 0;
    while (extra > 0) { per[order[oi % order.length][1]]++; extra--; oi++; }
    let si = 0;
    for (let i = 0; i < nuclei.length; i++) {
      chains.push(slots.slice(si, si + per[i]));
      si += per[i];
    }
  } else {
    for (let i = 0; i < slots.length; i++) chains.push([slots[i]]);
    let cursor = slots[slots.length - 1].startSec + slots[slots.length - 1].durSec;
    const lastMidi = slots[slots.length - 1].midi;
    while (chains.length < nuclei.length) {
      chains.push([{ startSec: cursor, durSec: 0.5 * spb, midi: lastMidi, restAfter: false }]);
      cursor += 0.5 * spb;
    }
  }
  return chains;
}

// ---------------- musical pitch & gain contour (per chain) ----------------
function makeContours(chains, shift, vib, style, rand) {
  // phrase map: which chain begins/ends a breath phrase (rest boundaries)
  const phraseEnd = chains.map(ch => ch[ch.length - 1].restAfter);
  // melodic-height dynamics: higher notes sing a touch louder
  const allMidi = chains.flatMap(ch => ch.map(s => s.midi));
  const midiMean = allMidi.reduce((s, v) => s + v, 0) / allMidi.length;

  return chains.map((chain, ci) => {
    const total = chain.reduce((s, sl) => s + sl.durSec, 0);
    const segStart = [];
    let acc = 0;
    for (const sl of chain) { segStart.push(acc); acc += sl.durSec; }
    const targets = chain.map(sl => midiToFreq(sl.midi + shift));

    const prevChain = ci > 0 ? chains[ci - 1] : null;
    const prevSlot = prevChain && prevChain[prevChain.length - 1];
    const legato = prevSlot && !prevSlot.restAfter &&
      chain[0].startSec - (prevSlot.startSec + prevSlot.durSec) < 0.18;
    const entryHz = !style.human ? targets[0]
      : legato ? midiToFreq(prevSlot.midi + shift)
      : targets[0] * Math.pow(CENT, -80);
    const isEnd = phraseEnd[ci] || ci === chains.length - 1;

    const vibDepth = 35 * vib * style.vibScale;
    const vibRate = 5.1 + rand() * 0.5;
    const vibPhase = rand() * Math.PI * 2;
    const j1 = (rand() * 2 - 1) * style.jitter, j2 = (rand() * 2 - 1) * style.jitter;
    const jf1 = 1.3 + rand(), jf2 = 2.9 + rand();

    // phrase arc: gentle swell toward the middle of each breath phrase
    let pStart = ci; while (pStart > 0 && !phraseEnd[pStart - 1]) pStart--;
    let pEnd = ci; while (pEnd < chains.length - 1 && !phraseEnd[pEnd]) pEnd++;
    const pPos = pEnd > pStart ? (ci - pStart) / (pEnd - pStart) : 0.5;
    const arcDb = 1.2 * Math.sin(Math.PI * pPos) - 0.6;

    const seg = tRel => {
      let k = chain.length - 1;
      while (k > 0 && tRel < segStart[k]) k--;
      return k;
    };

    const vibEnv = tRel => {
      if (total < 0.22) return 0;
      const k = seg(tRel);
      const local = tRel - segStart[k];
      const bloomStart = k === 0 ? Math.min(0.18, chain[0].durSec * 0.3) : 0.06;
      const bloomLen = k === 0 ? Math.min(0.3, Math.max(0.05, total * 0.35)) : 0.12;
      return local > bloomStart ? Math.min(1, (local - bloomStart) / bloomLen) : 0;
    };

    const hz = tRel => {
      const k = seg(tRel);
      const local = tRel - segStart[k];
      const target = targets[k];
      const from = k === 0 ? entryHz : targets[k - 1];
      const tau = k === 0 ? (legato ? 0.035 : 0.025) : 0.04;   // melisma glides are a hair slower
      let f = style.human ? target + (from - target) * Math.exp(-local / tau) : target;
      const wob = 5 * (j1 * Math.sin(2 * Math.PI * jf1 * tRel) + j2 * Math.sin(2 * Math.PI * jf2 * tRel)) / 2;
      let cents = vibDepth * vibEnv(tRel) * Math.sin(2 * Math.PI * vibRate * tRel + vibPhase) + wob;
      if (style.human && isEnd && total - tRel < 0.09)
        cents -= 45 * (1 - Math.max(0, total - tRel) / 0.09);
      return f * Math.pow(CENT, cents);
    };

    const gain = tRel => {
      const k = seg(tRel);
      const local = tRel - segStart[k];
      const a = Math.min(1, tRel / 0.035);
      let g = 1;
      if (total > 0.5) g = 0.86 + 0.14 * Math.exp(-(tRel / (total * 0.7)));
      // articulation dip when the vowel steps to the next melisma note
      if (k > 0 && local < 0.05) g *= 0.72 + 0.28 * (local / 0.05);
      // loudness vibrato coupled to pitch vibrato (real voices do both)
      g *= 1 + 0.10 * vib * style.vibScale * vibEnv(tRel) * Math.sin(2 * Math.PI * vibRate * tRel + vibPhase);
      // melodic height + phrase arc dynamics
      const hDb = Math.max(-2.5, Math.min(2.5, (chain[k].midi - midiMean) * 0.35));
      g *= Math.pow(10, (hDb + arcDb) / 20);
      const tail = total - tRel;
      const rel = isEnd ? 0.07 : 0.03;
      const r = tail < rel ? Math.max(0, tail / rel) : 1;
      return a * g * (0.25 + 0.75 * r);
    };

    return { hz, gain, total, startSec: chain[0].startSec };
  });
}

// ---------------- PSOLA render of one nucleus ----------------
// formantScale (beta) resamples grain contents: >1 shifts the spectral
// envelope up (brighter/smaller head), <1 down (darker/bigger), while the
// epoch spacing keeps the fundamental on the melody.
function renderNucleus(voc, wsum, input, sr, epochs, s0, s1, outStart, outLen, contour, rand, beta, detuneCents) {
  if (!epochs.length || outLen <= 0) return;
  const inLen = s1 - s0;
  const det = Math.pow(CENT, detuneCents || 0);

  const edgeIn = Math.min(Math.round(0.06 * sr), Math.floor(inLen * 0.3));
  const susIn = inLen - 2 * edgeIn;
  const susOut = outLen - 2 * edgeIn;
  const mapPos = oj => {
    if (susIn <= 0 || susOut <= 0) return s0 + oj * inLen / outLen;
    if (oj < edgeIn) return s0 + oj;
    if (oj >= outLen - edgeIn) return s1 - (outLen - oj);
    const u = (oj - edgeIn) / susOut;
    return s0 + edgeIn + u * susIn;
  };

  let oj = 0, k = 0;
  while (oj < outLen) {
    const tRel = oj / sr;
    const hz = contour.hz(tRel) * det;
    const Tout = sr / Math.max(60, Math.min(600, hz));
    const mapped = mapPos(oj) + (rand() - 0.5) * 0.6 * Tout;
    while (k + 1 < epochs.length && Math.abs(epochs[k + 1] - mapped) < Math.abs(epochs[k] - mapped)) k++;
    while (k > 0 && Math.abs(epochs[k - 1] - mapped) < Math.abs(epochs[k] - mapped)) k--;
    const ek = epochs[k];
    const Tin = k + 1 < epochs.length ? epochs[k + 1] - ek
              : k > 0 ? ek - epochs[k - 1] : Math.round(Tout);
    const half = Math.max(16, Math.min(Math.round(Tin / beta), Math.round(2.2 * Tout), 1200));
    const g = contour.gain(tRel);
    const center = outStart + Math.round(oj);
    for (let i = -half; i < half; i++) {
      const oi = center + i;
      if (oi < 0 || oi >= voc.length) continue;
      const fpos = ek + i * beta;
      const p0 = Math.floor(fpos);
      if (p0 < 0 || p0 + 1 >= input.length) continue;
      const fr = fpos - p0;
      const s = input[p0] * (1 - fr) + input[p0 + 1] * fr;
      const w = 0.5 + 0.5 * Math.cos(Math.PI * i / half);
      voc[oi] += s * w * g;
      wsum[oi] += w;
    }
    oj += Tout;
  }
}

// ---------------- consonant splicing ----------------
function spliceSpan(cons, input, from, to, outAt, fadeSamples) {
  const len = to - from;
  if (len <= 0) return;
  const F = Math.min(fadeSamples, Math.floor(len / 2));
  for (let i = 0; i < len; i++) {
    const oi = outAt + i;
    if (oi < 0 || oi >= cons.length) continue;
    let w = 1;
    if (i < F) w = 0.5 - 0.5 * Math.cos(Math.PI * i / F);
    else if (i >= len - F) w = 0.5 - 0.5 * Math.cos(Math.PI * (len - i) / F);
    cons[oi] += input[from + i] * w;
  }
}

// ---------------- offline polish ----------------
function biquad(x, sr, type, f0, dbGain, Q) {
  const A = Math.pow(10, dbGain / 40);
  const w0 = 2 * Math.PI * f0 / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highpass') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'peaking') {
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else if (type === 'highshelf') {
    const beta = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + beta);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - beta);
    a0 = (A + 1) - (A - 1) * cw + beta;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - beta;
  } else return;
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    x[i] = yi;
  }
}

function deess(x, sr) {
  const H = Math.round(sr * 0.01);
  const nF = Math.floor(x.length / H);
  if (nF < 4) return;
  const hf = new Float32Array(x.length);
  const k = Math.exp(-2 * Math.PI * 5000 / sr);
  let lp = 0;
  for (let i = 0; i < x.length; i++) { lp = lp + (1 - k) * (x[i] - lp); hf[i] = x[i] - lp; }
  const ratio = new Float32Array(nF), level = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    let eh = 0, et = 0;
    for (let i = f * H; i < (f + 1) * H && i < x.length; i++) { eh += hf[i] * hf[i]; et += x[i] * x[i]; }
    ratio[f] = et > 1e-9 ? eh / et : 0;
    level[f] = Math.sqrt(et / H);
  }
  const lv = Array.from(level).filter(v => v > 1e-4).sort((a, b) => a - b);
  const ref = lv.length ? lv[Math.floor(lv.length * 0.7)] : 0.05;
  let g = 1;
  for (let f = 0; f < nF; f++) {
    const sib = ratio[f] > 0.5 && level[f] > ref * 0.8;
    const gt = sib ? 0.55 : 1;
    for (let i = f * H; i < (f + 1) * H && i < x.length; i++) {
      g += (gt - g) * 0.003;
      x[i] *= g;
    }
  }
}

function softLimit(x, ceiling) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak < 1e-6) return;
  const gain = Math.min(3, (ceiling * 0.9) / peak * 1.25);
  const inv = 1 / Math.tanh(1.25);
  for (let i = 0; i < x.length; i++)
    x[i] = Math.tanh(x[i] * gain / ceiling * 1.25) * ceiling * inv;
}

// pitch-following aspiration: high-passed noise that rides the vocal envelope
function breathLayer(voc, sr, level, rand) {
  if (level <= 0) return null;
  const br = new Float32Array(voc.length);
  const kEnv = Math.exp(-1 / (sr * 0.008));
  let env = 0;
  for (let i = 0; i < voc.length; i++) {
    const a = Math.abs(voc[i]);
    env = a > env ? a : env * kEnv;
    br[i] = (rand() * 2 - 1) * env;
  }
  biquad(br, sr, 'highpass', 2600, 0, 0.71);
  for (let i = 0; i < br.length; i++) br[i] *= level;
  return br;
}

// ---------------- top level ----------------
function render(input, sr, notes, opts = {}) {
  const { tempo = 90, vibrato = 1, seed = 20260706 } = opts;
  const style = STYLES[opts.style] || STYLES.lead;
  const an = analyze(input, sr);
  if (!an.medF) return { out: input.slice(), info: { voiced: false } };

  const nuclei = findNuclei(an);
  if (!nuclei.length) return { out: input.slice(), info: { voiced: false } };

  const { slots, shift } = buildSlots(notes, tempo, an.medF, style.octave);
  if (!slots.length) return { out: input.slice(), info: { voiced: false } };

  const chains = buildChains(slots, nuclei, tempo);
  const used = Math.min(nuclei.length, chains.length);
  const rand = mulberry32(seed);
  const contours = makeContours(chains.slice(0, used), shift, vibrato, style, rand);

  const lastChain = chains[used - 1];
  const lastSlot = lastChain[lastChain.length - 1];
  const outN = Math.ceil((lastSlot.startSec + lastSlot.durSec + 0.8) * sr);
  const cons = new Float32Array(outN);
  const AH = an.AH;
  const fade = Math.round(sr * 0.004);

  // pre-compute per-nucleus geometry + epochs (shared by all takes)
  const parts = [];
  for (let i = 0; i < used; i++) {
    const [fa, fb] = nuclei[i];
    const s0 = fa * AH, s1 = Math.min(input.length, fb * AH);
    const outStart = Math.round(contours[i].startSec * sr);
    const outLen = Math.round(contours[i].total * sr * 0.94);
    parts.push({ s0, s1, outStart, outLen, epochs: markEpochs(input, s0, s1, an.f0At, sr) });

    const prevEnd = i > 0 ? nuclei[i - 1][1] * AH : 0;
    const gapStart = Math.max(prevEnd + Math.floor((s0 - prevEnd) / 2), s0 - Math.floor(0.3 * sr));
    if (s0 > gapStart) spliceSpan(cons, input, gapStart, s0, outStart - (s0 - gapStart), fade);
    const nextStart = i + 1 < nuclei.length ? nuclei[i + 1][0] * AH : input.length;
    const codaEnd = Math.min(s1 + Math.floor((nextStart - s1) / 2), s1 + Math.floor(0.25 * sr));
    if (codaEnd > s1) spliceSpan(cons, input, s1, codaEnd, outStart + outLen, fade);
  }

  // one take = a full voiced render; the lead plus (style.doubles) detuned,
  // time-offset, formant-varied doubles, spread across the stereo field
  const renderTake = (detune, offsetMs, betaMul, takeSeed) => {
    const voc = new Float32Array(outN);
    const wsum = new Float32Array(outN);
    const r = mulberry32(takeSeed);
    const off = Math.round(offsetMs * sr / 1000);
    for (let i = 0; i < used; i++) {
      const p = parts[i];
      renderNucleus(voc, wsum, input, sr, p.epochs, p.s0, p.s1, p.outStart + off, p.outLen, contours[i], r, style.formant * betaMul, detune);
    }
    for (let i = 0; i < outN; i++) voc[i] = wsum[i] > 0.05 ? voc[i] / wsum[i] : voc[i];
    return voc;
  };

  const lead = renderTake(0, 0, 1, seed ^ 0x5f3759df);
  const takes = [];
  for (let d = 0; d < style.doubles; d++) {
    const sgn = d % 2 === 0 ? 1 : -1;
    takes.push({
      buf: renderTake(sgn * style.detune * (1 + d * 0.3), sgn * (8 + d * 6) * (style.spread / 12), 1 + sgn * 0.025 * (1 + d * 0.4), seed + 101 * (d + 1)),
      pan: sgn * Math.min(1, style.spread / 30) * (0.5 + d * 0.2),
    });
  }

  const br = breathLayer(lead, sr, style.breath, mulberry32(seed ^ 0xbeef));

  // mix stereo: lead + breath center, doubles panned equal-power
  const L = new Float32Array(outN), R = new Float32Array(outN);
  const dblGain = style.doubles ? (style.doubles > 2 ? 0.34 : 0.42) : 0;
  for (let i = 0; i < outN; i++) {
    const c = lead[i] + (br ? br[i] : 0) + cons[i] * 0.9;
    L[i] = c * 0.72; R[i] = c * 0.72;
  }
  for (const t of takes) {
    const gL = Math.cos((t.pan + 1) * Math.PI / 4) * dblGain;
    const gR = Math.sin((t.pan + 1) * Math.PI / 4) * dblGain;
    for (let i = 0; i < outN; i++) { L[i] += t.buf[i] * gL; R[i] += t.buf[i] * gR; }
  }

  let pIn = 0;
  for (let i = 0; i < input.length; i++) pIn = Math.max(pIn, Math.abs(input[i]));
  const ceil = Math.min(0.95, Math.max(0.4, pIn * 1.15));
  for (const ch of [L, R]) {
    biquad(ch, sr, 'highpass', 75, 0, 0.71);
    biquad(ch, sr, 'peaking', 3000, 2.5, 0.9);
    biquad(ch, sr, 'highshelf', 8000, 1.5, 0.71);
    deess(ch, sr);
    softLimit(ch, ceil);
  }
  const out = new Float32Array(outN);
  for (let i = 0; i < outN; i++) out[i] = (L[i] + R[i]) / 2;

  return { out, stereo: [L, R], info: { voiced: true, shift, chains: chains.slice(0, used), nuclei: nuclei.slice(0, used), medF: an.medF, style: opts.style || 'lead' } };
}

function melodize(input, sr, notes, opts) {
  return render(input, sr, notes, opts).out;
}

const MuseVocal = { melodize, render, analyze, yinFrame, decimate4, markEpochs, findNuclei, buildSlots, buildChains, biquad, deess, softLimit, nameToMidi, STYLES };

if (typeof window !== 'undefined') window.MuseVocal = MuseVocal;
if (typeof module !== 'undefined' && module.exports) module.exports = MuseVocal;
})();
