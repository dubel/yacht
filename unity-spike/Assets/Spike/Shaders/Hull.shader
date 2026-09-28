// The boat as three's MeshStandardMaterial sees it (base colour, normal map, metallic/roughness factors, sun +
// sky IBL) with the game's underwater light patch (underwaterLight.ts): below the surface the sun arrives
// Fresnel-transmitted, attenuated along the refracted path and focused into caustics; sky light is attenuated
// and surfaces facing down only get the weak upwelling. Authored normals are used as they are on both sides
// (Boat.ts: the export's winding is inconsistent).
Shader "Spike/Hull"
{
    Properties
    {
        baseColorTexture ("Base colour", 2D) = "white" {}
        baseColorFactor ("Base colour factor", Color) = (1, 1, 1, 1)
        [Normal] normalTexture ("Normal map", 2D) = "bump" {}
        normalTexture_scale ("Normal scale", Float) = 1
        metallicFactor ("Metallic", Float) = 0
        roughnessFactor ("Roughness", Float) = 1
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "Queue" = "Geometry" "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            Name "Forward"
            Tags { "LightMode" = "UniversalForward" }
            Cull Off
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Spike.hlsl"

            TEXTURE2D(baseColorTexture); SAMPLER(samplerbaseColorTexture);
            TEXTURE2D(normalTexture); SAMPLER(samplernormalTexture);
            TEXTURE2D(_CausTex); SAMPLER(sampler_CausTex);
            float4 baseColorFactor, baseColorTexture_ST;
            float normalTexture_scale, metallicFactor, roughnessFactor;
            float2 _CausShift;
            float _CausPatch, _CausDepth;

            struct A { float4 pos : POSITION; float3 n : NORMAL; float4 t : TANGENT; float2 uv : TEXCOORD0; };
            struct V { float4 pos : SV_POSITION; float3 wpos : TEXCOORD0; float3 n : TEXCOORD1; float4 t : TEXCOORD2; float2 uv : TEXCOORD3; float vdepth : TEXCOORD4; };

            V vert(A a)
            {
                V v;
                v.wpos = TransformObjectToWorld(a.pos.xyz);
                v.pos = TransformWorldToHClip(v.wpos);
                v.n = TransformObjectToWorldNormal(a.n);
                v.t = float4(TransformObjectToWorldDir(a.t.xyz), a.t.w * GetOddNegativeScale());
                v.uv = a.uv * baseColorTexture_ST.xy + baseColorTexture_ST.zw;
                v.vdepth = -TransformWorldToView(v.wpos).z;
                return v;
            }

            float4 frag(V v) : SV_Target
            {
                float3 albedo = SAMPLE_TEXTURE2D(baseColorTexture, samplerbaseColorTexture, v.uv).rgb * baseColorFactor.rgb;
                float3 N = normalize(v.n);
                if (dot(v.t.xyz, v.t.xyz) > 1e-6)
                {
                    float3 T = normalize(v.t.xyz), B = cross(N, T) * v.t.w;
                    float3 tn = UnpackNormalScale(SAMPLE_TEXTURE2D(normalTexture, samplernormalTexture, v.uv), normalTexture_scale);
                    N = normalize(T * tn.x + B * tn.y + N * tn.z);
                }
                float3 Vd = normalize(_WorldSpaceCameraPos - v.wpos);
                float3 L = FromThree(_SunDirT);
                float metal = metallicFactor, rough = clamp(roughnessFactor, 0.04, 1.0);
                float3 diffC = albedo * (1.0 - metal);
                float3 F0 = lerp(0.04, albedo, metal);
                float nl = saturate(dot(N, L)), nv = saturate(abs(dot(N, Vd))) + 1e-4;
                float3 H = normalize(L + Vd);
                float nh = saturate(dot(N, H)), vh = saturate(dot(Vd, H));
                float a2 = rough * rough * rough * rough;
                float D = a2 / (PI_F * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
                float k = rough * rough * 0.5;
                float G = 0.25 / ((nl * (1.0 - k) + k) * (nv * (1.0 - k) + k));
                float3 F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
                float shadow = MainLightRealtimeShadow(TransformWorldToShadowCoord(v.wpos));
                float3 E = _SunRad * nl * shadow;
                float3 directD = E * diffC / PI_F, directS = E * D * G * F;
                float3 indirectD = SampleSH(N) * diffC;
                float3 R = reflect(-Vd, N);
                float3 envF = F0 + (max(1.0 - rough, F0) - F0) * pow(1.0 - nv, 5.0);
                float3 indirectS = GlossyEnvironmentReflection(R, rough, 1.0) * envF;

                // ---- under water (underwaterLight.ts) ----
                float3 P = ToThree(v.wpos);
                float d = max(-P.y, 0.0);
                float uw = smoothstep(0.12, -0.12, P.y);
                float3 sunT = RefractGL(-_SunDirT, float3(0, 1, 0), 1.0 / WATER_IOR);
                float cosT = max(-sunT.y, 0.2);
                float2 cuv = (P.xz - _CausShift * (d / _CausDepth)) / _CausPatch;
                float3 caus = SAMPLE_TEXTURE2D_BIAS(_CausTex, sampler_CausTex, cuv, 0.5 + 1.2 * smoothstep(3.0, 12.0, d)).rgb;
                caus = lerp(1.0, caus, smoothstep(0.0, 1.4, d) * lerp(1.0, 0.45, smoothstep(3.0, 14.0, d)));
                float3 Tsun = exp(-WATER_SIG_T * d / cosT) * (1.0 - FresnelDielectric(_SunDirT.y, WATER_IOR));
                directD *= lerp(1.0, Tsun * caus, uw);
                directS *= lerp(1.0, Tsun * 0.3, uw);
                float upwell = lerp(0.18, 1.0, smoothstep(-0.6, 0.6, N.y));
                indirectD *= lerp(1.0, exp(-(WATER_SIG_A + 0.4 * WATER_SIG_S) * d * 1.25) * upwell, uw);
                indirectS *= 1.0 - 0.9 * uw;

                float3 col = directD + directS + indirectD + indirectS;
                float fogF = 1.0 - exp(-_FogDensity * _FogDensity * v.vdepth * v.vdepth);
                col = lerp(col, _FogColor, fogF * smoothstep(-0.3, 0.2, P.y));
                return float4(col, 1);
            }
            ENDHLSL
        }
        UsePass "Universal Render Pipeline/Unlit/DepthOnly"
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
        UsePass "Universal Render Pipeline/Lit/DepthNormals"
    }
}
