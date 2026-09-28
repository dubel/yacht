// Port of src/render/water/UnderwaterParticles.ts: suspended matter in a cube that wraps round the camera
// (world-fixed as you move), lit by the attenuated sun. Procedural: 2500 camera-facing quads, no buffers.
Shader "Spike/Particles"
{
    SubShader
    {
        Tags { "Queue" = "Transparent" "RenderType" = "Transparent" "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            Tags { "LightMode" = "SRPDefaultUnlit" }
            Blend One One ZWrite Off ZTest LEqual Cull Off
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Spike.hlsl"
            static const float SIZE = 26.0;
            struct V { float4 pos : SV_POSITION; float2 c : TEXCOORD0; float depth : TEXCOORD1; float fade : TEXCOORD2; float rnd : TEXCOORD3; };
            float H(float n) { return frac(sin(n * 12.9898) * 43758.5453); }
            V vert(uint id : SV_VertexID)
            {
                V o;
                uint k = id / 6, corner = id % 6;
                float r = H(k + 0.5);
                float3 pos = float3(H(k + 1.7), H(k + 3.1), H(k + 5.3));
                float t = _SpikeTime;
                float3 camT = ToThree(_WorldSpaceCameraPos);
                float3 p = pos * SIZE + float3(sin(t * 0.13 + r * 40.0), sin(t * 0.07 + r * 17.0) * 0.6 + t * 0.02, cos(t * 0.11 + r * 23.0));
                float3 base = camT - SIZE * 0.5;
                float3 w = base + (p - base - SIZE * floor((p - base) / SIZE));
                o.depth = -w.y;
                o.rnd = r;
                float3 vpos = TransformWorldToView(FromThree(w));
                float d = -vpos.z;
                o.fade = smoothstep(SIZE * 0.5, SIZE * 0.25, length(w - camT)) * smoothstep(0.25, 0.8, d);
                // three's point size in pixels (90/d, 1–6 px) as a view-space quad
                float px = clamp((0.6 + 1.6 * r) * 90.0 / d, 1.0, 6.0);
                float half_ = 0.5 * px * d * 2.0 / (UNITY_MATRIX_P._m11 * _ScreenParams.y);
                float2 c = float2(corner == 1 || corner == 2 || corner == 4 ? 1 : -1, corner == 2 || corner == 4 || corner == 5 ? 1 : -1);
                o.c = c * 0.5;
                vpos.xy += c * half_;
                o.pos = TransformWViewToHClip(vpos);
                return o;
            }
            float4 frag(V i) : SV_Target
            {
                if (i.depth < 0.05) discard;
                float a = smoothstep(0.5, 0.1, length(i.c)) * i.fade;
                float3 sunT = RefractGL(-_SunDirT, float3(0, 1, 0), 1.0 / WATER_IOR);
                float3 lit = _SunRad * exp(-WATER_SIG_T * i.depth / max(-sunT.y, 0.2)) * (0.008 + 0.025 * i.rnd);
                return float4(lit * a, 1);
            }
            ENDHLSL
        }
    }
}
