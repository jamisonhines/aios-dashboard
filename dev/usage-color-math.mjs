// Offline/test colour math: OKLab Euclidean Delta E x100, with Machado 2009
// severity-1 protan/deutan simulation, matching validate_palette.js.
export function linearRgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
}
export function lab([r, g, b]) {
  const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b);
  const m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b);
  const s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
  return [.2104542553*l + .793617785*m - .0040720468*s, 1.9779984951*l - 2.428592205*m + .4505937099*s, .0259040371*l + .7827717662*m - .808675766*s];
}
const matrices = {
  protan: [[.152286,1.052583,-.204868],[.114503,.786281,.099216],[-.003882,-.048116,1.051998]],
  deutan: [[.367322,.860646,-.227968],[.280085,.672501,.047413],[-.01182,.04294,.968881]],
};
export function vectors(hex) {
  const rgb = linearRgb(hex);
  return { normal: lab(rgb), ...Object.fromEntries(Object.entries(matrices).map(([kind, matrix]) => [kind, lab(matrix.map(row => Math.max(0, Math.min(1, row.reduce((sum, c, i) => sum + c*rgb[i], 0)))))])) };
}
export function distance(a, b) { return 100*Math.hypot(...a.map((v, i) => v - b[i])); }
export function separation(a, b) {
  const va = typeof a === 'string' ? vectors(a) : a, vb = typeof b === 'string' ? vectors(b) : b;
  return { normal: distance(va.normal, vb.normal), cvd: Math.min(distance(va.protan, vb.protan), distance(va.deutan, vb.deutan)) };
}
export function fromLch(L, C, h) {
  const a = C*Math.cos(h*Math.PI/180), b = C*Math.sin(h*Math.PI/180);
  const l = (L+.3963377774*a+.2158037573*b)**3, m = (L-.1055613458*a-.0638541728*b)**3, s = (L-.0894841775*a-1.291485548*b)**3;
  return '#'+[4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s]
    .map(c => Math.round(255*Math.max(0, Math.min(1, c <= .0031308 ? 12.92*c : 1.055*c**(1/2.4)-.055))))
    .map(c => c.toString(16).padStart(2, '0')).join('');
}
export function hue(hex) {
  const [,a,b]=lab(linearRgb(hex));
  return (Math.atan2(b,a)*180/Math.PI+360)%360;
}
export function legalCandidate(hex, mode) {
  const [L, a, b] = lab(linearRgb(hex));
  return L >= (mode === 'dark' ? .48 : .43) && L <= (mode === 'dark' ? .67 : .77) && Math.hypot(a,b) >= .10;
}
