// Port of src/render/water/WaterSurface.ts (Clearwater's water model, MIT © 2026 Lumaris, adapted to a mesh):
// camera-centred radial grid displaced by the shared Gerstner waves + FFT + wake height; shaded with Fresnel,
// planar reflection, refraction through the real water thickness (URP opaque colour + depth), in-scatter,
// LEAN glints, suspended specks, foam and haze. Seen-from-below branch left out (the spike stays above water).
// All maths in three.js coordinates (Spike.hlsl) so it matches the web version pattern for pattern.
Shader "Spike/Water"
{
    SubShader
    {
        Tags { "RenderType" = "Transparent" "Queue" = "Transparent-100" "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            Name "Water"
            Tags { "LightMode" = "UniversalForward" }
            Cull Off ZWrite On ZTest LEqual Blend Off
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareOpaqueTexture.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"
            #include "Spike.hlsl"

            TEXTURE2D(_Surf); SAMPLER(sampler_Surf);
            TEXTURE2D(_Rip); SAMPLER(sampler_Rip);
            TEXTURE2D(_Refl); SAMPLER(sampler_Refl);
            float4 _SurfSize;     // (w, h, 1/w, 1/h)
            float _L, _RipSize, _Chop, _Whitecaps, _LodScale;
            float2 _RipCenter;    // three xz
            float2 _GridCenter;   // three xz (whole metres)
            float4x4 _ReflVP;     // mirror camera view-projection (GL convention, Unity world)
            float _WaterOff;      // debug: 1 = draw nothing (scene without water)
            int _View;            // debug: 1 normals, 3 reflection, 4 thickness, 5 ripples, 6 fft

            static const float SC = 0.41, WB = 0.10;
            float2 MulM(float2 v)   { return float2(0.8 * v.x + 0.6 * v.y, -0.6 * v.x + 0.8 * v.y); }
            float2 MulMT(float2 v)  { return float2(0.8 * v.x - 0.6 * v.y, 0.6 * v.x + 0.8 * v.y); }
            float2 MulM2(float2 v)  { return float2(0.28 * v.x - 0.96 * v.y, 0.96 * v.x + 0.28 * v.y); }
            float2 MulM2T(float2 v) { return float2(0.28 * v.x + 0.96 * v.y, -0.96 * v.x + 0.28 * v.y); }

            struct A { float4 pos : POSITION; };
            struct V { float4 pos : SV_POSITION; float3 world : TEXCOORD0; float2 param : TEXCOORD1; float crest : TEXCOORD2; };

            V vert(A a)
            {
                V o;
                // grid is symmetric: its local xz can be read directly as three xz
                float2 p = a.pos.xz + _GridCenter;
                float3 g = GerstnerDisplace(p);
                float ampSum = 0;
                [unroll] for (int i = 0; i < MAX_WAVES; i++) ampSum += _WaveB[i].x;
                o.crest = g.y / max(ampSum, 1e-3);
                float3 w = float3(p.x + g.x, g.y, p.y + g.z);
                float3 camT = ToThree(_WorldSpaceCameraPos);
                float camD = length(w.xz - camT.xz) * _LodScale;
                float detail = exp(-camD * 0.01);
                w.y += _Chop * detail * (SAMPLE_TEXTURE2D_LOD(_Surf, sampler_Surf, w.xz / _L, 0).x
                    + WB * SC * SAMPLE_TEXTURE2D_LOD(_Surf, sampler_Surf, MulM(w.xz) / (_L * SC) + 0.37, 0).x);
                float2 ruv = (w.xz - _RipCenter) / _RipSize + 0.5;
                if (all(ruv > 0.0) && all(ruv < 1.0)) w.y += SAMPLE_TEXTURE2D_LOD(_Rip, sampler_Rip, ruv, 0).x;
                o.param = p;
                o.world = w;
                o.pos = TransformWorldToHClip(FromThree(w));
                if (_WaterOff > 0.5) o.pos = float4(0, 0, -10, 1);
                return o;
            }

            // cubic B-spline filtering in 4 bilinear taps (Clearwater)
            float4 TexBS(float2 uv)
            {
                float2 ts = _SurfSize.xy;
                float2 p = uv * ts - 0.5; float2 f = frac(p); p = floor(p);
                float2 f2 = f * f, f3 = f2 * f;
                float2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
                float2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0, w3 = f3 / 6.0;
                float2 g0 = w0 + w1, g1 = w2 + w3;
                float2 h0 = (w1 / g0 - 0.5 + p) / ts, h1 = (w3 / g1 + 1.5 + p) / ts;
                return (SAMPLE_TEXTURE2D(_Surf, sampler_Surf, float2(h0.x, h0.y)) * g0.x + SAMPLE_TEXTURE2D(_Surf, sampler_Surf, float2(h1.x, h0.y)) * g1.x) * g0.y
                     + (SAMPLE_TEXTURE2D(_Surf, sampler_Surf, float2(h0.x, h1.y)) * g0.x + SAMPLE_TEXTURE2D(_Surf, sampler_Surf, float2(h1.x, h1.y)) * g1.x) * g1.y;
            }

            bool IsFar(float raw)
            {
            #if UNITY_REVERSED_Z
                return raw <= 1e-6;
            #else
                return raw >= 0.99999;
            #endif
            }

            float3 WorldFromDepthT(float2 uv, float raw) { return ToThree(ComputeWorldSpacePosition(uv, raw, UNITY_MATRIX_I_VP)); }
            float2 ScreenUV(float3 pT) { return ComputeNormalizedDeviceCoordinates(FromThree(pT), UNITY_MATRIX_VP); }
            float EyeDepth(float raw) { return LinearEyeDepth(raw, _ZBufferParams); }

            float4 frag(V i) : SV_Target
            {
                float3 P = i.world;
                float3 camT = ToThree(_WorldSpaceCameraPos);
                float3 uSunDir = _SunDirT;
                float3 uSunRad = _SunRad;
                float3 toCam = camT - P;
                float dist = length(toCam);
                float3 v = toCam / dist, wd = -v;
                float ldist = dist * _LodScale;
                float2 suv = GetNormalizedScreenSpaceUV(i.pos);

                float dStraight = SampleSceneDepth(suv);
                float waterZ = -TransformWorldToView(FromThree(P)).z;

                // ---- slope: Gerstner + two FFT layers + micro layer + wake ----
                float4 A = TexBS(P.xz / _L);
                float4 B = TexBS(MulM(P.xz) / (_L * SC) + 0.37);
                float4 Cm = SAMPLE_TEXTURE2D(_Surf, sampler_Surf, MulM2(P.xz) / (_L * 0.13) + 0.71);
                float2 ruv = (P.xz - _RipCenter) / _RipSize + 0.5;
                float4 R = 0;
                float ripIn = 0;
                if (all(ruv > 0.0) && all(ruv < 1.0)) { R = SAMPLE_TEXTURE2D(_Rip, sampler_Rip, ruv); ripIn = 1; }
                float2 slope = GerstnerSlope(i.param) + _Chop * (A.yz + WB * MulMT(B.yz)) + R.yz;
                slope += _Chop * 0.13 * exp(-ldist * 0.04) * MulM2T(Cm.yz);
                float var = _Chop * _Chop * (max(A.w - dot(A.yz, A.yz), 0.0) + WB * WB * max(B.w - dot(B.yz, B.yz), 0.0));
                float3 n = normalize(float3(-slope.x, 1.0, -slope.y));

                float nv = dot(n, v);
                if (nv < 0.02) { n = normalize(n + v * (0.02 - nv)); nv = dot(n, v); }
                float F = FresnelDielectric(nv, WATER_IOR);

                // ---- reflection: planar render, distorted by the normal ----
                float4 rc = mul(_ReflVP, float4(FromThree(float3(P.x, 0.0, P.z)), 1.0));
                float2 rUV0 = rc.xy / rc.w * 0.5 + 0.5;
                float2 rUV = rUV0 + n.xz * 0.16 / (1.0 + ldist * 0.012);
                float3 refl = SAMPLE_TEXTURE2D(_Refl, sampler_Refl, clamp(rUV, 0.001, 0.999)).rgb;

                // sun glints: Beckmann with slope-variance widening (LEAN), Clearwater
                float a2 = 0.00012 + 1.2 * var + 0.00002 * ldist;
                float3 h = normalize(v + uSunDir);
                float nh = max(dot(n, h), 0.0), nl = max(dot(n, uSunDir), 0.0);
                float c2 = max(nh * nh, 1e-4); float tan2 = (1.0 - c2) / c2;
                float D = exp(-tan2 / a2) / (PI_F * a2 * c2 * c2);
                float Vis = 0.5 / (nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2) + 1e-5);
                float Fh = FresnelDielectric(max(dot(h, v), 0.0), WATER_IOR);
                float3 spec = uSunRad * min(D * Vis * Fh * nl, 12000.0);

                // ---- refraction: follow the refracted ray to the seabed in the scene buffer ----
                float3 tr = RefractGL(wd, n, 1.0 / WATER_IOR);
                float3 bedStraight = WorldFromDepthT(suv, dStraight);
                float below = clamp(P.y - bedStraight.y, 0.0, 60.0);
                float3 FP = P + tr * (below / max(-tr.y, 0.08));
                float2 fuvRaw = ScreenUV(FP);
                float onScreen = smoothstep(0.0, 0.06, min(min(fuvRaw.x, 1.0 - fuvRaw.x), min(fuvRaw.y, 1.0 - fuvRaw.y)));
                float2 fuv = clamp(lerp(suv, fuvRaw, onScreen), 0.001, 0.999);
                float dR = SampleSceneDepth(fuv);
                if (EyeDepth(dR) < waterZ) { fuv = suv; dR = dStraight; }
                float3 bed = WorldFromDepthT(fuv, dR);
                float3 sceneCol = SampleSceneColor(fuv);
                float s = IsFar(dR) ? 400.0 : length(bed - P);
                float depthHere = IsFar(dR) ? 60.0 : max(P.y - bed.y, 0.0);

                float3 sunT = RefractGL(-uSunDir, float3(0, 1, 0), 1.0 / WATER_IOR);
                float Ts = 1.0 - FresnelDielectric(uSunDir.y, WATER_IOR);
                float3 Tv = exp(-WATER_SIG_T * s);
                float cosS = dot(sunT, -tr);
                float g = 0.8; float ph = (1.0 - g * g) / (4.0 * PI_F * pow(1.0 + g * g - 2.0 * g * cosS, 1.5));
                float dMid = min(depthHere * 0.5, 5.0);
                float3 Lmid = uSunRad * Ts * exp(-WATER_SIG_T * dMid / max(-sunT.y, 0.2)) * (ph + 0.02) + _SkyIrr * exp(-WATER_SIG_A * dMid * 1.2) / (4.0 * PI_F);
                float3 Lin = WATER_SIG_S / WATER_SIG_T * Lmid * (1.0 - Tv) * 3.2;
                float3 under = sceneCol * Tv + Lin;

                // suspended specks at three depths
                [unroll] for (int k = 0; k < 3; k++)
                {
                    float dz = 0.35 + 0.6 * k;
                    float tt = dz / max(-tr.y, 0.05);
                    float2 q = (P.xz + tr.xz * tt) * 22.0 + float2(_SpikeTime * (0.05 + 0.03 * k), _SpikeTime * 0.02) + k * 17.0;
                    float2 id = floor(q), f = frac(q) - 0.5;
                    float r = Hash12(id + k * 13.1);
                    float2 of = float2(Hash12(id + 3.1), Hash12(id + 7.7)) - 0.5;
                    float fw = fwidth(q.x) + fwidth(q.y);
                    float dot_ = smoothstep(0.10 + fw, 0.0, length(f - of * 0.6)) * step(0.988, r) * step(tt, s);
                    float fade = exp(-WATER_SIG_T.g * tt * 2.0) * smoothstep(1.2, 0.3, fw);
                    under += dot_ * fade * uSunRad * Ts * 0.02;
                }

                float3 col = F * refl + (1.0 - F) * under + spec;

                // ---- foam: wake + shore wash + whitecaps ----
                float foamN = VNoise(P.xz * 1.7 + _SpikeTime * 0.3) * 0.6 + VNoise(P.xz * 5.3 - _SpikeTime * 0.2) * 0.4;
                float cells = VNoise(P.xz * 1.3 + 7.0) * 0.45 + VNoise(P.xz * 4.1 - _SpikeTime * 0.15) * 0.35 + VNoise(P.xz * 13.0) * 0.2;
                float cover = clamp(R.a * 0.8, 0.0, 0.92);
                float lace = smoothstep(1.0 - cover, 1.0 - cover + 0.22, cells);
                float wake = ripIn * max(lace * clamp(R.a * 0.9, 0.0, 0.95), smoothstep(0.3, 0.7, length(R.yz)) * 0.4);
                float shoreD = max(P.y - bedStraight.y, 0.0);
                float shore = smoothstep(0.45, 0.05, shoreD) * (0.55 + 0.45 * sin(_SpikeTime * 1.3 - shoreD * 14.0 + foamN * 4.0));
                shore *= smoothstep(0.35, 0.7, foamN);
                float capCover = _Whitecaps * smoothstep(0.35, 0.95, i.crest + 0.35 * (cells - 0.5));
                float caps = smoothstep(1.0 - capCover, 1.0 - capCover + 0.18, VNoise(P.xz * 2.2 + _SpikeTime * 0.5) * 0.5 + cells * 0.5);
                float foam = saturate(max(max(wake, shore * 0.8), caps * 0.9));
                float3 foamCol = 1.15 / PI_F * (uSunRad * max(dot(n, uSunDir), 0.0) * 0.9 + uSunRad * 0.12 + _SkyIrr * 1.6);
                col = lerp(col, foamCol, foam * 0.85);

                float3 dry = SampleSceneColor(suv);
                col = lerp(dry, col, smoothstep(0.0, 0.12, shoreD));

                // aerial haze: far away it takes the colour of the sky just above the horizon (from the reflection)
                float fogF = 1.0 - exp(-_FogDensity * _FogDensity * dist * dist);
                float3 horizonSky = SAMPLE_TEXTURE2D_BIAS(_Refl, sampler_Refl, clamp(rUV0, 0.001, 0.999), 2.0).rgb;
                float3 hazeC = lerp(_FogColor, horizonSky, smoothstep(600.0, 4000.0, dist));
                col = lerp(col, hazeC, fogF);
                if (_View == 1) col = n * 0.5 + 0.5;
                else if (_View == 3) col = refl;
                else if (_View == 4) col = float3(1.0 - exp(-s * 0.15), 1.0 - exp(-depthHere * 0.2), 0.0);
                else if (_View == 5) col = float3(0.5 + R.x * 6.0, 0.5 + R.y * 2.0, 0.5 + R.z * 2.0) * ripIn;
                else if (_View == 6) col = float3(0.5 + A.x * 4.0, 0.5 + A.y * 3.0, 0.5 + A.z * 3.0);
                return float4(max(col, 0.0), 1.0);
            }
            ENDHLSL
        }
    }
}
