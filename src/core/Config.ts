// Central tunables + URL overrides. URL options (for debugging / screenshots):
//   ?debug            open the debug panel at start
//   ?t=5              freeze simulation time (deterministic screenshots)
//   ?view=caustics    start in a debug view (normals|caustics|reflection|depth|ripples|fft)
//   ?cam=x,y,z,tx,ty,tz  free camera looking from x,y,z at tx,ty,tz
//   ?q=0.8            initial render-resolution scale
//   ?sun=35,200       sun elevation, azimuth (degrees)
//   ?speed=4          start the boat moving (m/s), for wake checks
const Q = new URLSearchParams(location.search);

const num = (k: string): number | null => (Q.has(k) ? parseFloat(Q.get(k)!) : null);
const vec = (k: string): number[] | null => (Q.has(k) ? Q.get(k)!.split(',').map(Number) : null);

const sun = vec('sun');

export const Config = {
  debug: Q.has('debug'),
  fixedTime: num('t'),
  view: Q.get('view') ?? 'final',
  freeCam: vec('cam'),
  startSpeed: num('speed') ?? 3,
  initialQuality: num('q'),
  adaptiveQuality: !Q.has('t') && !Q.has('noadapt'),

  sunElevationDeg: sun?.[0] ?? 28,
  sunAzimuthDeg: sun?.[1] ?? 215,

  // Water ---------------------------------------------------------------
  fft: {
    N: 256,
    /** FFT patch size (m). Clearwater used 4.6 m for close-up puddle scale; we scale the whole spectrum up. */
    L: 20,
    /** RMS slope of the FFT layer (Clearwater: 0.078). */
    targetSlope: 0.105,
  },
  caustics: {
    grid: 256,
    size: 1024,
    /** caustics are computed from the FFT field re-tiled at this patch size (m)… */
    patch: 7.0,
    /** …focused for this water depth (m) */
    depth: 1.9,
  },
  ripples: {
    N: 512,
    /** simulated window (m), follows the boat */
    size: 128,
    /** wave speed in the local wake simulation (m/s) — sets the wake cone angle */
    speed: 1.5,
  },

  world: {
    size: 900,
  },
} as const;

export type ViewMode = 'final' | 'normals' | 'caustics' | 'reflection' | 'depth' | 'ripples' | 'fft';
export const VIEW_MODES: ViewMode[] = ['final', 'normals', 'caustics', 'reflection', 'depth', 'ripples', 'fft'];
