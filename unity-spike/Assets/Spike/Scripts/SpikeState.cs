using System;
using UnityEngine;

/// <summary>The web game's state exported by tools/dev/export-unity.mjs (three.js world coordinates).</summary>
[Serializable]
public class SpikeState
{
    public float time;
    public XZ wind;
    public Waves waves;
    public Env env;
    public Weather weather;
    public BoatS boat;
    public Cam camera;

    [Serializable] public class XZ { public float x, z; }
    [Serializable] public class Waves { public float[] A, B; }
    [Serializable] public class Env
    {
        public float[] lightDir, sunRadiance, skyIrradiance, fogColor, lightColor;
        public float fogDensity, lightIntensity, exposure, golden;
    }
    [Serializable] public class Weather { public float chop, whitecaps, rain; }
    [Serializable] public class Info { public float hullStern, hullBow, beam, keelDepth, deckHeight; }
    [Serializable] public class BoatS { public float[] position, quaternion; public Info info; }
    [Serializable] public class Cam { public float[] position, quaternion; public float fov, near, far; }

    public static SpikeState Parse(string json) => JsonUtility.FromJson<SpikeState>(json);

    /// <summary>three (x, y, z) → Unity (x, y, −z)</summary>
    public static Vector3 U(float[] a) => new Vector3(a[0], a[1], -a[2]);
    public static Vector3 V(float[] a) => new Vector3(a[0], a[1], a[2]);
    /// <summary>three quaternion (x, y, z, w) → Unity, mirrored in z</summary>
    public static Quaternion Q(float[] q) => new Quaternion(-q[0], -q[1], q[2], q[3]);
}
