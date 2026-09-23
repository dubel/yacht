// Water optical constants shared by every shader that sees light through water.
// Absorption/scattering per metre. Clearwater's values (MIT, © 2026 Lumaris) describe greenish coastal
// water; these are closer to a clear tropical lagoon: blue barely absorbed (pure-water-like), less
// particulate scattering → cyan shallows, blue depths, ~40 m visibility under water.
export const WATER_OPTICS_GLSL = /* glsl */ `
#ifndef WATER_OPTICS
#define WATER_OPTICS
const float WATER_IOR = 1.3335;
const vec3 WATER_SIG_A = vec3(0.34, 0.052, 0.034);
const vec3 WATER_SIG_S = vec3(0.018, 0.030, 0.044);
const vec3 WATER_SIG_T = WATER_SIG_A + WATER_SIG_S;
// exact unpolarised Fresnel for a dielectric (Clearwater); ci = cos(incidence), n = relative IOR
float fresnelDielectric(float ci, float n){
  ci = clamp(ci, 0.0, 1.0);
  float st2 = (1.0-ci*ci)/(n*n); if (st2 >= 1.0) return 1.0;
  float ct = sqrt(1.0-st2);
  float rs = (ci - n*ct)/(ci + n*ct), rp = (n*ci - ct)/(n*ci + ct);
  return 0.5*(rs*rs + rp*rp);
}
#endif
`;
