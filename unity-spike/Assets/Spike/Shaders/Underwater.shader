// Port of src/render/water/UnderwaterPass.ts: turns the frame into "seen through water" wherever the view ray
// starts below the surface (per pixel, from the near-plane point vs. the Gerstner surface, so a half-submerged
// lens gets a split image): extinction + single-scattered in-light, light shafts marched through the caustics,
// a slight refractive wobble and the meniscus line. Pixels that start above water are copied unchanged.
Shader "Hidden/Spike/Underwater"
{
    SubShader
    {
        ZTest Always ZWrite Off Cull Off Blend Off
        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Common.hlsl"
            #include "Spike.hlsl"
            TEXTURE2D(_Scene); TEXTURE2D(_SceneDepth); TEXTURE2D(_CausTex);
            SAMPLER(sampler_LinearClamp); SAMPLER(sampler_PointClamp); SAMPLER(sampler_CausTex);
            float4x4 _InvVP;
            float2 _CausShift;
            float _CausPatch, _CausDepth;
            struct V { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
            V vert(uint id : SV_VertexID)
            {
                V o;
                o.pos = GetFullScreenTriangleVertexPosition(id);
                o.uv = GetFullScreenTriangleTexCoord(id);
                return o;
            }
            float3 WorldAt(float2 uv, float raw) { return ToThree(ComputeWorldSpacePosition(uv, raw, _InvVP)); }
            float SurfaceHeight(float2 xz)
            {
                float2 p = xz;
                [unroll] for (int i = 0; i < 3; i++) p = xz - GerstnerDisplace(p).xz;
                return GerstnerDisplace(p).y;
            }
            float4 frag(V i) : SV_Target
            {
            #if UNITY_REVERSED_Z
                const float NEAR = 1.0, FAR = 0.0;
            #else
                const float NEAR = 0.0, FAR = 1.0;
            #endif
                float3 nearP = WorldAt(i.uv, NEAR);
                float hN = SurfaceHeight(nearP.xz);
                float under = nearP.y - hN;
                if (under > 0.0) return SAMPLE_TEXTURE2D_LOD(_Scene, sampler_LinearClamp, i.uv, 0);

                float2 wob = float2(sin(i.uv.y * 38.0 + _SpikeTime * 1.7), cos(i.uv.x * 31.0 + _SpikeTime * 1.3)) * 0.0016;
                float2 uv = i.uv + wob;
                float raw = SAMPLE_TEXTURE2D_LOD(_SceneDepth, sampler_PointClamp, uv, 0).r;
                float3 rd = normalize(WorldAt(uv, FAR) - nearP);
                bool sky = abs(raw - FAR) < 1e-6;
                float dist = sky ? 400.0 : length(WorldAt(uv, raw) - nearP);
                // the water surface seen from below (not in the opaque depth): where the ray meets it
                if (rd.y > 1e-3)
                {
                    float t = (hN - nearP.y) / rd.y;
                    [unroll] for (int k = 0; k < 2; k++) { float3 q = nearP + rd * t; t = max(0.0, t + (SurfaceHeight(q.xz) - q.y) / rd.y); }
                    dist = min(dist, t);
                }
                float3 col = SAMPLE_TEXTURE2D_LOD(_Scene, sampler_LinearClamp, uv, 0).rgb;

                float3 sunT = RefractGL(-_SunDirT, float3(0, 1, 0), 1.0 / WATER_IOR);
                float cosT = max(-sunT.y, 0.2);
                float Ts = 1.0 - FresnelDielectric(_SunDirT.y, WATER_IOR);
                float mu = dot(rd, -sunT);
                float g = 0.8; float ph = (1.0 - g * g) / (4.0 * PI_F * pow(1.0 + g * g - 2.0 * g * mu, 1.5));

                float camDepth = max(hN - nearP.y, 0.0);
                float dMid = min(camDepth + 1.0, 6.0);
                float3 Lmid = _SunRad * Ts * exp(-WATER_SIG_T * dMid / cosT) * (ph * 0.18 + 0.03) + _SkyIrr * exp(-WATER_SIG_A * dMid * 1.2) / (4.0 * PI_F);
                float3 Linf = WATER_SIG_S / WATER_SIG_T * Lmid * 3.2;
                float3 Tv = exp(-WATER_SIG_T * dist);
                col = col * Tv + Linf * (1.0 - Tv);

                // light shafts: march the view ray through the caustic focus of the sunlight reaching each point
                float L = min(dist, 36.0);
                const int N = 24;
                float stepL = L / N;
                float jitter = frac(52.9829189 * frac(dot(i.pos.xy + floor(frac(_SpikeTime * 7.0) * 16.0) * 5.588, float2(0.06711056, 0.00583715))));
                float3 shafts = 0;
                for (int s = 0; s < N; s++)
                {
                    float t = (s + jitter) * stepL;
                    float3 p = nearP + rd * t;
                    float depth = -p.y;
                    if (depth < 0.0) break;
                    float2 cuv = (p.xz - _CausShift * (depth / _CausDepth)) / _CausPatch;
                    float c = SAMPLE_TEXTURE2D_LOD(_CausTex, sampler_CausTex, cuv, 2.0 + depth * 0.15).g;
                    float3 sunHere = _SunRad * Ts * exp(-WATER_SIG_T * depth / cosT);
                    shafts += sunHere * max(c - 0.4, 0.0) * exp(-WATER_SIG_T * t) * stepL;
                }
                col += min(shafts * WATER_SIG_S * ph * 4.0, 6.0);
                col *= 1.0 - 0.6 * smoothstep(-0.04, 0.0, under);
                return float4(col, 1);
            }
            ENDHLSL
        }
    }
}
