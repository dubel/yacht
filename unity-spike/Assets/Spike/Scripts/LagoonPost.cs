using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.RenderGraphModule;
using UnityEngine.Rendering.Universal;

/// <summary>
/// The game's own post (PostProcessor.ts): bright → blur → blur → ¼ copy → 2× blur → final (bloom, exposure,
/// vignette, ACES, grade, gamma, grain). Runs only for the main camera; URP's own post stays off.
/// </summary>
public class LagoonPost : ScriptableRendererFeature
{
    public Shader shader;
    Material mat;
    PostPass pass;

    public static float exposure = 0.63f;
    public static float debug;

    public override void Create()
    {
        if (shader == null) shader = Shader.Find("Hidden/Spike/Post");
        if (shader != null) mat = CoreUtils.CreateEngineMaterial(shader);
        pass = new PostPass { renderPassEvent = RenderPassEvent.BeforeRenderingPostProcessing, requiresIntermediateTexture = true };
    }

    public override void AddRenderPasses(ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        if (mat == null || !renderingData.cameraData.camera.CompareTag("MainCamera")) return;
        pass.mat = mat;
        renderer.EnqueuePass(pass);
    }

    protected override void Dispose(bool disposing) => CoreUtils.Destroy(mat);

    class PostPass : ScriptableRenderPass
    {
        public Material mat;

        class Data
        {
            public Material mat;
            public int pass;
            public TextureHandle src, hdr, b1, b2;
            public Vector4 srcSize, b2Size;
            public Vector2 dir;
            public float k;
            public MaterialPropertyBlock mpb = new MaterialPropertyBlock();
        }

        static readonly int SrcId = Shader.PropertyToID("_Src"), SrcSizeId = Shader.PropertyToID("_SrcSize"), DirId = Shader.PropertyToID("_Dir"),
            KId = Shader.PropertyToID("_K"), ThrId = Shader.PropertyToID("_Thr"), HdrId = Shader.PropertyToID("_Hdr"), B1Id = Shader.PropertyToID("_B1"),
            B2Id = Shader.PropertyToID("_B2"), B2SizeId = Shader.PropertyToID("_B2Size"), ExpId = Shader.PropertyToID("_Exp"), TimeId = Shader.PropertyToID("_PostTime");

        static Vector4 Size(int w, int h) => new Vector4(w, h, 1f / w, 1f / h);

        void Blit(RenderGraph rg, string name, int p, TextureHandle src, Vector4 srcSize, TextureHandle dst, Vector2 dir = default, float k = 1)
        {
            using var b = rg.AddRasterRenderPass<Data>(name, out var d);
            d.mat = mat; d.pass = p; d.src = src; d.srcSize = srcSize; d.dir = dir; d.k = k;
            b.UseTexture(src);
            b.SetRenderAttachment(dst, 0);
            b.SetRenderFunc((Data x, RasterGraphContext ctx) =>
            {
                x.mpb.SetTexture(SrcId, x.src);
                x.mpb.SetVector(SrcSizeId, x.srcSize);
                x.mpb.SetVector(DirId, x.dir);
                x.mpb.SetFloat(KId, x.k);
                x.mpb.SetFloat(ThrId, 2.5f);
                ctx.cmd.DrawProcedural(Matrix4x4.identity, x.mat, x.pass, MeshTopology.Triangles, 3, 1, x.mpb);
            });
        }

        public override void RecordRenderGraph(RenderGraph rg, ContextContainer frameData)
        {
            var res = frameData.Get<UniversalResourceData>();
            var cam = frameData.Get<UniversalCameraData>();
            if (res.isActiveTargetBackBuffer) return;
            var hdr = res.activeColorTexture;
            var desc = cam.cameraTargetDescriptor;
            desc.depthStencilFormat = UnityEngine.Experimental.Rendering.GraphicsFormat.None;
            desc.msaaSamples = 1;
            desc.graphicsFormat = UnityEngine.Experimental.Rendering.GraphicsFormat.R16G16B16A16_SFloat;
            int w = desc.width, h = desc.height;
            int qw = Mathf.Max(1, w >> 1), qh = Mathf.Max(1, h >> 1);
            int ew = Mathf.Max(1, qw >> 2), eh = Mathf.Max(1, qh >> 2);
            TextureHandle Tex(string n, int tw, int th)
            {
                var dd = desc; dd.width = tw; dd.height = th;
                return UniversalRenderer.CreateRenderGraphTexture(rg, dd, n, false, FilterMode.Bilinear);
            }
            var qA = Tex("_PostQA", qw, qh);
            var qB = Tex("_PostQB", qw, qh);
            var b1 = Tex("_PostB1", qw, qh);
            var b2 = Tex("_PostB2", ew, eh);
            var b2t = Tex("_PostB2t", ew, eh);
            var outTex = Tex("_PostOut", w, h);

            Blit(rg, "Post bright", 0, hdr, Size(w, h), qA);
            Blit(rg, "Post blur h", 1, qA, Size(qw, qh), qB, new Vector2(1, 0));
            Blit(rg, "Post blur v", 1, qB, Size(qw, qh), b1, new Vector2(0, 1));
            Blit(rg, "Post copy", 2, b1, Size(qw, qh), b2);
            for (int i = 0; i < 2; i++)
            {
                Blit(rg, "Post blur2 h", 1, b2, Size(ew, eh), b2t, new Vector2(1.5f, 0));
                Blit(rg, "Post blur2 v", 1, b2t, Size(ew, eh), b2, new Vector2(0, 1.5f));
            }

            using (var b = rg.AddRasterRenderPass<Data>("Post final", out var d))
            {
                d.mat = mat; d.hdr = hdr; d.b1 = b1; d.b2 = b2; d.b2Size = Size(ew, eh);
                b.UseTexture(hdr); b.UseTexture(b1); b.UseTexture(b2);
                b.SetRenderAttachment(outTex, 0);
                b.SetRenderFunc((Data x, RasterGraphContext ctx) =>
                {
                    x.mpb.SetTexture(HdrId, x.hdr);
                    x.mpb.SetTexture(B1Id, x.b1);
                    x.mpb.SetTexture(B2Id, x.b2);
                    x.mpb.SetVector(B2SizeId, x.b2Size);
                    x.mpb.SetFloat(ExpId, exposure);
                    x.mpb.SetFloat(TimeId, Time.time);
                    x.mpb.SetFloat("_PostDebug", debug);
                    ctx.cmd.DrawProcedural(Matrix4x4.identity, x.mat, 3, MeshTopology.Triangles, 3, 1, x.mpb);
                });
            }
            res.cameraColor = outTex;
        }
    }
}
