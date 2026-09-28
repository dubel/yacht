// Port of the game's terrain look: vertex colours from WorldGen + the seabed/land detail patch (Terrain.ts)
// + the underwater light patch (underwaterLight.ts: Fresnel-transmitted, attenuated sun with caustics,
// attenuated sky light, no aerial fog below the surface). Lambert like three's rough MeshStandardMaterial.
Shader "Spike/Terrain"
{
    Properties { _Peb ("Pebbles", 2D) = "white" {} }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "Queue" = "Geometry" "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            Name "Forward"
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Spike.hlsl"

            TEXTURE2D(_Peb); SAMPLER(sampler_Peb);
            TEXTURE2D(_CausTex); SAMPLER(sampler_CausTex);
            float2 _CausShift;
            float _CausPatch, _CausDepth;

            struct A { float4 pos : POSITION; float3 n : NORMAL; float4 col : COLOR; };
            struct V { float4 pos : SV_POSITION; float3 wpos : TEXCOORD0; float3 n : TEXCOORD1; float3 col : TEXCOORD2; float vdepth : TEXCOORD3; };

            V vert(A a)
            {
                V v;
                v.wpos = TransformObjectToWorld(a.pos.xyz);
                v.pos = TransformWorldToHClip(v.wpos);
                v.n = TransformObjectToWorldNormal(a.n);
                v.col = a.col.rgb;
                v.vdepth = -TransformWorldToView(v.wpos).z;
                return v;
            }

            float4 frag(V v) : SV_Target
            {
                float3 P = ToThree(v.wpos);
                float3 N = normalize(v.n);
                float3 albedo = v.col;
                // ---- detail (Terrain.ts patchShader) ----
                {
                    float under = smoothstep(0.6, -0.2, P.y);
                    float2 xz = P.xz;
                    float k = VNoise(xz * 0.21);
                    float l = k * 8.0; float ia = floor(l), fa = frac(l);
                    float2 oa = sin(float2(3.0, 7.0) * ia), ob = sin(float2(3.0, 7.0) * (ia + 1.0));
                    float2 puv = xz / 1.3;
                    float3 pa = SAMPLE_TEXTURE2D(_Peb, sampler_Peb, puv + oa).rgb;
                    float3 pb = SAMPLE_TEXTURE2D(_Peb, sampler_Peb, puv + ob).rgb;
                    float3 peb = lerp(pa, pb, smoothstep(0.2, 0.8, fa));
                    float pebZone = smoothstep(0.45, 0.7, VNoise(xz * 0.05 + 3.0)) * under;
                    float marks = (0.5 + 0.5 * sin(dot(xz, float2(0.93, 0.37)) * 5.0 + 3.0 * VNoise(xz * 0.3))) * smoothstep(0.0, -0.4, P.y);
                    float grain = VNoise(xz * 9.0) * 0.6 + VNoise(xz * 31.0) * 0.4;
                    float patches = VNoise(xz * 0.35) * 0.6 + VNoise(xz * 1.7) * 0.4;
                    float3 sandDetail = (0.88 + 0.12 * marks + 0.12 * grain) * lerp(float3(0.92, 0.9, 0.86), float3(1.05, 1.02, 0.97), patches);
                    float3 pebDetail = peb * 2.4;
                    albedo *= lerp(1.0, lerp(sandDetail, pebDetail, pebZone), smoothstep(1.8, 0.0, P.y));
                    float land = smoothstep(1.6, 2.4, P.y);
                    float ln = VNoise(xz * 0.9) * 0.5 + VNoise(xz * 3.3) * 0.3 + VNoise(xz * 11.0) * 0.2;
                    float3 earth = float3(0.32, 0.26, 0.17);
                    albedo = lerp(albedo, lerp(albedo * (0.7 + 0.6 * ln), earth, smoothstep(0.62, 0.8, ln) * 0.6), land);
                    float wet = smoothstep(0.7, 0.05, P.y) * smoothstep(-0.3, 0.05, P.y);
                    albedo *= 1.0 - 0.18 * wet;
                }
                // ---- light ----
                float3 sunW = FromThree(_SunDirT);
                float shadow = MainLightRealtimeShadow(TransformWorldToShadowCoord(v.wpos));
                float3 direct = _SunRad * saturate(dot(N, sunW)) * shadow / PI_F;
                float3 indirect = SampleSH(N);
                // ---- under water (underwaterLight.ts) ----
                float d = max(-P.y, 0.0);
                float uw = smoothstep(0.12, -0.12, P.y);
                float3 sunT = RefractGL(-_SunDirT, float3(0, 1, 0), 1.0 / WATER_IOR);
                float cosT = max(-sunT.y, 0.2);
                float2 cuv = (P.xz - _CausShift * (d / _CausDepth)) / _CausPatch;
                float3 caus = SAMPLE_TEXTURE2D_BIAS(_CausTex, sampler_CausTex, cuv, 0.5 + 1.2 * smoothstep(3.0, 12.0, d)).rgb;
                float focus = smoothstep(0.0, 1.4, d) * lerp(1.0, 0.45, smoothstep(3.0, 14.0, d));
                caus = lerp(1.0, caus, focus);
                float3 Tsun = exp(-WATER_SIG_T * d / cosT) * (1.0 - FresnelDielectric(_SunDirT.y, WATER_IOR));
                direct *= lerp(1.0, Tsun * caus, uw);
                float upwell = lerp(0.18, 1.0, smoothstep(-0.6, 0.6, N.y));
                indirect *= lerp(1.0, exp(-(WATER_SIG_A + 0.4 * WATER_SIG_S) * d * 1.25) * upwell, uw);
                float3 col = albedo * (direct + indirect);
                // ---- aerial fog, not below the surface ----
                float fogF = 1.0 - exp(-_FogDensity * _FogDensity * v.vdepth * v.vdepth);
                col = lerp(col, _FogColor, fogF * smoothstep(-0.3, 0.2, P.y));
                return float4(col, 1);
            }
            ENDHLSL
        }
        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode" = "DepthOnly" }
            ColorMask R
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            float4 vert(float4 p : POSITION) : SV_POSITION { return TransformObjectToHClip(p.xyz); }
            half frag() : SV_Target { return 0; }
            ENDHLSL
        }
        Pass
        {
            Name "DepthNormals"
            Tags { "LightMode" = "DepthNormals" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            struct V { float4 pos : SV_POSITION; float3 n : TEXCOORD0; };
            V vert(float4 p : POSITION, float3 n : NORMAL) { V v; v.pos = TransformObjectToHClip(p.xyz); v.n = TransformObjectToWorldNormal(n); return v; }
            half4 frag(V v) : SV_Target { return half4(normalize(v.n), 0); }
            ENDHLSL
        }
    }
}
