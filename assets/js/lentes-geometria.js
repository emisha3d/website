/* ==========================================================================
   Emisha — lentes 3D: geometría paramétrica del armazón
   Todo en milímetros. Origen en el centro del puente, a la altura del centro
   de los lentes. +X hacia la derecha de quien MIRA los lentes de frente (la
   izquierda de quien los trae puestos), +Y arriba, +Z hacia afuera del frente.
   Las varillas van hacia −Z.

   Deja window.EmishaLentesGeo = { construir, contornoLente, rutaSvgLente,
   construirDije, formasDije }.
   ========================================================================== */
import * as THREE from './vendor/three-0.186.0.min.js';

const N_CONTORNO = 144;          // puntos por contorno de lente
const GROSOR_FRENTE = 4.6;       // mm, de adelante hacia atrás
const LABIO = 1.0;               // cuánto tapa el aro el borde del lente
const BISEL = 0.7;               // bisel de las piezas extruidas

/* Parámetros de cada forma. razon = alto/ancho. nSup/nInf = exponente de
   superelipse arriba y abajo (2 = elipse, 4+ = casi rectángulo).
   aro = ancho del aro en mm: base, extra arriba, extra afuera. */
const GEO_FORMAS = {
  clasico:     { razon: 0.76, nSup: 5.0, nInf: 3.0, trapecio: 0.16, inclina: 0.07, aro: [4.2, 3.0, 1.0] },
  redondo:     { razon: 0.94, nSup: 2.05, nInf: 2.05, aro: [2.8, 0.0, 0.0] },
  cuadrado:    { razon: 0.84, nSup: 4.2, nInf: 4.2, aro: [3.8, 0.8, 0.4] },
  rectangular: { razon: 0.60, nSup: 4.8, nInf: 4.8, aro: [3.4, 0.6, 0.4] },
  gato:        { razon: 0.66, nSup: 3.4, nInf: 2.4, ala: 0.75, inclina: 0.16, aro: [3.8, 1.6, 2.4] },
  aviador:     { razon: 0.84, nSup: 3.8, nInf: 2.2, gota: 0.24, aro: [2.6, 0.4, 0.0] }
};

function geoForma(id) { return GEO_FORMAS[id] || GEO_FORMAS.clasico; }

/* ------------------------------------------------------------ CONTORNOS */

/* Contorno del lente DERECHO (el que queda en +X), centrado en (0,0),
   antihorario, con `ancho` exacto de lado a lado. u=+1 es el lado de la
   sien, u=−1 el de la nariz. */
function contornoLente(formaId, ancho, n) {
  const g = geoForma(formaId);
  n = n || N_CONTORNO;
  const crudos = [];
  const M = 720;
  for (let i = 0; i < M; i++) {
    const t = (i / M) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    const e = s >= 0 ? g.nSup : g.nInf;
    let u = Math.sign(c) * Math.pow(Math.abs(c), 2 / e);
    let v = Math.sign(s) * Math.pow(Math.abs(s), 2 / e);
    if (g.trapecio && v < 0) u *= 1 - g.trapecio * (-v) * (0.5 + 0.5 * Math.max(0, u));
    if (g.inclina && v > 0) v += g.inclina * u * v;
    if (g.ala) {
      const uu = Math.max(0, u);
      if (v > 0) { v += g.ala * uu * uu * uu * v; u += 0.10 * uu * uu * uu * v; }
      else u *= 1 - 0.14 * (-v) * uu;
    }
    if (g.gota && v < 0) v *= 1 + g.gota * (1 - u) * 0.5;
    crudos.push(new THREE.Vector2(u, v * g.razon));
  }
  /* Encuadre: ancho exacto y centro de la caja en el origen. */
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  crudos.forEach(p => { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); });
  const k = ancho / (x1 - x0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  crudos.forEach(p => { p.x = (p.x - cx) * k; p.y = (p.y - cy) * k; });
  const pts = remuestrear(crudos, n);
  return { pts, ancho, alto: (y1 - y0) * k };
}

/* Mismo número de puntos, a igual distancia sobre el perímetro. */
function remuestrear(pts, n) {
  const m = pts.length, acum = [0];
  for (let i = 1; i <= m; i++) acum.push(acum[i - 1] + pts[i % m].distanceTo(pts[i - 1]));
  const total = acum[m], out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = (i / n) * total;
    while (acum[j + 1] < d) j++;
    const a = pts[j], b = pts[(j + 1) % m];
    const f = (d - acum[j]) / ((acum[j + 1] - acum[j]) || 1);
    out.push(new THREE.Vector2(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f));
  }
  return out;
}

/* Desplaza un contorno antihorario hacia afuera (d>0) o adentro (d<0).
   d puede ser función (punto, índice) → mm. */
function desplazar(pts, d) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const t1 = new THREE.Vector2(b.x - a.x, b.y - a.y).normalize();
    const t2 = new THREE.Vector2(c.x - b.x, c.y - b.y).normalize();
    const n1 = new THREE.Vector2(t1.y, -t1.x), n2 = new THREE.Vector2(t2.y, -t2.x);
    const nm = n1.clone().add(n2).normalize();
    const dist = typeof d === 'function' ? d(b, i) : d;
    const k = dist / Math.max(nm.dot(n1), 0.5);
    out.push(new THREE.Vector2(b.x + nm.x * k, b.y + nm.y * k));
  }
  return out;
}

function espejoX(pts) { return pts.map(p => new THREE.Vector2(-p.x, p.y)).reverse(); }
function mover(pts, dx, dy) { return pts.map(p => new THREE.Vector2(p.x + dx, p.y + dy)); }

/* Ruta SVG del lente para los íconos de la interfaz (caja de 0..w). */
function rutaSvgLente(formaId, w) {
  const { pts, alto } = contornoLente(formaId, w, 64);
  return {
    d: pts.map((p, i) => (i ? 'L' : 'M') + (p.x + w / 2).toFixed(2) + ' ' + (alto / 2 - p.y).toFixed(2)).join(' ') + 'Z',
    alto
  };
}

/* ------------------------------------------------------------ EXTRUSIÓN */

/* Extruye un contorno (con agujeros) con el frente en z=0 y la espalda en
   z=−grosor. Las UV salen en milímetros, que es lo que esperan las
   texturas (se repiten cada tantos mm). */
function extruir(contorno, agujeros, grosor, bisel) {
  const b = bisel === undefined ? BISEL : bisel;
  const forma = new THREE.Shape(contorno);
  (agujeros || []).forEach(h => forma.holes.push(new THREE.Path(h)));
  const prof = Math.max(0.2, grosor - 2 * b);
  const geo = new THREE.ExtrudeGeometry(forma, {
    depth: prof, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b,
    bevelSegments: 3, curveSegments: 8
  });
  geo.translate(0, 0, -(prof + b));
  return geo;
}

/* Espejo en X que conserva el sentido de las caras. */
function espejarGeometria(geo) {
  const g = geo.clone();
  g.scale(-1, 1, 1);
  if (g.index) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  } else {
    ['position', 'normal', 'uv'].forEach(nombre => {
      const at = g.getAttribute(nombre);
      if (!at) return;
      const s = at.itemSize, arr = at.array;
      for (let i = 0; i < at.count; i += 3) {
        for (let k = 0; k < s; k++) {
          const a = (i + 1) * s + k, c = (i + 2) * s + k;
          const t = arr[a]; arr[a] = arr[c]; arr[c] = t;
        }
      }
    });
  }
  return g;
}

/* Banda a lo largo de una curva 2D (puentes, barras): polígono cerrado. */
function banda(curva, alto, muestras) {
  const n = muestras || 40, arriba = [], abajo = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = curva.getPoint(t), tg = curva.getTangent(t);
    const nx = -tg.y, ny = tg.x;
    const h = (typeof alto === 'function' ? alto(t) : alto) / 2;
    arriba.push(new THREE.Vector2(p.x + nx * h, p.y + ny * h));
    abajo.push(new THREE.Vector2(p.x - nx * h, p.y - ny * h));
  }
  const pol = arriba.concat(abajo.reverse());
  if (THREE.ShapeUtils.isClockWise(pol)) pol.reverse();
  return pol;
}

/* ------------------------------------------------------------- VARILLAS */

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/* Perfil de cada varilla: alto h(s) y grosor t(s) en mm, ángulo de la
   curva de la oreja, apertura hacia afuera y si abraza la cabeza. */
const GEO_VARILLAS = {
  delgada:   { h: () => 3.2, t: () => 2.4, curva: 30, abre: 3.0 },
  clasica:   { h: s => lerp(7.6, 4.2, smooth(0, 38, s)), t: () => 3.0, curva: 26, abre: 3.0 },
  ancha:     { h: (s, L) => lerp(12, 6.0, smooth(0, L - 30, s)), t: () => 3.4, curva: 20, abre: 2.5 },
  deportiva: { h: (s, L) => lerp(9, 4.6, smooth(0, L * 0.6, s)), t: () => 3.2, curva: 16, abre: 6.0, abraza: true }
};
const LARGO_CURVA = 32;   // mm de la punta que se dobla detrás de la oreja

function rutaVarilla(tipo, L, lado, s) {
  const g = GEO_VARILLAS[tipo] || GEO_VARILLAS.clasica;
  const ang = g.curva * Math.PI / 180, sb = L - LARGO_CURVA;
  let y = 0, z;
  if (s <= sb) z = -s;
  else {
    const R = LARGO_CURVA / ang, a = (s - sb) / R;
    z = -(sb + R * Math.sin(a));
    y = -R * (1 - Math.cos(a));
  }
  let x = s * Math.sin(g.abre * Math.PI / 180);
  if (g.abraza) x -= 0.0009 * s * s;
  return new THREE.Vector3(lado * x, y, z);
}

/* Barre una sección de rectángulo redondeado a lo largo de la ruta.
   Devuelve la geometría y un `marco(s)` para colgarle cosas (dijes, placa). */
function construirVarilla(tipo, L, lado) {
  const g = GEO_VARILLAS[tipo] || GEO_VARILLAS.clasica;
  const S = 90, K = 20, E = 4;
  const pos = [], nor = [], uv = [], idx = [], marcos = [];
  const arriba = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= S; i++) {
    const s = (i / S) * L;
    const p = rutaVarilla(tipo, L, lado, s);
    const T = rutaVarilla(tipo, L, lado, Math.min(L, s + 0.5)).sub(rutaVarilla(tipo, L, lado, Math.max(0, s - 0.5))).normalize();
    const N = arriba.clone().sub(T.clone().multiplyScalar(arriba.dot(T))).normalize();
    const B = new THREE.Vector3().crossVectors(T, N);
    const punta = 0.62 + 0.38 * (1 - smooth(L - 9, L, s));
    const h = g.h(s, L) * punta, t = g.t(s, L) * (0.8 + 0.2 * punta);
    const a = t / 2, b = h / 2;
    marcos.push({ s, p, T, N, B, h, t });
    const perim = Math.PI * (a + b);
    for (let k = 0; k <= K; k++) {
      const f = (k / K) * Math.PI * 2, c = Math.cos(f), sn = Math.sin(f);
      const cx = Math.sign(c) * Math.pow(Math.abs(c), 2 / E) * a;
      const cy = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / E) * b;
      const nx = Math.sign(cx) * Math.pow(Math.abs(cx / a), E - 1) / a;
      const ny = Math.sign(cy) * Math.pow(Math.abs(cy / b), E - 1) / b;
      const v = p.clone().addScaledVector(B, cx).addScaledVector(N, cy);
      const n = B.clone().multiplyScalar(nx).addScaledVector(N, ny).normalize();
      pos.push(v.x, v.y, v.z); nor.push(n.x, n.y, n.z); uv.push(s, (k / K) * perim);
    }
  }
  const R = K + 1;
  for (let i = 0; i < S; i++) for (let k = 0; k < K; k++) {
    const a = i * R + k, b = (i + 1) * R + k, c = i * R + k + 1, d = (i + 1) * R + k + 1;
    idx.push(a, b, c, b, d, c);
  }
  /* Tapas: la de la punta mira hacia +T, la del inicio hacia −T. */
  [[0, -1], [S, 1]].forEach(([i, sentido]) => {
    const m = marcos[i];
    const centro = m.p.clone().addScaledVector(m.T, sentido * 0.6);
    const ci = pos.length / 3;
    pos.push(centro.x, centro.y, centro.z); nor.push(m.T.x * sentido, m.T.y * sentido, m.T.z * sentido); uv.push(m.s, 0);
    const base = pos.length / 3;
    for (let k = 0; k <= K; k++) {
      const j = (i * R + k) * 3;
      pos.push(pos[j], pos[j + 1], pos[j + 2]); nor.push(m.T.x * sentido, m.T.y * sentido, m.T.z * sentido); uv.push(uv[(i * R + k) * 2], uv[(i * R + k) * 2 + 1]);
    }
    for (let k = 0; k < K; k++) {
      if (sentido > 0) idx.push(ci, base + k + 1, base + k);
      else idx.push(ci, base + k, base + k + 1);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const marco = s => marcos[Math.max(0, Math.min(S, Math.round((s / L) * S)))];
  return { geo, marco };
}

/* ------------------------------------------------------------ ARMAZÓN */

/* opciones: { forma, anchoLente, puente, varilla, tipoPuente, tipoVarilla,
               bisagra, detalles:{remaches,ceja,placa} }
   mats:     { frente, puente, varillas, ceja, metal, lente, silicon }
   → { grupo, lugares, medidas, lentes:[mesh,mesh] } */
function construir(o, mats) {
  const grupo = new THREE.Group();
  const A = o.anchoLente, b = o.puente, T = GROSOR_FRENTE;
  const g = geoForma(o.forma);
  const lente = contornoLente(o.forma, A);
  const H = lente.alto, cx = b / 2 + A / 2;
  const [aroBase, aroSup, aroExt] = g.aro;
  const anchoAro = p => aroBase + aroSup * smooth(0.05, 0.9, p.y / (H / 2)) + aroExt * smooth(0.35, 1, p.x / (A / 2));

  const exterior = desplazar(lente.pts, p => anchoAro(p) - BISEL);
  const interior = desplazar(lente.pts, -(LABIO - BISEL));
  const extDer = mover(exterior, cx, 0);

  function malla(geo, mat, lista) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    grupo.add(m);
    if (lista) lista.push(m);
    return m;
  }
  const par = (geo, mat) => { malla(geo, mat); malla(espejarGeometria(geo), mat); };

  /* Aros. */
  par(extruir(extDer, [mover(interior, cx, 0)], T), mats.frente);

  /* Lentes: el contorno completo, con una curva suave hacia adelante. El
     borde queda metido en el aro. UV normalizadas a la caja del lente
     (el degradado del tinte las usa). */
  const lentes = [];
  [1, -1].forEach(lado => {
    const pts = lado > 0 ? lente.pts : espejoX(lente.pts);
    const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 1.4, bevelEnabled: false, curveSegments: 4 });
    const p = geo.getAttribute('position'), u = geo.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      const r2 = (x * x) / ((A / 2) * (A / 2)) + (y * y) / ((H / 2) * (H / 2));
      p.setZ(i, p.getZ(i) - T / 2 - 0.7 + 1.3 * Math.max(0, 1 - r2));
      u.setXY(i, (x + A / 2) / A, (y + H / 2) / H);
      p.setX(i, x + lado * cx);
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mats.lente);
    m.renderOrder = 2;
    grupo.add(m); lentes.push(m);
  });

  /* Altura de la bisagra y borde exterior del aro a esa altura. */
  const yH = H / 2 * (o.forma === 'aviador' || o.forma === 'gato' ? 0.5 : 0.4);
  let xExt = 0;
  extDer.forEach(p => { if (Math.abs(p.y - yH) < 3) xExt = Math.max(xExt, p.x + BISEL); });
  let yTopeAro = 0;
  extDer.forEach(p => { yTopeAro = Math.max(yTopeAro, p.y + BISEL); });
  const topeSobre = x => {   // y más alta del aro cerca de una x (lado derecho)
    let y = -Infinity;
    extDer.forEach(p => { if (Math.abs(p.x - x) < 3) y = Math.max(y, p.y + BISEL); });
    return y;
  };

  /* Puente. */
  const H2 = H;
  let curva, altoBanda, topePuente;
  const ext = b / 2 - aroBase * 0.4;   // el pie del puente queda dentro del aro, no asoma al lente
  if (o.tipoPuente === 'cerradura') {
    curva = new THREE.CatmullRomCurve3([
      new THREE.Vector3(ext, 0.02 * H2, 0), new THREE.Vector3(b / 2 - 1.6, 0.16 * H2, 0),
      new THREE.Vector3(b * 0.22, 0.30 * H2 + 1.2, 0), new THREE.Vector3(0, 0.32 * H2 + 1.5, 0),
      new THREE.Vector3(-b * 0.22, 0.30 * H2 + 1.2, 0), new THREE.Vector3(-(b / 2 - 1.6), 0.16 * H2, 0),
      new THREE.Vector3(-ext, 0.02 * H2, 0)
    ]);
    altoBanda = 3.6;
  } else {
    const yPie = o.tipoPuente === 'doble' ? 0.10 * H2 : o.tipoPuente === 'plaquetas' ? 0.24 * H2 : 0.18 * H2;
    curva = new THREE.QuadraticBezierCurve(
      new THREE.Vector2(ext, yPie), new THREE.Vector2(0, yPie + 0.12 * H2 + 2.5), new THREE.Vector2(-ext, yPie));
    altoBanda = o.tipoPuente === 'plaquetas' ? 3.2 : 4.4;
  }
  const polPuente = banda(curva, altoBanda);
  topePuente = Math.max(...polPuente.map(p => p.y));
  malla(extruir(polPuente, null, T - 0.4), mats.puente);

  if (o.tipoPuente === 'doble') {
    const yb = H / 2 + (aroBase + aroSup) * 0.45;
    const xb = b / 2 + A * 0.32;
    const barra = new THREE.QuadraticBezierCurve(
      new THREE.Vector2(xb, topeSobre(xb) - 1.6), new THREE.Vector2(0, yb + 2.2), new THREE.Vector2(-xb, topeSobre(xb) - 1.6));
    const pol = banda(barra, 2.6);
    topePuente = Math.max(topePuente, ...pol.map(p => p.y));
    malla(extruir(pol, null, T - 1.2, 0.5), mats.puente);
  }

  if (o.tipoPuente === 'plaquetas') {
    [1, -1].forEach(lado => {
      const almohada = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), mats.silicon);
      almohada.scale.set(2.4, 5.2, 1.2);
      almohada.position.set(lado * (b / 2 + 0.6), -0.14 * H, -T - 4.2);
      almohada.rotation.y = lado * 0.55;
      grupo.add(almohada);
      const brazo = new THREE.TubeGeometry(new THREE.LineCurve3(
        new THREE.Vector3(lado * (b / 2 + 2.2), 0.08 * H, -T + 0.5),
        new THREE.Vector3(lado * (b / 2 + 1.0), -0.12 * H, -T - 3.6)), 1, 0.45, 8);
      malla(brazo, mats.metal);
    });
  }

  /* Terminales: la pieza en L que lleva del aro hacia atrás, a la bisagra. */
  const gv = GEO_VARILLAS[o.tipoVarilla] || GEO_VARILLAS.clasica;
  const altoTerminal = Math.max(7.5, gv.h(0, o.varilla) + 1.4);
  const fondo = T + 6;
  const perfil = [
    [xExt - 5.5, 0], [xExt - 1.2, 0], [xExt + 0.2, 0.4], [xExt + 0.9, 1.6],
    [xExt + 0.9, fondo], [xExt - 2.8, fondo], [xExt - 2.8, T], [xExt - 5.5, T]
  ].map(([x, zz]) => new THREE.Vector2(x, zz));
  const terminal = new THREE.ExtrudeGeometry(new THREE.Shape(perfil), {
    depth: altoTerminal - 1.2, bevelEnabled: true, bevelThickness: 0.6, bevelSize: 0.6, bevelSegments: 3
  });
  terminal.rotateX(-Math.PI / 2);   // (x, zz, e) → (x, e, −zz)
  terminal.computeBoundingBox();
  const bb = terminal.boundingBox;
  terminal.translate(0, yH - (bb.min.y + bb.max.y) / 2, 0);
  par(terminal, mats.frente);

  /* Bisagras y varillas. lado +1 = +X (izquierda de quien los trae puestos). */
  const xBisagra = xExt - 0.9, zBisagra = -fondo;
  const lugares = {};
  const varillas = [];
  [1, -1].forEach(lado => {
    const v = construirVarilla(o.tipoVarilla, o.varilla, lado);
    const gv2 = new THREE.Group();
    gv2.position.set(lado * xBisagra, yH, zBisagra);
    const mv = new THREE.Mesh(v.geo, mats.varillas);
    mv.castShadow = true; mv.receiveShadow = true;
    gv2.add(mv);
    grupo.add(gv2);
    varillas.push(gv2);

    if (o.bisagra === 'visible') {
      for (let k = -1; k <= 1; k++) {
        const barril = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 1.9, 16), mats.metal);
        barril.position.set(lado * (xBisagra + 0.4), yH + k * 2.2, zBisagra + 0.6);
        grupo.add(barril);
      }
    }
    if (o.detalles && o.detalles.placa) {
      const m = v.marco(13);
      const placa = new THREE.Mesh(new THREE.BoxGeometry(0.5, Math.min(3.2, m.h * 0.6), 9), mats.metal);
      placa.position.copy(m.p).addScaledVector(m.B, lado * (m.t / 2 + 0.1)).add(gv2.position);
      grupo.add(placa);
    }
    const nombre = lado > 0 ? 'izq' : 'der';
    [[1, 26], [2, 50]].forEach(([n, s]) => {
      const m = v.marco(s);
      const p = m.p.clone().addScaledVector(m.B, lado * (m.t / 2 + 0.3)).add(gv2.position);
      lugares['varilla-' + nombre + '-' + n] = { pos: p, giroY: lado * Math.PI / 2 };
    });
    lugares['esquina-' + nombre] = { pos: new THREE.Vector3(lado * (xExt - 3.2), yH - 1.5, 0.8), giroY: 0 };
    lugares['ceja-' + nombre] = { pos: new THREE.Vector3(lado * cx, topeSobre(cx) - 1.2, 0.8), giroY: 0 };
  });
  lugares['ceja-centro'] = { pos: new THREE.Vector3(0, topePuente + 2.2, 0.4), giroY: 0 };

  /* Remaches. */
  if (o.detalles && o.detalles.remaches) {
    [1, -1].forEach(lado => [2.4, 5.4].forEach(dx => {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 1.0, 18), mats.metal);
      r.rotation.x = Math.PI / 2;
      r.position.set(lado * (xExt - dx), yH + 1.6, 0.25);
      r.userData.remache = lado > 0 ? 'izq' : 'der';
      grupo.add(r);
    }));
  }

  /* Ceja sobrepuesta: arco superior de cada aro, encima del frente. */
  if (o.detalles && o.detalles.ceja) {
    const yc = 0.10 * H;
    const fuera = mover(desplazar(lente.pts, p => anchoAro(p) + 0.5), cx, 0);
    const dentro = mover(desplazar(lente.pts, -1.2), cx, 0);
    const mitad = Math.round(N_CONTORNO / 2);
    const arcoF = [], arcoD = [];
    for (let i = 0; i <= mitad; i++) {
      if (fuera[i].y > yc) arcoF.push(fuera[i]);
      if (dentro[i].y > yc + 1.5) arcoD.push(dentro[i]);
    }
    if (arcoF.length > 3 && arcoD.length > 3) {
      const pol = arcoF.concat(arcoD.reverse());
      if (THREE.ShapeUtils.isClockWise(pol)) pol.reverse();
      const geo = extruir(pol, null, 1.6, 0.5);
      geo.translate(0, 0, 1.4);
      par(geo, mats.ceja);
    }
  }

  /* Medidas reales de lo que se construyó. */
  const caja = new THREE.Box3().setFromObject(grupo);
  return {
    grupo, lugares, lentes, varillas,
    medidas: {
      anchoTotal: caja.max.x - caja.min.x, altoLente: H,
      yMinFrente: -H / 2 - aroBase - 1, yMaxFrente: Math.max(yTopeAro, topePuente),
      caja
    }
  };
}

/* ---------------------------------------------------------------- DIJES
   Cada dije es una lista de capas 2D: forma, color, altura (z) y grosor.
   De la misma lista salen la pieza 3D y el ícono SVG de la interfaz. */

function circulo(cx, cy, r, n) {
  const pts = [];
  n = n || 32;
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r)); }
  return pts;
}
function elipse(cx, cy, rx, ry, giro, n) {
  const c = Math.cos(giro || 0), s = Math.sin(giro || 0);
  return circulo(0, 0, 1, n || 32).map(p => new THREE.Vector2(cx + p.x * rx * c - p.y * ry * s, cy + p.x * rx * s + p.y * ry * c));
}
const poli = arr => arr.map(([x, y]) => new THREE.Vector2(x, y));
function deForma(f, n) { return f.getPoints(n || 12); }

const DEF_DIJES = {
  estrella: () => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = Math.PI / 2 + (i / 10) * Math.PI * 2, r = i % 2 ? 2.4 : 5.6;
      pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
    }
    return [{ pts, color: '#f5c518' }];
  },
  corazon: () => {
    const f = new THREE.Shape();
    f.moveTo(0, -4.8);
    f.bezierCurveTo(-1.2, -3.6, -5.4, -1.2, -5.4, 1.4);
    f.bezierCurveTo(-5.4, 4.0, -2.4, 5.4, 0, 2.8);
    f.bezierCurveTo(2.4, 5.4, 5.4, 4.0, 5.4, 1.4);
    f.bezierCurveTo(5.4, -1.2, 1.2, -3.6, 0, -4.8);
    return [{ pts: deForma(f), color: '#e0344a' }];
  },
  rayo: () => [{ pts: poli([[2.4, 5.6], [-3.2, -0.2], [-0.3, -0.2], [-1.9, -5.6], [3.4, 0.9], [0.5, 0.9]]), color: '#ffcc1f' }],
  flor: () => {
    const pts = [];
    for (let i = 0; i < 80; i++) {
      const a = (i / 80) * Math.PI * 2;
      const r = 2.9 + 2.5 * Math.pow(Math.abs(Math.cos(2.5 * a)), 0.8);
      pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
    }
    return [{ pts, color: '#e85d9a' }, { pts: circulo(0, 0, 1.8, 24), color: '#ffd23f', z: 1.6, prof: 1.0 }];
  },
  calavera: () => {
    const f = new THREE.Shape();
    f.moveTo(-2.7, -1.2);
    f.absarc(0, 1.2, 4.6, Math.PI + 0.55, -0.55, true);
    f.lineTo(2.7, -1.2); f.lineTo(2.6, -4.6); f.quadraticCurveTo(2.6, -5.4, 1.8, -5.4);
    f.lineTo(-1.8, -5.4); f.quadraticCurveTo(-2.6, -5.4, -2.6, -4.6); f.lineTo(-2.7, -1.2);
    const agujeros = [circulo(-1.75, 0.8, 1.3, 20), circulo(1.75, 0.8, 1.3, 20), poli([[0, -0.9], [-0.7, -2.1], [0.7, -2.1]])];
    return [
      { pts: circulo(0, 0.2, 3.6, 24), color: '#1a1a1a', z: -0.2, prof: 0.6 },
      { pts: deForma(f), agujeros, color: '#f2ede2' },
      { pts: circulo(0, 3.6, 1.0, 16), color: '#e85d9a', z: 1.6, prof: 0.6 }
    ];
  },
  nopal: () => [
    { pts: elipse(-0.6, -1.0, 3.6, 4.6, -0.1), color: '#3e9a48' },
    { pts: elipse(3.0, 3.4, 1.7, 2.3, -0.5), color: '#48a852', z: 0.2 },
    { pts: circulo(3.4, 5.4, 1.1, 16), color: '#ff5d8f', z: 1.4, prof: 0.8 },
    { pts: circulo(-1.6, 0.2, 0.35, 8), color: '#d8f0c0', z: 1.6, prof: 0.5 },
    { pts: circulo(0.6, -2.4, 0.35, 8), color: '#d8f0c0', z: 1.6, prof: 0.5 },
    { pts: circulo(-1.2, -3.8, 0.35, 8), color: '#d8f0c0', z: 1.6, prof: 0.5 }
  ],
  chile: () => {
    const f = new THREE.Shape();
    f.moveTo(-1.6, 3.4);
    f.bezierCurveTo(-4.0, 1.0, -3.2, -3.8, 2.0, -5.4);
    f.bezierCurveTo(-0.4, -2.6, 0.8, 0.8, 1.8, 3.2);
    f.quadraticCurveTo(0.1, 4.2, -1.6, 3.4);
    const tallo = new THREE.Shape();
    tallo.moveTo(-2.0, 3.2); tallo.quadraticCurveTo(0, 5.0, 2.2, 3.1); tallo.lineTo(0.6, 4.3);
    tallo.lineTo(1.4, 6.2); tallo.lineTo(0.5, 6.4); tallo.lineTo(-0.2, 4.5); tallo.lineTo(-2.0, 3.2);
    return [{ pts: deForma(f), color: '#d62828' }, { pts: deForma(tallo, 8), color: '#2f8a3a', z: 0.6 }];
  },
  emisha: () => [
    { pts: circulo(0, 0, 5.2, 40), color: '#0b6bcb' },
    { pts: poli([[-2, -2.8], [2.3, -2.8], [2.3, -1.7], [-0.8, -1.7], [-0.8, -0.5], [1.7, -0.5], [1.7, 0.5],
                 [-0.8, 0.5], [-0.8, 1.7], [2.3, 1.7], [2.3, 2.8], [-2, 2.8]]), color: '#ffffff', z: 1.6, prof: 0.8 }
  ]
};

const matsDije = {};
function matDije(color) {
  if (!matsDije[color]) matsDije[color] = new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.2 });
  return matsDije[color];
}

/* Pieza 3D del dije: el frente mira a +Z, la espalda está en z=0 y el
   perno se mete hacia −Z. */
function construirDije(id) {
  const capas = (DEF_DIJES[id] || DEF_DIJES.estrella)();
  const g = new THREE.Group();
  capas.forEach(c => {
    const forma = new THREE.Shape(c.pts);
    (c.agujeros || []).forEach(h => forma.holes.push(new THREE.Path(h)));
    const prof = c.prof || 1.6;
    const geo = new THREE.ExtrudeGeometry(forma, { depth: prof, bevelEnabled: true, bevelThickness: 0.35, bevelSize: 0.3, bevelSegments: 2, curveSegments: 10 });
    geo.translate(0, 0, (c.z || 0) + 0.35);
    const m = new THREE.Mesh(geo, matDije(c.color));
    m.castShadow = true;
    g.add(m);
  });
  const perno = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 2.6, 12), matDije(capas[0].color));
  perno.rotation.x = Math.PI / 2;
  perno.position.z = -1.1;
  g.add(perno);
  return g;
}

/* Ícono SVG (cadena) del dije, en una caja de −7..7. */
function iconoDije(id) {
  const capas = (DEF_DIJES[id] || DEF_DIJES.estrella)();
  const ruta = pts => pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(2) + ' ' + (-p.y).toFixed(2)).join(' ') + 'Z';
  const cuerpo = capas.map(c => {
    const d = ruta(c.pts) + (c.agujeros || []).map(ruta).join(' ');
    return '<path d="' + d + '" fill="' + c.color + '" fill-rule="evenodd" stroke="rgba(0,0,0,.25)" stroke-width=".3"/>';
  }).join('');
  return '<svg viewBox="-7 -7 14 14" aria-hidden="true">' + cuerpo + '</svg>';
}

window.EmishaLentesGeo = { construir, contornoLente, rutaSvgLente, construirDije, iconoDije, GROSOR_FRENTE };
