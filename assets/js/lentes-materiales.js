/* ==========================================================================
   Emisha — lentes 3D: materiales
   Las texturas impresas (estrías, rombos, panal, celdas) se dibujan en un
   canvas como mapa de alturas y se convierten en mapa de normales: en la
   pieza real son relieve de verdad; aquí es la ilusión de relieve, que para
   verlo en pantalla es lo mismo y cuesta mil veces menos.

   Deja window.EmishaLentesMat = { crearArmazon, crearLente, crearMetal,
   crearSilicon }.
   ========================================================================== */
import * as THREE from './vendor/three-0.186.0.min.js';

const TAU = Math.PI * 2;
const frac = x => x - Math.floor(x);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/* ------------------------------------------------------ MAPAS DE ALTURA
   Cada textura: tamaño del mosaico en mm (se repite sin costura) y una
   función de altura h(x, y) en 0..1 con x, y en mm. */
const HEX_A = 1.25;
const PUNTOS_VORONOI = (() => {
  let s = 7;
  const azar = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  for (let i = 0; i < 16; i++) out.push([azar() * 10, azar() * 10]);
  return out;
})();

const ALTURAS = {
  acanalada: { mm: [10, 10], fuerza: 1.4, h: x => Math.pow(0.5 + 0.5 * Math.cos(TAU * x / 1.25), 0.6) },
  moleteada: {
    mm: [10, 10], fuerza: 1.6, h: (x, y) => {
      const p = 10 / 6;
      const t = f => 1 - Math.abs(2 * f - 1);
      return Math.min(t(frac((x + y) / p)), t(frac((x - y) / p)));
    }
  },
  hexagonal: {
    mm: [HEX_A * Math.sqrt(3) * 4, HEX_A * 3 * 2], fuerza: 1.5, h: (x, y) => {
      /* Distancia al centro de celda más cercano en una red de hexágonos. */
      const w = HEX_A * Math.sqrt(3), hh = HEX_A * 1.5;
      const fila = Math.round(y / hh);
      let mejor = Infinity;
      for (let df = -1; df <= 1; df++) {
        const f = fila + df, off = (f & 1) ? w / 2 : 0;
        const col = Math.round((x - off) / w);
        for (let dc = -1; dc <= 1; dc++) {
          const cx = (col + dc) * w + off, cy = f * hh;
          const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
          const d = Math.max(dx * 0.866 + dy * 0.5, dy) / HEX_A;   // distancia hexagonal
          mejor = Math.min(mejor, d);
        }
      }
      return 1 - smooth(0.72, 0.9, mejor);
    }
  },
  organica: {
    mm: [10, 10], fuerza: 1.3, h: (x, y) => {
      let f1 = Infinity, f2 = Infinity;
      PUNTOS_VORONOI.forEach(([px, py]) => {
        for (let ox = -10; ox <= 10; ox += 10) for (let oy = -10; oy <= 10; oy += 10) {
          const d = Math.hypot(x - px - ox, y - py - oy);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
      });
      return smooth(0.0, 0.45, f2 - f1);
    }
  }
};

/* Líneas de capa del acabado crudo (0.4 mm, un poco exageradas). */
const capas = (x, y) => 0.5 + 0.5 * Math.cos(TAU * y / 0.4);

const cache = new Map();

function mapaNormales(textura, crudo) {
  const clave = textura + '|' + crudo;
  if (cache.has(clave)) return cache.get(clave);
  const def = ALTURAS[textura];
  if (!def && !crudo) { cache.set(clave, null); return null; }
  const mm = def ? def.mm : [10, 10];
  const W = 384, H = Math.round(W * mm[1] / mm[0]);
  const alt = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = (i / W) * mm[0], y = (j / H) * mm[1];
    let h = def ? def.h(x, y) * def.fuerza : 0;
    if (crudo) h += capas(x, y) * 0.22;
    alt[j * W + i] = h;
  }
  const lienzo = document.createElement('canvas');
  lienzo.width = W; lienzo.height = H;
  const ctx = lienzo.getContext('2d'), img = ctx.createImageData(W, H);
  const pxPorMm = W / mm[0], k = pxPorMm * 0.09;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const hx = alt[j * W + (i + 1) % W] - alt[j * W + (i - 1 + W) % W];
    const hy = alt[((j + 1) % H) * W + i] - alt[((j - 1 + H) % H) * W + i];
    let nx = -hx * k, ny = hy * k, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const o = (j * W + i) * 4;
    img.data[o] = (nx * 0.5 + 0.5) * 255; img.data[o + 1] = (ny * 0.5 + 0.5) * 255;
    img.data[o + 2] = (nz * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(lienzo);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / mm[0], 1 / mm[1]);
  tex.anisotropy = 4;
  cache.set(clave, tex);
  return tex;
}

/* Veta de madera en gris (se multiplica por el color). Mosaico de 40 mm. */
function mapaMadera() {
  if (cache.has('madera')) return cache.get('madera');
  const W = 512, mm = 40, lienzo = document.createElement('canvas');
  lienzo.width = lienzo.height = W;
  const ctx = lienzo.getContext('2d'), img = ctx.createImageData(W, W);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const x = (i / W) * TAU, y = (j / W) * TAU;
    const onda = y * 11 + 0.55 * Math.sin(x + 0.5) + 0.22 * Math.sin(x * 3 + y * 2) + 0.1 * Math.sin(x * 7 - y);
    const veta = Math.pow(0.5 + 0.5 * Math.sin(onda * 2.2), 4) * (0.7 + 0.3 * Math.sin(y * 5 + x));
    const fibra = 0.5 + 0.5 * Math.sin(y * 150 + Math.sin(x * 5) * 3);
    const v = 0.93 - veta * 0.26 - fibra * 0.05;
    const o = (j * W + i) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v * 255; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(lienzo);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / mm, 1 / mm);
  cache.set('madera', tex);
  return tex;
}

/* Destellos del PLA Cosmic: hojuelas metálicas y lisas sobre fondo mate.
   Un solo canvas: el canal G es la rugosidad, el B lo metálico. */
function mapaDestellos(rugosidadBase) {
  const clave = 'destellos|' + rugosidadBase.toFixed(2);
  if (cache.has(clave)) return cache.get(clave);
  const W = 256, mm = 12, lienzo = document.createElement('canvas');
  lienzo.width = lienzo.height = W;
  const ctx = lienzo.getContext('2d');
  const g = Math.round(rugosidadBase * 255);
  ctx.fillStyle = 'rgb(0,' + g + ',0)';
  ctx.fillRect(0, 0, W, W);
  let s = 11;
  const azar = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = 'rgb(0,' + Math.round(30 + azar() * 40) + ',255)';
    ctx.beginPath(); ctx.arc(azar() * W, azar() * W, 1 + azar() * 2.2, 0, TAU); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(lienzo);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / mm, 1 / mm);
  cache.set(clave, tex);
  return tex;
}

/* ------------------------------------------------------------ ACABADOS */
const ACABADOS = {
  crudo:     { rugosidad: 0.70 },
  lijado:    { rugosidad: 0.86 },
  brillante: { rugosidad: 0.38, barniz: 1 },
  suave:     { rugosidad: 0.96, terciopelo: 1 }
};

/* Material de una zona del armazón. El color se aplica en el shader para
   poder hacer dos tonos o degradado sin partir la geometría: el frente
   entero es una sola pieza y el color depende de la altura. */
function crearArmazon() {
  const u = {
    uColor1: { value: new THREE.Color('#1b1b1b') },
    uColor2: { value: new THREE.Color('#e3e3e4') },
    uModo: { value: 0 },
    uYMin: { value: -20 }, uYMax: { value: 20 }
  };
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0 });
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vYObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvYObj = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vYObj;\nuniform vec3 uColor1;\nuniform vec3 uColor2;\nuniform float uModo;\nuniform float uYMin;\nuniform float uYMax;')
      .replace('#include <color_fragment>', [
        '#include <color_fragment>',
        'float tY = clamp((vYObj - uYMin) / max(uYMax - uYMin, 0.001), 0.0, 1.0);',
        'float fC = 1.0;',
        'if (uModo > 0.5 && uModo < 1.5) fC = smoothstep(0.47, 0.53, tY);',
        'else if (uModo > 1.5) fC = smoothstep(0.08, 0.92, tY);',
        'diffuseColor.rgb *= mix(uColor2, uColor1, fC);'
      ].join('\n'));
  };
  m.customProgramCacheKey = () => 'emisha-armazon';

  /* o: { color1, color2, modo (0 sólido, 1 dos tonos, 2 degradado),
          yMin, yMax, efecto (null|'madera'|'destellos'), textura, acabado, petg } */
  m.fijar = o => {
    u.uColor1.value.set(o.color1);
    u.uColor2.value.set(o.color2 || o.color1);
    u.uModo.value = o.modo || 0;
    if (o.yMin !== undefined) { u.uYMin.value = o.yMin; u.uYMax.value = o.yMax; }
    const a = ACABADOS[o.acabado] || ACABADOS.lijado;
    const rug = Math.max(0.05, a.rugosidad - (o.petg ? 0.06 : 0));
    m.normalMap = mapaNormales(o.textura, o.acabado === 'crudo');
    m.normalScale.set(1, 1);
    m.map = o.efecto === 'madera' ? mapaMadera() : null;
    if (o.efecto === 'destellos') {
      const t = mapaDestellos(rug);
      m.roughnessMap = t; m.metalnessMap = t; m.roughness = 1; m.metalness = 1;
    } else {
      m.roughnessMap = null; m.metalnessMap = null; m.roughness = rug; m.metalness = 0;
    }
    m.clearcoat = a.barniz ? 1 : 0;
    m.clearcoatRoughness = 0.06;
    m.sheen = a.terciopelo ? 1 : 0;
    m.sheenRoughness = 0.8;
    m.sheenColor.set(0x555555);
    m.needsUpdate = true;
  };
  return m;
}

/* --------------------------------------------------------------- LENTES */
let degradadoAlfa = null;
function mapaDegradado() {
  if (degradadoAlfa) return degradadoAlfa;
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const ctx = c.getContext('2d'), gr = ctx.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, '#fff'); gr.addColorStop(0.35, '#eee'); gr.addColorStop(0.85, '#222'); gr.addColorStop(1, '#111');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, 4, 128);
  degradadoAlfa = new THREE.CanvasTexture(c);
  return degradadoAlfa;
}

function crearLente() {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 0.12, roughness: 0.04, metalness: 0,
    depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.2
  });
  /* o: { sol, tinteHex, ar, azul, exterior (0..1, para el fotocromático) } */
  m.fijar = o => {
    const oscuro = o.sol === 'fotocromatico' ? (o.exterior || 0) : 1;
    let color = new THREE.Color(0xffffff), opacidad = 0.12;
    if (o.azul) { color.set('#fff3cf'); opacidad = 0.16; }
    if (o.sol === 'tinte' || o.sol === 'degradado') { color.set(o.tinteHex); opacidad = 0.8; }
    if (o.sol === 'polarizado') { color.set(o.tinteHex).multiplyScalar(0.7); opacidad = 0.88; }
    if (o.sol === 'fotocromatico') {
      color.lerp(new THREE.Color('#2b2f33'), oscuro);
      opacidad = 0.12 + (0.8 - 0.12) * oscuro;
    }
    m.color.copy(color);
    m.opacity = opacidad;
    m.alphaMap = o.sol === 'degradado' ? mapaDegradado() : null;
    m.specularIntensity = o.ar || o.sol === 'polarizado' ? 0.35 : 1;
    m.iridescence = o.ar ? 0.8 : o.azul ? 0.6 : 0;
    m.iridescenceIOR = 1.6;
    m.iridescenceThicknessRange = o.ar ? [380, 520] : [220, 320];
    m.needsUpdate = true;
  };
  return m;
}

function crearMetal() {
  return new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 1, roughness: 0.25 });
}
function crearSilicon() {
  return new THREE.MeshPhysicalMaterial({ color: 0xf4f6f8, roughness: 0.35, transparent: true, opacity: 0.6, depthWrite: false });
}

window.EmishaLentesMat = { crearArmazon, crearLente, crearMetal, crearSilicon };
