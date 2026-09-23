import { mulberry32 } from '../core/noise';

/*
 * Weather: named presets blended smoothly. The current parameter set is the single source of truth for
 * sky/clouds, light, fog, wind, waves (physics included), rain, lightning and audio.
 */
export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'gale' | 'fog';

export interface WeatherParams {
  /** volumetric cloud layer: coverage 0..1, density scale, base/top altitude (m), type 0 cumulus … 1 storm tower */
  cloudCoverage: number;
  cloudDensity: number;
  cloudBase: number;
  cloudTop: number;
  cloudType: number;
  /** 0..1: how much the cloud deck dims and greys sun and sky */
  overcast: number;
  /** 0..1 rain intensity */
  rain: number;
  /** strikes per minute */
  lightning: number;
  /** mean wind, m/s */
  wind: number;
  gustiness: number;
  /** Gerstner amplitude multiplier (physics + rendering) */
  waves: number;
  /** FFT slope multiplier (visual chop) */
  chop: number;
  /** FogExp2 density */
  fog: number;
  /** 0..1 breaking crests */
  whitecaps: number;
}

export const WEATHER: Record<WeatherKind, WeatherParams> = {
  clear:  { cloudCoverage: 0.17, cloudDensity: 1.3, cloudBase: 950, cloudTop: 2300, cloudType: 0, overcast: 0.0,  rain: 0,    lightning: 0,   wind: 6.5, gustiness: 0.2,  waves: 1.0, chop: 1.0,  fog: 0.0011, whitecaps: 0 },
  cloudy: { cloudCoverage: 0.48, cloudDensity: 1.7, cloudBase: 800, cloudTop: 2700, cloudType: 0.2, overcast: 0.35, rain: 0,    lightning: 0,   wind: 8,   gustiness: 0.28, waves: 1.2, chop: 1.15, fog: 0.0016, whitecaps: 0.05 },
  rain:   { cloudCoverage: 0.8, cloudDensity: 1.6, cloudBase: 600, cloudTop: 3000, cloudType: 0.55, overcast: 0.65, rain: 0.6,  lightning: 0,   wind: 9,   gustiness: 0.3,  waves: 1.35, chop: 1.3, fog: 0.0034, whitecaps: 0.12 },
  storm:  { cloudCoverage: 0.9, cloudDensity: 1.5, cloudBase: 500, cloudTop: 6500, cloudType: 1.0, overcast: 0.93, rain: 1.0,  lightning: 7,   wind: 12,  gustiness: 0.45, waves: 1.8, chop: 1.55, fog: 0.0048, whitecaps: 0.4 },
  gale:   { cloudCoverage: 0.8, cloudDensity: 1.3, cloudBase: 500, cloudTop: 3200, cloudType: 0.5, overcast: 0.8, rain: 0.45, lightning: 1.5, wind: 16.5, gustiness: 0.4, waves: 2.6, chop: 1.9, fog: 0.0042, whitecaps: 0.85 },
  fog:    { cloudCoverage: 0.55, cloudDensity: 0.8, cloudBase: 350, cloudTop: 1500, cloudType: 0.7, overcast: 0.5,  rain: 0,    lightning: 0,   wind: 3,   gustiness: 0.1,  waves: 0.6, chop: 0.65, fog: 0.012, whitecaps: 0 },
};

export const WEATHER_NAMES: Record<WeatherKind, string> = {
  clear: 'pogodnie', cloudy: 'pochmurno', rain: 'deszcz', storm: 'burza', gale: 'sztorm', fog: 'mgła',
};

const ALIASES: Record<string, WeatherKind> = {
  clear: 'clear', pogodnie: 'clear', sun: 'clear', slonce: 'clear',
  cloudy: 'cloudy', pochmurno: 'cloudy', clouds: 'cloudy',
  rain: 'rain', deszcz: 'rain',
  storm: 'storm', burza: 'storm', thunder: 'storm',
  gale: 'gale', sztorm: 'gale',
  fog: 'fog', mgla: 'fog', 'mgła': 'fog', mist: 'fog',
};

export function parseWeather(s: string | null): WeatherKind | 'auto' | null {
  if (!s) return null;
  const k = s.toLowerCase();
  if (k === 'auto') return 'auto';
  return ALIASES[k] ?? null;
}

// which weather tends to follow which (auto mode)
const NEXT: Record<WeatherKind, WeatherKind[]> = {
  clear: ['clear', 'cloudy', 'cloudy', 'fog'],
  cloudy: ['clear', 'rain', 'rain', 'fog'],
  rain: ['cloudy', 'storm', 'storm'],
  storm: ['rain', 'gale'],
  gale: ['storm', 'rain'],
  fog: ['clear', 'cloudy'],
};

export interface Strike {
  /** bearing of the strike from the camera, radians (world atan2(x, z)) */
  angle: number;
  /** distance, m */
  distance: number;
  /** seconds since the flash */
  age: number;
}

export class Weather {
  kind: WeatherKind;
  auto: boolean;
  readonly p: WeatherParams;
  /** 0..1 current lightning flash brightness */
  flash = 0;
  /** latest strike, for the bolt visual and the thunder */
  strike: Strike | null = null;
  onStrike: ((s: Strike) => void) | null = null;

  private target: WeatherParams;
  private untilChange: number;
  private readonly rnd = mulberry32(99);
  private nextStrike = 5;
  private flashT = 10;

  constructor(kind: WeatherKind, auto: boolean) {
    this.kind = kind;
    this.auto = auto;
    this.p = { ...WEATHER[kind] };
    this.target = WEATHER[kind];
    this.untilChange = this.randomSpell();
  }

  private randomSpell(): number {
    return 80 + this.rnd() * 110; // real seconds a weather spell lasts in auto mode
  }

  set(kind: WeatherKind, lock = true): void {
    this.kind = kind;
    this.target = WEATHER[kind];
    if (lock) this.auto = false;
  }

  /** N key: step through the presets */
  cycle(): WeatherKind {
    const order: WeatherKind[] = ['clear', 'cloudy', 'rain', 'storm', 'gale', 'fog'];
    const k = order[(order.indexOf(this.kind) + 1) % order.length];
    this.set(k);
    return k;
  }

  update(dt: number): void {
    if (this.auto) {
      this.untilChange -= dt;
      if (this.untilChange <= 0) {
        const opts = NEXT[this.kind];
        this.set(opts[Math.floor(this.rnd() * opts.length)], false);
        this.untilChange = this.randomSpell();
      }
    }
    // ease every parameter toward the target preset (~20 s time constant)
    const k = 1 - Math.exp(-dt / 20);
    const p = this.p as unknown as Record<string, number>, t = this.target as unknown as Record<string, number>;
    for (const key in t) p[key] += (t[key] - p[key]) * k;

    // lightning: Poisson strikes, each a double flicker
    this.flashT += dt;
    if (this.p.lightning > 0.05) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.nextStrike = (-Math.log(1 - this.rnd()) * 60) / this.p.lightning;
        this.flashT = 0;
        this.strike = { angle: this.rnd() * Math.PI * 2, distance: 500 + this.rnd() * 5000, age: 0 };
        this.onStrike?.(this.strike);
      }
    }
    if (this.strike) this.strike.age += dt;
    const f = this.flashT;
    const near = this.strike ? Math.min(1, 1500 / this.strike.distance) : 0;
    this.flash = f < 0.6 ? near * (Math.exp(-f * 18) + 0.7 * Math.exp(-Math.max(0, f - 0.12) * 14) * (f > 0.12 ? 1 : 0)) : 0;
  }

  get name(): string {
    return WEATHER_NAMES[this.kind];
  }
}
