// dev: render one of AudioSystem's synthesised sounds offline, report it, and hand back a WAV
// (/tools/dev/sound.html?s=growl:rasp:3:1 — method:args…, numbers parsed; window.__wav = base64 WAV)
import { AudioSystem } from '../../src/audio/AudioSystem';
const Q = new URLSearchParams(location.search);
const [name, ...args] = (Q.get('s') ?? 'growl:roar:3:0').split(':');
const rate = 44100, secs = +(Q.get('len') ?? 3);
const ctx = new OfflineAudioContext(2, rate * secs, rate);
const noise = ctx.createBuffer(1, rate * 4, rate);
const d = noise.getChannelData(0);
for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
const a = Object.create(AudioSystem.prototype) as Record<string, unknown>;
Object.assign(a, { ctx, noise, muffle: ctx.destination });
(a[name] as (...x: unknown[]) => void)(...args.map((x) => (isNaN(+x) ? (x === 'true' ? true : x === 'false' ? false : x) : +x)));
const buf = await ctx.startRendering();
const L = buf.getChannelData(0), R = buf.getChannelData(1);
let peak = 0, sum = 0, last = 0;
for (let i = 0; i < L.length; i++) { const v = Math.max(Math.abs(L[i]), Math.abs(R[i])); peak = Math.max(peak, v); sum += v * v; if (v > 0.01) last = i; }
// WAV (16-bit stereo)
const n = L.length, wav = new DataView(new ArrayBuffer(44 + n * 4));
const str = (o: number, s2: string) => { for (let i = 0; i < s2.length; i++) wav.setUint8(o + i, s2.charCodeAt(i)); };
str(0, 'RIFF'); wav.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 2, true);
wav.setUint32(24, rate, true); wav.setUint32(28, rate * 4, true); wav.setUint16(32, 4, true); wav.setUint16(34, 16, true); str(36, 'data'); wav.setUint32(40, n * 4, true);
for (let i = 0; i < n; i++) { wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
let bin = ''; const bytes = new Uint8Array(wav.buffer); for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
(window as unknown as Record<string, unknown>).__wav = btoa(bin);
(window as unknown as Record<string, unknown>).__out = `peak ${peak.toFixed(3)} rms ${Math.sqrt(sum / L.length).toFixed(4)} audible until ${(last / rate).toFixed(2)} s`;
(window as unknown as Record<string, unknown>).__ready = true;
