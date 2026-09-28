// Port of src/render/PostProcessor.ts (Clearwater post, MIT © 2026 Lumaris): bloom + ACES + grade, without the
// spyglass / drunk / trip effects. Passes: 0 bright, 1 blur, 2 copy, 3 final. The final pass outputs the
// display-encoded colour decoded back to linear, so URP's sRGB back buffer reproduces the web picture exactly.
Shader "Hidden/Spike/Post"
{
    HLSLINCLUDE
    #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Common.hlsl"
    #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Color.hlsl"
    TEXTURE2D(_Src); TEXTURE2D(_Hdr); TEXTURE2D(_B1); TEXTURE2D(_B2);
    SAMPLER(sampler_LinearClamp);
    float4 _SrcSize, _B2Size, _OutSize; // (w, h, 1/w, 1/h)
    float2 _Dir;
    float _Thr, _K, _Exp, _PostTime, _Aspect, _PostDebug;
    struct V { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
    V vert(uint id : SV_VertexID)
    {
        V o;
        o.pos = GetFullScreenTriangleVertexPosition(id);
        o.uv = GetFullScreenTriangleTexCoord(id);
        return o;
    }
    float3 S(TEXTURE2D(t), float2 uv) { return SAMPLE_TEXTURE2D_LOD(t, sampler_LinearClamp, uv, 0).rgb; }
    ENDHLSL

    SubShader
    {
        ZTest Always ZWrite Off Cull Off Blend Off
        Pass // 0 bright
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            float4 frag(V i) : SV_Target
            {
                float2 px = _SrcSize.zw;
                float3 c = 0;
                for (int y = -1; y <= 2; y++) for (int x = -1; x <= 2; x++) c += S(_Src, i.uv + (float2(x, y) - 0.5) * px);
                c /= 16.0;
                float l = max(max(c.r, c.g), c.b);
                float k = max(l - _Thr, 0.0) / max(l, 1e-4);
                return float4(min(c * k, 160.0), 1);
            }
            ENDHLSL
        }
        Pass // 1 blur
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            float4 frag(V i) : SV_Target
            {
                float2 px = _Dir * _SrcSize.zw;
                float3 c = S(_Src, i.uv) * 0.2270270270;
                c += (S(_Src, i.uv + px * 1.3846153846) + S(_Src, i.uv - px * 1.3846153846)) * 0.3162162162;
                c += (S(_Src, i.uv + px * 3.2307692308) + S(_Src, i.uv - px * 3.2307692308)) * 0.0702702703;
                return float4(c, 1);
            }
            ENDHLSL
        }
        Pass // 2 copy
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            float4 frag(V i) : SV_Target { return float4(S(_Src, i.uv) * _K, 1); }
            ENDHLSL
        }
        Pass // 3 final
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            float3 Bicubic(float2 uv)
            {
                float2 ts = _B2Size.xy; float2 p = uv * ts - 0.5; float2 f = frac(p); p = floor(p);
                float2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f), w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
                float2 g0 = w0 + w1, g1 = w2 + w3; float2 h0 = (w1 / g0 - 0.5 + p) / ts, h1 = (w3 / g1 + 1.5 + p) / ts;
                return (S(_B2, float2(h0.x, h0.y)) * g0.x + S(_B2, float2(h1.x, h0.y)) * g1.x) * g0.y + (S(_B2, float2(h0.x, h1.y)) * g0.x + S(_B2, float2(h1.x, h1.y)) * g1.x) * g1.y;
            }
            float3 Aces(float3 x) { const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14; return saturate((x * (a * x + b)) / (x * (c * x + d) + e)); }
            float Hash(float2 p) { float3 p3 = frac(float3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return frac((p3.x + p3.y) * p3.z); }
            float4 frag(V i) : SV_Target
            {
                float2 uv = i.uv;
                float2 cc = uv - 0.5; float ca = 0.0012 * dot(cc, cc) * 4.0;
                float3 c;
                c.r = S(_Hdr, uv + cc * ca).r; c.g = S(_Hdr, uv).g; c.b = S(_Hdr, uv - cc * ca).b;
                float bloom = 0.035;
                c += S(_B1, uv) * bloom + Bicubic(uv) * bloom;
                c *= _Exp;
                float vig = 1.0 - 0.22 * dot(cc * float2(1.0, 0.8), cc * float2(1.0, 0.8)) * 2.2;
                c *= vig;
                c = Aces(c);
                float lum = dot(c, float3(0.2126, 0.7152, 0.0722));
                c = lerp(lum, c, 0.93);
                c = lerp(c, c * float3(0.96, 1.0, 1.05), 1.0 - smoothstep(0.0, 0.35, lum));
                c = pow(c, 1.0 / 2.2);
                float g = Hash(i.pos.xy + frac(_PostTime * 7.13) * 917.0) - 0.5;
                c += g * 0.014 * (1.0 - c * 0.6);
                if (_PostDebug == 1) c = float3(0.2, 0.5, 0.9);
                if (_PostDebug == 2) c = S(_Hdr, uv) * 0.25;
                return float4(SRGBToLinear(saturate(c)), 1);
            }
            ENDHLSL
        }
    }
}
