using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

/// <summary>
/// The spike scene: the web game's lighting and waves (from state.json), our water (FFT, wake, caustics,
/// Clearwater surface with planar reflection), a floating boat on keyboard, a chase camera — and a headless-ish
/// shot mode for side-by-side comparisons with three.js:
///   spike.x86_64 -cam x,y,z,tx,ty,tz -t 5 -frames 60 -shot out.png -state out.json -bench 120
/// Positions on the command line are three.js world coordinates, as in the web game's ?cam=.
/// </summary>
public class Lagoon : MonoBehaviour
{
    public TextAsset stateJson;
    public Texture2D h0;
    public ComputeShader spectrumCS, ripplesCS;
    public Shader causticsShader, postShader;
    public Material particlesMaterial;
    public Material waterMaterial;
    public Camera cam;
    public Light sun;
    public Transform boat;

    SpikeState st;
    WaveField waves;
    WaterSpectrum spectrum;
    Ripples ripples;
    Caustics caustics;
    Mesh grid;
    Camera reflCam;
    RenderTexture reflRT;

    // boat (three coords)
    Vector2 boatPos;
    float heading, speed = 3, heaveVel, lastY;
    // chase camera
    float yaw = 0.55f, pitch = 0.28f, distance = 42, headingYaw;
    Vector3 camTarget, camSmooth;
    bool camFirst = true;

    // command line
    float? fixedT;
    float[] freeCam;
    string shotPath, statePath;
    int shotFrames = 60, benchFrames;
    Vector2Int benchRes;
    bool waterOff;
    int view;
    int frame;
    float time;
    // render scale like the web game: 0.7 on a HiDPI screen, adapted between 0.45 and 1 (Game.adaptQuality)
    float scale = -1, ftAvg = 16, outOfBand, sinceResize;
    bool adaptive = true;
    GUIStyle hud;
    readonly List<double> gpuMs = new(), cpuMs = new(), dtMs = new();

    static readonly FrameTiming[] timings = new FrameTiming[1];

    void Awake()
    {
        st = SpikeState.Parse(stateJson.text);
        ParseArgs();
        // playing: vsync like the browser's requestAnimationFrame; measuring: as fast as it goes
        bool measuring = shotPath != null || benchFrames > 0;
        QualitySettings.vSyncCount = measuring ? 0 : 1;
        Application.targetFrameRate = -1;
        if (scale < 0) scale = measuring ? 1 : (Screen.dpi > 150 || Screen.height > 1440 ? 0.7f : 1f);
        SetScale(scale);
        waves = new WaveField(st.waves.A, st.waves.B);
        spectrum = new WaterSpectrum(spectrumCS, h0, 256, 20);
        ripples = new Ripples(ripplesCS, 512, 128, 1.5f);
        caustics = new Caustics(causticsShader, spectrum.surface, 20, 256, 1024, 7.0f, 1.9f);
        grid = RadialGrid(262, 320, 0.35f, 1.03f);
        var water = new GameObject("Water") { layer = 4 };
        water.AddComponent<MeshFilter>().sharedMesh = grid;
        var mr = water.AddComponent<MeshRenderer>();
        mr.sharedMaterial = waterMaterial;
        mr.shadowCastingMode = ShadowCastingMode.Off;
        mr.receiveShadows = false;

        var bp = st.boat.position;
        boatPos = new Vector2(bp[0], bp[2]);
        var q = st.boat.quaternion;
        // heading from the three quaternion: forward (0,0,1) rotated → (sin h, cos h)
        var fwd = new Quaternion(q[0], q[1], q[2], q[3]) * Vector3.forward;
        heading = Mathf.Atan2(fwd.x, fwd.z);
        headingYaw = heading;
        time = fixedT ?? st.time;

        SetupLight();
        SetupReflection();
        // fixed-size offscreen frames for benchmarking (the tiling window manager decides the window's size)
        if (benchRes.x > 0)
        {
            cam.targetTexture = new RenderTexture(benchRes.x, benchRes.y, 24, RenderTextureFormat.ARGBHalf, RenderTextureReadWrite.Linear);
            cam.targetTexture.Create();
        }
        DynamicGI.UpdateEnvironment();
        LagoonPost.exposure = st.env.exposure;
    }

    void ParseArgs()
    {
        var a = System.Environment.GetCommandLineArgs();
        for (int i = 0; i < a.Length - 1; i++)
        {
            string k = a[i], v = a[i + 1];
            if (k == "-t") fixedT = F(v);
            else if (k == "-cam") freeCam = System.Array.ConvertAll(v.Split(','), F);
            else if (k == "-shot") shotPath = v;
            else if (k == "-state") statePath = v;
            else if (k == "-frames") shotFrames = int.Parse(v);
            else if (k == "-bench") benchFrames = int.Parse(v);
            else if (k == "-benchres") { var r = v.Split('x'); benchRes = new Vector2Int(int.Parse(r[0]), int.Parse(r[1])); }
            else if (k == "-speed") speed = F(v);
            else if (k == "-view") view = int.Parse(v);
            else if (k == "-scale") { scale = F(v); adaptive = false; }
            else if (k == "-postdebug") LagoonPost.debug = F(v);
        }
        foreach (var s in a) if (s == "-nowater") waterOff = true;
        static float F(string s) => float.Parse(s, CultureInfo.InvariantCulture);
    }

    void SetupLight()
    {
        var e = st.env;
        var dirT = SpikeState.V(e.lightDir);
        sun.transform.rotation = Quaternion.LookRotation(-SpikeState.U(e.lightDir));
        var c = new Color(e.lightColor[0], e.lightColor[1], e.lightColor[2]);
        float m = Mathf.Max(c.r, Mathf.Max(c.g, c.b));
        sun.color = (c / m).gamma;
        // URP Lit: albedo·E·N·L (no 1/π) — three: albedo/π·E·N·L
        sun.intensity = e.lightIntensity * m / Mathf.PI;
        sun.shadows = LightShadows.Soft;

        var fog = new Color(e.fogColor[0], e.fogColor[1], e.fogColor[2]);
        RenderSettings.fog = true;
        RenderSettings.fogMode = FogMode.ExponentialSquared;
        RenderSettings.fogDensity = e.fogDensity;
        RenderSettings.fogColor = fog.gamma;

        Shader.SetGlobalVector("_SunDirT", dirT.normalized);
        Shader.SetGlobalVector("_SunRad", SpikeState.V(e.sunRadiance));
        Shader.SetGlobalVector("_SkyIrr", SpikeState.V(e.skyIrradiance));
        Shader.SetGlobalVector("_FogColor", SpikeState.V(e.fogColor));
        Shader.SetGlobalFloat("_FogDensity", e.fogDensity);
        Shader.SetGlobalVectorArray("_WaveA", waves.A);
        Shader.SetGlobalVectorArray("_WaveB", waves.B);
    }

    void SetupReflection()
    {
        var go = new GameObject("Reflection camera") { hideFlags = HideFlags.DontSave };
        reflCam = go.AddComponent<Camera>();
        reflCam.enabled = false;
        reflCam.cullingMask = ~(1 << 4); // not the water
        var data = go.AddComponent<UniversalAdditionalCameraData>();
        data.renderShadows = false;
        data.requiresColorOption = CameraOverrideOption.Off;
        data.requiresDepthOption = CameraOverrideOption.Off;
        data.renderPostProcessing = false;
    }

    static Mesh RadialGrid(int rings, int segments, float first, float growth)
    {
        var radii = new List<float> { 0 };
        float r = 0, step = first;
        for (int i = 0; i < rings; i++) { r += step; step *= growth; radii.Add(r); }
        var v = new List<Vector3> { Vector3.zero };
        for (int i = 1; i < radii.Count; i++)
            for (int j = 0; j < segments; j++)
            {
                float a = (float)j / segments * Mathf.PI * 2;
                v.Add(new Vector3(Mathf.Cos(a) * radii[i], 0, Mathf.Sin(a) * radii[i]));
            }
        var idx = new List<int>();
        for (int j = 0; j < segments; j++) idx.AddRange(new[] { 0, 1 + (j + 1) % segments, 1 + j });
        for (int i = 1; i < radii.Count - 1; i++)
        {
            int a0 = 1 + (i - 1) * segments, b0 = 1 + i * segments;
            for (int j = 0; j < segments; j++)
            {
                int j1 = (j + 1) % segments;
                idx.AddRange(new[] { a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j });
            }
        }
        var m = new Mesh { indexFormat = IndexFormat.UInt32 };
        m.SetVertices(v);
        m.SetTriangles(idx, 0);
        m.bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f);
        return m;
    }

    void Update()
    {
        float dt = Time.deltaTime;
        float stepDt = fixedT.HasValue ? 1f / 60f : dt;
        time = fixedT ?? time + dt;

        AdaptScale(Time.unscaledDeltaTime);
        UpdateBoat(stepDt);

        Shader.SetGlobalFloat("_WaveTime", time);
        Shader.SetGlobalFloat("_SpikeTime", time);
        spectrum.Update(time * 0.9f);
        var bf = new Vector2(Mathf.Sin(heading), Mathf.Cos(heading));
        const float halfLength = 9.0f, halfBeam = 2.7f;
        ripples.Update(stepDt, boatPos + bf * speed * 1.5f, new Ripples.Hull
        {
            x = boatPos.x, z = boatPos.y, fx = bf.x, fz = bf.y, halfLength = halfLength, halfBeam = halfBeam,
            strength = 0.0075f * Mathf.Min(speed, 7) + 0.01f * Mathf.Min(Mathf.Abs(heaveVel), 1),
        });
        caustics.Update(SpikeState.V(st.env.lightDir).normalized);

        Shader.SetGlobalTexture("_CausTex", caustics.target);
        Shader.SetGlobalVector("_CausShift", caustics.shift);
        Shader.SetGlobalFloat("_CausPatch", caustics.patch);
        Shader.SetGlobalFloat("_CausDepth", caustics.depth);
    }

    void SetScale(float k)
    {
        scale = k;
        if (GraphicsSettings.currentRenderPipeline is UniversalRenderPipelineAsset urp) urp.renderScale = k;
        sinceResize = 0;
    }

    void AdaptScale(float dt)
    {
        var kb = Keyboard.current;
        if (kb != null && kb.leftBracketKey.wasPressedThisFrame) { adaptive = false; SetScale(Mathf.Max(0.3f, scale - 0.1f)); }
        if (kb != null && kb.rightBracketKey.wasPressedThisFrame) { adaptive = false; SetScale(Mathf.Min(1.5f, scale + 0.1f)); }
        if (kb != null && kb.backslashKey.wasPressedThisFrame) adaptive = !adaptive;
        ftAvg = ftAvg * 0.95f + dt * 1000 * 0.05f;
        sinceResize += dt;
        if (!adaptive || shotPath != null || benchFrames > 0) return;
        bool slow = ftAvg > 21, fast = ftAvg < 13.5f;
        outOfBand = slow || fast ? outOfBand + dt : 0;
        if (sinceResize < 4 || outOfBand < 2) return;
        if (slow && scale > 0.45f) SetScale(Mathf.Max(0.45f, scale * 0.88f));
        else if (fast && scale < 1) SetScale(Mathf.Min(1, scale * 1.06f));
        outOfBand = 0;
    }

    void OnGUI()
    {
        if (shotPath != null || benchFrames > 0) return;
        hud ??= new GUIStyle(GUI.skin.label) { fontSize = Mathf.RoundToInt(14 * Mathf.Max(1, Screen.height / 1000f)) };
        int w = Mathf.RoundToInt(Screen.width * scale), h = Mathf.RoundToInt(Screen.height * scale);
        GUI.Label(new Rect(10, 8, 900, 60), $"{1000 / ftAvg:F0} fps  {ftAvg:F1} ms   render {w}×{h} (×{scale:F2}{(adaptive ? ", auto" : "")})   [ ] scale  \\ auto", hud);
    }

    void UpdateBoat(float dt)
    {
        var kb = Keyboard.current;
        if (kb != null && !fixedT.HasValue)
        {
            if (kb.wKey.isPressed) speed = Mathf.Min(speed + 1.5f * dt, 7);
            if (kb.sKey.isPressed) speed = Mathf.Max(speed - 1.5f * dt, 0);
            float turn = (kb.aKey.isPressed ? -1 : 0) + (kb.dKey.isPressed ? 1 : 0);
            heading += turn * 0.12f * Mathf.Min(speed, 4) / 4 * dt * 2.5f;
        }
        var f = new Vector2(Mathf.Sin(heading), Mathf.Cos(heading));
        boatPos += f * speed * dt;
        var r = new Vector2(f.y, -f.x); // three: port = local +X = (cos h, −sin h)
        float t = time;
        float hb = waves.Sample(boatPos.x + f.x * 7, boatPos.y + f.y * 7, t, out _);
        float hs = waves.Sample(boatPos.x - f.x * 7, boatPos.y - f.y * 7, t, out _);
        float hp = waves.Sample(boatPos.x + r.x * 2.2f, boatPos.y + r.y * 2.2f, t, out _);
        float hst = waves.Sample(boatPos.x - r.x * 2.2f, boatPos.y - r.y * 2.2f, t, out _);
        float hc = waves.Sample(boatPos.x, boatPos.y, t, out _);
        float y = (hb + hs + hp + hst + 2 * hc) / 6;
        heaveVel = dt > 0 ? (y - lastY) / dt : 0;
        lastY = y;
        float pitchA = Mathf.Atan2(hb - hs, 14), roll = Mathf.Atan2(hp - hst, 4.4f);
        // three quaternion: heading about Y, bow up about local X (negative), port up about local Z
        var qT = Quaternion.AngleAxis(heading * Mathf.Rad2Deg, Vector3.up)
               * Quaternion.AngleAxis(-pitchA * Mathf.Rad2Deg, Vector3.right)
               * Quaternion.AngleAxis(roll * Mathf.Rad2Deg, Vector3.forward);
        boat.SetPositionAndRotation(SpikeState.U(new[] { boatPos.x, y, boatPos.y }), SpikeState.Q(new[] { qT.x, qT.y, qT.z, qT.w }));
    }

    void LateUpdate()
    {
        UpdateCamera(Time.deltaTime);
        Underwater();
        RenderReflection(Mathf.RoundToInt(cam.pixelWidth * scale), Mathf.RoundToInt(cam.pixelHeight * scale));

        var tex = Shader.PropertyToID("_Surf");
        waterMaterial.SetTexture(tex, spectrum.surface);
        waterMaterial.SetVector("_SurfSize", new Vector4(256, 256, 1f / 256, 1f / 256));
        waterMaterial.SetTexture("_Rip", ripples.field);
        waterMaterial.SetFloat("_L", 20);
        waterMaterial.SetFloat("_RipSize", ripples.size);
        waterMaterial.SetVector("_RipCenter", ripples.center);
        waterMaterial.SetFloat("_Chop", st.weather.chop);
        waterMaterial.SetFloat("_Whitecaps", st.weather.whitecaps);
        waterMaterial.SetFloat("_LodScale", 1);
        waterMaterial.SetFloat("_WaterOff", waterOff ? 1 : 0);
        waterMaterial.SetInt("_View", view);
        var ct = cam.transform.position;
        waterMaterial.SetVector("_GridCenter", new Vector2(Mathf.Round(ct.x), Mathf.Round(-ct.z)));

        frame++;
        if (benchFrames > 0 && frame > shotFrames)
        {
            FrameTimingManager.CaptureFrameTimings();
            if (FrameTimingManager.GetLatestTimings(1, timings) > 0) { gpuMs.Add(timings[0].gpuFrameTime); cpuMs.Add(timings[0].cpuFrameTime); }
            dtMs.Add(Time.unscaledDeltaTime * 1000.0);
        }
        if (shotPath != null && frame == shotFrames) Shot(shotPath);
        if ((shotPath != null || benchFrames > 0) && frame >= shotFrames + benchFrames)
        {
            try { if (statePath != null) WriteState(statePath); }
            finally { Application.Quit(); }
        }
    }

    /// <summary>how far the lens is below the surface decides the underwater pass and the specks (Game.ts)</summary>
    void Underwater()
    {
        var cp = ToThreeV(cam.transform.position);
        float submerged = waves.Sample(cp.x, cp.z, time, out _) - cp.y;
        LagoonPost.underwater = submerged > -1.2f;
        var vp = GL.GetGPUProjectionMatrix(cam.projectionMatrix, true) * cam.worldToCameraMatrix;
        LagoonPost.invViewProj = vp.inverse;
        if (submerged > -1.5f && particlesMaterial != null)
            Graphics.RenderPrimitives(new RenderParams(particlesMaterial) { camera = cam, worldBounds = new Bounds(cam.transform.position, Vector3.one * 100), layer = 4 },
                MeshTopology.Triangles, 2500 * 6);
    }

    static Vector3 ToThreeV(Vector3 u) => new Vector3(u.x, u.y, -u.z);

    /// <summary>terrain height at three (x, z) from the terrain colliders</summary>
    static float Ground(float x, float z) =>
        Physics.Raycast(new Vector3(x, 500, -z), Vector3.down, out var hit, 1000) ? hit.point.y : -50;

    void UpdateCamera(float dt)
    {
        cam.fieldOfView = 55; cam.nearClipPlane = 0.3f; cam.farClipPlane = 40000;
        if (freeCam != null)
        {
            var p = SpikeState.U(freeCam);
            var t = SpikeState.U(new[] { freeCam[3], freeCam[4], freeCam[5] });
            cam.transform.SetPositionAndRotation(p, Quaternion.LookRotation(t - p));
            return;
        }
        var mouse = Mouse.current;
        if (mouse != null)
        {
            if (mouse.leftButton.isPressed || mouse.rightButton.isPressed)
            {
                var d = mouse.delta.ReadValue();
                yaw -= d.x * 0.005f;
                pitch = Mathf.Clamp(pitch - d.y * 0.005f, -0.75f, 1.35f);
            }
            float wheel = mouse.scroll.ReadValue().y;
            if (wheel != 0) distance = Mathf.Clamp(distance * Mathf.Pow(1.1f, -Mathf.Sign(wheel)), 9, 160);
        }
        var kbc = Keyboard.current;
        if (kbc != null && kbc.vKey.wasPressedThisFrame)
        {
            if (pitch > -0.1f) { pitch = -0.3f; distance = Mathf.Min(distance, 32); }
            else pitch = 0.28f;
        }
        float dh = Mathf.DeltaAngle(headingYaw * Mathf.Rad2Deg, heading * Mathf.Rad2Deg) * Mathf.Deg2Rad;
        headingYaw += dh * (1 - Mathf.Exp(-dt * 0.8f));
        var focus = new Vector3(boatPos.x, 0, boatPos.y);
        camTarget = camFirst ? focus : Vector3.Lerp(camTarget, focus, 1 - Mathf.Exp(-dt * 6));
        float a = headingYaw + Mathf.PI + yaw, cp = Mathf.Cos(pitch);
        var want = new Vector3(camTarget.x + Mathf.Sin(a) * cp * distance, camTarget.y + Mathf.Sin(pitch) * distance + 3, camTarget.z + Mathf.Cos(a) * cp * distance);
        float floor = Ground(want.x, want.z) + 1.2f;
        want.y = Mathf.Max(want.y, floor);
        camSmooth = camFirst ? want : Vector3.Lerp(camSmooth, want, 1 - Mathf.Exp(-dt * 8));
        camSmooth.y = Mathf.Max(camSmooth.y, floor);
        camFirst = false;
        float aimY = Mathf.Lerp(4, -1.2f, Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0.02f, 0.3f, -pitch)));
        var pU = SpikeState.U(new[] { camSmooth.x, camSmooth.y, camSmooth.z });
        var tU = SpikeState.U(new[] { camTarget.x, camTarget.y + aimY, camTarget.z });
        cam.transform.SetPositionAndRotation(pU, Quaternion.LookRotation(tU - pU));
    }

    void Shot(string path)
    {
        // (URP sizes its intermediate buffer from the destination: it must be HDR, or the scene clamps at 1)
        var rt = new RenderTexture(1280, 720, 24, RenderTextureFormat.ARGBHalf, RenderTextureReadWrite.Linear);
        rt.Create();
        var prevAspect = cam.aspect;
        cam.aspect = 1280f / 720f;
        RenderReflection(1280, 720);
        RenderPipeline.SubmitRenderRequest(cam, new RenderPipeline.StandardRequest { destination = rt });
        cam.aspect = prevAspect;
        var prev = RenderTexture.active;
        RenderTexture.active = rt;
        var tex = new Texture2D(1280, 720, TextureFormat.RGBAFloat, false, true);
        tex.ReadPixels(new Rect(0, 0, 1280, 720), 0, 0);
        RenderTexture.active = prev;
        // the post already wrote display colour (decoded to linear): encode it back
        var px = tex.GetPixels();
        var outTex = new Texture2D(1280, 720, TextureFormat.RGB24, false);
        var o = new Color32[px.Length];
        for (int i = 0; i < px.Length; i++)
        {
            var c = px[i];
            o[i] = new Color32(E(c.r), E(c.g), E(c.b), 255);
        }
        outTex.SetPixels32(o);
        File.WriteAllBytes(path, outTex.EncodeToPNG());
        Debug.Log($"[spike] shot → {path}");
        static byte E(float v) => (byte)Mathf.Clamp(Mathf.RoundToInt(Mathf.LinearToGammaSpace(Mathf.Clamp01(v)) * 255), 0, 255);
    }

    /// <summary>planar reflection across y = 0 at half the view resolution (Pipeline.ts)</summary>
    void RenderReflection(int w, int h)
    {
        w = Mathf.Max(1, w / 2); h = Mathf.Max(1, h / 2);
        if (reflRT == null || reflRT.width != w || reflRT.height != h)
        {
            if (reflRT != null) reflRT.Release();
            reflRT = new RenderTexture(w, h, 24, RenderTextureFormat.ARGBHalf, RenderTextureReadWrite.Linear)
            { useMipMap = true, autoGenerateMips = true, filterMode = FilterMode.Trilinear, wrapMode = TextureWrapMode.Clamp };
            reflRT.Create();
        }
        reflCam.CopyFrom(cam);
        reflCam.enabled = false;
        reflCam.cullingMask = ~(1 << 4); // not the water
        reflCam.targetTexture = reflRT;
        var R = Matrix4x4.identity; R.m11 = -1;
        reflCam.worldToCameraMatrix = cam.worldToCameraMatrix * R;
        var c2w = reflCam.worldToCameraMatrix.inverse;
        reflCam.transform.position = new Vector3(c2w.m03, c2w.m13, c2w.m23);
        // oblique near plane: keep y > −0.08 (three: clip plane (0,1,0)·p + 0.08)
        var planeCS = c2w.transpose * new Vector4(0, 1, 0, 0.08f);
        reflCam.projectionMatrix = cam.CalculateObliqueMatrix(planeCS);
        GL.invertCulling = true;
        RenderPipeline.SubmitRenderRequest(reflCam, new UniversalRenderPipeline.SingleCameraRequest { destination = reflRT });
        GL.invertCulling = false;
        waterMaterial.SetTexture("_Refl", reflRT);
        waterMaterial.SetMatrix("_ReflVP", reflCam.projectionMatrix * reflCam.worldToCameraMatrix);
    }

    void WriteState(string path)
    {
        static double Avg(List<double> l) { if (l.Count == 0) return 0; double s = 0; foreach (var x in l) s += x; return s / l.Count; }
        static double Med(List<double> l) => Pct(l, 0.5);
        static double Pct(List<double> l, double q) { if (l.Count == 0) return 0; var c = new List<double>(l); c.Sort(); return c[Mathf.Min(c.Count - 1, (int)(c.Count * q))]; }
        var p = boat.position;
        string N(double v) => v.ToString("F2", CultureInfo.InvariantCulture);
        string json = "{" + string.Join(",",
            $"\"frames\":{gpuMs.Count}", $"\"gpuMsAvg\":{N(Avg(gpuMs))}", $"\"gpuMsMed\":{N(Med(gpuMs))}", $"\"gpuP95\":{N(Pct(gpuMs, 0.95))}",
            $"\"cpuMsAvg\":{N(Avg(cpuMs))}", $"\"cpuMsMed\":{N(Med(cpuMs))}",
            $"\"dtMed\":{N(Pct(dtMs, 0.5))}", $"\"dtP95\":{N(Pct(dtMs, 0.95))}", $"\"dtP99\":{N(Pct(dtMs, 0.99))}", $"\"dtMax\":{N(Pct(dtMs, 1))}",
            $"\"boat\":[{N(p.x)},{N(p.y)},{N(-p.z)}]", $"\"screen\":[{Screen.width},{Screen.height}]", $"\"scale\":{N(scale)}",
            $"\"gpu\":\"{SystemInfo.graphicsDeviceName}\"", $"\"api\":\"{SystemInfo.graphicsDeviceType}\"") + "}";
        File.WriteAllText(path, json);
    }
}
