/* ==========================================================================
   Emisha — lentes 3D: prueba con la cámara
   MediaPipe Face Landmarker corre en el navegador (WebAssembly). El video no
   sale del dispositivo: ni se sube ni se graba.

   El detector (~15 MB) se descarga SOLO cuando alguien pide la cámara.

   Escala real: el iris humano mide ~11.7 mm de ancho casi en cualquier
   adulto, así que sirve de regla. Con él se calibra la distancia entre las
   esquinas de los ojos y de ahí sale cuántos píxeles mide un milímetro. Por
   eso una talla L se ve más grande que una S en la cara, como en la vida.

   Deja window.EmishaLentesCam = { iniciar }.
   ========================================================================== */
import * as THREE from './vendor/three-0.186.0.min.js';

const BASE = new URL('./vendor/mediapipe-1.0.1/', import.meta.url).href;
const IRIS_MM = 11.7;

/* Puntos del modelo de 478 (índices de MediaPipe). */
const P = {
  ojoDerExt: 33, ojoDerInt: 133, ojoIzqInt: 362, ojoIzqExt: 263,
  frente: 10, barbilla: 152,
  irisDer: [469, 471], irisIzq: [474, 476]
};

/* Filtro "One Euro": suaviza cuando la cara está quieta y deja pasar el
   movimiento rápido sin retraso. */
class Filtro {
  constructor(minCorte, beta) { this.minCorte = minCorte; this.beta = beta; this.x = null; this.dx = 0; this.t = 0; }
  static alfa(corte, dt) { const r = 2 * Math.PI * corte * dt; return r / (r + 1); }
  filtrar(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += Filtro.alfa(1, dt) * (dx - this.dx);
    const corte = this.minCorte + this.beta * Math.abs(this.dx);
    this.x += Filtro.alfa(corte, dt) * (x - this.x);
    return this.x;
  }
  reiniciar() { this.x = null; this.dx = 0; }
}

async function cargarDetector(alAvisar) {
  alAvisar && alAvisar('Cargando el detector de rostro (≈15 MB, solo la primera vez)…');
  const vision = await import(BASE + 'vision_bundle.mjs');
  if (vision.FilesetResolver && vision.FilesetResolver.isSimdSupported && !(await vision.FilesetResolver.isSimdSupported())) {
    throw Object.assign(new Error('sin SIMD'), { codigo: 'navegador' });
  }
  const archivos = { wasmLoaderPath: BASE + 'vision_wasm_internal.js', wasmBinaryPath: BASE + 'vision_wasm_internal.wasm' };
  const opciones = delegado => ({
    baseOptions: { modelAssetPath: BASE + 'face_landmarker.task', delegate: delegado },
    runningMode: 'VIDEO', numFaces: 1,
    outputFacialTransformationMatrixes: true, outputFaceBlendshapes: false
  });
  try {
    return await vision.FaceLandmarker.createFromOptions(archivos, opciones('GPU'));
  } catch (e) {
    return await vision.FaceLandmarker.createFromOptions(archivos, opciones('CPU'));
  }
}

/* Arranca cámara y detector en paralelo. Devuelve el controlador. */
async function iniciar(video, alAvisar) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw Object.assign(new Error('sin getUserMedia'), { codigo: 'inseguro' });
  }
  alAvisar && alAvisar('Pidiendo permiso para usar la cámara…');
  const detectorP = cargarDetector(null);
  detectorP.catch(() => {});
  let flujo;
  try {
    flujo = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
    });
  } catch (e) {
    throw Object.assign(e, { codigo: e.name === 'NotAllowedError' ? 'permiso' : e.name === 'NotFoundError' ? 'sin-camara' : 'camara' });
  }
  video.srcObject = flujo;
  video.muted = true;
  video.setAttribute('playsinline', '');
  await video.play();
  alAvisar && alAvisar('Cargando el detector de rostro (≈15 MB, solo la primera vez)…');
  let detector;
  try { detector = await detectorP; }
  catch (e) { flujo.getTracks().forEach(t => t.stop()); throw Object.assign(e, { codigo: e.codigo || 'detector' }); }

  const f = { x: new Filtro(0.8, 0.02), y: new Filtro(0.8, 0.02), z: new Filtro(0.8, 0.02), esc: new Filtro(0.5, 0.01),
              qx: new Filtro(1.2, 0.5), qy: new Filtro(1.2, 0.5), qz: new Filtro(1.2, 0.5), qw: new Filtro(1.2, 0.5) };
  let ultimoTiempo = -1, esquinasMm = 90, muestras = 0, qPrevia = null, fuenteGiro = '';
  let ultimaPose = null, ultimaVista = 0;

  /* Todo en "píxeles de video": origen al centro del cuadro, +Y arriba,
     +Z hacia la cámara. Sin espejo: el espejo lo pone el CSS. */
  function punto(lm, i, vw, vh) { const p = lm[i]; return new THREE.Vector3((p.x - 0.5) * vw, -(p.y - 0.5) * vh, -p.z * vw); }

  function detectar() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || video.readyState < 2) return ultimaPose;
    if (video.currentTime === ultimoTiempo) return ultimaPose;
    ultimoTiempo = video.currentTime;
    const t = performance.now();
    const r = detector.detectForVideo(video, t);
    if (!r.faceLandmarks || !r.faceLandmarks.length) {
      if (t - ultimaVista > 400) {
        ultimaPose = null;
        Object.values(f).forEach(fi => fi.reiniciar());
        qPrevia = null;
      }
      return ultimaPose;
    }
    ultimaVista = t;
    const lm = r.faceLandmarks[0];
    const pt = i => punto(lm, i, vw, vh);
    const dExt = pt(P.ojoDerExt), iExt = pt(P.ojoIzqExt), dInt = pt(P.ojoDerInt), iInt = pt(P.ojoIzqInt);
    const distEsquinas = dExt.distanceTo(iExt);

    /* Calibración con el iris: rápida al principio, lenta después. */
    if (lm.length > 476) {
      const iris = (pt(P.irisDer[0]).distanceTo(pt(P.irisDer[1])) + pt(P.irisIzq[0]).distanceTo(pt(P.irisIzq[1]))) / 2;
      if (iris > 2) {
        const estimado = Math.min(104, Math.max(80, distEsquinas / iris * IRIS_MM));
        const a = muestras < 30 ? 0.08 : 0.01;
        esquinasMm += (estimado - esquinasMm) * a;
        muestras++;
      }
    }
    const pxPorMm = distEsquinas / esquinasMm;

    /* Orientación desde los puntos. */
    const xL = iExt.clone().sub(dExt).normalize();
    const yL = pt(P.frente).sub(pt(P.barbilla));
    yL.sub(xL.clone().multiplyScalar(yL.dot(xL))).normalize();
    const zL = new THREE.Vector3().crossVectors(xL, yL);
    let base = new THREE.Matrix4().makeBasis(xL, yL, zL);
    fuenteGiro = 'puntos';

    /* La matriz de MediaPipe da mejor el giro de la cabeza (lo resuelve
       sobre un modelo 3D métrico). Se usa si coincide con los puntos. */
    const M = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0];
    if (M && M.data) {
      const d = M.data;
      const xM = new THREE.Vector3(d[0], d[1], d[2]).normalize();
      const yM = new THREE.Vector3(d[4], d[5], d[6]).normalize();
      const zM = new THREE.Vector3().crossVectors(xM, yM).normalize();
      if (xM.dot(xL) > 0.6 && yM.dot(yL) > 0.6) {
        yM.crossVectors(zM, xM).normalize();
        base = new THREE.Matrix4().makeBasis(xM, yM, zM);
        fuenteGiro = 'matriz';
      }
    }
    const q = new THREE.Quaternion().setFromRotationMatrix(base);
    if (qPrevia && q.dot(qPrevia) < 0) { q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w; }
    const qf = new THREE.Quaternion(f.qx.filtrar(q.x, t), f.qy.filtrar(q.y, t), f.qz.filtrar(q.z, t), f.qw.filtrar(q.w, t)).normalize();
    qPrevia = qf.clone();

    const centro = dExt.add(iExt).add(dInt).add(iInt).multiplyScalar(0.25);
    ultimaPose = {
      pos: new THREE.Vector3(f.x.filtrar(centro.x, t), f.y.filtrar(centro.y, t), f.z.filtrar(centro.z, t)),
      quat: qf,
      pxPorMm: f.esc.filtrar(pxPorMm, t),
      esquinasMm, fuenteGiro, vw, vh
    };
    return ultimaPose;
  }

  function detener() {
    flujo.getTracks().forEach(tr => tr.stop());
    video.srcObject = null;
  }

  return { detectar, detener };
}

window.EmishaLentesCam = { iniciar };
