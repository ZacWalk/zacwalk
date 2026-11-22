/* turbo-sid's music player for the web. It runs the same 6502 player and music data as a
   Commodore 64 (as made by tools/mid2sid.py) on a small 6502 emulator, and turns the SID
   registers the player writes into sound with a model of the SID chip: oscillators with
   band-limited edges, the noise generator, the ADSR envelope with its rate counters, and the
   resonant filter. A tune sounds as it does on a C64 and in turbo-sid's WAV previews.

   Plain JavaScript that touches no DOM, so it runs in an AudioWorklet and in Node:

     const player = new SidPlayer(MUSIC, sampleRate);  // MUSIC: a module made by mid2sid.py
     player.start(0);              // a tune, by number
     player.render(left, right);   // fills two buffers, calling the player once a frame
     player.effect(0);             // a sound effect, on the tune's effect voice
     player.stop();                // the music stops and its notes ring out; effects go on

   Decimal mode is not modelled: the player never uses it. */

const CLOCK = 985248; // PAL C64 cycles a second
const RETURN = 0xfff0; // where an emulated call returns to
const RATE_PERIODS = Int32Array.of(9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251);
const ATTACK = 0;
const DECAY = 1;
const RELEASE = 2;

// ---------- the 6502 ----------

const MODES = ['imp', 'imm', 'zp', 'zpx', 'zpy', 'abs', 'abx', 'aby', 'ind', 'izx', 'izy', 'rel', 'acc'];
const SIZES = [1, 2, 2, 2, 2, 3, 3, 3, 3, 2, 2, 2, 1];
const ACC = 12;

/* Every documented 6502 instruction: its opcodes, each with its addressing mode. */
const OPCODES = `
ADC 69 imm 65 zp 75 zpx 6D abs 7D abx 79 aby 61 izx 71 izy
AND 29 imm 25 zp 35 zpx 2D abs 3D abx 39 aby 21 izx 31 izy
ASL 0A acc 06 zp 16 zpx 0E abs 1E abx
BCC 90 rel
BCS B0 rel
BEQ F0 rel
BIT 24 zp 2C abs
BMI 30 rel
BNE D0 rel
BPL 10 rel
BRK 00 imp
BVC 50 rel
BVS 70 rel
CLC 18 imp
CLD D8 imp
CLI 58 imp
CLV B8 imp
CMP C9 imm C5 zp D5 zpx CD abs DD abx D9 aby C1 izx D1 izy
CPX E0 imm E4 zp EC abs
CPY C0 imm C4 zp CC abs
DEC C6 zp D6 zpx CE abs DE abx
DEX CA imp
DEY 88 imp
EOR 49 imm 45 zp 55 zpx 4D abs 5D abx 59 aby 41 izx 51 izy
INC E6 zp F6 zpx EE abs FE abx
INX E8 imp
INY C8 imp
JMP 4C abs 6C ind
JSR 20 abs
LDA A9 imm A5 zp B5 zpx AD abs BD abx B9 aby A1 izx B1 izy
LDX A2 imm A6 zp B6 zpy AE abs BE aby
LDY A0 imm A4 zp B4 zpx AC abs BC abx
LSR 4A acc 46 zp 56 zpx 4E abs 5E abx
NOP EA imp
ORA 09 imm 05 zp 15 zpx 0D abs 1D abx 19 aby 01 izx 11 izy
PHA 48 imp
PHP 08 imp
PLA 68 imp
PLP 28 imp
ROL 2A acc 26 zp 36 zpx 2E abs 3E abx
ROR 6A acc 66 zp 76 zpx 6E abs 7E abx
RTI 40 imp
RTS 60 imp
SBC E9 imm E5 zp F5 zpx ED abs FD abx F9 aby E1 izx F1 izy
SEC 38 imp
SED F8 imp
SEI 78 imp
STA 85 zp 95 zpx 8D abs 9D abx 99 aby 81 izx 91 izy
STX 86 zp 96 zpy 8E abs
STY 84 zp 94 zpx 8C abs
TAX AA imp
TAY A8 imp
TSX BA imp
TXA 8A imp
TXS 9A imp
TYA 98 imp`;

const NAME = new Array(256).fill(null);
const MODE = new Uint8Array(256);
for (const line of OPCODES.trim().split('\n')) {
  const [name, ...rest] = line.trim().split(/\s+/);
  for (let i = 0; i < rest.length; i += 2) {
    const op = parseInt(rest[i], 16);
    NAME[op] = name;
    MODE[op] = MODES.indexOf(rest[i + 1]);
  }
}

class Cpu {
  /* `memory` is 64K; `write(address, value)` stores every byte the program writes. */
  constructor(memory, write) {
    this.m = memory;
    this.write = write;
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xff;
    this.pc = 0;
    this.n = this.v = this.z = this.c = this.d = this.i = false;
  }

  /* Runs the routine at `address`, with A = `a`, to its RTS. */
  call(address, a = 0) {
    this.a = a & 0xff;
    this.push(((RETURN - 1) >> 8) & 0xff);
    this.push((RETURN - 1) & 0xff);
    this.pc = address;
    for (let steps = 0; this.pc !== RETURN; steps++) {
      if (steps > 1e6) throw new Error(`the 6502 routine at $${address.toString(16)} ran away`);
      this.step();
    }
  }

  push(value) {
    this.m[0x100 | this.sp] = value;
    this.sp = (this.sp - 1) & 0xff;
  }

  pull() {
    this.sp = (this.sp + 1) & 0xff;
    return this.m[0x100 | this.sp];
  }

  nz(value) {
    this.n = value >= 0x80;
    this.z = value === 0;
    return value;
  }

  status() {
    return (this.n << 7) | (this.v << 6) | 0x20 | (this.d << 3) | (this.i << 2) | (this.z << 1) | +this.c;
  }

  setStatus(p) {
    this.n = (p & 0x80) !== 0;
    this.v = (p & 0x40) !== 0;
    this.d = (p & 0x08) !== 0;
    this.i = (p & 0x04) !== 0;
    this.z = (p & 0x02) !== 0;
    this.c = (p & 0x01) !== 0;
  }

  adc(value) {
    const r = this.a + value + +this.c;
    this.v = (~(this.a ^ value) & (this.a ^ r) & 0x80) !== 0;
    this.c = r > 0xff;
    this.a = this.nz(r & 0xff);
  }

  compare(register, value) {
    this.c = register >= value;
    this.nz((register - value) & 0xff);
  }

  step() {
    const m = this.m;
    const op = m[this.pc];
    const name = NAME[op];
    if (!name || name === 'BRK') throw new Error(`no instruction $${op.toString(16)} at $${this.pc.toString(16)}`);
    const mode = MODE[op];
    const lo = m[(this.pc + 1) & 0xffff];
    const hi = m[(this.pc + 2) & 0xffff];
    let ea = 0;
    switch (mode) {
      case 1: ea = (this.pc + 1) & 0xffff; break;
      case 2: ea = lo; break;
      case 3: ea = (lo + this.x) & 0xff; break;
      case 4: ea = (lo + this.y) & 0xff; break;
      case 5: ea = lo | (hi << 8); break;
      case 6: ea = ((lo | (hi << 8)) + this.x) & 0xffff; break;
      case 7: ea = ((lo | (hi << 8)) + this.y) & 0xffff; break;
      case 8: {
        const p = lo | (hi << 8); // the 6502 reads the high byte from the same page
        ea = m[p] | (m[(p & 0xff00) | ((p + 1) & 0xff)] << 8);
        break;
      }
      case 9: {
        const p = (lo + this.x) & 0xff;
        ea = m[p] | (m[(p + 1) & 0xff] << 8);
        break;
      }
      case 10: ea = ((m[lo] | (m[(lo + 1) & 0xff] << 8)) + this.y) & 0xffff; break;
      case 11: ea = (this.pc + 2 + ((lo << 24) >> 24)) & 0xffff; break;
    }
    this.pc = (this.pc + SIZES[mode]) & 0xffff;
    switch (name) {
      case 'LDA': this.a = this.nz(m[ea]); break;
      case 'LDX': this.x = this.nz(m[ea]); break;
      case 'LDY': this.y = this.nz(m[ea]); break;
      case 'STA': this.write(ea, this.a); break;
      case 'STX': this.write(ea, this.x); break;
      case 'STY': this.write(ea, this.y); break;
      case 'ADC': this.adc(m[ea]); break;
      case 'SBC': this.adc(m[ea] ^ 0xff); break;
      case 'AND': this.a = this.nz(this.a & m[ea]); break;
      case 'ORA': this.a = this.nz(this.a | m[ea]); break;
      case 'EOR': this.a = this.nz(this.a ^ m[ea]); break;
      case 'CMP': this.compare(this.a, m[ea]); break;
      case 'CPX': this.compare(this.x, m[ea]); break;
      case 'CPY': this.compare(this.y, m[ea]); break;
      case 'BIT': {
        const v = m[ea];
        this.z = (this.a & v) === 0;
        this.n = (v & 0x80) !== 0;
        this.v = (v & 0x40) !== 0;
        break;
      }
      case 'ASL':
      case 'LSR':
      case 'ROL':
      case 'ROR': {
        const v = mode === ACC ? this.a : m[ea];
        let r;
        if (name === 'ASL') r = (v << 1) & 0xff;
        else if (name === 'LSR') r = v >> 1;
        else if (name === 'ROL') r = ((v << 1) | +this.c) & 0xff;
        else r = (v >> 1) | (this.c ? 0x80 : 0);
        this.c = name === 'ASL' || name === 'ROL' ? v >= 0x80 : (v & 1) !== 0;
        this.nz(r);
        if (mode === ACC) this.a = r;
        else this.write(ea, r);
        break;
      }
      case 'INC': this.write(ea, this.nz((m[ea] + 1) & 0xff)); break;
      case 'DEC': this.write(ea, this.nz((m[ea] - 1) & 0xff)); break;
      case 'INX': this.x = this.nz((this.x + 1) & 0xff); break;
      case 'INY': this.y = this.nz((this.y + 1) & 0xff); break;
      case 'DEX': this.x = this.nz((this.x - 1) & 0xff); break;
      case 'DEY': this.y = this.nz((this.y - 1) & 0xff); break;
      case 'TAX': this.x = this.nz(this.a); break;
      case 'TAY': this.y = this.nz(this.a); break;
      case 'TXA': this.a = this.nz(this.x); break;
      case 'TYA': this.a = this.nz(this.y); break;
      case 'TSX': this.x = this.nz(this.sp); break;
      case 'TXS': this.sp = this.x; break;
      case 'PHA': this.push(this.a); break;
      case 'PLA': this.a = this.nz(this.pull()); break;
      case 'PHP': this.push(this.status() | 0x10); break;
      case 'PLP': this.setStatus(this.pull()); break;
      case 'BCC': if (!this.c) this.pc = ea; break;
      case 'BCS': if (this.c) this.pc = ea; break;
      case 'BEQ': if (this.z) this.pc = ea; break;
      case 'BNE': if (!this.z) this.pc = ea; break;
      case 'BMI': if (this.n) this.pc = ea; break;
      case 'BPL': if (!this.n) this.pc = ea; break;
      case 'BVC': if (!this.v) this.pc = ea; break;
      case 'BVS': if (this.v) this.pc = ea; break;
      case 'JMP': this.pc = ea; break;
      case 'JSR': {
        const back = (this.pc - 1) & 0xffff;
        this.push(back >> 8);
        this.push(back & 0xff);
        this.pc = ea;
        break;
      }
      case 'RTS': {
        const l = this.pull();
        this.pc = (((this.pull() << 8) | l) + 1) & 0xffff;
        break;
      }
      case 'RTI': {
        this.setStatus(this.pull());
        const l = this.pull();
        this.pc = (this.pull() << 8) | l;
        break;
      }
      case 'CLC': this.c = false; break;
      case 'SEC': this.c = true; break;
      case 'CLD': this.d = false; break;
      case 'SED': this.d = true; break;
      case 'CLI': this.i = false; break;
      case 'SEI': this.i = true; break;
      case 'CLV': this.v = false; break;
      case 'NOP': break;
    }
  }
}

// ---------- the SID ----------

/* The corner of a saw or pulse edge, rounded off (PolyBLEP) so high notes do not alias. */
function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

/* The bits of the noise shift register the SID puts out, as a 12-bit value. */
const noiseOut = (s) =>
  ((s & 0x400000) >> 11) |
  ((s & 0x100000) >> 10) |
  ((s & 0x010000) >> 7) |
  ((s & 0x002000) >> 5) |
  ((s & 0x000800) >> 4) |
  ((s & 0x000080) >> 1) |
  ((s & 0x000010) << 1) |
  ((s & 0x000004) << 2);

class Sid {
  /* `pans` places each voice from -1 (left) to 1 (right). Each voice gets its own copy of the
     filter, with the same settings: the filter is linear, so the voices together sound as
     through the one filter, and they can still be panned apart. */
  constructor(sampleRate, pans) {
    this.rate = sampleRate;
    this.cps = CLOCK / sampleRate;
    this.pos = 0;
    this.regs = new Uint8Array(32);
    this.acc = new Int32Array(3);
    this.lfsr = new Int32Array(3).fill(0x7ffff8);
    this.env = new Int32Array(3);
    this.state = new Int32Array(3).fill(RELEASE);
    this.rc = new Int32Array(3);
    this.expc = new Int32Array(3);
    this.hold = [true, true, true];
    this.gate = new Int32Array(3);
    this.period = new Int32Array(3).fill(9);
    this.decay = new Int32Array(3).fill(9);
    this.freq = new Int32Array(3);
    this.pw = new Float64Array(3);
    this.ctrl = new Int32Array(3);
    this.sus = new Int32Array(3);
    this.rise = [false, false, false];
    this.ic1 = new Float64Array(3);
    this.ic2 = new Float64Array(3);
    this.panL = pans.map((p) => Math.cos(((p + 1) * Math.PI) / 4));
    this.panR = pans.map((p) => Math.sin(((p + 1) * Math.PI) / 4));
    this.hpR = 1 - (2 * Math.PI * 16) / sampleRate;
    this.lpA = 1 - Math.exp((-2 * Math.PI * 12000) / sampleRate);
    this.dc = new Float64Array(4); // per channel: last input, last output
    this.lp = new Float64Array(2);
    this.latch();
  }

  /* Takes the registers as the player left them at the end of a frame. */
  latch() {
    const r = this.regs;
    let quiet = true;
    for (let v = 0; v < 3; v++) {
      const b = v * 7;
      this.freq[v] = r[b] | (r[b + 1] << 8);
      this.pw[v] = (r[b + 2] | ((r[b + 3] & 15) << 8)) / 4096;
      const ctrl = r[b + 4];
      this.ctrl[v] = ctrl;
      const ad = r[b + 5];
      const sr = r[b + 6];
      this.sus[v] = (sr >> 4) * 0x11;
      const g = ctrl & 1;
      if (g && !this.gate[v]) {
        this.state[v] = ATTACK;
        this.hold[v] = false;
      } else if (!g && this.gate[v]) this.state[v] = RELEASE;
      this.gate[v] = g;
      this.decay[v] = RATE_PERIODS[ad & 15];
      this.period[v] = RATE_PERIODS[this.state[v] === ATTACK ? ad >> 4 : this.state[v] === DECAY ? ad & 15 : sr & 15];
      if (ctrl & 8) {
        this.acc[v] = 0;
        this.lfsr[v] = 0x7ffff8;
      }
      if (g || this.env[v]) quiet = false;
    }
    const cutoff = (r[0x15] & 7) | (r[0x16] << 3);
    const fc = Math.min(30 + cutoff * 5.8, this.rate * 0.45);
    const q = 0.707 + (1.6 * (r[0x17] >> 4)) / 15;
    const g = Math.tan((Math.PI * fc) / this.rate);
    const k = 1 / q;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
    this.k = k;
    this.route = r[0x17] & 7;
    this.mode = r[0x18] & 0x70;
    this.gain = (r[0x18] & 15) / 15 / 3;
    this.voice3off = (r[0x18] & 0x80) !== 0;
    this.quiet = quiet;
  }

  /* One voice's envelope over `cycles` cycles: the SID's rate counter and its exponential
     decay, step for step. */
  envelope(v, cycles) {
    let remaining = cycles;
    while (remaining > 0) {
      const p = this.period[v];
      const rc = this.rc[v];
      const need = rc < p ? p - rc : 0x8000 - rc + p;
      if (need > remaining) {
        this.rc[v] = (rc + remaining) & 0x7fff;
        return;
      }
      remaining -= need;
      this.rc[v] = 0;
      let e = this.env[v];
      if (this.state[v] === ATTACK) {
        this.expc[v] = 0;
        if (!this.hold[v]) {
          e = (e + 1) & 0xff;
          if (e === 0xff) {
            this.state[v] = DECAY;
            this.period[v] = this.decay[v];
          }
        }
      } else {
        const ep = e > 0x5d ? 1 : e > 0x36 ? 2 : e > 0x1a ? 4 : e > 0x06 ? 8 : e > 0 ? 16 : 1;
        if (++this.expc[v] >= ep) {
          this.expc[v] = 0;
          if (!this.hold[v] && e > 0 && (this.state[v] === RELEASE || e !== this.sus[v])) e--;
        }
      }
      if (e === 0) this.hold[v] = true;
      this.env[v] = e;
    }
  }

  /* Fills left and right from `from` to `to` with the voices under the latched registers. */
  render(left, right, from, to) {
    if (this.quiet) {
      left.fill(0, from, to);
      right.fill(0, from, to);
      this.ic1.fill(0);
      this.ic2.fill(0);
      this.dc.fill(0);
      this.lp.fill(0);
      return;
    }
    const { acc, lfsr, ctrl, freq, ic1, ic2, dc, lp } = this;
    for (let i = from; i < to; i++) {
      const c0 = Math.floor(this.pos);
      this.pos += this.cps;
      const cycles = Math.floor(this.pos) - c0;
      for (let v = 0; v < 3; v++) {
        if (ctrl[v] & 8) {
          this.rise[v] = false;
          continue;
        }
        const old = acc[v];
        const now = old + freq[v] * cycles;
        let shifts = ((now - 0x80000) >> 20) - ((old - 0x80000) >> 20);
        for (shifts = Math.min(shifts, 16); shifts > 0; shifts--) {
          const s = lfsr[v];
          lfsr[v] = ((s << 1) & 0x7fffff) | (((s >> 22) ^ (s >> 17)) & 1);
        }
        this.rise[v] = (((old >> 23) & 1) === 0 && ((now >> 23) & 1) === 1) || now >> 24 > old >> 24;
        acc[v] = now & 0xffffff;
      }
      for (let v = 0; v < 3; v++) {
        if (ctrl[v] & 2 && this.rise[(v + 2) % 3]) acc[v] = 0; // hard sync
      }
      let L = 0;
      let R = 0;
      for (let v = 0; v < 3; v++) {
        this.envelope(v, cycles);
        const env = this.env[v];
        const c = ctrl[v];
        const w = c >> 4;
        const a = acc[v];
        let out = 0;
        if (env === 0 || w === 0) {
          // silent, but a filter keeps ringing
        } else if (w === 4 && !(c & 8)) {
          const t = a / 16777216;
          const dt = Math.min(0.5, (freq[v] * cycles) / 16777216);
          const p = this.pw[v];
          out = (t >= p ? 1 : -1) - blep(t, dt) + blep((t - p + 1) % 1, dt);
        } else if (w === 2) {
          const t = a / 16777216;
          out = 2 * t - 1 - blep(t, (freq[v] * cycles) / 16777216);
        } else {
          // triangle, noise, and waveforms together, as the SID ANDs them
          const src = acc[(v + 2) % 3];
          let o = 0xfff;
          if (w & 1) {
            let t = (a >> 11) & 0xfff;
            if (((a >> 23) ^ (c & 4 ? src >> 23 : 0)) & 1) t ^= 0xfff;
            o &= t;
          }
          if (w & 2) o &= a >> 12;
          if (w & 4 && !(c & 8) && a >> 12 < this.pw[v] * 4096) o = 0;
          if (w & 8) o &= noiseOut(lfsr[v]);
          out = (o - 0x800) / 2048;
        }
        let y = (out * env) / 255;
        if ((this.route >> v) & 1) {
          const v3 = y - ic2[v];
          const v1 = this.a1 * ic1[v] + this.a2 * v3;
          const v2 = ic2[v] + this.a2 * ic1[v] + this.a3 * v3;
          ic1[v] = 2 * v1 - ic1[v];
          ic2[v] = 2 * v2 - ic2[v];
          let f = 0;
          if (this.mode & 0x10) f += v2;
          if (this.mode & 0x20) f += v1;
          if (this.mode & 0x40) f += y - this.k * v1 - v2;
          y = f;
        } else if (v === 2 && this.voice3off) continue;
        L += y * this.panL[v];
        R += y * this.panR[v];
      }
      // the output stage: no DC, and the gentle top-end roll-off of the real chip's output
      L *= this.gain;
      R *= this.gain;
      const hl = L - dc[0] + this.hpR * dc[1];
      dc[0] = L;
      dc[1] = hl;
      const hr = R - dc[2] + this.hpR * dc[3];
      dc[2] = R;
      dc[3] = hr;
      lp[0] += this.lpA * (hl - lp[0]);
      lp[1] += this.lpA * (hr - lp[1]);
      left[i] = lp[0];
      right[i] = lp[1];
    }
  }
}

// ---------- the player ----------

/* Base64, by hand: an AudioWorklet has no atob. */
function decode(text) {
  const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let value = 0;
  let bits = 0;
  let n = 0;
  for (const ch of clean) {
    value = ((value << 6) | digits.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

export class SidPlayer {
  /* `music` is a module made by mid2sid.py: the player and its data, where they load, the
     entry points, and each tune's title and frame length. */
  constructor(music, sampleRate, { pans = [0, 0.35, -0.2] } = {}) {
    this.music = music;
    this.rate = sampleRate;
    this.memory = new Uint8Array(65536);
    this.memory.set(decode(music.binary), music.org);
    this.sid = new Sid(sampleRate, pans);
    const regs = this.sid.regs;
    this.cpu = new Cpu(this.memory, (address, value) => {
      this.memory[address] = value;
      if (address >>> 5 === 0xd400 >>> 5) regs[address & 31] = value;
    });
    this.tune = -1;
    this.perFrame = sampleRate / 50;
    this.untilFrame = 0;
  }

  /* Starts tune `tune` from its beginning. */
  start(tune) {
    this.cpu.call(this.music.init, tune);
    this.tune = tune;
    this.perFrame = (this.rate * this.music.tunes[tune].frameCycles) / CLOCK;
    this.untilFrame = 0;
  }

  /* Stops the music: its notes ring out; effects still play. */
  stop() {
    if (this.tune >= 0) this.cpu.call(this.music.stop);
  }

  /* Plays sound effect `n` on the tune's effect voice, unless a more important one plays. */
  effect(n) {
    if (this.tune >= 0) this.cpu.call(this.music.sfx, n);
  }

  /* One frame: the player's play routine, then the chip takes the registers it wrote. Returns
     the registers. */
  frame() {
    this.cpu.call(this.music.play);
    this.sid.latch();
    return this.sid.regs;
  }

  /* Fills two buffers of samples, running the player whenever a frame begins. */
  render(left, right) {
    if (this.tune < 0) {
      left.fill(0);
      right.fill(0);
      return;
    }
    for (let i = 0; i < left.length; ) {
      if (this.untilFrame <= 0) {
        this.frame();
        this.untilFrame += this.perFrame;
      }
      const n = Math.min(left.length - i, Math.ceil(this.untilFrame));
      this.sid.render(left, right, i, i + n);
      this.untilFrame -= n;
      i += n;
    }
  }
}
