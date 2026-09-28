using UnityEngine;

/// <summary>
/// CPU mirror of the Gerstner waves (src/environment/WaveField.ts) — the same packed uniforms the shaders use,
/// so the boat floats on exactly the surface that is drawn. three.js coordinates in and out.
/// </summary>
public class WaveField
{
    public const int MAX = 6;
    public readonly Vector4[] A = new Vector4[MAX], B = new Vector4[MAX];

    public WaveField(float[] a, float[] b)
    {
        for (int i = 0; i < MAX; i++)
        {
            A[i] = new Vector4(a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]);
            B[i] = new Vector4(b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]);
        }
    }

    void Displace(float px, float pz, float t, out float x, out float y, out float z)
    {
        x = y = z = 0;
        for (int i = 0; i < MAX; i++)
        {
            Vector4 a = A[i], b = B[i];
            float th = a.z * (a.x * px + a.y * pz) - a.w * t + b.z;
            float c = Mathf.Cos(th), s = Mathf.Sin(th);
            float qa = b.y * b.x;
            x += qa * a.x * c;
            z += qa * a.y * c;
            y += b.x * s;
        }
    }

    /// <summary>height and unit normal at three (x, z)</summary>
    public float Sample(float x, float z, float t, out Vector3 n)
    {
        float px = x, pz = z;
        for (int i = 0; i < 3; i++)
        {
            Displace(px, pz, t, out float dx, out _, out float dz);
            px = x - dx; pz = z - dz;
        }
        float h = 0, nx = 0, nz = 0, ny = 1;
        for (int i = 0; i < MAX; i++)
        {
            Vector4 a = A[i], b = B[i];
            float th = a.z * (a.x * px + a.y * pz) - a.w * t + b.z;
            float c = Mathf.Cos(th), s = Mathf.Sin(th);
            float wa = a.z * b.x;
            h += b.x * s;
            nx -= a.x * wa * c;
            nz -= a.y * wa * c;
            ny -= b.y * wa * s;
        }
        n = new Vector3(nx, ny, nz).normalized;
        return h;
    }
}
