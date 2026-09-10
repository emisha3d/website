/* ==========================================================================
   Emisha — lentes 3D: escena, estado e interfaz de /lentes/
   Depende de lentes-precios.js (catálogo y precios), lentes-geometria.js,
   lentes-materiales.js y lentes-camara.js, que se cargan antes en la página.

   El diseño completo vive en la URL (#d=...), así que "Copiar enlace" y el
   mensaje de WhatsApp llevan exactamente lo que el cliente armó.
   ========================================================================== */
import * as THREE from './vendor/three-0.186.0.min.js';

const C = window.EmishaLentes, G = window.EmishaLentesGeo, MAT = window.EmishaLentesMat;
const $ = (s, r) => (r || document).querySelector(s);
const WHATSAPP = '525575639255';

/* Dónde quedan los lentes respecto a las esquinas de los ojos, en mm:
   adelante del ojo y un poco abajo (el centro del lente va bajo la pupila). */
const AJUSTE_CARA = { adelanteMm: 16, arribaMm: -1 };

const INICIAL = {
  forma: 'clasico', talla: 'M',
  colores: { frente: 'petg-deep-black', frente2: 'petg-deep-white', puente: null, varillas: null, ceja: null },
  estiloFrente: 'solido', textura: 'lisa', acabado: 'lijado',
  puente: 'silla', varillas: 'clasica', bisagra: 'oculta',
  detalles: { remaches: false, ceja: false, placa: false },
  dijes: {},
  lente: 'claro', tratamientos: { ar: false, azul: false }, sol: 'ninguno', tinte: 'gris'
};

const clonar = o => JSON.parse(JSON.stringify(o));

/* ------------------------------------------------------------ URL <-> estado */
function codificar(e) {
  const json = JSON.stringify(e);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodificar(txt) {
  try {
    const b = txt.replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(decodeURIComponent(escape(atob(b))));
    const e = clonar(INICIAL);
    const valido = (lista, id) => lista.some(x => x.id === id);
    const listas = { forma: C.FORMAS, talla: C.TALLAS, estiloFrente: C.ESTILOS_FRENTE, textura: C.TEXTURAS,
      acabado: C.ACABADOS, puente: C.PUENTES, varillas: C.VARILLAS, bisagra: C.BISAGRAS, lente: C.LENTES,
      sol: C.SOL, tinte: C.TINTES };
    Object.keys(listas).forEach(k => { if (valido(listas[k], o[k])) e[k] = o[k]; });
    Object.keys(e.colores).forEach(k => {
      const v = o.colores && o.colores[k];
      if (v === null && k !== 'frente' && k !== 'frente2') e.colores[k] = null;
      else if (valido(C.COLORES, v)) e.colores[k] = v;
    });
    C.DETALLES.forEach(d => { e.detalles[d.id] = !!(o.detalles && o.detalles[d.id]); });
    C.TRATAMIENTOS.forEach(t => { e.tratamientos[t.id] = !!(o.tratamientos && o.tratamientos[t.id]); });
    C.LUGARES_DIJE.forEach(l => { const v = o.dijes && o.dijes[l.id]; if (valido(C.DIJES, v)) e.dijes[l.id] = v; });
    return e;
  } catch (err) { return null; }
}

function main() {
  const escenaEl = $('[data-escena]');
  if (!escenaEl || !C || !G || !MAT) return;
  const lienzo = $('[data-lienzo]'), video = $('[data-video]');
  const avisoEl = $('[data-aviso]');

  const m = /#d=([A-Za-z0-9_-]+)/.exec(location.hash);
  const estado = (m && decodificar(m[1])) || clonar(INICIAL);
  const ui = { pestana: 'forma', zona: 'frente', dije: null, exterior: 1 };
  let exteriorActual = 0;   // fotocromático: 0 adentro, 1 al sol (se anima hacia ui.exterior)

  function aviso(txt) {
    avisoEl.textContent = txt || '';
    avisoEl.hidden = !txt;
  }

  /* ------------------------------------------------------------ RENDERER */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: lienzo, antialias: true, alpha: true });
  } catch (e) {
    aviso('Tu navegador no puede mostrar gráficos 3D. Aún puedes armar tus lentes y ver el precio.');
    renderer = null;
  }

  const escena = new THREE.Scene();
  const camPersp = new THREE.PerspectiveCamera(28, 1, 5, 5000);
  const camOrto = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
  camOrto.position.set(0, 0, 6000);
  let controles = null;

  const mats = {
    frente: MAT.crearArmazon(), puente: MAT.crearArmazon(), varillas: MAT.crearArmazon(), ceja: MAT.crearArmazon(),
    metal: MAT.crearMetal(), lente: MAT.crearLente(), silicon: MAT.crearSilicon()
  };

  const raiz = new THREE.Group();       // los lentes
  const cabeza = new THREE.Group();     // en modo cámara: sigue a la cara
  escena.add(raiz);

  let suelo = null;
  if (renderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const pmrem = new THREE.PMREMGenerator(renderer);
    escena.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
    escena.environmentIntensity = 0.9;

    const luz = new THREE.DirectionalLight(0xffffff, 1.6);
    luz.position.set(140, 320, 220);
    luz.castShadow = true;
    luz.shadow.mapSize.set(1024, 1024);
    Object.assign(luz.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, near: 10, far: 1200 });
    luz.shadow.radius = 4;
    escena.add(luz);
    escena.add(new THREE.HemisphereLight(0xffffff, 0xdde3ea, 0.5));

    suelo = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), new THREE.ShadowMaterial({ opacity: 0.13 }));
    suelo.rotation.x = -Math.PI / 2;
    suelo.receiveShadow = true;
    escena.add(suelo);

    controles = new THREE.OrbitControls(camPersp, lienzo);
    controles.enableDamping = true;
    controles.enablePan = false;
    controles.minDistance = 160;
    controles.maxDistance = 900;
    controles.autoRotate = true;
    controles.autoRotateSpeed = 0.7;
    controles.addEventListener('start', () => { controles.autoRotate = false; });
  }

  /* Cabeza invisible que tapa las varillas cuando pasan detrás. Solo
     escribe profundidad: el video se sigue viendo. Superelipsoide más
     cuadrado que una esfera, como una cabeza vista desde arriba. */
  const ocultador = (() => {
    const geo = new THREE.SphereGeometry(1, 48, 32);
    const p = geo.getAttribute('position');
    const se = (v, n) => Math.sign(v) * Math.pow(Math.abs(v), 2 / n);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const r = Math.hypot(x, z);
      const k = r < 1e-6 ? 1 : Math.pow(Math.pow(Math.abs(x / r), 3) + Math.pow(Math.abs(z / r), 3), -1 / 3);
      p.setXYZ(i, x * k * 68, se(y, 2) * 115, z * k * 100);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false }));
    mesh.position.set(0, 18, -92);
    mesh.renderOrder = -1;
    return mesh;
  })();

  /* ---------------------------------------------------------- CONSTRUIR */
  let actual = null;
  let marcadores = new THREE.Group();
  let encuadrado = false;

  function liberar(obj) {
    obj.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }

  function reconstruir() {
    const med = C.medidas(estado);
    if (actual) { raiz.remove(actual.grupo); liberar(actual.grupo); }
    actual = G.construir({
      forma: estado.forma, anchoLente: med.anchoLente, puente: med.puente, varilla: med.varilla,
      tipoPuente: estado.puente, tipoVarilla: estado.varillas, bisagra: estado.bisagra, detalles: estado.detalles
    }, mats);
    raiz.add(actual.grupo);

    /* Dijes puestos. */
    Object.keys(estado.dijes).forEach(lugar => {
      const id = estado.dijes[lugar], l = actual.lugares[lugar];
      if (!id || !l) return;
      const d = G.construirDije(id);
      d.position.copy(l.pos);
      d.rotation.y = l.giroY;
      actual.grupo.add(d);
      if (lugar.indexOf('esquina-') === 0) {
        const lado = lugar.slice(8);
        actual.grupo.children.forEach(o => { if (o.userData.remache === lado) o.visible = false; });
      }
    });

    /* Marcadores para poner dijes tocando la escena. */
    marcadores.parent && marcadores.parent.remove(marcadores);
    liberar(marcadores);
    marcadores = new THREE.Group();
    const aro = new THREE.TorusGeometry(3.4, 0.5, 10, 32);
    C.LUGARES_DIJE.forEach(ld => {
      const l = actual.lugares[ld.id];
      if (!l) return;
      const ocupado = !!estado.dijes[ld.id];
      const mk = new THREE.Mesh(aro, new THREE.MeshBasicMaterial({ color: ocupado ? 0xd2590b : 0x0b6bcb, depthTest: false, transparent: true, opacity: 0.9 }));
      mk.position.copy(l.pos).add(new THREE.Vector3(0, 0, 0));
      mk.rotation.y = l.giroY;
      mk.renderOrder = 5;
      const toque = new THREE.Mesh(new THREE.SphereGeometry(6, 10, 8), new THREE.MeshBasicMaterial({ visible: false }));
      toque.userData.lugar = ld.id;
      mk.add(toque);
      marcadores.add(mk);
    });
    actual.grupo.add(marcadores);
    marcadores.visible = ui.pestana === 'dijes' && modo === '3d';

    aplicarMateriales();
    const forma = C.porId(C.FORMAS, estado.forma);
    if (forma.modelo) ponerModelo(forma, med, actual);

    const caja = actual.medidas.caja;
    if (suelo) suelo.position.y = caja.min.y - 16;
    if (controles) controles.target.set(0, (caja.min.y + caja.max.y) / 2, (caja.min.z + caja.max.z) / 2);
    if (!encuadrado) { vista('tresCuartos', true); encuadrado = true; }
  }

  /* ------------------------------------------------ MODELOS PROPIOS (GLB)
     Si una forma de lentes-precios.js trae `modelo: '/ruta/archivo.glb'`, el
     archivo reemplaza las piezas generadas que traiga. Reglas del archivo:
       · milímetros, diseñado para la talla M de esa forma (S y L se escalan)
       · origen en el centro del puente, a la altura del centro de los lentes
       · el frente mira a +Z, las varillas van hacia −Z, +Y arriba
       · transformaciones aplicadas (sin escalas ni giros en los nodos)
       · cada malla se nombra por la pieza: frente…, puente…, varilla…,
         lente…, ceja… — las piezas que no traiga se siguen generando
       · UV en milímetros para que las texturas salgan a escala; si no trae
         UV se proyectan de frente
     Los lugares de los dijes y las bisagras siguen siendo los de la forma
     generada: si tu frente no llega a esas bisagras, incluye también las
     varillas en el archivo. */
  const cargador = renderer ? new THREE.GLTFLoader() : null;
  const modelos = new Map();
  const ZONAS_GLB = [['frente', 'frente'], ['puente', 'puente'], ['varilla', 'varillas'], ['lente', 'lente'], ['ceja', 'ceja']];

  function cargarModelo(url) {
    if (!modelos.has(url)) {
      modelos.set(url, cargador.loadAsync(new URL(url, location.href).href).then(g => g.scene).catch(err => {
        console.warn('No se pudo cargar el modelo ' + url, err);
        return null;
      }));
    }
    return modelos.get(url);
  }

  function ponerModelo(forma, med, dueno) {
    if (!cargador) return;
    cargarModelo(forma.modelo).then(glb => {
      if (!glb || actual !== dueno) return;
      const copia = glb.clone(true);
      copia.scale.setScalar(med.anchoLente / forma.tallas.M[0]);
      const zonas = new Set();
      copia.traverse(o => {
        if (!o.isMesh) return;
        const nombre = (o.name || '').toLowerCase();
        const z = ZONAS_GLB.find(([pref]) => nombre.indexOf(pref) === 0);
        if (!z) return;
        zonas.add(z[1]);
        if (!o.geometry.getAttribute('uv')) {
          const pos = o.geometry.getAttribute('position'), uv = [];
          for (let i = 0; i < pos.count; i++) uv.push(pos.getX(i), pos.getY(i));
          o.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        }
        o.material = mats[z[1]];
        o.castShadow = o.receiveShadow = true;
        if (z[1] === 'lente') o.renderOrder = 2;
      });
      dueno.grupo.traverse(o => {
        if (o.isMesh && o.parent !== copia && [...zonas].some(z => o.material === mats[z])) o.visible = false;
      });
      dueno.grupo.add(copia);
    });
  }

  function aplicarMateriales() {
    const col = id => C.porId(C.COLORES, id);
    const lin = c => C.porId(C.LINEAS, c.linea);
    const f1 = col(estado.colores.frente), f2 = col(estado.colores.frente2);
    const modoColor = { solido: 0, dostonos: 1, degradado: 2 }[estado.estiloFrente] || 0;
    const med = actual ? actual.medidas : { yMinFrente: -20, yMaxFrente: 20 };
    const comun = { textura: estado.textura, acabado: estado.acabado };
    const frente = Object.assign({}, comun, {
      color1: f1.hex, color2: f2.hex, modo: modoColor, yMin: med.yMinFrente, yMax: med.yMaxFrente,
      efecto: lin(f1).efecto, petg: f1.linea === 'petg-matte'
    });
    mats.frente.fijar(frente);
    const zona = id => {
      if (!id) return null;
      const c = col(id);
      return Object.assign({}, comun, { color1: c.hex, modo: 0, efecto: lin(c).efecto, petg: c.linea === 'petg-matte' });
    };
    mats.puente.fijar(zona(estado.colores.puente) || frente);
    mats.varillas.fijar(zona(estado.colores.varillas) || Object.assign({}, frente, { modo: 0 }));
    mats.ceja.fijar(zona(estado.colores.ceja) || Object.assign({}, frente, { modo: 0 }));
    mats.lente.fijar({
      sol: estado.sol, tinteHex: C.porId(C.TINTES, estado.tinte).hex,
      ar: estado.tratamientos.ar, azul: estado.tratamientos.azul, exterior: exteriorActual
    });
  }

  /* -------------------------------------------------------------- VISTAS */
  const VISTAS = {
    frente:      { az: 0,   pol: 88, nombre: 'Frente' },
    tresCuartos: { az: 38,  pol: 76, nombre: '3/4' },
    lado:        { az: 90,  pol: 86, nombre: 'Lado' },
    arriba:      { az: 18,  pol: 28, nombre: 'Arriba' }
  };
  let animVista = null;
  function vista(id, inmediato) {
    if (!controles || !actual) return;
    const v = VISTAS[id];
    const caja = actual.medidas.caja;
    const ancho = caja.max.x - caja.min.x, fondo = caja.max.z - caja.min.z;
    const tam = id === 'frente' ? ancho * 0.8 : Math.max(ancho, fondo);
    const aspecto = Math.min(1, camPersp.aspect || 1);
    const dist = (tam * 0.95) / Math.tan(THREE.MathUtils.degToRad(camPersp.fov / 2)) / Math.max(0.62, aspecto);
    const destino = new THREE.Vector3().setFromSphericalCoords(dist,
      THREE.MathUtils.degToRad(v.pol), THREE.MathUtils.degToRad(v.az)).add(controles.target);
    controles.autoRotate = false;
    if (inmediato) { camPersp.position.copy(destino); controles.autoRotate = id === 'tresCuartos'; controles.update(); return; }
    animVista = { desde: camPersp.position.clone(), hasta: destino, t0: performance.now() };
  }

  /* -------------------------------------------------------- MODO CÁMARA */
  let modo = '3d', cam = null;
  const btnCamara = $('[data-camara]'), btnFoto = $('[data-foto]'), vistasEl = $('[data-vistas]');

  function mensajeError(e) {
    switch (e && e.codigo) {
      case 'inseguro': return 'Tu navegador no deja usar la cámara en esta página. Ábrela con https en Chrome, Safari o Edge.';
      case 'permiso': return 'No diste permiso para la cámara. Actívalo en el candado de la barra de direcciones y vuelve a intentar.';
      case 'sin-camara': return 'No encontramos una cámara en este dispositivo.';
      case 'navegador': return 'Este navegador es muy antiguo para la prueba con cámara. Actualízalo o usa Chrome.';
      default: return 'No se pudo iniciar la prueba con cámara. Recarga la página e intenta de nuevo.';
    }
  }

  async function entrarCamara() {
    if (!renderer || !window.EmishaLentesCam) return;
    btnCamara.disabled = true;
    try {
      cam = await window.EmishaLentesCam.iniciar(video, aviso);
    } catch (e) {
      aviso(mensajeError(e));
      btnCamara.disabled = false;
      return;
    }
    aviso('Mira a la cámara. Buena luz de frente ayuda.');
    setTimeout(() => { if (modo === 'camara' && avisoEl.textContent.indexOf('Mira') === 0) aviso(''); }, 4000);
    modo = 'camara';
    video.hidden = false;
    escenaEl.classList.add('es-camara');
    escena.remove(raiz);
    raiz.position.set(0, AJUSTE_CARA.arribaMm, AJUSTE_CARA.adelanteMm);
    raiz.rotation.set(0, 0, 0);
    cabeza.add(raiz);
    cabeza.add(ocultador);
    escena.add(cabeza);
    cabeza.visible = false;
    if (suelo) suelo.visible = false;
    marcadores.visible = false;
    controles.enabled = false;
    btnCamara.textContent = 'Salir de la cámara';
    btnCamara.disabled = false;
    btnFoto.hidden = false;
    vistasEl.hidden = true;
  }

  function salirCamara() {
    if (cam) cam.detener();
    cam = null;
    modo = '3d';
    video.hidden = true;
    escenaEl.classList.remove('es-camara');
    cabeza.remove(raiz); cabeza.remove(ocultador); escena.remove(cabeza);
    raiz.position.set(0, 0, 0);
    escena.add(raiz);
    if (suelo) suelo.visible = true;
    marcadores.visible = ui.pestana === 'dijes';
    controles.enabled = true;
    btnCamara.textContent = 'Probar con mi cámara';
    btnFoto.hidden = true;
    vistasEl.hidden = false;
    aviso('');
    redimensionar();
  }

  if (btnCamara) btnCamara.addEventListener('click', () => (modo === 'camara' ? salirCamara() : entrarCamara()));

  /* El encuadre del video es "cover": se recorta lo que sobra. La cámara
     ortográfica ve exactamente la parte visible, en píxeles de video. */
  function ajustarOrto(vw, vh) {
    const W = lienzo.clientWidth, H = lienzo.clientHeight;
    if (!vw || !W) return;
    const s = Math.max(W / vw, H / vh);
    camOrto.left = -W / s / 2; camOrto.right = W / s / 2;
    camOrto.top = H / s / 2; camOrto.bottom = -H / s / 2;
    camOrto.updateProjectionMatrix();
  }

  function tomarFoto() {
    if (modo !== 'camara' || !cam) return;
    renderer.render(escena, camOrto);
    const W = lienzo.width, H = lienzo.height, vw = video.videoWidth, vh = video.videoHeight;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const s = Math.max(W / vw, H / vh), sw = W / s, sh = H / s;
    ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, W, H);
    ctx.drawImage(lienzo, 0, 0);
    c.toBlob(b => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'mis-lentes-emisha.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }
  if (btnFoto) btnFoto.addEventListener('click', tomarFoto);

  /* --------------------------------------------------- TOCAR PARA PONER DIJES */
  const rayo = new THREE.Raycaster(), puntero = new THREE.Vector2();
  let abajo = null;
  lienzo.addEventListener('pointerdown', e => { abajo = { x: e.clientX, y: e.clientY }; });
  lienzo.addEventListener('pointerup', e => {
    if (!abajo || modo !== '3d' || !marcadores.visible) return;
    if (Math.hypot(e.clientX - abajo.x, e.clientY - abajo.y) > 6) return;
    const r = lienzo.getBoundingClientRect();
    puntero.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    rayo.setFromCamera(puntero, camPersp);
    const toques = [];
    marcadores.children.forEach(mk => toques.push(mk.children[0]));
    marcadores.children.forEach(mk => { mk.children[0].material.visible = true; });
    const hit = rayo.intersectObjects(toques, false)[0];
    marcadores.children.forEach(mk => { mk.children[0].material.visible = false; });
    if (!hit) return;
    const lugar = hit.object.userData.lugar;
    if (ui.dije && estado.dijes[lugar] !== ui.dije) estado.dijes[lugar] = ui.dije;
    else delete estado.dijes[lugar];
    actualizar();
  });

  /* ------------------------------------------------------------- BUCLE */
  function redimensionar() {
    if (!renderer) return;
    const W = lienzo.clientWidth, H = lienzo.clientHeight;
    if (!W || !H) return;
    renderer.setSize(W, H, false);
    camPersp.aspect = W / H;
    camPersp.updateProjectionMatrix();
  }
  if (window.ResizeObserver) new ResizeObserver(redimensionar).observe(escenaEl);
  window.addEventListener('resize', redimensionar);

  let visible = true;
  if (window.IntersectionObserver) new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(escenaEl);

  const objetivoExterior = () => (estado.sol === 'fotocromatico' ? ui.exterior : 0);

  function cuadro(t) {
    requestAnimationFrame(cuadro);
    if (!renderer || !visible) return;
    /* Fotocromático: se oscurece o aclara poco a poco. */
    const obj = objetivoExterior();
    if (Math.abs(obj - exteriorActual) > 0.002 && estado.sol === 'fotocromatico') {
      exteriorActual += (obj - exteriorActual) * 0.035;
      mats.lente.fijar({ sol: estado.sol, tinteHex: C.porId(C.TINTES, estado.tinte).hex,
        ar: estado.tratamientos.ar, azul: estado.tratamientos.azul, exterior: exteriorActual });
    }
    if (modo === 'camara' && cam) {
      const pose = cam.detectar();
      if (window.__lentes) window.__lentes.pose = pose;
      ajustarOrto(video.videoWidth, video.videoHeight);
      if (pose) {
        cabeza.visible = true;
        cabeza.position.copy(pose.pos);
        cabeza.quaternion.copy(pose.quat);
        cabeza.scale.setScalar(pose.pxPorMm);
      } else cabeza.visible = false;
      renderer.render(escena, camOrto);
      return;
    }
    if (animVista) {
      const k = Math.min(1, (t - animVista.t0) / 550), e = 1 - Math.pow(1 - k, 3);
      camPersp.position.lerpVectors(animVista.desde, animVista.hasta, e);
      if (k >= 1) animVista = null;
    }
    controles.update();
    renderer.render(escena, camPersp);
  }

  /* ============================================================ INTERFAZ */
  const panelesEl = $('[data-paneles]'), tabsEl = $('[data-tabs]');
  const PESTANAS = [['forma', 'Forma'], ['talla', 'Talla'], ['color', 'Color'], ['superficie', 'Superficie'],
                    ['piezas', 'Piezas'], ['dijes', 'Dijes'], ['lentes', 'Lentes']];
  const dinero = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  const delta = p => (p > 0 ? '+' + dinero.format(p) : p < 0 ? '−' + dinero.format(-p) : 'Incluido');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const leer = ruta => ruta.split('.').reduce((o, k) => (o ? o[k] : undefined), estado);
  function escribir(ruta, v) {
    const ks = ruta.split('.'), ultimo = ks.pop();
    ks.reduce((o, k) => o[k], estado)[ultimo] = v;
  }

  function svgForma(id) {
    const { d, alto } = G.rutaSvgLente(id, 40);
    return '<svg class="lentes-op__icono" viewBox="-3 -3 96 ' + (alto + 6).toFixed(1) + '" aria-hidden="true">' +
      '<path d="' + d + '" transform="translate(50 0)"/><path d="' + d + '" transform="translate(40 0) scale(-1 1)"/>' +
      '<path d="M40 ' + (alto * 0.32).toFixed(1) + ' Q45 ' + (alto * 0.16).toFixed(1) + ' 50 ' + (alto * 0.32).toFixed(1) + '"/></svg>';
  }

  function opciones(titulo, lista, ruta, icono) {
    return '<fieldset class="lentes-grupo"><legend>' + esc(titulo) + '</legend><div class="lentes-opciones">' +
      lista.map(o => '<button type="button" class="lentes-op" data-set="' + ruta + '" data-val="' + o.id + '" aria-pressed="' + (leer(ruta) === o.id) + '">' +
        (icono ? icono(o) : '') +
        '<span class="lentes-op__nombre">' + esc(o.nombre) + '</span>' +
        '<span class="lentes-op__precio">' + delta(o.precio) + '</span>' +
        (o.nota ? '<span class="lentes-op__nota">' + esc(o.nota) + '</span>' : '') + '</button>').join('') +
      '</div></fieldset>';
  }

  function interruptores(titulo, lista, base) {
    return '<fieldset class="lentes-grupo"><legend>' + esc(titulo) + '</legend><div class="lentes-opciones">' +
      lista.map(o => '<button type="button" class="lentes-op lentes-op--toggle" data-toggle="' + base + '.' + o.id + '" aria-pressed="' + !!estado[base][o.id] + '">' +
        '<span class="lentes-op__nombre">' + esc(o.nombre) + '</span><span class="lentes-op__precio">' + delta(o.precio) + '</span>' +
        (o.nota ? '<span class="lentes-op__nota">' + esc(o.nota) + '</span>' : '') + '</button>').join('') +
      '</div></fieldset>';
  }

  const PANELES = {
    forma: () => opciones('Forma del armazón', C.FORMAS, 'forma', o => svgForma(o.id)),

    talla: () => {
      const forma = C.porId(C.FORMAS, estado.forma), med = C.medidas(estado);
      const tarjetas = '<fieldset class="lentes-grupo"><legend>Talla</legend><div class="lentes-opciones">' +
        C.TALLAS.map(t => {
          const m = forma.tallas[t.id];
          return '<button type="button" class="lentes-op" data-set="talla" data-val="' + t.id + '" aria-pressed="' + (estado.talla === t.id) + '">' +
            '<span class="lentes-op__nombre">' + t.id + ' · ' + esc(t.nombre) + '</span>' +
            '<span class="lentes-op__precio">' + delta(t.precio) + '</span>' +
            '<span class="lentes-op__nota lentes-mono">' + m[0] + ' □ ' + m[1] + ' — ' + m[2] + '</span></button>';
        }).join('') + '</div></fieldset>';
      const pastillas = C.TALLAS_LENTE.map(t =>
        '<span class="lentes-talla' + (t.n === med.tallaLente ? ' es-activa' : '') + '" title="Talla ' + t.n + ': ' + t.ancho + ' mm">' + t.ancho + '</span>').join('');
      return tarjetas +
        '<div class="lentes-grupo"><p class="lentes-grupo__titulo">Lente para el laboratorio</p>' +
        '<div class="lentes-tallas">' + pastillas + '</div>' +
        '<p class="lentes-texto">Tu lente: <strong class="lentes-mono">' + med.codigoLente + '</strong> · ' + med.anchoLente +
        ' mm de ancho (talla ' + med.tallaLente + ' de 10). El laboratorio corta solo estas 10 medidas, por eso sale más rápido y más barato.</p>' +
        '<p class="lentes-texto lentes-texto--suave">¿No sabes tu talla? Busca en la varilla de unos lentes que te queden bien: vienen grabados tres números, como <span class="lentes-mono">52 □ 19 — 140</span> (lente, puente y varilla). Ancho total de este armazón: <strong>' +
        Math.round(actual ? actual.medidas.anchoTotal : 0) + ' mm</strong>.</p></div>';
    },

    color: () => {
      const zonas = [['frente', estado.estiloFrente === 'solido' ? 'Armazón' : 'Frente, arriba']];
      if (estado.estiloFrente !== 'solido') zonas.push(['frente2', 'Frente, abajo']);
      zonas.push(['puente', 'Puente'], ['varillas', 'Varillas']);
      if (estado.detalles.ceja) zonas.push(['ceja', 'Ceja']);
      if (!zonas.some(z => z[0] === ui.zona)) ui.zona = 'frente';
      const colorDe = z => estado.colores[z] || estado.colores.frente;
      const chips = zonas.map(([z, n]) =>
        '<button type="button" class="lentes-zona" data-zona="' + z + '" aria-pressed="' + (ui.zona === z) + '">' +
        '<i style="background:' + C.porId(C.COLORES, colorDe(z)).hex + '"></i>' + esc(n) + '</button>').join('');
      const actualZona = estado.colores[ui.zona];
      const mismo = ui.zona === 'frente' || ui.zona === 'frente2' ? '' :
        '<button type="button" class="lentes-mismo" data-color="" aria-pressed="' + !actualZona + '">Igual que el frente</button>';
      const porLinea = C.LINEAS.map(l => {
        const cs = C.COLORES.filter(c => c.linea === l.id);
        return '<p class="lentes-grupo__titulo">' + esc(l.nombre) + ' <span>' + delta(l.precio) + '</span></p><div class="lentes-muestras">' +
          cs.map(c => '<button type="button" class="lentes-muestra" data-color="' + c.id + '" aria-pressed="' + (actualZona === c.id) + '" title="' + esc(c.nombre) + '" aria-label="' + esc(l.nombre + ' ' + c.nombre) + '" style="--c:' + c.hex + '"></button>').join('') + '</div>';
      }).join('');
      const elegido = C.porId(C.COLORES, colorDe(ui.zona));
      return opciones('Cómo se reparte el color', C.ESTILOS_FRENTE, 'estiloFrente') +
        '<div class="lentes-grupo"><p class="lentes-grupo__titulo">Pieza que estás pintando</p><div class="lentes-zonas">' + chips + '</div>' +
        '<p class="lentes-texto">' + esc(C.porId(C.LINEAS, elegido.linea).nombre + ' ' + elegido.nombre) +
        '. Los 29 colores son los filamentos que tenemos en existencia. Cada color más en el armazón: ' + delta(C.PRECIO.colorExtra) + '.</p>' +
        mismo + porLinea + '</div>';
    },

    superficie: () => opciones('Textura impresa', C.TEXTURAS, 'textura') + opciones('Acabado', C.ACABADOS, 'acabado'),

    piezas: () => opciones('Puente', C.PUENTES, 'puente') + opciones('Varillas', C.VARILLAS, 'varillas') +
      opciones('Bisagras', C.BISAGRAS, 'bisagra') + interruptores('Detalles (puedes elegir varios)', C.DETALLES, 'detalles'),

    dijes: () => {
      const d = ui.dije && C.porId(C.DIJES, ui.dije);
      const figuras = '<div class="lentes-dijes">' + C.DIJES.map(x =>
        '<button type="button" class="lentes-dije" data-dije="' + x.id + '" aria-pressed="' + (ui.dije === x.id) + '">' +
        G.iconoDije(x.id) + '<span>' + esc(x.nombre) + '</span><small>' + delta(x.precio) + '</small></button>').join('') + '</div>';
      const ayuda = modo === 'camara'
        ? 'Sal de la cámara para tocar los lugares en los lentes, o usa la lista de abajo.'
        : d ? 'Toca un círculo azul en los lentes para ponerle ' + esc(d.nombre.toLowerCase()) + '. Tocar uno naranja lo quita.'
            : 'Elige una figura y luego toca dónde la quieres en los lentes.';
      const lista = C.LUGARES_DIJE.map(l =>
        '<label class="lentes-lugar"><span>' + esc(l.nombre) + '</span><select data-lugar="' + l.id + '">' +
        '<option value="">Nada</option>' + C.DIJES.map(x => '<option value="' + x.id + '"' + (estado.dijes[l.id] === x.id ? ' selected' : '') + '>' + esc(x.nombre) + '</option>').join('') +
        '</select></label>').join('');
      const puestos = Object.keys(estado.dijes).length;
      return '<div class="lentes-grupo"><p class="lentes-grupo__titulo">Dijes · se enganchan como los de Crocs</p>' + figuras +
        '<p class="lentes-texto lentes-ayuda">' + ayuda + '</p></div>' +
        '<details class="lentes-grupo lentes-lista-dijes"' + (puestos ? ' open' : '') + '><summary>Lugares (' + puestos + ' de ' + C.LUGARES_DIJE.length + ' ocupados)</summary>' + lista +
        (puestos ? '<button type="button" class="btn btn--ghost btn--sm" data-accion="quitar-dijes">Quitar todos</button>' : '') + '</details>';
    },

    lentes: () => {
      let html = opciones('Tipo de lente', C.LENTES, 'lente') +
        interruptores('Tratamientos', C.TRATAMIENTOS, 'tratamientos') + opciones('Para el sol', C.SOL, 'sol');
      if (['tinte', 'degradado', 'polarizado'].indexOf(estado.sol) >= 0) {
        html += '<div class="lentes-grupo"><p class="lentes-grupo__titulo">Color del tinte</p><div class="lentes-muestras">' +
          C.TINTES.map(t => '<button type="button" class="lentes-muestra lentes-muestra--tinte" data-set="tinte" data-val="' + t.id + '" aria-pressed="' + (estado.tinte === t.id) + '" title="' + t.nombre + '" aria-label="Tinte ' + t.nombre + '" style="--c:' + t.hex + '"></button>').join('') +
          '</div></div>';
      }
      if (estado.sol === 'fotocromatico') {
        html += '<div class="lentes-grupo"><button type="button" class="btn btn--ghost btn--sm" data-accion="exterior">' +
          (ui.exterior ? 'Ver como se ve adentro' : 'Ver como se ve al sol') + '</button></div>';
      }
      return html;
    }
  };

  function pintarTabs() {
    tabsEl.innerHTML = PESTANAS.map(([id, n]) =>
      '<button type="button" role="tab" id="tab-' + id + '" aria-controls="panel-lentes" aria-selected="' + (ui.pestana === id) + '" data-tab="' + id + '">' + n + '</button>').join('');
  }

  /* Repinta el panel conservando el foco del teclado. */
  function pintarPanel() {
    const a = document.activeElement;
    let selector = null;
    if (a && panelesEl.contains(a)) {
      const attrs = ['data-set', 'data-val', 'data-toggle', 'data-color', 'data-zona', 'data-dije', 'data-lugar', 'data-accion'];
      selector = attrs.filter(k => a.hasAttribute(k)).map(k => '[' + k + '="' + a.getAttribute(k) + '"]').join('');
    }
    panelesEl.setAttribute('aria-labelledby', 'tab-' + ui.pestana);
    panelesEl.innerHTML = PANELES[ui.pestana]();
    if (selector) { const b = panelesEl.querySelector(selector); if (b) b.focus(); }
  }

  /* ------------------------------------------------------------ PRECIO */
  const totalEl = $('[data-total]'), desgloseEl = $('[data-desglose]'), labEl = $('[data-lab]');
  const medidasEl = $('[data-medidas]'), waEl = $('[data-whatsapp]'), copiarEl = $('[data-copiar]');

  function enlace() { return location.origin + location.pathname + '#d=' + codificar(estado); }

  function mensaje(r, med) {
    const nom = (lista, id) => C.porId(lista, id).nombre;
    const col = id => { const c = C.porId(C.COLORES, id); return C.porId(C.LINEAS, c.linea).nombre + ' ' + c.nombre; };
    const colores = [(estado.estiloFrente === 'solido' ? 'Armazón: ' : 'Frente: ') + col(estado.colores.frente) +
      (estado.estiloFrente !== 'solido' ? ' y ' + col(estado.colores.frente2) + ' (' + nom(C.ESTILOS_FRENTE, estado.estiloFrente).toLowerCase() + ')' : '')];
    [['puente', 'Puente'], ['varillas', 'Varillas'], ['ceja', 'Ceja']].forEach(([z, n]) => {
      if (estado.colores[z] && (z !== 'ceja' || estado.detalles.ceja)) colores.push(n + ': ' + col(estado.colores[z]));
    });
    const detalles = C.DETALLES.filter(d => estado.detalles[d.id]).map(d => d.nombre);
    const dijes = r.lineas.filter(l => l.concepto === 'Dijes').map(l => l.detalle);
    const lentes = [nom(C.LENTES, estado.lente)].concat(C.TRATAMIENTOS.filter(t => estado.tratamientos[t.id]).map(t => t.nombre));
    if (estado.sol !== 'ninguno') lentes.push(r.lineas.filter(l => l.concepto === 'Sol').map(l => l.detalle)[0]);
    const lineas = [
      'Hola, armé unos lentes en la demo de Emisha y quiero cotizarlos:', '',
      '• Forma: ' + nom(C.FORMAS, estado.forma) + ', talla ' + estado.talla + ' (' + med.anchoLente + ' □ ' + med.puente + ' — ' + med.varilla + ')',
      '• Lente para laboratorio: ' + med.codigoLente + ' (' + med.anchoLente + ' mm)',
      '• ' + colores.join(' · '),
      '• Textura: ' + nom(C.TEXTURAS, estado.textura) + ' · Acabado: ' + nom(C.ACABADOS, estado.acabado),
      '• Puente: ' + nom(C.PUENTES, estado.puente) + ' · Varillas: ' + nom(C.VARILLAS, estado.varillas) + ' · Bisagras: ' + nom(C.BISAGRAS, estado.bisagra)
    ];
    if (detalles.length) lineas.push('• Detalles: ' + detalles.join(', '));
    if (dijes.length) lineas.push('• Dijes: ' + dijes.join(', '));
    lineas.push('• Lentes: ' + lentes.join(', '));
    if (estado.lente !== 'claro') lineas.push('', 'Les mando mi receta por aquí.');
    lineas.push('', 'Total estimado: ' + dinero.format(r.total) + ' MXN', 'Mi diseño: ' + enlace());
    return lineas.join('\n');
  }

  function pintarPrecio() {
    const r = C.calcular(estado), med = C.medidas(estado);
    totalEl.textContent = dinero.format(r.total);
    desgloseEl.innerHTML = r.lineas.map(l =>
      '<tr><th scope="row">' + esc(l.concepto) + '<span>' + esc(l.detalle) + '</span></th><td>' + (l.monto < 0 ? '−' + dinero.format(-l.monto) : dinero.format(l.monto)) + '</td></tr>').join('') +
      '<tr class="lentes-desglose__total"><th scope="row">Total</th><td>' + dinero.format(r.total) + '</td></tr>';
    labEl.innerHTML = 'Lente <strong class="lentes-mono">' + med.codigoLente + '</strong> · ' + med.anchoLente + ' □ ' + med.puente + ' — ' + med.varilla;
    medidasEl.textContent = med.anchoLente + ' □ ' + med.puente + ' — ' + med.varilla +
      (actual ? ' · ' + Math.round(actual.medidas.anchoTotal) + ' mm de ancho' : '');
    waEl.href = 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(mensaje(r, med));
  }

  function actualizar() {
    reconstruir();
    pintarPanel();
    pintarPrecio();
    try { history.replaceState(null, '', location.pathname + location.search + '#d=' + codificar(estado)); } catch (e) { /* file:// */ }
  }

  /* ------------------------------------------------------------ EVENTOS */
  tabsEl.addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    ui.pestana = b.getAttribute('data-tab');
    pintarTabs();
    pintarPanel();
    marcadores.visible = ui.pestana === 'dijes' && modo === '3d';
    if (ui.pestana === 'dijes' && controles && modo === '3d') vista('tresCuartos');
  });
  tabsEl.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = PESTANAS.findIndex(p => p[0] === ui.pestana);
    const j = (i + (e.key === 'ArrowRight' ? 1 : PESTANAS.length - 1)) % PESTANAS.length;
    ui.pestana = PESTANAS[j][0];
    pintarTabs(); pintarPanel();
    marcadores.visible = ui.pestana === 'dijes' && modo === '3d';
    tabsEl.querySelector('[data-tab="' + ui.pestana + '"]').focus();
  });

  panelesEl.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !panelesEl.contains(b)) return;
    if (b.hasAttribute('data-set')) {
      const ruta = b.getAttribute('data-set'), v = b.getAttribute('data-val');
      escribir(ruta, v);
      if (ruta === 'sol' && v === 'fotocromatico') { ui.exterior = 1; exteriorActual = 0; }
      actualizar();
    } else if (b.hasAttribute('data-toggle')) {
      const ruta = b.getAttribute('data-toggle');
      escribir(ruta, !leer(ruta));
      actualizar();
    } else if (b.hasAttribute('data-zona')) {
      ui.zona = b.getAttribute('data-zona');
      pintarPanel();
    } else if (b.hasAttribute('data-color')) {
      estado.colores[ui.zona] = b.getAttribute('data-color') || null;
      actualizar();
    } else if (b.hasAttribute('data-dije')) {
      const id = b.getAttribute('data-dije');
      ui.dije = ui.dije === id ? null : id;
      pintarPanel();
    } else if (b.getAttribute('data-accion') === 'quitar-dijes') {
      estado.dijes = {};
      actualizar();
    } else if (b.getAttribute('data-accion') === 'exterior') {
      ui.exterior = ui.exterior ? 0 : 1;
      pintarPanel();
    }
  });
  panelesEl.addEventListener('change', e => {
    const s = e.target.closest('select[data-lugar]');
    if (!s) return;
    if (s.value) estado.dijes[s.getAttribute('data-lugar')] = s.value;
    else delete estado.dijes[s.getAttribute('data-lugar')];
    actualizar();
  });

  if (vistasEl) {
    vistasEl.innerHTML = Object.keys(VISTAS).map(id => '<button type="button" data-vista="' + id + '">' + VISTAS[id].nombre + '</button>').join('');
    vistasEl.addEventListener('click', e => { const b = e.target.closest('[data-vista]'); if (b) vista(b.getAttribute('data-vista')); });
  }

  if (copiarEl) copiarEl.addEventListener('click', () => {
    const url = enlace();
    const listo = () => { copiarEl.textContent = 'Enlace copiado'; setTimeout(() => { copiarEl.textContent = 'Copiar enlace de este diseño'; }, 2200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(listo, () => window.prompt('Copia este enlace:', url));
    else window.prompt('Copia este enlace:', url);
  });

  /* ------------------------------------------------------------ ARRANQUE */
  pintarTabs();
  redimensionar();
  actualizar();
  if (renderer) requestAnimationFrame(cuadro);
  window.__lentes = { estado, ui, vista, escena, camPersp, controles, actualizar };   // para depurar desde la consola
}

main();
