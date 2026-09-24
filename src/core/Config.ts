// Central tunables + URL overrides. URL options (for debugging / screenshots):
//   ?debug            open the debug panel at start
//   ?t=5              freeze simulation time (deterministic screenshots)
//   ?view=caustics    start in a debug view (normals|caustics|reflection|depth|ripples|fft)
//   ?cam=x,y,z,tx,ty,tz  free camera looking from x,y,z at tx,ty,tz
//   ?q=0.8            initial render-resolution scale
//   ?time=19:40       time of day at start;  ?daylen=7  minutes per day (0 = frozen)
//   ?weather=storm    clear|fair|cloudy|rain|storm|gale|squall|fog (PL: bezchmurnie|pogodnie|pochmurno|deszcz|burza|sztorm|szkwal|mgla|auto)
//   ?moon=0.5         moon phase (0 new … 0.5 full);  ?pause  start with the clock stopped
//   ?sun=35,200       pin the sun: elevation, azimuth (degrees) — overrides the day cycle
//   ?speed=4          start the boat moving (m/s), for wake checks
//   ?seed=7           procedural world beyond the home lagoon (default 1337)
import { parseTime } from '../environment/GameTime';
import { parseWeather } from '../environment/Weather';

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
  /** ?seed=7 procedural ocean around the home lagoon */
  worldSeed: num('seed') ?? 1337,
  initialQuality: num('q'),
  adaptiveQuality: !Q.has('t') && !Q.has('noadapt'),

  /** ?sun=el,az pins the sun (debug); otherwise the day/night cycle drives it */
  sunOverride: sun ? { elevation: sun[0], azimuth: sun[1] } : null,
  /** ?time=18:30 start time of day */
  startTime: parseTime(Q.get('time')) ?? 10.5,
  /** ?daylen=7 minutes per game day (0 = clock stopped) */
  dayLengthSec: (num('daylen') ?? 7) * 60,
  /** ?weather=clear|fair|cloudy|rain|storm|gale|fog (or bezchmurnie|pogodnie|pochmurno|deszcz|burza|sztorm|mgla); fixed unless =auto */
  weather: parseWeather(Q.get('weather')),
  /** ?moon=0.5 moon phase at start (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter) */
  moonPhase: num('moon'),
  /** ?pause starts with the day clock stopped */
  paused: Q.has('pause'),

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

} as const;

export type ViewMode = 'final' | 'normals' | 'caustics' | 'reflection' | 'depth' | 'ripples' | 'fft';
export const VIEW_MODES: ViewMode[] = ['final', 'normals', 'caustics', 'reflection', 'depth', 'ripples', 'fft'];
