// The game's clear sky (Preetham + sun disc), captured from three.js as an HDR equirect in three coords.
Shader "Spike/Sky"
{
    Properties { _SkyTex ("Sky (equirect, three coords)", 2D) = "black" {} }
    SubShader
    {
        Tags { "Queue" = "Background" "RenderType" = "Background" "PreviewType" = "Skybox" "RenderPipeline" = "UniversalPipeline" }
        Cull Off ZWrite Off
        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Spike.hlsl"
            TEXTURE2D(_SkyTex); SAMPLER(sampler_SkyTex);
            struct A { float4 pos : POSITION; };
            struct V { float4 pos : SV_POSITION; float3 dir : TEXCOORD0; };
            V vert(A a) { V v; v.pos = TransformObjectToHClip(a.pos.xyz); v.dir = a.pos.xyz; return v; }
            float4 frag(V v) : SV_Target
            {
                float3 d = ToThree(normalize(v.dir));
                return float4(SAMPLE_TEXTURE2D_LOD(_SkyTex, sampler_SkyTex, SkyUV(d), 0).rgb, 1);
            }
            ENDHLSL
        }
    }
}
