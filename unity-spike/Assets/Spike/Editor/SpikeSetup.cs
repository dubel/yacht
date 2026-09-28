using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

/// <summary>
/// Builds the whole spike from the exported web data (unity-spike/Import, see tools/dev/export-*.{ts,mjs}):
///   Unity -batchmode -quit -projectPath unity-spike -executeMethod SpikeSetup.All
///   Unity -batchmode -quit -projectPath unity-spike -executeMethod SpikeSetup.Build
/// </summary>
public static class SpikeSetup
{
    const string Gen = "Assets/Generated";
    const string Spike = "Assets/Spike";
    const string ScenePath = Spike + "/Lagoon.unity";
    static string Import => Path.GetFullPath(Path.Combine(Application.dataPath, "../Import"));

    [MenuItem("Spike/Setup all")]
    public static void All()
    {
        Directory.CreateDirectory(Gen);
        Settings();
        var pipeline = Pipeline();
        ImportData();
        BuildScene();
        AssetDatabase.SaveAssets();
        Debug.Log("[spike] setup done: " + pipeline.name);
    }

    [MenuItem("Spike/Build Linux")]
    public static void Build()
    {
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { ScenePath },
            locationPathName = "Build/spike.x86_64",
            target = BuildTarget.StandaloneLinux64,
            options = BuildOptions.None,
        });
        Debug.Log($"[spike] build {report.summary.result}: {report.summary.totalSize / 1e6:F1} MB, {report.summary.totalTime.TotalSeconds:F0} s, {report.summary.totalErrors} errors");
        if (report.summary.result != BuildResult.Succeeded) EditorApplication.Exit(1);
    }

    static void Settings()
    {
        PlayerSettings.colorSpace = ColorSpace.Linear;
        PlayerSettings.fullScreenMode = FullScreenMode.Windowed;
        PlayerSettings.defaultScreenWidth = 1280;
        PlayerSettings.defaultScreenHeight = 720;
        PlayerSettings.resizableWindow = true;
        PlayerSettings.runInBackground = true;
        PlayerSettings.visibleInBackground = true;
        PlayerSettings.enableFrameTimingStats = true;
        PlayerSettings.productName = "Lagoon spike";
        PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.StandaloneLinux64, false);
        PlayerSettings.SetGraphicsAPIs(BuildTarget.StandaloneLinux64, new[] { GraphicsDeviceType.Vulkan });
        // both input back ends (the spike uses the Input System package)
        var ps = Unsupported.GetSerializedAssetInterfaceSingleton("PlayerSettings");
        var so = new SerializedObject(ps);
        var input = so.FindProperty("activeInputHandler");
        if (input != null) { input.intValue = 2; so.ApplyModifiedProperties(); }
    }

    static UniversalRenderPipelineAsset Pipeline()
    {
        string rdPath = Spike + "/URP_Renderer.asset", pPath = Spike + "/URP.asset";
        AssetDatabase.DeleteAsset(rdPath);
        AssetDatabase.DeleteAsset(pPath);
        var rd = ScriptableObject.CreateInstance<UniversalRendererData>();
        // the water (a transparent) reads the scene depth: copy it right after the opaques
        rd.copyDepthMode = CopyDepthMode.AfterOpaques;
        AssetDatabase.CreateAsset(rd, rdPath);
        var post = ScriptableObject.CreateInstance<LagoonPost>();
        post.name = "LagoonPost";
        post.shader = Shader.Find("Hidden/Spike/Post");
        AssetDatabase.AddObjectToAsset(post, rd);
        rd.rendererFeatures.Add(post);
        var map = typeof(ScriptableRendererData).GetField("m_RendererFeatureMap", BindingFlags.NonPublic | BindingFlags.Instance);
        if (map != null && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(post, out _, out long id)) map.SetValue(rd, new System.Collections.Generic.List<long> { id });
        EditorUtility.SetDirty(rd);

        var p = UniversalRenderPipelineAsset.Create(rd);
        AssetDatabase.CreateAsset(p, pPath);
        var s = new SerializedObject(p);
        void B(string n, bool v) { var f = s.FindProperty(n); if (f != null) f.boolValue = v; else Debug.LogWarning("[spike] no " + n); }
        void I(string n, int v) { var f = s.FindProperty(n); if (f != null) f.intValue = v; else Debug.LogWarning("[spike] no " + n); }
        void F(string n, float v) { var f = s.FindProperty(n); if (f != null) f.floatValue = v; else Debug.LogWarning("[spike] no " + n); }
        B("m_RequireDepthTexture", true);
        B("m_RequireOpaqueTexture", true);
        I("m_OpaqueDownsampling", 0);
        B("m_SupportsHDR", true);
        I("m_HDRColorBufferPrecision", 1); // 64 bits
        I("m_MSAA", 4);
        I("m_MainLightShadowmapResolution", 2048);
        F("m_ShadowDistance", 150);
        I("m_ShadowCascadeCount", 2);
        B("m_SoftShadowsSupported", true);
        s.ApplyModifiedPropertiesWithoutUndo();
        EditorUtility.SetDirty(p);

        GraphicsSettings.defaultRenderPipeline = p;
        for (int q = 0; q < QualitySettings.names.Length; q++)
        {
            QualitySettings.SetQualityLevel(q, false);
            QualitySettings.renderPipeline = p;
        }
        var ensure = typeof(UniversalRenderPipelineAsset).Assembly.GetType("UnityEngine.Rendering.Universal.UniversalRenderPipelineGlobalSettings")?.GetMethod("Ensure", BindingFlags.NonPublic | BindingFlags.Static);
        ensure?.Invoke(null, new object[] { true });
        AssetDatabase.SaveAssets();
        return p;
    }

    static T Copy<T>(string src, string dst) where T : Object
    {
        File.Copy(Path.Combine(Import, src), dst, true);
        AssetDatabase.ImportAsset(dst, ImportAssetOptions.ForceUpdate);
        return AssetDatabase.LoadAssetAtPath<T>(dst);
    }

    static void ImportData()
    {
        // sky (HDR equirect in three coords, raw float RGBA, row 0 = straight down)
        var sky = new Texture2D(2048, 1024, TextureFormat.RGBAFloat, false, true) { wrapModeU = TextureWrapMode.Repeat, wrapModeV = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear, name = "sky" };
        sky.LoadRawTextureData(File.ReadAllBytes(Path.Combine(Import, "sky.bin")));
        sky.Apply(false, false);
        AssetDatabase.DeleteAsset(Gen + "/sky.exr");
        AssetDatabase.DeleteAsset(Gen + "/sky.asset");
        AssetDatabase.CreateAsset(sky, Gen + "/sky.asset");

        // pebbles (three: sRGB, repeat, anisotropy 8)
        File.Copy(Path.GetFullPath(Path.Combine(Application.dataPath, "../../public/assets/textures/pebbles.jpg")), Gen + "/pebbles.jpg", true);
        AssetDatabase.ImportAsset(Gen + "/pebbles.jpg");
        var pi = (TextureImporter)AssetImporter.GetAtPath(Gen + "/pebbles.jpg");
        pi.sRGBTexture = true;
        pi.wrapMode = TextureWrapMode.Repeat;
        pi.anisoLevel = 8;
        pi.SaveAndReimport();

        // FFT seed spectrum
        var h0 = new Texture2D(256, 256, TextureFormat.RGBAFloat, false, true) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Repeat, name = "h0" };
        h0.LoadRawTextureData(File.ReadAllBytes(Path.Combine(Import, "h0.bin")));
        h0.Apply(false, false);
        AssetDatabase.DeleteAsset(Gen + "/h0.asset");
        AssetDatabase.CreateAsset(h0, Gen + "/h0.asset");

        Copy<TextAsset>("state.json", Gen + "/state.json");
        File.Copy(Path.Combine(Import, "boat.glb"), Gen + "/boat.glb", true);
        AssetDatabase.ImportAsset(Gen + "/boat.glb", ImportAssetOptions.ForceUpdate);

        TerrainMeshes();
    }

    [System.Serializable] class TerrainInfo { public int n; public float x0, z0, step; }

    /// <summary>terrain.bin → 128-quad chunks in Unity coords (z mirrored), normals from the whole grid</summary>
    static void TerrainMeshes()
    {
        var info = JsonUtility.FromJson<TerrainInfo>(File.ReadAllText(Path.Combine(Import, "terrain.json")));
        var bytes = File.ReadAllBytes(Path.Combine(Import, "terrain.bin"));
        int n = info.n;
        var data = new float[bytes.Length / 4];
        System.Buffer.BlockCopy(bytes, 0, data, 0, bytes.Length);
        float H(int i, int j) => data[Mathf.Clamp(j, 0, n - 1) * n + Mathf.Clamp(i, 0, n - 1)];
        string dir = Gen + "/Terrain";
        AssetDatabase.DeleteAsset(dir);
        Directory.CreateDirectory(dir);
        const int C = 128;
        for (int cj = 0; cj < (n - 1) / C; cj++)
            for (int ci = 0; ci < (n - 1) / C; ci++)
            {
                int W = C + 1;
                var v = new Vector3[W * W];
                var nr = new Vector3[W * W];
                var col = new Color[W * W];
                for (int j = 0; j < W; j++)
                    for (int i = 0; i < W; i++)
                    {
                        int gi = ci * C + i, gj = cj * C + j, k = j * W + i;
                        float x = info.x0 + gi * info.step, z = info.z0 + gj * info.step;
                        v[k] = new Vector3(x, H(gi, gj), -z);
                        var nt = new Vector3(H(gi - 1, gj) - H(gi + 1, gj), 2 * info.step, H(gi, gj - 1) - H(gi, gj + 1)).normalized;
                        nr[k] = new Vector3(nt.x, nt.y, -nt.z);
                        int c = n * n + (gj * n + gi) * 3;
                        col[k] = new Color(data[c], data[c + 1], data[c + 2], 1);
                    }
                var idx = new int[C * C * 6];
                for (int j = 0, o = 0; j < C; j++)
                    for (int i = 0; i < C; i++)
                    {
                        int a = j * W + i, b = a + 1, c = a + W, d = c + 1;
                        // rows run toward −z in Unity: (a, b, c) is clockwise seen from above
                        idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = b; idx[o++] = d; idx[o++] = c;
                    }
                var m = new Mesh { name = $"terrain_{ci}_{cj}", vertices = v, normals = nr, colors = col, triangles = idx };
                m.RecalculateBounds();
                AssetDatabase.CreateAsset(m, $"{dir}/terrain_{ci}_{cj}.asset");
            }
    }

    static Material Mat(string path, string shader)
    {
        var m = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (m == null) { m = new Material(Shader.Find(shader)); AssetDatabase.CreateAsset(m, path); }
        m.shader = Shader.Find(shader);
        return m;
    }

    static void BuildScene()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

        var sky = Mat(Spike + "/Sky.mat", "Spike/Sky");
        sky.SetTexture("_SkyTex", AssetDatabase.LoadAssetAtPath<Texture2D>(Gen + "/sky.asset"));
        var terrainMat = Mat(Spike + "/Terrain.mat", "Spike/Terrain");
        terrainMat.SetTexture("_Peb", AssetDatabase.LoadAssetAtPath<Texture2D>(Gen + "/pebbles.jpg"));
        var waterMat = Mat(Spike + "/Water.mat", "Spike/Water");
        EditorUtility.SetDirty(sky); EditorUtility.SetDirty(terrainMat); EditorUtility.SetDirty(waterMat);

        RenderSettings.skybox = sky;
        RenderSettings.ambientMode = AmbientMode.Skybox;
        RenderSettings.defaultReflectionMode = DefaultReflectionMode.Skybox;
        RenderSettings.ambientIntensity = 1;
        RenderSettings.reflectionIntensity = 1;

        var camGo = new GameObject("Main Camera") { tag = "MainCamera" };
        var cam = camGo.AddComponent<Camera>();
        cam.fieldOfView = 55; cam.nearClipPlane = 0.3f; cam.farClipPlane = 40000;
        cam.allowHDR = true; cam.allowMSAA = true;
        var cd = camGo.AddComponent<UniversalAdditionalCameraData>();
        cd.renderPostProcessing = false;
        cd.antialiasing = AntialiasingMode.None;
        camGo.AddComponent<AudioListener>();

        var sunGo = new GameObject("Sun");
        var sun = sunGo.AddComponent<Light>();
        sun.type = LightType.Directional;
        sun.shadows = LightShadows.Soft;
        sunGo.AddComponent<UniversalAdditionalLightData>();

        var terrain = new GameObject("Terrain");
        foreach (var guid in AssetDatabase.FindAssets("t:Mesh", new[] { Gen + "/Terrain" }))
        {
            var mesh = AssetDatabase.LoadAssetAtPath<Mesh>(AssetDatabase.GUIDToAssetPath(guid));
            var go = new GameObject(mesh.name);
            go.transform.SetParent(terrain.transform, false);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var mr = go.AddComponent<MeshRenderer>();
            mr.sharedMaterial = terrainMat;
            mr.shadowCastingMode = ShadowCastingMode.Off;
            go.isStatic = true;
        }

        var boat = new GameObject("Boat");
        var glb = AssetDatabase.LoadAssetAtPath<GameObject>(Gen + "/boat.glb");
        if (glb != null)
        {
            var model = (GameObject)PrefabUtility.InstantiatePrefab(glb);
            model.transform.SetParent(boat.transform, false);
            // glTFast mirrors x; our world mirrors z → the model turned half round about y (see Lagoon.cs)
            model.transform.localRotation = Quaternion.Euler(0, 180, 0);
            foreach (var r in model.GetComponentsInChildren<Renderer>()) r.shadowCastingMode = ShadowCastingMode.On;
        }
        else Debug.LogError("[spike] boat.glb did not import");

        var lagoonGo = new GameObject("Lagoon");
        var lagoon = lagoonGo.AddComponent<Lagoon>();
        lagoon.stateJson = AssetDatabase.LoadAssetAtPath<TextAsset>(Gen + "/state.json");
        lagoon.h0 = AssetDatabase.LoadAssetAtPath<Texture2D>(Gen + "/h0.asset");
        lagoon.spectrumCS = AssetDatabase.LoadAssetAtPath<ComputeShader>(Spike + "/Shaders/Spectrum.compute");
        lagoon.ripplesCS = AssetDatabase.LoadAssetAtPath<ComputeShader>(Spike + "/Shaders/Ripples.compute");
        lagoon.causticsShader = Shader.Find("Hidden/Spike/Caustics");
        lagoon.postShader = Shader.Find("Hidden/Spike/Post");
        lagoon.waterMaterial = waterMat;
        lagoon.cam = cam;
        lagoon.sun = sun;
        lagoon.boat = boat.transform;

        EditorSceneManager.SaveScene(scene, ScenePath);
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
    }
}
