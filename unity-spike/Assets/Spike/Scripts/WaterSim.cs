using UnityEngine;
using UnityEngine.Rendering;

/// <summary>FFT spectrum (WaterSpectrum.ts) as compute kernels.</summary>
public class WaterSpectrum
{
    public readonly int N;
    public readonly float L;
    public readonly RenderTexture surface;
    readonly RenderTexture a, b;
    readonly Texture2D h0;
    readonly ComputeShader cs;
    readonly int kSpec, kFft, kResolve;

    public WaterSpectrum(ComputeShader cs, Texture2D h0, int n, float l)
    {
        this.cs = cs; this.h0 = h0; N = n; L = l;
        a = RT(n, FilterMode.Point, false);
        b = RT(n, FilterMode.Point, false);
        surface = RT(n, FilterMode.Trilinear, true);
        surface.anisoLevel = 8;
        kSpec = cs.FindKernel("Spec"); kFft = cs.FindKernel("Fft"); kResolve = cs.FindKernel("Resolve");
    }

    static RenderTexture RT(int n, FilterMode f, bool mips)
    {
        var rt = new RenderTexture(n, n, 0, mips ? RenderTextureFormat.ARGBHalf : RenderTextureFormat.ARGBFloat, RenderTextureReadWrite.Linear)
        {
            enableRandomWrite = true, filterMode = f, wrapMode = TextureWrapMode.Repeat, useMipMap = mips, autoGenerateMips = false,
        };
        rt.Create();
        return rt;
    }

    public void Update(float t)
    {
        int g = N / 8;
        cs.SetInt("N", N); cs.SetFloat("T", t); cs.SetFloat("L", L);
        cs.SetTexture(kSpec, "H0", h0); cs.SetTexture(kSpec, "Dst", a);
        cs.Dispatch(kSpec, g, g, 1);
        RenderTexture src = a, dst = b;
        int logN = (int)Mathf.Log(N, 2);
        for (int horiz = 1; horiz >= 0; horiz--)
            for (int s = 0; s < logN; s++)
            {
                cs.SetInt("P", 1 << s); cs.SetInt("Horiz", horiz);
                cs.SetTexture(kFft, "Src", src); cs.SetTexture(kFft, "Dst", dst);
                cs.Dispatch(kFft, g, g, 1);
                (src, dst) = (dst, src);
            }
        cs.SetTexture(kResolve, "Src", src); cs.SetTexture(kResolve, "Dst", surface);
        cs.Dispatch(kResolve, g, g, 1);
        surface.GenerateMips();
    }
}

/// <summary>Local wave-equation window following the boat (Ripples.ts). three coords.</summary>
public class Ripples
{
    public readonly int N;
    public readonly float size;
    public readonly RenderTexture field;
    public Vector2 center;
    readonly RenderTexture[] sim = new RenderTexture[2];
    int idx;
    float acc, time;
    readonly ComputeShader cs;
    readonly int kStep, kNorm;
    readonly float K;

    public struct Hull { public float x, z, fx, fz, halfLength, halfBeam, strength; }

    public Ripples(ComputeShader cs, int n, float size, float speed)
    {
        this.cs = cs; N = n; this.size = size;
        for (int i = 0; i < 2; i++) sim[i] = RT(n);
        field = RT(n);
        float dx = size / n, dt = 1f / 60f;
        K = Mathf.Min(1.6f, 4 * speed * speed * dt * dt / (dx * dx));
        kStep = cs.FindKernel("Step"); kNorm = cs.FindKernel("Norm");
    }

    static RenderTexture RT(int n)
    {
        var rt = new RenderTexture(n, n, 0, RenderTextureFormat.ARGBHalf, RenderTextureReadWrite.Linear)
        { enableRandomWrite = true, filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
        rt.Create();
        var prev = RenderTexture.active;
        RenderTexture.active = rt; GL.Clear(false, true, Color.clear); RenderTexture.active = prev;
        return rt;
    }

    public void Update(float dt, Vector2 follow, Hull? hull)
    {
        acc = Mathf.Min(acc + dt, 0.1f);
        float texel = size / N;
        int g = N / 8;
        cs.SetInt("N", N); cs.SetFloat("K", K); cs.SetFloat("Texel", texel);
        while (acc >= 1f / 60f)
        {
            acc -= 1f / 60f;
            float dxT = Mathf.Round((follow.x - center.x) / texel), dzT = Mathf.Round((follow.y - center.y) / texel);
            cs.SetVector("Shift", new Vector2(dxT / N, dzT / N));
            center.x += dxT * texel; center.y += dzT * texel;
            cs.SetVector("Drop", Vector4.zero);
            if (hull is Hull h && h.strength != 0)
            {
                cs.SetVector("Hull", new Vector4((h.x - center.x) / size + 0.5f, (h.z - center.y) / size + 0.5f, h.fx, h.fz));
                cs.SetVector("HullS", new Vector3(h.halfLength / size, h.halfBeam / size, h.strength));
            }
            else cs.SetVector("HullS", new Vector3(1, 1, 0));
            time += 1f / 60f;
            cs.SetFloat("Time", time);
            cs.SetTexture(kStep, "Src", sim[idx]); cs.SetTexture(kStep, "Dst", sim[1 - idx]);
            cs.Dispatch(kStep, g, g, 1);
            idx = 1 - idx;
        }
        cs.SetTexture(kNorm, "Src", sim[idx]); cs.SetTexture(kNorm, "Dst", field);
        cs.Dispatch(kNorm, g, g, 1);
    }
}

/// <summary>Refracted-grid caustics with dispersion (Caustics.ts). three coords.</summary>
public class Caustics
{
    static readonly float[] IORS = { 1.3315f, 1.3335f, 1.3365f };
    public readonly RenderTexture target;
    public Vector2 shift;
    public readonly float patch, depth;
    readonly Material mat;
    readonly Mesh grid;
    readonly CommandBuffer cmd = new CommandBuffer { name = "Caustics" };
    readonly MaterialPropertyBlock[] mpb = { new(), new(), new() };

    public Caustics(Shader shader, Texture surface, float fftL, int G, int size, float patch, float depth)
    {
        this.patch = patch; this.depth = depth;
        target = new RenderTexture(size, size, 0, RenderTextureFormat.ARGBHalf, RenderTextureReadWrite.Linear)
        { wrapMode = TextureWrapMode.Repeat, useMipMap = true, autoGenerateMips = true, filterMode = FilterMode.Trilinear, anisoLevel = 8 };
        target.Create();
        mat = new Material(shader);
        mat.SetTexture("_Surf", surface);
        mat.SetFloat("_CL", patch);
        mat.SetFloat("_HScale", patch / fftL);
        mat.SetFloat("_Depth", depth);
        mat.SetFloat("_Norm", (size / patch) * (size / patch));
        mat.SetFloat("_FlipY", SystemInfo.graphicsUVStartsAtTop ? -1 : 1);
        var v = new Vector3[(G + 1) * (G + 1)];
        for (int j = 0, o = 0; j <= G; j++) for (int i = 0; i <= G; i++) v[o++] = new Vector3((float)i / G, (float)j / G, 0);
        var idx = new int[G * G * 6];
        for (int j = 0, o = 0; j < G; j++)
            for (int i = 0; i < G; i++)
            {
                int a = j * (G + 1) + i, b = a + 1, c = a + G + 1, d = c + 1;
                idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = b; idx[o++] = d; idx[o++] = c;
            }
        grid = new Mesh { indexFormat = IndexFormat.UInt32, vertices = v, triangles = idx, bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f) };
    }

    public void Update(Vector3 sunT)
    {
        float sy = Mathf.Max(sunT.y, 0.05f), sinI = Mathf.Sqrt(1 - sy * sy), sinT = sinI / IORS[1], cosT = Mathf.Sqrt(1 - sinT * sinT);
        float hd = Mathf.Sqrt(sunT.x * sunT.x + sunT.z * sunT.z); if (hd == 0) hd = 1;
        float tanT = sinT / cosT;
        shift = new Vector2(-sunT.x / hd * depth * tanT, -sunT.z / hd * depth * tanT);
        mat.SetVector("_Sun", sunT);
        mat.SetVector("_Shift", shift);
        cmd.Clear();
        cmd.SetRenderTarget(target);
        cmd.ClearRenderTarget(false, true, Color.clear);
        for (int c = 0; c < 3; c++)
        {
            mpb[c].SetFloat("_Ior", IORS[c]);
            mpb[c].SetVector("_Mask", new Vector4(c == 0 ? 1 : 0, c == 1 ? 1 : 0, c == 2 ? 1 : 0, 0));
            cmd.DrawMeshInstancedProcedural(grid, 0, mat, 0, 9, mpb[c]);
        }
        Graphics.ExecuteCommandBuffer(cmd);
    }
}
