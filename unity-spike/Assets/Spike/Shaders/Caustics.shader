// Port of src/render/water/Caustics.ts (Clearwater caustics, after Evan Wallace; MIT © 2026 Lumaris): a grid of
// sun rays refracted through the FFT surface and splatted onto a flat floor; triangle area change = light.
Shader "Hidden/Spike/Caustics"
{
    SubShader
    {
        Pass
        {
            Blend One One
            ZTest Always ZWrite Off Cull Off
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            Texture2D _Surf; SamplerState sampler_Surf;
            float _CL, _HScale, _Depth, _Ior, _Norm, _FlipY;
            float3 _Sun;      // three coords
            float2 _Shift;
            float4 _Mask;
            struct V { float4 pos : SV_POSITION; float2 src : TEXCOORD0; };
            float3 refractGL(float3 I, float3 N, float eta)
            {
                float k = 1.0 - eta * eta * (1.0 - dot(N, I) * dot(N, I));
                return k < 0.0 ? 0 : eta * I - (eta * dot(N, I) + sqrt(k)) * N;
            }
            V vert(float3 p : POSITION, uint inst : SV_InstanceID)
            {
                V o;
                float2 aUV = p.xy;
                int2 off = int2((int)(inst % 3) - 1, (int)(inst / 3) - 1);
                float4 s = _Surf.SampleLevel(sampler_Surf, aUV, 0);
                float3 n = normalize(float3(-s.y, 1.0, -s.z));
                float3 r = refractGL(-_Sun, n, 1.0 / _Ior);
                float h = s.x * _HScale;
                float3 P = float3(aUV.x * _CL, h, aUV.y * _CL);
                float3 F = P + r * ((-_Depth - h) / r.y);
                o.src = aUV * _CL;
                float2 c = (F.xz - _Shift) / _CL + float2(off);
                o.pos = float4(c * 2.0 - 1.0, 0.5, 1.0);
                o.pos.y *= _FlipY;
                return o;
            }
            float4 frag(V i) : SV_Target
            {
                float2 a = ddx(i.src), b = ddy(i.src);
                float area = abs(a.x * b.y - a.y * b.x);
                float I = min(area * _Norm, 40.0);
                return _Mask * I;
            }
            ENDHLSL
        }
    }
}
