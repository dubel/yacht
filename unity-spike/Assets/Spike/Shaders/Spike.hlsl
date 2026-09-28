// Shared by the spike's shaders. Everything water-related is computed in three.js world coordinates
// (the game's own frame) so patterns, waves and spectra line up 1:1 with the web version:
//   Unity (x, y, z)  <->  three (x, y, -z)
#ifndef SPIKE_INCLUDED
#define SPIKE_INCLUDED

#define PI_F 3.14159265359

float3 ToThree(float3 u) { return float3(u.x, u.y, -u.z); }
float3 FromThree(float3 t) { return float3(t.x, t.y, -t.z); }

// ---- lighting / state (globals set by Lagoon.cs, three coords where directional) ----
float3 _SunDirT;      // unit, toward the sun
float3 _SunRad;       // sun radiance (Clearwater convention: full sun ≈ (1, .9, .74) × 6)
float3 _SkyIrr;
float3 _FogColor;
float _FogDensity;
float _SpikeTime;

// ---- Gerstner (mirrors src/environment/WaveField.ts) ----
#define MAX_WAVES 6
float4 _WaveA[MAX_WAVES]; // (dx, dz, k, omega)
float4 _WaveB[MAX_WAVES]; // (amplitude, Q, phase, 0)
float _WaveTime;

float3 GerstnerDisplace(float2 p)
{
    float3 d = 0;
    [unroll] for (int i = 0; i < MAX_WAVES; i++)
    {
        float4 A = _WaveA[i], B = _WaveB[i];
        float th = A.z * dot(A.xy, p) - A.w * _WaveTime + B.z;
        float c = cos(th), s = sin(th);
        d.xz += B.y * B.x * A.xy * c;
        d.y += B.x * s;
    }
    return d;
}

float2 GerstnerSlope(float2 p)
{
    float3 n = float3(0, 1, 0);
    [unroll] for (int i = 0; i < MAX_WAVES; i++)
    {
        float4 A = _WaveA[i], B = _WaveB[i];
        float th = A.z * dot(A.xy, p) - A.w * _WaveTime + B.z;
        float wa = A.z * B.x;
        n.xz -= A.xy * wa * cos(th);
        n.y -= B.y * wa * sin(th);
    }
    return -n.xz / n.y;
}

// ---- water optics (src/render/water/optics.ts) ----
static const float WATER_IOR = 1.3335;
static const float3 WATER_SIG_A = float3(0.34, 0.052, 0.034);
static const float3 WATER_SIG_S = float3(0.018, 0.030, 0.044);
static const float3 WATER_SIG_T = WATER_SIG_A + WATER_SIG_S;

float FresnelDielectric(float ci, float n)
{
    ci = saturate(ci);
    float st2 = (1.0 - ci * ci) / (n * n);
    if (st2 >= 1.0) return 1.0;
    float ct = sqrt(1.0 - st2);
    float rs = (ci - n * ct) / (ci + n * ct), rp = (n * ci - ct) / (n * ci + ct);
    return 0.5 * (rs * rs + rp * rp);
}

// GLSL refract (same semantics)
float3 RefractGL(float3 I, float3 N, float eta)
{
    float k = 1.0 - eta * eta * (1.0 - dot(N, I) * dot(N, I));
    return k < 0.0 ? float3(0, 0, 0) : eta * I - (eta * dot(N, I) + sqrt(k)) * N;
}

// ---- noise (same hashes as the GLSL) ----
float Hash12(float2 p)
{
    float3 p3 = frac(float3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return frac((p3.x + p3.y) * p3.z);
}

float VNoise(float2 p)
{
    float2 i = floor(p), f = frac(p);
    float2 u = f * f * (3.0 - 2.0 * f);
    return lerp(lerp(Hash12(i), Hash12(i + float2(1, 0)), u.x), lerp(Hash12(i + float2(0, 1)), Hash12(i + float2(1, 1)), u.x), u.y);
}

// ---- equirect sky (three coords; see tools/dev/unityExport.ts) ----
float2 SkyUV(float3 dT)
{
    float lon = atan2(dT.x, -dT.z), lat = asin(clamp(dT.y, -1.0, 1.0));
    return float2(lon / (2.0 * PI_F) + 0.5, lat / PI_F + 0.5);
}

#endif
