export interface GpuCapabilities {
  webgl2: boolean;
  floatColorBuffer: boolean;
  floatLinear: boolean;
  maxTextureSize: number;
  maxSamples: number;
  renderer: string;
}

/** Probe on a throwaway context so we can fail with a readable message before Three.js starts. */
export function probeCapabilities(): GpuCapabilities {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { webgl2: false, floatColorBuffer: false, floatLinear: false, maxTextureSize: 0, maxSamples: 0, renderer: '' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const caps: GpuCapabilities = {
    webgl2: true,
    floatColorBuffer: !!gl.getExtension('EXT_color_buffer_float'),
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return caps;
}

export function capabilityError(c: GpuCapabilities): string | null {
  if (!c.webgl2) return 'Ta przeglądarka nie obsługuje WebGL2.';
  if (!c.floatColorBuffer) return 'GPU nie potrafi renderować do tekstur zmiennoprzecinkowych (brak EXT_color_buffer_float).';
  return null;
}
