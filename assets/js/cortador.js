/* ==========================================================================
   Emisha — cortador de piezas (/cortador/)
   Editor de modelos estilo "dora": carga un STL o 3MF, separa las piezas,
   muévelas, gíralas y escálalas, y córtalas con planos o con pincel. Todo
   corre en el navegador; los archivos nunca se suben a ningún servidor.

   El motor de geometría y de precios vive en cotizador.js y se usa por el
   gancho window.__emishaQuote — aquí solo está la interfaz del editor.
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };

  var lienzo = $('#lienzo');
  if (!lienzo || typeof window === 'undefined') return;

  var Q = window.__emishaQuote;
  if (!Q || !window.EmishaPreview) return;

  var CONFIG = Q.config;
  var fmt = function (n) { return '$' + Math.round(n).toLocaleString('es-MX') + ' MXN'; };

  /* ------------------------------------------------------------- estado */

  /* Cada pieza del editor:
       nombre, malla (Float64Array original), rangos (colores por tramo),
       colorBase, volumenMm3, areaMm2, limites/caja originales, visible,
       t = {dx,dy,dz, rz, sx,sy,sz} su transformación,
       planos = {x:[],y:[],z:[]} cortes rectos en coordenadas de mundo,
       pincel = Uint8Array por triángulo (0 = sin sección), pincelListo.   */
  var piezas = [];
  var sel = -1;
  var vista = 'armado';               // 'armado' | 'despiece'
  var pincelActivo = false;
  var pincelSeccion = 1;
  var pincelRadio = 30;
  var ctrl = null;
  var mapa = [];                      // trozos del visor -> pieza y triángulo local
  var timer = null;
  /* Herramienta activa estilo Maya/Max: arrastrar sobre la pieza la mueve,
     gira o escala. Atajos W / R / S; F encuadra la selección. */
  var modoT = null;                   // null | 'mover' | 'girar' | 'escalar'
  var agarre = null;                  // estado del arrastre en curso

  var SECCIONES = [
    { nombre: 'A', color: [0.86, 0.26, 0.22] },
    { nombre: 'B', color: [0.12, 0.47, 0.75] },
    { nombre: 'C', color: [0.24, 0.65, 0.36] },
    { nombre: 'D', color: [0.92, 0.55, 0.10] }
  ];

  /* Paleta estilo dora: a cada pieza sin color propio le toca un color vivo
     para que la lista y el visor hablen el mismo idioma. */
  var PALETA = [
    [0.95, 0.33, 0.49], [0.35, 0.65, 0.95], [0.34, 0.78, 0.52],
    [0.65, 0.55, 0.98], [0.95, 0.64, 0.29], [0.18, 0.83, 0.75],
    [0.94, 0.33, 0.31], [0.92, 0.70, 0.03], [0.39, 0.40, 0.95],
    [0.64, 0.90, 0.21], [0.13, 0.83, 0.93], [0.85, 0.27, 0.94]
  ];
  var FONDO_VISOR = [0.955, 0.963, 0.975];   // el blanco del sitio: los fantasmas palidecen

  function colorDePieza(p) {
    return p.colorBase || p.colorAuto || [0.72, 0.74, 0.78];
  }

  /* --------------------------------------------------------- transformar */

  function tNueva() { return { dx: 0, dy: 0, dz: 0, rz: 0, sx: 1, sy: 1, sz: 1 }; }

  function versionT(p) {
    var t = p.t;
    return t.dx + ',' + t.dy + ',' + t.dz + ',' + t.rz + ','
         + t.sx + ',' + t.sy + ',' + t.sz;
  }

  /* Malla de la pieza en coordenadas de mundo: escala y giro alrededor del
     centro original de la pieza, y después el corrimiento. Se guarda por
     versión porque transformar 100 mil triángulos no es gratis. */
  function mundo(p) {
    var v = versionT(p);
    if (p._mundo && p._mundo.v === v) return p._mundo;
    var t = p.t;
    var c = [(p.limites.min[0] + p.limites.max[0]) / 2,
             (p.limites.min[1] + p.limites.max[1]) / 2,
             (p.limites.min[2] + p.limites.max[2]) / 2];
    var cos = Math.cos(t.rz * Math.PI / 180), sin = Math.sin(t.rz * Math.PI / 180);
    var m = p.malla, out = new Float64Array(m.length);
    for (var i = 0; i < m.length; i += 3) {
      var x = (m[i]     - c[0]) * t.sx;
      var y = (m[i + 1] - c[1]) * t.sy;
      var z = (m[i + 2] - c[2]) * t.sz;
      out[i]     = x * cos - y * sin + c[0] + t.dx;
      out[i + 1] = x * sin + y * cos + c[1] + t.dy;
      out[i + 2] = z + c[2] + t.dz;
    }
    var lim = Q.limites(out);
    p._mundo = {
      v: v, malla: out, limites: lim,
      caja: [lim.max[0] - lim.min[0], lim.max[1] - lim.min[1], lim.max[2] - lim.min[2]]
    };
    return p._mundo;
  }

  function invalidar(p) { p._mundo = null; p._corte = null; }

  function rangosDe(p) {
    return (p.rangos && p.rangos.length)
      ? p.rangos
      : [{ ini: 0, fin: p.malla.length, color: p.colorBase }];
  }

  function coloresDe(p) {
    var vistos = {}, n = 0;
    rangosDe(p).forEach(function (rg) {
      var k = rg.color ? rg.color.join(',') : 'base';
      if (!vistos[k]) { vistos[k] = 1; n++; }
    });
    return n || 1;
  }

  function tienePlanos(p) {
    return p.planos && (p.planos.x.length || p.planos.y.length || p.planos.z.length);
  }

  /* El corte de una pieza: el pincel mana; si no, los planos que el usuario
     haya puesto. Sin nada de eso, la pieza va entera. */
  function corteDe(p) {
    var clave;
    if (p.pincelListo && p.pincel) {
      clave = 'pin|' + versionT(p) + '|' + (p.pincelVersion || 0);
      if (!p._corte || p._corte.clave !== clave) {
        p._corte = { clave: clave, datos: Q.cortarEtiquetas(mundo(p).malla, 1, p.pincel) };
      }
      return p._corte.datos;
    }
    if (tienePlanos(p)) {
      clave = 'pla|' + versionT(p) + '|' + JSON.stringify(p.planos);
      if (!p._corte || p._corte.clave !== clave) {
        p._corte = { clave: clave, datos: Q.cortar(mundo(p).malla, 1, 1e9, p.planos) };
      }
      return p._corte.datos;
    }
    return null;
  }

  /* --------------------------------------------------------------- visor */

  /* Con una pieza elegida, las demás palidecen hacia el fondo (el
     "fantasma" de dora); la elegida conserva su color pleno. */
  function fantasma(col) {
    return [col[0] * 0.28 + FONDO_VISOR[0] * 0.72,
            col[1] * 0.28 + FONDO_VISOR[1] * 0.72,
            col[2] * 0.28 + FONDO_VISOR[2] * 0.72];
  }

  function reconstruir(reencuadre) {
    var datos = [];
    mapa = [];
    var global = 0;

    piezas.forEach(function (p, i) {
      if (!p.visible) return;
      var corte = vista === 'despiece' ? corteDe(p) : null;
      if (corte) {
        var ex = Q.explotar(corte);
        datos.push({ tri: ex, color: colorDePieza(p) });
        mapa.push({ p: i, base: -1, n: ex.length / 9, global: global });
        global += ex.length / 9;
        return;
      }
      var w = mundo(p);
      rangosDe(p).forEach(function (rg) {
        var tri = w.malla.subarray(rg.ini, rg.fin);
        var col = rg.color || colorDePieza(p);
        if (sel >= 0 && i !== sel && vista === 'armado') col = fantasma(col);
        datos.push({ tri: tri, color: col });
        mapa.push({ p: i, base: rg.ini / 9, n: tri.length / 9, global: global });
        global += tri.length / 9;
      });
    });

    var p = piezas[sel];
    var conPlanos = vista === 'armado' && p && tienePlanos(p);
    var opciones = {
      camaMm: CONFIG.camaMm, alturaMm: CONFIG.alturaMm, quieto: true,
      planos: conPlanos ? p.planos : null,
      cajaPlanos: conPlanos ? mundo(p).limites : null
    };

    if (!ctrl) {
      ctrl = window.EmishaPreview.montar(lienzo, datos, opciones);
      ctrl.elegir(alElegir);
      ctrl.agarre(probarAgarre, alMoverAgarre);
      ctrl.alMoverPlano(alMoverPlano);
    } else {
      ctrl.actualizar(datos, opciones);
    }
    if (reencuadre) ctrl.reencuadrar();

    if (pincelActivo) {
      ctrl.pincel(pincelRadio, alPintar);
      repintarMarcas();
    } else {
      ctrl.pincel(0);
      lienzo.style.cursor = modoT ? 'move' : '';
    }
    ponerGizmo();
    ponerCorteVista();
    ponerNota();
  }

  /* Rango de vértices de la pieza elegida dentro del visor. */
  function rangoDeSel() {
    var ini = Infinity, fin = -Infinity;
    mapa.forEach(function (ch) {
      if (ch.p !== sel) return;
      if (ch.global * 3 < ini) ini = ch.global * 3;
      if ((ch.global + ch.n) * 3 > fin) fin = (ch.global + ch.n) * 3;
    });
    return isFinite(ini) ? { ini: ini, fin: fin } : null;
  }

  /* La vista previa azul/rosa del plano ACTIVO: se ve de qué lado cae
     cada mitad mientras lo arrastras. */
  function ponerCorteVista() {
    if (!ctrl) return;
    var p = piezas[sel];
    var pa = p && p._planoActivo;
    if (!pa || vista !== 'armado' || pincelActivo ||
        !p.planos[pa.eje] || pa.idx >= p.planos[pa.eje].length) {
      ctrl.corteVista(null);
      return;
    }
    var rango = rangoDeSel();
    if (!rango) { ctrl.corteVista(null); return; }
    ctrl.corteVista({
      ini: rango.ini, fin: rango.fin,
      eje: { x: 0, y: 1, z: 2 }[pa.eje],
      val: p.planos[pa.eje][pa.idx]
    });
  }

  /* El gizmo vive sobre la pieza elegida según la herramienta: flechas
     para mover, anillo para girar, cubos para escalar. */
  function ponerGizmo() {
    if (!ctrl) return;
    var p = piezas[sel];
    if (!p || !modoT || vista !== 'armado' || pincelActivo) {
      ctrl.gizmo(null, alGizmoMover);
      return;
    }
    var w = mundo(p);
    ctrl.gizmo({
      c: [(w.limites.min[0] + w.limites.max[0]) / 2,
          (w.limites.min[1] + w.limites.max[1]) / 2,
          (w.limites.min[2] + w.limites.max[2]) / 2],
      tam: Math.max(30, Math.max(w.caja[0], w.caja[1], w.caja[2]) * 0.72),
      modo: modoT
    }, alGizmoMover);
  }

  var gizmoAcum = null;

  function alGizmoMover(info) {
    var p = piezas[sel];
    if (!p) return;
    if (info.fase === 'fin') {
      if (gizmoAcum) {
        p.t.dx += gizmoAcum.d[0];
        p.t.dy += gizmoAcum.d[1];
        p.t.dz += gizmoAcum.d[2];
        p.t.rz += gizmoAcum.rz;
        if (p.t.rz > 180) p.t.rz -= 360;
        if (p.t.rz < -180) p.t.rz += 360;
        p.t.sx *= gizmoAcum.esc; p.t.sy *= gizmoAcum.esc; p.t.sz *= gizmoAcum.esc;
        gizmoAcum = null;
        invalidar(p);
        if (ctrl) ctrl.previsualizar(null);
        reconstruir(false);
        renderLista();
        refrescarPanel();
        cotizaTodo();
      }
      return;
    }
    if (!gizmoAcum) {
      var rango = rangoDeSel();
      if (!rango) return;
      var w = mundo(p);
      gizmoAcum = {
        ini: rango.ini, fin: rango.fin,
        piv: [(w.limites.min[0] + w.limites.max[0]) / 2,
              (w.limites.min[1] + w.limites.max[1]) / 2,
              (w.limites.min[2] + w.limites.max[2]) / 2],
        tam: Math.max(30, Math.max(w.caja[0], w.caja[1], w.caja[2]) * 0.72),
        d: [0, 0, 0], rz: 0, esc: 1
      };
    }
    if (info.eje === 'rz') {
      gizmoAcum.rz += info.delta;
    } else if (modoT === 'escalar') {
      /* jalar un cubo hacia afuera agranda; hacia el centro, achica */
      var f = 1 + info.delta / (gizmoAcum.tam * 0.9);
      if (f < 0.5) f = 0.5;
      if (f > 2) f = 2;
      var esc = gizmoAcum.esc * f;
      var total = esc * p.t.sx;
      if (total >= 0.01 && total <= 100) gizmoAcum.esc = esc;
    } else {
      gizmoAcum.d[{ x: 0, y: 1, z: 2 }[info.eje]] += info.delta;
    }
    if (ctrl) ctrl.previsualizar({
      ini: gizmoAcum.ini, fin: gizmoAcum.fin,
      piv: gizmoAcum.piv, desp: gizmoAcum.d,
      rz: gizmoAcum.rz * Math.PI / 180, esc: gizmoAcum.esc
    });
  }

  /* Índice global de triángulo -> [pieza, triángulo local] vía el mapa. */
  function resolver(t) {
    for (var i = 0; i < mapa.length; i++) {
      var ch = mapa[i];
      if (t >= ch.global && t < ch.global + ch.n) {
        return [ch.p, ch.base >= 0 ? ch.base + (t - ch.global) : -1];
      }
    }
    return null;
  }

  function alElegir(t) {
    if (pincelActivo) return;
    if (t < 0) { seleccionar(-1); return; }
    var r = resolver(t);
    seleccionar(r ? r[0] : -1);
  }

  /* ------------------------------------- herramientas de arrastre (W/R/S) */

  function setModoT(m) {
    modoT = (modoT === m) ? null : m;
    if (modoT) {
      pincelActivo = false;
      var pp = $('#pincel-panel');
      if (pp) pp.classList.add('is-hidden');
      if (vista !== 'armado') { vista = 'armado'; reconstruir(false); }
      /* Que siempre se vea la herramienta: sin selección, la primera pieza. */
      if (sel < 0 && piezas.length) seleccionar(0);
    }
    refrescarBotones();
    if (ctrl && !pincelActivo) {
      ctrl.pincel(0);
      lienzo.style.cursor = modoT ? 'move' : '';
    }
    ponerGizmo();
    ponerNota();
  }

  function enfocarSel() {
    if (!ctrl) return;
    var p = piezas[sel];
    if (!p) { ctrl.reencuadrar(); return; }
    var w = mundo(p);
    var c = [(w.limites.min[0] + w.limites.max[0]) / 2,
             (w.limites.min[1] + w.limites.max[1]) / 2,
             (w.limites.min[2] + w.limites.max[2]) / 2];
    var r = 0.5 * Math.sqrt(w.caja[0] * w.caja[0] + w.caja[1] * w.caja[1]
                          + w.caja[2] * w.caja[2]);
    ctrl.enfocar(c, Math.max(r, 1) * 1.15);
  }

  /* ¿El arrastre que empieza en este triángulo se queda con la pieza?
     Solo con herramienta activa y sobre la pieza YA seleccionada; si es
     otra pieza, el primer arrastre la selecciona y el siguiente la mueve. */
  function probarAgarre(t) {
    if (!modoT || pincelActivo || vista !== 'armado') return false;
    var r = resolver(t);
    if (!r) return false;
    if (r[0] !== sel) { seleccionar(r[0]); return false; }
    var p = piezas[sel];
    var rango = rangoDeSel();
    if (!rango) return false;
    /* El pivote es el centro de la pieza en el mundo: el giro y la escala
       de mundo() dejan ese punto quieto, así que el arrastre previsualizado
       coincide exacto con lo que se confirma al soltar. */
    agarre = {
      ini: rango.ini, fin: rango.fin,
      piv: [(p.limites.min[0] + p.limites.max[0]) / 2 + p.t.dx,
            (p.limites.min[1] + p.limites.max[1]) / 2 + p.t.dy,
            (p.limites.min[2] + p.limites.max[2]) / 2 + p.t.dz],
      dx: 0, dy: 0, rz: 0, esc: 1
    };
    return true;
  }

  function alMoverAgarre(info) {
    if (!agarre) return;
    var p = piezas[sel];
    if (!p) { agarre = null; return; }
    if (info.fase === 'fin') {
      p.t.dx += agarre.dx;
      p.t.dy += agarre.dy;
      p.t.rz += agarre.rz;
      if (p.t.rz > 180) p.t.rz -= 360;
      if (p.t.rz < -180) p.t.rz += 360;
      p.t.sx *= agarre.esc; p.t.sy *= agarre.esc; p.t.sz *= agarre.esc;
      agarre = null;
      invalidar(p);
      if (ctrl) ctrl.previsualizar(null);
      reconstruir(false);
      renderLista();
      refrescarPanel();
      cotizaTodo();
      return;
    }
    if (modoT === 'mover') {
      agarre.dx += info.wx;
      agarre.dy += info.wy;
    } else if (modoT === 'girar') {
      agarre.rz += info.dx * 0.5;
    } else if (modoT === 'escalar') {
      agarre.esc *= Math.exp(-info.dy * 0.006);
      var tope = agarre.esc * p.t.sx;
      if (tope < 0.01) agarre.esc = 0.01 / p.t.sx;
      if (tope > 100) agarre.esc = 100 / p.t.sx;
    }
    if (ctrl) ctrl.previsualizar({
      ini: agarre.ini, fin: agarre.fin, piv: agarre.piv,
      desp: [agarre.dx, agarre.dy, 0],
      rz: agarre.rz * Math.PI / 180, esc: agarre.esc
    });
  }

  /* Arrastre de un marco de plano en el visor: el visor ya movió la línea;
     aquí solo se acota al cuerpo de la pieza y, al soltar, se recorta y se
     recotiza. */
  function alMoverPlano(info) {
    var p = piezas[sel];
    if (!p || !p.planos[info.eje]) return;
    if (info.fase === 'fin') {
      var a = { x: 0, y: 1, z: 2 }[info.eje];
      var w = mundo(p);
      var v = Math.min(Math.max(info.valor, w.limites.min[a] + 1), w.limites.max[a] - 1);
      p.planos[info.eje][info.idx] = v;
      p._corte = null;
      renderPlanos();
      ponerCorteVista();
      cotizaTodo();
      return;
    }
    /* Mientras se arrastra la sábana, el teñido azul/rosa la sigue en vivo. */
    p._planoActivo = { eje: info.eje, idx: info.idx };
    ponerCorteVista();
  }

  function alPintar(indices) {
    var marcarAhora = [];
    for (var i = 0; i < indices.length; i++) {
      var r = resolver(indices[i]);
      if (!r || r[1] < 0) continue;
      var p = piezas[r[0]];
      if (!p.pincel) p.pincel = new Uint8Array(Math.floor(p.malla.length / 9));
      if (p.pincel[r[1]] === pincelSeccion) continue;
      p.pincel[r[1]] = pincelSeccion;
      marcarAhora.push(indices[i]);
    }
    if (!marcarAhora.length) return;
    if (pincelSeccion === 0) {
      ctrl.desmarcar();
      repintarMarcas();
    } else {
      ctrl.marcar(marcarAhora, SECCIONES[pincelSeccion - 1].color);
    }
    refrescarBotones();
  }

  function repintarMarcas() {
    if (!ctrl) return;
    ctrl.desmarcar();
    for (var s = 1; s <= SECCIONES.length; s++) {
      var lista = [];
      mapa.forEach(function (ch) {
        if (ch.base < 0) return;
        var p = piezas[ch.p];
        if (!p.pincel) return;
        for (var k = 0; k < ch.n; k++) {
          if (p.pincel[ch.base + k] === s) lista.push(ch.global + k);
        }
      });
      if (lista.length) ctrl.marcar(lista, SECCIONES[s - 1].color);
    }
  }

  function ponerNota() {
    var nota = $('#nota');
    if (!nota) return;
    if (!piezas.length) {
      nota.textContent = 'Carga un modelo STL o 3MF para empezar. Nunca sale de tu navegador.';
      return;
    }
    if (pincelActivo) {
      nota.textContent = 'Pinta la sección sobre la pieza · el aro enseña el tamaño del pincel · '
        + 'Shift+arrastrar mueve la vista';
      return;
    }
    if (vista === 'despiece') {
      nota.textContent = 'Así quedan las secciones cortadas · «Armado» regresa a la vista normal';
      return;
    }
    var MODOS = { mover: 'arrastra la pieza para moverla',
                  girar: 'arrastra sobre la pieza para girarla',
                  escalar: 'arrastra sobre la pieza para escalarla' };
    if (modoT) {
      nota.textContent = (sel >= 0 ? piezas[sel].nombre + ' · ' : '')
        + MODOS[modoT] + ' · W mueve · R gira · S escala · F encuadra · Esc suelta';
      return;
    }
    var pSel = piezas[sel];
    if (pSel && (tienePlanos(pSel) || pSel.pincelListo)) {
      nota.textContent = pSel.nombre + ' · arrastra la flecha o la sábana para '
        + 'acomodar el corte · «Cortar pieza» lo aplica y separa las secciones';
      return;
    }
    nota.textContent = (sel >= 0 ? piezas[sel].nombre + ' seleccionada · ' : '')
      + 'clic en una pieza para elegirla · W mueve · R gira · S escala · '
      + 'F encuadra · arrastra los marcos azules para mover un corte';
  }

  /* ------------------------------------------------------------ archivos */

  function agregarArchivos(files) {
    Array.prototype.forEach.call(files, function (file) {
      var ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ext !== 'stl' && ext !== '3mf') return;
      var base = file.name.replace(/\.[^.]+$/, '');
      var reader = new FileReader();
      reader.onload = function () {
        Promise.resolve()
          .then(function () {
            if (ext === 'stl') {
              var tri = new Float64Array(Q.parseSTL(reader.result));
              return { partes: [{ malla: tri, rangos: null, color: null,
                                  volumenMm3: Q.volumen(tri), limites: Q.limites(tri) }] };
            }
            return Q.parse3MF(reader.result);
          })
          .then(function (r) {
            var lote = r.partes || [];
            lote.forEach(function (parte, i) {
              var lim = parte.limites || Q.limites(parte.malla);
              piezas.push({
                nombre: base + (lote.length > 1 ? ' · ' + (i + 1) : ''),
                malla: parte.malla, rangos: parte.rangos || null,
                colorBase: parte.color || null,
                colorAuto: PALETA[piezas.length % PALETA.length],
                volumenMm3: parte.volumenMm3 || Q.volumen(parte.malla),
                areaMm2: Q.area(parte.malla),
                limites: lim,
                caja: [lim.max[0] - lim.min[0], lim.max[1] - lim.min[1], lim.max[2] - lim.min[2]],
                visible: true, t: tNueva(),
                planos: { x: [], y: [], z: [] },
                pincel: null, pincelListo: false, pincelVersion: 0
              });
            });
            if (!lote.length) throw new Error('vacío');
            seleccionar(piezas.length - 1, true);
            renderLista();
            reconstruir(true);
            cotizaTodo();
          })
          .catch(function () {
            var nota = $('#nota');
            if (nota) nota.textContent = 'No se pudo leer ' + file.name + '. ¿Es un STL o 3MF válido?';
          });
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* --------------------------------------------- separar piezas (islas) */

  /* Componentes conexos por vértice compartido: la malla se parte en las
     piezas físicas que realmente contiene. Une-y-encuentra clásico. */
  function separar(idx) {
    var p = piezas[idx];
    if (!p) return;
    var m = p.malla, n = Math.floor(m.length / 9);
    var padre = new Int32Array(n), i;
    for (i = 0; i < n; i++) padre[i] = i;
    function raiz(a) { while (padre[a] !== a) { padre[a] = padre[padre[a]]; a = padre[a]; } return a; }
    function unir(a, b) { a = raiz(a); b = raiz(b); if (a !== b) padre[b] = a; }

    var visto = Object.create(null);
    for (i = 0; i < n; i++) {
      for (var v = 0; v < 3; v++) {
        var o = i * 9 + v * 3;
        var k = Math.round(m[o] * 100) + ',' + Math.round(m[o + 1] * 100) + ','
              + Math.round(m[o + 2] * 100);
        var antes = visto[k];
        if (antes === undefined) visto[k] = i;
        else unir(antes, i);
      }
    }

    var grupos = {};
    for (i = 0; i < n; i++) {
      var r = raiz(i);
      (grupos[r] || (grupos[r] = [])).push(i);
    }
    var claves = Object.keys(grupos);
    if (claves.length < 2) {
      var nota = $('#nota');
      if (nota) nota.textContent = p.nombre + ' ya es una sola pieza conexa.';
      return;
    }

    /* De mayor a menor; si hay demasiadas islas (un STL hecho pedazos),
       las más grandes van sueltas y el resto queda junto en "restos". */
    claves.sort(function (a, b) { return grupos[b].length - grupos[a].length; });
    var MAX = 48;
    var listas = claves.slice(0, MAX).map(function (k) { return grupos[k]; });
    if (claves.length > MAX) {
      var resto = [];
      claves.slice(MAX).forEach(function (k) { resto.push.apply(resto, grupos[k]); });
      listas.push(resto);
    }

    var nuevas = listas.map(function (lista, li) {
      lista.sort(function (a, b) { return a - b; });
      var tri = new Float64Array(lista.length * 9);
      var rangos = [], colorAct, iniAct = 0;
      for (var j = 0; j < lista.length; j++) {
        var src = lista[j] * 9;
        for (var c = 0; c < 9; c++) tri[j * 9 + c] = m[src + c];
        var col = colorDeTri(p, lista[j]);
        var kcol = col ? col.join(',') : 'base';
        if (j === 0) { colorAct = kcol; }
        else if (kcol !== colorAct) {
          rangos.push({ ini: iniAct * 9, fin: j * 9, color: colorAct === 'base' ? null : colorAct.split(',').map(Number) });
          colorAct = kcol; iniAct = j;
        }
      }
      rangos.push({ ini: iniAct * 9, fin: lista.length * 9,
                    color: colorAct === 'base' ? null : colorAct.split(',').map(Number) });
      var lim = Q.limites(tri);
      return {
        nombre: p.nombre + ' · ' + String.fromCharCode(65 + (li % 26)),
        malla: tri, rangos: rangos.length > 1 ? rangos : null,
        colorBase: rangos.length === 1 ? rangos[0].color : p.colorBase,
        colorAuto: PALETA[(idx + li) % PALETA.length],
        volumenMm3: Q.volumen(tri), areaMm2: Q.area(tri),
        limites: lim,
        caja: [lim.max[0] - lim.min[0], lim.max[1] - lim.min[1], lim.max[2] - lim.min[2]],
        visible: true, t: { dx: p.t.dx, dy: p.t.dy, dz: p.t.dz, rz: p.t.rz,
                            sx: p.t.sx, sy: p.t.sy, sz: p.t.sz },
        planos: { x: [], y: [], z: [] },
        pincel: null, pincelListo: false, pincelVersion: 0
      };
    });

    var args = [idx, 1].concat(nuevas);
    Array.prototype.splice.apply(piezas, args);
    seleccionar(idx, true);
    renderLista();
    reconstruir(false);
    cotizaTodo();
  }

  function colorDeTri(p, t) {
    if (!p.rangos) return p.colorBase;
    var o = t * 9;
    for (var i = 0; i < p.rangos.length; i++) {
      if (o >= p.rangos[i].ini && o < p.rangos[i].fin) return p.rangos[i].color || p.colorBase;
    }
    return p.colorBase;
  }

  /* ------------------------------------------------- aplicar el corte */

  /* Volumen de una sección abierta (el corte no tapa los agujeros): tetraedros
     con firma desde el centro de la propia sección, que acota el error de las
     tapas que faltan. Después se normaliza contra el volumen del padre, que sí
     es exacto, así el total de gramos no se mueve. */
  function volumenSeccion(tri, lim) {
    var ox = (lim.min[0] + lim.max[0]) / 2;
    var oy = (lim.min[1] + lim.max[1]) / 2;
    var oz = (lim.min[2] + lim.max[2]) / 2;
    var v6 = 0;
    for (var i = 0; i < tri.length; i += 9) {
      var ax = tri[i] - ox, ay = tri[i + 1] - oy, az = tri[i + 2] - oz;
      var bx = tri[i + 3] - ox, by = tri[i + 4] - oy, bz = tri[i + 5] - oz;
      var cx = tri[i + 6] - ox, cy = tri[i + 7] - oy, cz = tri[i + 8] - oz;
      v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    return Math.abs(v6) / 6;
  }

  /* ------------------------------------------- corte con tapa (planos) ---
     Partir una malla CERRADA con un plano recto deja dos mallas cerradas:
     se recorta cada triángulo, se juntan los segmentos que caen sobre el
     plano, se encadenan en lazos (contornos y agujeros), se triangula la
     sección y se tapa cada mitad con la orientación que le toca. Los planos
     se aplican uno por uno: cada mitad intermedia sigue siendo estanca, así
     que el siguiente plano también la corta bien (las tapas viejas se
     recortan como cualquier triángulo). Solo aquí — el pincel no lleva tapa. */

  /* El valor del plano se aparta un pelo de cualquier vértice: sin vértices
     exactamente sobre el plano no hay casos degenerados y los cruces de
     bordes compartidos dan el mismo punto en los dos triángulos vecinos. */
  function apartarValor(m, eje, val) {
    var v = val, paso = 3e-4, intentos = 0;
    while (intentos++ < 6) {
      var choca = false;
      for (var i = eje; i < m.length; i += 3) {
        if (Math.abs(m[i] - v) < 1e-6) { choca = true; break; }
      }
      if (!choca) return v;
      v += paso;
      paso *= 3;
    }
    return v;
  }

  function areaLazo(pts) {
    var a = 0;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    }
    return a / 2;
  }

  function dentroLazo(pt, pts) {
    var dentro = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var a = pts[i], b = pts[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
          pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) {
        dentro = !dentro;
      }
    }
    return dentro;
  }

  function dentroTri2(p, a, b, c) {
    var d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
    var d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
    var d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
    var neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    var pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(neg && pos);
  }

  /* Recorte de orejas sobre un polígono simple CCW; devuelve índices por
     tercias. Si se atora (ruido numérico), lanza y arriba deciden el plan B. */
  function orejas(pts) {
    var n = pts.length, idx = [], i;
    for (i = 0; i < n; i++) idx.push(i);
    var tris = [], vueltasSinOreja = 0;
    while (idx.length > 3) {
      var corto = false;
      for (i = 0; i < idx.length; i++) {
        var i0 = idx[(i + idx.length - 1) % idx.length];
        var i1 = idx[i];
        var i2 = idx[(i + 1) % idx.length];
        var a = pts[i0], b = pts[i1], c = pts[i2];
        var cruz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (cruz <= 1e-12) continue;                 // cóncava o degenerada
        var limpia = true;
        for (var k = 0; k < idx.length; k++) {
          var iv = idx[k];
          if (iv === i0 || iv === i1 || iv === i2) continue;
          var q = pts[iv];
          if ((q[0] === a[0] && q[1] === a[1]) || (q[0] === b[0] && q[1] === b[1])
              || (q[0] === c[0] && q[1] === c[1])) continue;   // duplicados de puente
          if (dentroTri2(q, a, b, c)) { limpia = false; break; }
        }
        if (!limpia) continue;
        tris.push([i0, i1, i2]);
        idx.splice(i, 1);
        corto = true;
        break;
      }
      if (!corto && ++vueltasSinOreja > 1) throw new Error('sin oreja');
      if (corto) vueltasSinOreja = 0;
    }
    tris.push([idx[0], idx[1], idx[2]]);
    return tris;
  }

  /* Unir un agujero al contorno con un puente (método clásico del rayo
     hacia +u desde el vértice más a la derecha del agujero). */
  function puentear(contorno, hueco) {
    var hi = 0, i;
    for (i = 1; i < hueco.length; i++) if (hueco[i][0] > hueco[hi][0]) hi = i;
    var M = hueco[hi];
    var mejorX = Infinity, mejorI = -1;
    for (i = 0; i < contorno.length; i++) {
      var a = contorno[i], b = contorno[(i + 1) % contorno.length];
      if ((a[1] > M[1]) === (b[1] > M[1])) continue;
      var x = a[0] + (M[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if (x >= M[0] - 1e-9 && x < mejorX) {
        mejorX = x;
        mejorI = (a[0] > b[0]) ? i : (i + 1) % contorno.length;
      }
    }
    if (mejorI < 0) throw new Error('sin puente');
    /* Si algún vértice reflejo cae dentro del triángulo M–I–P, el puente
       va hacia el más cercano en ángulo, no a través de él. */
    var P = contorno[mejorI], I = [mejorX, M[1]];
    var mejorTan = Infinity;
    for (i = 0; i < contorno.length; i++) {
      var q = contorno[i];
      if (q === P || q[0] < M[0]) continue;
      if (!dentroTri2(q, M, I, P)) continue;
      var tan = Math.abs(q[1] - M[1]) / (q[0] - M[0] || 1e-12);
      if (tan < mejorTan) { mejorTan = tan; mejorI = i; P = contorno[i]; }
    }
    var out = [];
    for (i = 0; i <= mejorI; i++) out.push(contorno[i]);
    for (i = 0; i < hueco.length + 1; i++) out.push(hueco[(hi + i) % hueco.length]);
    out.push(contorno[mejorI]);
    for (i = mejorI + 1; i < contorno.length; i++) out.push(contorno[i]);
    return out;
  }

  /* Segmentos sobre el plano -> triángulos de tapa en 3D con normal +eje.
     Los lazos se clasifican por conteo de contención: profundidad par es
     contorno, impar es agujero del contorno más chico que lo contiene. */
  function tapaDeSegmentos(segs, eje, val) {
    var u = (eje + 1) % 3, w = (eje + 2) % 3;
    var mapa = Object.create(null), i, k;
    function clave(p) { return p[u] + ',' + p[w]; }
    segs.forEach(function (s, si) {
      [0, 1].forEach(function (fin) {
        var c = clave(s[fin]);
        (mapa[c] || (mapa[c] = [])).push([si, fin]);
      });
    });

    var usado = new Array(segs.length), lazos = [];
    for (i = 0; i < segs.length; i++) {
      if (usado[i]) continue;
      var lazo = [], si = i, fin = 1;
      usado[i] = true;
      lazo.push([segs[i][0][u], segs[i][0][w]]);
      for (var pasos = 0; pasos <= segs.length; pasos++) {
        var punta = segs[si][fin];
        var c = clave(punta);
        if (c === clave(segs[i][0])) break;         // lazo cerrado
        lazo.push([punta[u], punta[w]]);
        var vecinos = mapa[c].filter(function (v) { return !usado[v[0]]; });
        if (!vecinos.length) throw new Error('borde abierto');
        si = vecinos[0][0];
        usado[si] = true;
        fin = 1 - vecinos[0][1];
      }
      if (lazo.length >= 3 && Math.abs(areaLazo(lazo)) > 1e-7) lazos.push(lazo);
    }
    if (!lazos.length) return [];

    var prof = lazos.map(function (lz, li) {
      var d = 0;
      for (var lj = 0; lj < lazos.length; lj++) {
        if (lj !== li && dentroLazo(lz[0], lazos[lj])) d++;
      }
      return d;
    });

    var tris2 = [];
    lazos.forEach(function (lz, li) {
      if (prof[li] % 2) return;                     // los agujeros van con su contorno
      var poli = areaLazo(lz) > 0 ? lz.slice() : lz.slice().reverse();
      lazos.forEach(function (hu, hj) {
        if (prof[hj] !== prof[li] + 1 || !dentroLazo(hu[0], lz)) return;
        var hueco = areaLazo(hu) > 0 ? hu.slice().reverse() : hu.slice();
        poli = puentear(poli, hueco);
      });
      orejas(poli).forEach(function (t) {
        tris2.push([poli[t[0]], poli[t[1]], poli[t[2]]]);
      });
    });

    var out = [];
    tris2.forEach(function (t) {
      for (k = 0; k < 3; k++) {
        var p3 = [0, 0, 0];
        p3[eje] = val; p3[u] = t[k][0]; p3[w] = t[k][1];
        out.push(p3[0], p3[1], p3[2]);
      }
    });
    return out;
  }

  /* Parte una malla por un plano recto y tapa las dos mitades. Devuelve la
     lista de mitades con geometría (una sola si el plano no la toca). */
  function partirYTapar(m, eje, val) {
    var lim = Q.limites(m);
    if (val <= lim.min[eje] + 0.05 || val >= lim.max[eje] - 0.05) return [m];
    val = apartarValor(m, eje, val);

    var abajo = [], arriba = [], segs = [];
    var v = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

    function cruce(a, b) {
      /* con los extremos ordenados por su coordenada del eje, el punto del
         cruce sale idéntico en los dos triángulos que comparten el borde */
      var p0 = a, p1 = b;
      if (b[eje] < a[eje]) { p0 = b; p1 = a; }
      var t = (val - p0[eje]) / (p1[eje] - p0[eje]);
      return [p0[0] + (p1[0] - p0[0]) * t,
              p0[1] + (p1[1] - p0[1]) * t,
              p0[2] + (p1[2] - p0[2]) * t];
    }
    function meter(destino, p0, p1, p2) {
      destino.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    }

    for (var i = 0; i < m.length; i += 9) {
      for (var k = 0; k < 3; k++) {
        v[k][0] = m[i + k * 3];
        v[k][1] = m[i + k * 3 + 1];
        v[k][2] = m[i + k * 3 + 2];
      }
      var bajo0 = v[0][eje] < val, bajo1 = v[1][eje] < val, bajo2 = v[2][eje] < val;
      var nBajo = (bajo0 ? 1 : 0) + (bajo1 ? 1 : 0) + (bajo2 ? 1 : 0);
      if (nBajo === 3) { meter(abajo, v[0], v[1], v[2]); continue; }
      if (nBajo === 0) { meter(arriba, v[0], v[1], v[2]); continue; }

      /* gira los vértices para que el solitario quede en a */
      var solo = nBajo === 1
        ? (bajo0 ? 0 : (bajo1 ? 1 : 2))
        : (!bajo0 ? 0 : (!bajo1 ? 1 : 2));
      var a = v[solo], b = v[(solo + 1) % 3], c = v[(solo + 2) % 3];
      var pab = cruce(a, b), pca = cruce(c, a);
      if (nBajo === 1) {
        meter(abajo, a, pab, pca);
        meter(arriba, pab, b, c);
        meter(arriba, pab, c, pca);
        segs.push([pab, pca]);        // dirección como la recorre la mitad de abajo
      } else {
        meter(arriba, a, pab, pca);
        meter(abajo, pab, b, c);
        meter(abajo, pab, c, pca);
        segs.push([pca, pab]);
      }
    }

    if (segs.length) {
      var tapa = null;
      try {
        tapa = tapaDeSegmentos(segs, eje, val);
      } catch (e) {
        /* malla sucia o caso degenerado: tapa de abanico con paridad de giro
           — el volumen y el laminado salen bien aunque haya solapes */
        tapa = [];
        var cu = 0, cw = 0, u2 = (eje + 1) % 3, w2 = (eje + 2) % 3;
        segs.forEach(function (s) { cu += s[0][u2] + s[1][u2]; cw += s[0][w2] + s[1][w2]; });
        var C = [0, 0, 0];
        C[eje] = val; C[u2] = cu / (segs.length * 2); C[w2] = cw / (segs.length * 2);
        segs.forEach(function (s) {
          tapa.push(C[0], C[1], C[2], s[1][0], s[1][1], s[1][2], s[0][0], s[0][1], s[0][2]);
        });
      }
      /* mitad de abajo: tapa mirando a +eje; la de arriba, invertida */
      for (var q = 0; q < tapa.length; q += 9) {
        abajo.push(tapa[q], tapa[q + 1], tapa[q + 2],
                   tapa[q + 3], tapa[q + 4], tapa[q + 5],
                   tapa[q + 6], tapa[q + 7], tapa[q + 8]);
        arriba.push(tapa[q], tapa[q + 1], tapa[q + 2],
                    tapa[q + 6], tapa[q + 7], tapa[q + 8],
                    tapa[q + 3], tapa[q + 4], tapa[q + 5]);
      }
    }

    var out = [];
    if (abajo.length >= 27) out.push(new Float64Array(abajo));
    if (arriba.length >= 27) out.push(new Float64Array(arriba));
    return out.length ? out : [m];
  }

  function cortarConTapas(malla, planos) {
    var partes = [malla];
    ['x', 'y', 'z'].forEach(function (eje, e) {
      planos[eje].slice().sort(function (a, b) { return a - b; }).forEach(function (val) {
        var sig = [];
        partes.forEach(function (m) {
          partirYTapar(m, e, val).forEach(function (r) { sig.push(r); });
        });
        partes = sig;
      });
    });
    return partes;
  }

  /* El «Cortar» de dora: las secciones del corte en curso pasan a la lista
     como piezas de verdad, cada una con su color, listas para moverse con W.
     Quedan en su sitio: nada salta solo. Los cortes por plano salen tapados
     (sólidos estancos); el pincel deja las secciones abiertas. */
  function aplicarCorte(idx) {
    var p = piezas[idx];
    if (!p) return;
    var nota = $('#nota');
    var lote = null, tapado = false;

    if (p.pincelListo && p.pincel) {
      var corte = corteDe(p);
      if (corte && corte.celdas && corte.celdas.length > 1) {
        var celdas = corte.celdas.map(function (cel) {
          var lim = cel.lim || Q.limites(cel.tri);
          return { tri: cel.tri, vol: volumenSeccion(cel.tri, lim) };
        });
        var suma = 0;
        celdas.forEach(function (cel) { suma += cel.vol; });
        var volPadre = p.volumenMm3 * p.t.sx * p.t.sy * p.t.sz;
        var factor = suma > 0 ? volPadre / suma : 1;
        lote = celdas.map(function (cel) { return { tri: cel.tri, vol: cel.vol * factor }; });
      }
    } else if (tienePlanos(p)) {
      var partes = cortarConTapas(mundo(p).malla, p.planos);
      if (partes.length > 1) {
        tapado = true;
        lote = partes.map(function (tri) { return { tri: tri, vol: Q.volumen(tri) }; });
      }
    }

    if (!lote) {
      if (nota) nota.textContent = 'Primero pon un corte: «+ X / + Y / + Z», «Automático» o el pincel.';
      return;
    }

    var nuevas = lote.map(function (nm, ci) {
      var lim = Q.limites(nm.tri);
      return {
        nombre: p.nombre + ' · ' + String.fromCharCode(65 + (ci % 26)),
        malla: nm.tri, rangos: null,
        colorBase: null,
        colorAuto: PALETA[(idx + ci) % PALETA.length],
        volumenMm3: nm.vol, areaMm2: Q.area(nm.tri),
        limites: lim,
        caja: [lim.max[0] - lim.min[0], lim.max[1] - lim.min[1], lim.max[2] - lim.min[2]],
        visible: true, t: tNueva(),
        planos: { x: [], y: [], z: [] },
        pincel: null, pincelListo: false, pincelVersion: 0
      };
    });

    Array.prototype.splice.apply(piezas, [idx, 1].concat(nuevas));
    vista = 'armado';
    seleccionar(idx, true);
    renderLista();
    refrescarPanel();
    reconstruir(false);
    cotizaTodo();
    if (nota) nota.textContent = p.nombre + ' cortada en ' + nuevas.length
      + (tapado ? ' piezas sólidas, con el corte tapado — listas para descargar en STL.'
                : ' secciones (el pincel va sin tapa). El botón de descarga las exporta.');
  }

  /* ------------------------------------------------------------ interfaz */

  function seleccionar(i, silencio) {
    if (sel === i && !silencio) return;
    sel = i;
    renderLista();
    refrescarPanel();
    if (!silencio) reconstruir(false);
  }

  function renderLista() {
    var cont = $('#lista-piezas');
    if (!cont) return;
    var titulo = $('#piezas-titulo');
    if (titulo) {
      titulo.textContent = piezas.length ? 'Piezas (' + piezas.length + ')' : 'Piezas';
    }
    var contador = $('#contador');
    if (contador) {
      var tris = 0;
      piezas.forEach(function (p) { tris += Math.floor(p.malla.length / 9); });
      contador.textContent = piezas.length
        ? piezas.length + (piezas.length === 1 ? ' pieza · ' : ' piezas · ')
          + tris.toLocaleString('es-MX') + ' triángulos'
        : '';
    }
    cont.innerHTML = '';
    if (!piezas.length) {
      var p0 = document.createElement('p');
      p0.className = 'muted';
      p0.style.fontSize = '.85rem';
      p0.textContent = 'Sin piezas todavía.';
      cont.appendChild(p0);
      refrescarBotones();
      return;
    }
    piezas.forEach(function (p, i) {
      var fila = document.createElement('div');
      fila.className = 'pieza-fila' + (i === sel ? ' pieza-fila--activa' : '');

      var punto = document.createElement('span');
      punto.className = 'pieza-fila__punto';
      punto.style.background = 'rgb(' + colorDePieza(p).map(function (c) {
        return Math.round(c * 255);
      }).join(',') + ')';

      var nombre = document.createElement('span');
      nombre.className = 'pieza-fila__nombre';
      var w = mundo(p);
      nombre.textContent = p.nombre;
      nombre.title = p.nombre + ' — ' + w.caja.map(function (v) {
        return Math.round(v);
      }).join(' × ') + ' mm';

      var ojo = document.createElement('button');
      ojo.type = 'button';
      ojo.className = 'pieza-fila__ojo' + (p.visible ? '' : ' pieza-fila__ojo--off');
      ojo.textContent = '👁';
      ojo.setAttribute('aria-label', (p.visible ? 'Ocultar ' : 'Mostrar ') + p.nombre);
      ojo.addEventListener('click', function (e) {
        e.stopPropagation();
        p.visible = !p.visible;
        renderLista();
        reconstruir(false);
      });

      fila.appendChild(punto);
      fila.appendChild(nombre);
      fila.appendChild(ojo);
      fila.addEventListener('click', function () { seleccionar(i); cerrarMenuPiezas(); });
      cont.appendChild(fila);
    });

    /* El botón del desplegable enseña la pieza elegida (o cuántas hay). */
    var btnP = $('#piezas-boton'), lblP = $('#piezas-actual'), dotP = $('#piezas-punto');
    var pSelB = piezas[sel];
    if (btnP) btnP.disabled = !piezas.length;
    if (lblP) {
      lblP.textContent = pSelB ? pSelB.nombre
        : (piezas.length ? 'Elige una pieza (' + piezas.length + ')' : 'Sin piezas todavía');
    }
    if (dotP) {
      dotP.style.background = pSelB
        ? 'rgb(' + colorDePieza(pSelB).map(function (c) { return Math.round(c * 255); }).join(',') + ')'
        : '#cbd5e1';
    }
    refrescarBotones();
  }

  function cerrarMenuPiezas() {
    var menu = $('#lista-piezas'), btn = $('#piezas-boton');
    if (menu) menu.classList.add('is-hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function refrescarBotones() {
    var hay = piezas.length > 0;
    var p = piezas[sel];
    /* Sin piezas manda la zona de arrastre, como en el cotizador; con
       piezas, el lienzo. */
    var zc = $('#zona-carga');
    if (zc) zc.classList.toggle('is-hidden', hay);
    lienzo.classList.toggle('is-hidden', !hay);
    [['#btn-separar', hay && sel >= 0],
     ['#btn-cortar', !!(p && (tienePlanos(p) || p.pincelListo))],
     ['#btn-vista', hay],
     ['#btn-pincel', hay],
     ['#btn-reset', hay],
     ['#btn-enfocar', hay],
     ['#btn-exportar', hay],
     ['#modo-mover', hay],
     ['#modo-girar', hay],
     ['#modo-escalar', hay]].forEach(function (par) {
      var b = $(par[0]);
      if (b) b.disabled = !par[1];
    });
    [['#modo-mover', 'mover'], ['#modo-girar', 'girar'], ['#modo-escalar', 'escalar']]
      .forEach(function (par) {
        var b = $(par[0]);
        if (b) b.classList.toggle('visor-btn--activo', modoT === par[1]);
      });
    /* Los botones de la barra son iconos: el estado va en la clase activa
       y el título, no en el texto. */
    var vistaBtn = $('#btn-vista');
    if (vistaBtn) {
      vistaBtn.classList.toggle('visor-btn--activo', vista === 'despiece');
      vistaBtn.title = vista === 'despiece'
        ? 'Armado — regresa a la vista normal'
        : 'Despiece — muestra las secciones cortadas separadas';
    }
    var pincelBtn = $('#btn-pincel');
    if (pincelBtn) pincelBtn.classList.toggle('visor-btn--activo', pincelActivo);
    var res = $('#resultado');
    if (res) res.classList.toggle('is-hidden', !hay);
    var pp = $('#panel-pieza');
    if (pp) pp.classList.toggle('is-hidden', !p);
    var pc = $('#panel-cortes');
    if (pc) pc.classList.toggle('is-hidden', !p);
  }

  /* Los valores solo se escriben si el usuario no está tecleando en ese
     campo: si no, se pelearía con su propio cursor. */
  function poner(idSel, valor) {
    var el = $(idSel);
    if (!el || document.activeElement === el) return;
    el.value = valor;
  }

  function refrescarPanel() {
    var p = piezas[sel];
    refrescarBotones();
    if (!p) return;
    var nom = $('#pieza-nombre');
    if (nom) nom.textContent = p.nombre;
    poner('#mov-x', Math.round(p.t.dx));
    poner('#mov-y', Math.round(p.t.dy));
    poner('#mov-z', Math.round(p.t.dz));
    poner('#gir-z', Math.round(p.t.rz));
    var gv = $('#gir-z-val');
    if (gv) gv.textContent = Math.round(p.t.rz) + '°';
    poner('#med-x', +(p.caja[0] * p.t.sx).toFixed(1));
    poner('#med-y', +(p.caja[1] * p.t.sy).toFixed(1));
    poner('#med-z', +(p.caja[2] * p.t.sz).toFixed(1));
    poner('#esc-pct', Math.round(p.t.sx * 100));
    renderPlanos();
  }

  function alCambiar(fn) {
    var p = piezas[sel];
    if (!p) return;
    fn(p);
    invalidar(p);
    clearTimeout(timer);
    timer = setTimeout(function () {
      reconstruir(false);
      renderLista();
      refrescarPanel();
      cotizaTodo();
    }, 160);
  }

  function numero(ev) {
    var v = parseFloat(ev.target.value);
    return isFinite(v) ? v : null;
  }

  function conectarPanel() {
    [['#mov-x', 'dx'], ['#mov-y', 'dy'], ['#mov-z', 'dz']].forEach(function (par) {
      var el = $(par[0]);
      if (!el) return;
      el.addEventListener('input', function (ev) {
        var v = numero(ev);
        if (v === null) return;
        alCambiar(function (p) { p.t[par[1]] = v; });
      });
    });

    var gir = $('#gir-z');
    if (gir) gir.addEventListener('input', function (ev) {
      var v = numero(ev);
      if (v === null) return;
      var gv = $('#gir-z-val');
      if (gv) gv.textContent = Math.round(v) + '°';
      alCambiar(function (p) { p.t.rz = v; });
    });
    var g90 = $('#gir-90');
    if (g90) g90.addEventListener('click', function () {
      alCambiar(function (p) {
        p.t.rz = p.t.rz + 90;
        if (p.t.rz > 180) p.t.rz -= 360;
      });
    });

    [['#med-x', 0, 'sx'], ['#med-y', 1, 'sy'], ['#med-z', 2, 'sz']].forEach(function (par) {
      var el = $(par[0]);
      if (!el) return;
      el.addEventListener('input', function (ev) {
        var v = numero(ev);
        if (v === null || v <= 0) return;
        alCambiar(function (p) {
          var k = v / (p.caja[par[1]] || 1);
          if (!isFinite(k) || k <= 0) return;
          var uni = $('#med-uni');
          if (!uni || uni.checked) { p.t.sx = k; p.t.sy = k; p.t.sz = k; }
          else p.t[par[2]] = k;
        });
      });
    });

    var esc = $('#esc-pct');
    if (esc) esc.addEventListener('input', function (ev) {
      var v = numero(ev);
      if (v === null || v <= 0) return;
      alCambiar(function (p) { p.t.sx = v / 100; p.t.sy = v / 100; p.t.sz = v / 100; });
    });

    var reset = $('#pieza-reset');
    if (reset) reset.addEventListener('click', function () {
      alCambiar(function (p) {
        p.t = tNueva();
        p.planos = { x: [], y: [], z: [] };
        p._planoActivo = null;
        p.pincel = null; p.pincelListo = false;
        p.pincelVersion++;
      });
    });

    var quitar = $('#pieza-quitar');
    if (quitar) quitar.addEventListener('click', function () {
      if (sel < 0) return;
      piezas.splice(sel, 1);
      sel = piezas.length ? Math.min(sel, piezas.length - 1) : -1;
      renderLista();
      refrescarPanel();
      reconstruir(false);
      cotizaTodo();
    });
  }

  /* -------------------------------------------------- cortes por plano */

  function renderPlanos() {
    var cont = $('#lista-planos');
    var p = piezas[sel];
    if (!cont) return;
    cont.innerHTML = '';
    refrescarBotones();          // «Cortar pieza» prende y apaga con los planos
    if (!p) return;
    var w = mundo(p);
    var EJES = ['x', 'y', 'z'];
    var NOMBRES = { x: 'X', y: 'Y', z: 'Z' };
    EJES.forEach(function (eje, a) {
      p.planos[eje].forEach(function (valor, i) {
        var fila = document.createElement('div');
        fila.className = 'plano-fila';
        var eti = document.createElement('span');
        eti.textContent = NOMBRES[eje] + ' · corte ' + (i + 1);
        var rango = document.createElement('input');
        rango.type = 'range';
        rango.min = (w.limites.min[a] + 1).toFixed(0);
        rango.max = (w.limites.max[a] - 1).toFixed(0);
        rango.step = '1';
        rango.value = Math.round(valor);
        var num = document.createElement('span');
        num.className = 'plano-mm';
        num.textContent = Math.round(valor - w.limites.min[a]) + ' mm';
        rango.addEventListener('input', function () {
          var v = parseFloat(rango.value);
          p.planos[eje][i] = v;
          num.textContent = Math.round(v - w.limites.min[a]) + ' mm';
          p._corte = null;
          p._planoActivo = { eje: eje, idx: i };
          if (ctrl) ctrl.configurar({ camaMm: CONFIG.camaMm, alturaMm: CONFIG.alturaMm,
                                      planos: p.planos, cajaPlanos: mundo(p).limites });
          ponerCorteVista();
          clearTimeout(timer);
          timer = setTimeout(function () { cotizaTodo(); ponerNota(); }, 300);
        });
        var quitar = document.createElement('button');
        quitar.type = 'button';
        quitar.className = 'plano-quitar';
        quitar.textContent = '×';
        quitar.setAttribute('aria-label', 'Quitar este corte');
        quitar.addEventListener('click', function () {
          p.planos[eje].splice(i, 1);
          p._corte = null;
          p._planoActivo = null;
          renderPlanos();
          reconstruir(false);
          cotizaTodo();
        });
        fila.appendChild(eti); fila.appendChild(rango);
        fila.appendChild(num); fila.appendChild(quitar);
        cont.appendChild(fila);
      });
    });
  }

  function conectarCortes() {
    [['#add-x', 'x', 0], ['#add-y', 'y', 1], ['#add-z', 'z', 2]].forEach(function (par) {
      var b = $(par[0]);
      if (!b) return;
      b.addEventListener('click', function () {
        var p = piezas[sel];
        if (!p) return;
        var w = mundo(p);
        var a = par[2];
        p.planos[par[1]].push((w.limites.min[a] + w.limites.max[a]) / 2);
        p._corte = null;
        p._planoActivo = { eje: par[1], idx: p.planos[par[1]].length - 1 };
        renderPlanos();
        reconstruir(false);
        cotizaTodo();
      });
    });

    var auto = $('#auto-cortes');
    if (auto) auto.addEventListener('click', function () {
      var p = piezas[sel];
      if (!p) return;
      var lim = Math.min(CONFIG.camaMm, CONFIG.alturaMm) - CONFIG.margenCorteMm;
      var corte = Q.cortar(mundo(p).malla, 1, lim, null);
      var nota = $('#nota');
      if (!corte) {
        if (nota) nota.textContent = p.nombre + ' ya cabe en la cama de '
          + CONFIG.camaMm + ' mm: no necesita cortes.';
        return;
      }
      p.planos = { x: corte.fronteras.x.slice(),
                   y: corte.fronteras.y.slice(),
                   z: corte.fronteras.z.slice() };
      p._corte = null;
      var ejeAct = ['z', 'y', 'x'].filter(function (e2) {
        return p.planos[e2].length;
      })[0];
      p._planoActivo = ejeAct ? { eje: ejeAct, idx: 0 } : null;
      renderPlanos();
      reconstruir(false);
      cotizaTodo();
    });
  }

  /* --------------------------------------------------------- el pincel */

  function construirPanelPincel() {
    var panel = $('#pincel-panel');
    if (!panel || panel.childNodes.length) return;
    var eti = document.createElement('span');
    eti.textContent = 'Sección:';
    panel.appendChild(eti);

    var botones = [];
    function boton(nombre, css, valor) {
      var b = document.createElement('button');
      b.type = 'button';
      /* el de Borrar no lleva color de sección: texto normal y ancho libre */
      b.className = css ? 'pincel-sec' : 'pincel-sec pincel-sec--borrar';
      b.textContent = nombre;
      if (css) b.style.background = css;
      b.addEventListener('click', function () {
        pincelSeccion = valor;
        botones.forEach(function (x) { x.classList.remove('pincel-sec--activo'); });
        b.classList.add('pincel-sec--activo');
      });
      botones.push(b);
      panel.appendChild(b);
      return b;
    }
    SECCIONES.forEach(function (s, i) {
      var css = 'rgb(' + s.color.map(function (c) { return Math.round(c * 255); }).join(',') + ')';
      var b = boton(s.nombre, css, i + 1);
      if (i + 1 === pincelSeccion) b.classList.add('pincel-sec--activo');
    });
    boton('Borrar', '', 0);

    var etiT = document.createElement('span');
    etiT.textContent = 'Tamaño:';
    panel.appendChild(etiT);
    var rango = document.createElement('input');
    rango.type = 'range'; rango.min = '10'; rango.max = '90';
    rango.value = pincelRadio;
    rango.addEventListener('input', function () {
      pincelRadio = parseInt(rango.value, 10) || 30;
      if (ctrl && pincelActivo) ctrl.pincel(pincelRadio, alPintar);
    });
    panel.appendChild(rango);

    var aplicar = document.createElement('button');
    aplicar.type = 'button';
    aplicar.className = 'btn btn--primary btn--sm';
    aplicar.textContent = 'Aplicar corte';
    aplicar.addEventListener('click', function () {
      var alguno = false;
      piezas.forEach(function (p) {
        if (p.pincel && p.pincel.some(function (e) { return e; })) {
          p.pincelListo = true;
          p.pincelVersion++;
          p._corte = null;
          alguno = true;
        }
      });
      if (!alguno) return;
      pincelActivo = false;
      vista = 'despiece';
      $('#pincel-panel').classList.add('is-hidden');
      renderLista();
      reconstruir(false);
      cotizaTodo();
    });
    panel.appendChild(aplicar);
  }

  /* ------------------------------------------------------- exportar --- */

  /* STL binario de una o varias mallas en coordenadas de mundo: cabecera de
     80 bytes, conteo, y 50 bytes por triángulo (normal + 3 vértices + attr). */
  function stlDe(mallas) {
    var nTri = 0;
    mallas.forEach(function (m) { nTri += Math.floor(m.length / 9); });
    var buf = new ArrayBuffer(84 + nTri * 50);
    var dv = new DataView(buf);
    var firma = 'Emisha cortador — emisha.com.mx';
    for (var i = 0; i < firma.length && i < 80; i++) dv.setUint8(i, firma.charCodeAt(i) & 0x7f);
    dv.setUint32(80, nTri, true);
    var off = 84;
    mallas.forEach(function (m) {
      for (var t = 0; t + 8 < m.length; t += 9) {
        var ux = m[t + 3] - m[t], uy = m[t + 4] - m[t + 1], uz = m[t + 5] - m[t + 2];
        var vx = m[t + 6] - m[t], vy = m[t + 7] - m[t + 1], vz = m[t + 8] - m[t + 2];
        var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        var lg = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        dv.setFloat32(off, nx / lg, true);
        dv.setFloat32(off + 4, ny / lg, true);
        dv.setFloat32(off + 8, nz / lg, true);
        off += 12;
        for (var c = 0; c < 9; c++) { dv.setFloat32(off, m[t + c], true); off += 4; }
        dv.setUint16(off, 0, true); off += 2;
      }
    });
    return buf;
  }

  function descargarArchivo(nombre, buf) {
    var blob = new Blob([buf], { type: 'model/stl' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function nombreArchivo(s) {
    return s.replace(/[^\w.á-úÁ-Úñ-]+/g, '-').replace(/^-+|-+$/g, '') || 'pieza';
  }

  /* Descarga la pieza seleccionada tal como está en el visor (movida, girada,
     escalada y cortada); sin selección, todas las visibles en un solo STL. */
  function exportarSTL() {
    if (!piezas.length) return;
    var nota = $('#nota');
    var p = piezas[sel];
    if (p) {
      descargarArchivo(nombreArchivo(p.nombre) + '.stl', stlDe([mundo(p).malla]));
      if (nota) nota.textContent = p.nombre + ' descargada como STL. Los cortes por '
        + 'plano van tapados (sólidos); solo el pincel deja la sección abierta.';
      return;
    }
    var visibles = piezas.filter(function (v) { return v.visible; });
    if (!visibles.length) return;
    descargarArchivo('piezas-emisha.stl',
      stlDe(visibles.map(function (v) { return mundo(v).malla; })));
    if (nota) nota.textContent = visibles.length + ' piezas descargadas en un solo STL. '
      + 'Elige una pieza antes de descargar si la quieres suelta.';
  }

  /* ------------------------------------------------------- cotización */

  function cotizaTodo() {
    var totalEl = $('#total'), detalleEl = $('#total-detalle'), wa = $('#btn-wa');
    if (!totalEl) return;
    if (!piezas.length) { totalEl.textContent = '—'; return; }

    var total = 0, gramos = 0, horas = 0, camas = 0, secciones = 0;
    var lineas = ['Hola, arme estas piezas en el cortador y quiero cotizarlas:', ''];

    piezas.forEach(function (p) {
      var w = mundo(p);
      var volE = p.volumenMm3 * p.t.sx * p.t.sy * p.t.sz / 1000;
      var sm = (p.t.sx + p.t.sy + p.t.sz) / 3;
      var corte = corteDe(p);
      var q = Q.cotizar(volE, 'pla', 0.15, 1, w.caja, corte, null, 0,
                        p.areaMm2 * sm * sm, coloresDe(p), null);
      total += q.total; gramos += q.gramos; horas += q.horas;
      camas += q.camas; secciones += q.secciones;
      var linea = '• ' + p.nombre + ' · '
        + w.caja.map(function (v) { return Math.round(v); }).join('×') + ' mm';
      if (corte) linea += ' · en ' + q.secciones + ' secciones para armar';
      lineas.push(linea);
    });
    /* Revisar y preparar el archivo se cobra una vez, no por pieza. */
    if (piezas.length > 1) total -= CONFIG.preparacionPorArchivo * (piezas.length - 1);

    totalEl.textContent = fmt(total);
    if (detalleEl) {
      detalleEl.textContent = piezas.length
        + (piezas.length === 1 ? ' pieza' : ' piezas')
        + (secciones > piezas.length ? ' · ' + secciones + ' secciones' : '')
        + ' · ' + Math.round(gramos) + ' g de PLA · ~' + horas.toFixed(1) + ' h · '
        + camas + (camas === 1 ? ' cama' : ' camas');
    }
    if (wa) {
      lineas.push('', 'Estimado del sitio: ' + fmt(total),
                  '', 'Enseguida mando los archivos por aquí.');
      wa.href = 'https://wa.me/' + Q.whatsapp + '?text=' + encodeURIComponent(lineas.join('\n'));
    }
  }

  /* -------------------------------------------------------- arranque */

  var archivo = $('#archivo');
  if (archivo) archivo.addEventListener('change', function () {
    agregarArchivos(archivo.files);
    archivo.value = '';
  });

  /* También se puede soltar el archivo directo sobre el visor. */
  var zonaVisor = $('#zona-visor');
  if (zonaVisor) {
    ['dragenter', 'dragover'].forEach(function (ev) {
      zonaVisor.addEventListener(ev, function (e) { e.preventDefault(); });
    });
    zonaVisor.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer) agregarArchivos(e.dataTransfer.files);
    });
  }

  /* La zona de arrastre inicial: clic o Enter abre el selector; el soltado
     lo atiende el visor de arriba, aquí solo va el resaltado. */
  var zonaCarga = $('#zona-carga');
  if (zonaCarga) {
    zonaCarga.addEventListener('click', function () { if (archivo) archivo.click(); });
    zonaCarga.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (archivo) archivo.click(); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zonaCarga.addEventListener(ev, function (e) {
        e.preventDefault(); zonaCarga.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zonaCarga.addEventListener(ev, function () {
        zonaCarga.classList.remove('is-over');
      });
    });
  }

  var btnSeparar = $('#btn-separar');
  if (btnSeparar) btnSeparar.addEventListener('click', function () {
    if (sel >= 0) separar(sel);
  });

  var btnCortar = $('#btn-cortar');
  if (btnCortar) btnCortar.addEventListener('click', function () {
    if (sel >= 0) aplicarCorte(sel);
  });

  var btnEnfocar = $('#btn-enfocar');
  if (btnEnfocar) btnEnfocar.addEventListener('click', function () { enfocarSel(); });

  var btnExportar = $('#btn-exportar');
  if (btnExportar) btnExportar.addEventListener('click', exportarSTL);

  var piezasBoton = $('#piezas-boton');
  if (piezasBoton) {
    piezasBoton.addEventListener('click', function (e) {
      e.stopPropagation();
      var menu = $('#lista-piezas');
      if (!menu) return;
      var abrir = menu.classList.contains('is-hidden');
      menu.classList.toggle('is-hidden', !abrir);
      piezasBoton.setAttribute('aria-expanded', abrir ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!(e.target.closest && e.target.closest('.ctr-desplegable-caja'))) cerrarMenuPiezas();
    });
  }

  var btnVista = $('#btn-vista');
  if (btnVista) btnVista.addEventListener('click', function () {
    vista = vista === 'armado' ? 'despiece' : 'armado';
    if (vista === 'despiece') {
      pincelActivo = false;
      var pp = $('#pincel-panel');
      if (pp) pp.classList.add('is-hidden');
    }
    refrescarBotones();
    reconstruir(false);
  });

  var btnPincel = $('#btn-pincel');
  if (btnPincel) btnPincel.addEventListener('click', function () {
    pincelActivo = !pincelActivo;
    if (pincelActivo) {
      vista = 'armado';
      construirPanelPincel();
    }
    var pp = $('#pincel-panel');
    if (pp) pp.classList.toggle('is-hidden', !pincelActivo);
    refrescarBotones();
    reconstruir(false);
  });

  var btnReset = $('#btn-reset');
  if (btnReset) btnReset.addEventListener('click', function () {
    piezas.forEach(function (p) {
      p.t = tNueva();
      p.planos = { x: [], y: [], z: [] };
      p._planoActivo = null;
      p.pincel = null; p.pincelListo = false;
      p.pincelVersion++;
      p.visible = true;
      invalidar(p);
    });
    vista = 'armado';
    pincelActivo = false;
    var pp = $('#pincel-panel');
    if (pp) pp.classList.add('is-hidden');
    if (ctrl) ctrl.desmarcar();
    renderLista();
    refrescarPanel();
    reconstruir(true);
    cotizaTodo();
  });

  [['#modo-mover', 'mover'], ['#modo-girar', 'girar'], ['#modo-escalar', 'escalar']]
    .forEach(function (par) {
      var b = $(par[0]);
      if (b) b.addEventListener('click', function () { setModoT(par[1]); });
    });

  /* Atajos estilo Maya/Max: W mueve, R gira, S escala, F encuadra, Esc
     suelta la herramienta (y con ella apagada, la selección). No aplican
     mientras se teclea en un campo. */
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (!piezas.length) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'w') { setModoT('mover'); e.preventDefault(); }
    else if (k === 'r') { setModoT('girar'); e.preventDefault(); }
    else if (k === 's') { setModoT('escalar'); e.preventDefault(); }
    else if (k === 'f') { enfocarSel(); e.preventDefault(); }
    else if (k === 'escape') {
      var menuP = $('#lista-piezas');
      if (menuP && !menuP.classList.contains('is-hidden')) cerrarMenuPiezas();
      else if (modoT) setModoT(modoT);     // apaga la herramienta activa
      else if (sel >= 0) seleccionar(-1);
    }
  });

  conectarPanel();
  conectarCortes();
  renderLista();

  /* Gancho de pruebas del editor, como __emishaQuote en el cotizador. */
  window.__emishaCut = {
    piezas: function () { return piezas; },
    seleccionar: seleccionar,
    seleccion: function () { return sel; },
    mundo: mundo,
    corte: corteDe,
    separar: separar,
    cortar: aplicarCorte,
    vista: function () { return vista; },
    modo: function () { return modoT; }
  };
})();
