/* ==========================================================================
   Emisha — vista previa 3D de la malla del cotizador
   WebGL puro, sin librerías ni dependencias externas. El archivo del cliente
   nunca sale del navegador: aquí sólo se dibujan los triángulos que el
   cotizador ya leyó en memoria.

   API pública (única):
     window.EmishaPreview.montar(canvas, datos, opciones) -> controlador
       datos    : Float64Array en milímetros, 9 números por triángulo
                  (x1,y1,z1, x2,y2,z2, x3,y3,z3), en coordenadas de mundo
                  — o una lista de trozos [{tri, color:[r,g,b]}] para pintar
                  cada parte del modelo con su color (color null = gris).
       opciones : opcional, {camaMm, alturaMm} dibuja la cama de impresión
                  bajo el modelo (varias camas si el modelo abarca más de
                  una) para dar la escala. Sin opciones no se dibuja nada.
       controlador.actualizar(datos, opciones)  cambia la geometría
       controlador.destruir()                   libera GL y quita los oyentes

   Si no hay WebGL el módulo no hace nada visible y no lanza excepciones:
   la cotización (que son números) tiene que seguir funcionando siempre.
   ========================================================================== */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ================================================================
     AJUSTES DE PRESENTACIÓN — el sitio es blanco y minimal, así que
     el fondo va transparente y la pieza se resuelve en gris neutro.
     ================================================================ */
  var COLOR_MALLA   = [0.72, 0.74, 0.78];   // gris frío, legible en claro y oscuro
  var FOV           = 32 * Math.PI / 180;   // campo vertical
  var MARGEN_ENCUADRE = 1.14;               // aire alrededor de la pieza
  var GIRO_INACTIVO = 0.20;                 // rad/s del giro de reposo
  var DPR_MAX       = 2;                    // más que esto no se nota y cuesta
  var ZOOM_MIN      = 0.18;
  var ZOOM_MAX      = 9;
  var PITCH_MAX     = 1.50;                 // ~86°, evita el polo del lookAt
  var MS_POR_TAJADA = 8;                    // presupuesto por cuadro al construir
  var TRI_POR_BLOQUE = 2048;                // triángulos entre lecturas del reloj

  /* Sensibilidad de la órbita, en radianes por píxel de CSS. */
  var RAD_POR_PX = 0.0090;

  var ahora = (window.performance && window.performance.now)
    ? function () { return window.performance.now(); }
    : function () { return Date.now(); };

  var pedirCuadro = window.requestAnimationFrame ||
                    window.webkitRequestAnimationFrame ||
                    function (fn) { return window.setTimeout(function () { fn(ahora()); }, 16); };
  var cancelarCuadro = window.cancelAnimationFrame ||
                       window.webkitCancelAnimationFrame ||
                       window.clearTimeout;

  /* ¿El navegador entiende el tercer argumento como objeto de opciones?
     Lo necesitamos para poder llamar preventDefault en wheel y touchmove. */
  var OPC_ACTIVO = false;
  try {
    var sonda = Object.defineProperty({}, 'passive', {
      get: function () { OPC_ACTIVO = { passive: false }; return false; }
    });
    window.addEventListener('emisha-sonda', null, sonda);
    window.removeEventListener('emisha-sonda', null, sonda);
  } catch (e) { OPC_ACTIVO = false; }

  function movimientoReducido() {
    try {
      return !!(window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  /* ======================================================== SOMBREADORES */

  /* uMod/uPiv/uDesp: transformación de previsualización mientras se arrastra
     una pieza (mover/girar/escalar). En reposo son la identidad y cero, así
     que no cuestan nada; al arrastrar, la pieza se transforma en la GPU sin
     reconstruir la malla — por eso el arrastre se siente vivo. */
  var VS = [
    'attribute vec3 aPos;',
    'attribute vec3 aNor;',
    'uniform mat4 uProy;',
    'uniform mat4 uVista;',
    'uniform mat3 uNorMat;',
    'uniform vec3 uCentro;',
    'uniform mat3 uMod;',
    'uniform vec3 uPiv;',
    'uniform vec3 uDesp;',
    'varying vec3 vNor;',
    'varying vec3 vVista;',
    'varying vec3 vPosM;',
    'void main() {',
    '  vec3 pm = uMod * (aPos - uPiv) + uPiv + uDesp;',
    '  vPosM = pm;',
    '  vec4 p = uVista * vec4(pm - uCentro, 1.0);',
    '  vVista = p.xyz;',
    '  vNor = uNorMat * (uMod * aNor);',
    '  gl_Position = uProy * p;',
    '}'
  ].join('\n');

  var MAT3_IDENT = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  /* Luz direccional fija respecto a la cámara (así la pieza nunca se apaga
     al girarla) + ambiente + un relleno tenue y un realce de silueta.
     Las normales se voltean en las caras traseras porque los STL de los
     clientes vienen con orientaciones inconsistentes bastante seguido. */
  /* uCorte*: vista previa del corte por plano — los dos lados del plano
     activo se tiñen distinto (azul/rosa) para ver dónde cae el corte
     mientras se arrastra, sin reconstruir nada. */
  var FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec3 vNor;',
    'varying vec3 vVista;',
    'varying vec3 vPosM;',
    'uniform vec3 uColor;',
    'uniform float uCorteOn;',
    'uniform float uCorteEje;',
    'uniform float uCorteVal;',
    'void main() {',
    '  vec3 n = normalize(vNor);',
    '  n *= (gl_FrontFacing ? 1.0 : -1.0);',
    '  vec3 v = normalize(-vVista);',
    '  vec3 l = normalize(vec3(-0.40, 0.45, 0.80));',
    '  vec3 r = normalize(vec3( 0.55, -0.35, 0.25));',
    '  float dif = max(dot(n, l), 0.0);',
    '  float rel = max(dot(n, r), 0.0) * 0.25;',
    '  vec3 h = normalize(l + v);',
    '  float esp = pow(max(dot(n, h), 0.0), 26.0) * 0.18;',
    '  float sil = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.12;',
    /* Con el corte activo, el color del lado SUSTITUYE al de la pieza:
       sobre una pieza negra un teñido sutil no se ve nada. */
    '  vec3 base = uColor;',
    '  if (uCorteOn > 0.5) {',
    '    float coord = uCorteEje < 0.5 ? vPosM.x : (uCorteEje < 1.5 ? vPosM.y : vPosM.z);',
    '    base = coord > uCorteVal ? vec3(0.45, 0.63, 0.97) : vec3(0.97, 0.52, 0.66);',
    '  }',
    '  vec3 col = base * (0.34 + 0.66 * dif + rel) + vec3(esp + sil);',
    '  gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);',
    '}'
  ].join('\n');

  /* Líneas de la cama de impresión: posición y color plano, nada más. */
  var VS_LIN = [
    'attribute vec3 aPos;',
    'uniform mat4 uProy;',
    'uniform mat4 uVista;',
    'uniform vec3 uCentro;',
    'void main() {',
    '  gl_Position = uProy * (uVista * vec4(aPos - uCentro, 1.0));',
    '}'
  ].join('\n');

  var FS_LIN = [
    'precision mediump float;',
    'uniform vec4 uColor;',
    'void main() { gl_FragColor = uColor; }'
  ].join('\n');

  /* Los datos pueden llegar planos o como lista de trozos con color. Se
     devuelve siempre una sola malla continua más los rangos de vértices
     que hay que pintar de cada color (null = todo gris). */
  function normalizarDatos(datos) {
    if (!datos || typeof datos.length !== 'number') return { tri: null, rangos: null };
    if (!datos.length || typeof datos[0] !== 'object' || !datos[0] || !datos[0].tri) {
      return { tri: datos, rangos: null };
    }
    var total = 0, i;
    for (i = 0; i < datos.length; i++) total += datos[i].tri.length;
    var tri = new Float64Array(total), pos = 0, rangos = [];
    for (i = 0; i < datos.length; i++) {
      var t = datos[i].tri;
      tri.set(t, pos);
      rangos.push({ ini: pos / 3, fin: (pos + t.length) / 3, color: datos[i].color || null });
      pos += t.length;
    }
    return { tri: tri, rangos: rangos };
  }

  /* ============================================================ MATRICES */

  function matPerspectiva(m, fovy, aspecto, cerca, lejos) {
    var f = 1 / Math.tan(fovy / 2);
    m[0] = f / aspecto; m[1] = 0; m[2] = 0;  m[3] = 0;
    m[4] = 0; m[5] = f; m[6] = 0;            m[7] = 0;
    m[8] = 0; m[9] = 0; m[10] = (lejos + cerca) / (cerca - lejos); m[11] = -1;
    m[12] = 0; m[13] = 0; m[14] = (2 * lejos * cerca) / (cerca - lejos); m[15] = 0;
  }

  /* lookAt con el objetivo siempre en el origen: el centrado de la pieza se
     hace en el sombreador restando uCentro, así conservamos precisión aunque
     el modelo esté a cientos de milímetros del origen. */
  function matVista(m, ojo, arriba) {
    var zx = ojo[0], zy = ojo[1], zz = ojo[2];
    var l = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
    zx /= l; zy /= l; zz /= l;

    var xx = arriba[1] * zz - arriba[2] * zy;
    var xy = arriba[2] * zx - arriba[0] * zz;
    var xz = arriba[0] * zy - arriba[1] * zx;
    var lx = Math.sqrt(xx * xx + xy * xy + xz * xz);
    if (lx < 1e-6) { xx = 1; xy = 0; xz = 0; } else { xx /= lx; xy /= lx; xz /= lx; }

    var yx = zy * xz - zz * xy;
    var yy = zz * xx - zx * xz;
    var yz = zx * xy - zy * xx;

    m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
    m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
    m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
    m[12] = -(xx * ojo[0] + xy * ojo[1] + xz * ojo[2]);
    m[13] = -(yx * ojo[0] + yy * ojo[1] + yz * ojo[2]);
    m[14] = -(zx * ojo[0] + zy * ojo[1] + zz * ojo[2]);
    m[15] = 1;
  }

  /* La vista es rotación + traslación, así que la matriz de normales es
     simplemente su bloque 3x3 superior izquierdo. */
  function matNormales(n, v) {
    n[0] = v[0]; n[1] = v[1]; n[2] = v[2];
    n[3] = v[4]; n[4] = v[5]; n[5] = v[6];
    n[6] = v[8]; n[7] = v[9]; n[8] = v[10];
  }

  /* =============================================================== MONTAR */

  var NULO = {
    actualizar: function () {},
    destruir: function () {}
  };

  function montar(canvas, datos, opciones) {
    if (!canvas || !canvas.getContext) return NULO;

    var gl = null;
    var atributos = {
      alpha: true,                 // fondo transparente: se ve la página
      antialias: true,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: false
    };
    try {
      gl = canvas.getContext('webgl', atributos) ||
           canvas.getContext('experimental-webgl', atributos);
    } catch (e) { gl = null; }
    if (!gl) return NULO;            // sin WebGL: no se dibuja nada, y ya

    /* ------------------------------------------------ estado del visor */
    var programa = null, ubic = null;
    var bufPos = null, bufNor = null;
    var attrPos = -1, attrNor = -1;

    var posArr = null, norArr = null;   // copias en CPU, para restaurar contexto
    var vertices = 0;                   // vértices ya subidos a la GPU
    var trisListos = 0;                 // triángulos ya resueltos en CPU
    var rangos = null;                  // colores por tramo de vértices

    var opCama = opciones || null;      // {camaMm, alturaMm, camas, planos} o null
    var programaLin = null, ubicLin = null, attrPosLin = -1;
    var bufLin = null, linVerts = 0;
    var bufPlanos = null, planosVerts = 0;
    var bufPlanosFill = null, planosFillVerts = 0;   // relleno translúcido
    /* Flechas de ejes (gizmo de mover): geometría propia, siempre encima. */
    var gizmoCfg = null, alGizmo = null, gizmoDrag = null;
    var bufGizmo = null, bufGizmoNor = null, gizmoRangos = [], gizmoVerts = 0;
    var COLOR_EJE = { x: [0.93, 0.28, 0.32], y: [0.30, 0.78, 0.38], z: [0.25, 0.52, 0.96] };
    var cajaMin = null, cajaMax = null;
    var radioClip = 1;                  // alcance de los planos de recorte

    var objetivo = [0, 0, 0];           // corrimiento del punto de mira (paneo)
    var miraX = 0, miraY = 0, miraZ = 0; // uCentro efectivo del último cuadro

    /* Pincel de corte: la página lo enciende con controlador.pincel() y
       recibe los índices de triángulo que pasan bajo el cursor. */
    var radioPincel = 0, alPintar = null, pintando = false;
    var circuloPincel = null;           // aro que enseña el tamaño del pincel
    /* Elegir pieza: clic (o toque) sin arrastre avisa qué triángulo quedó
       bajo el cursor. Lo enciende controlador.elegir(fn). */
    var alElegir = null, clicX = 0, clicY = 0, clicMovido = false, tapPosible = false;
    /* Agarrar pieza (mover/girar/escalar arrastrando sobre ella) y arrastrar
       planos de corte. La página los enciende con controlador.agarre() y
       controlador.alMoverPlano(). */
    var alAgarreProbar = null, alAgarreMover = null, agarrando = false;
    var alPlano = null, planosLista = [], planoDrag = null;
    /* Transformación de previsualización: rango de vértices + matriz. */
    var prevTrans = null;
    /* Vista previa del corte: tiñe los dos lados del plano activo dentro
       de un rango de vértices. {ini, fin, eje: 0|1|2, val} o null. */
    var corteVista = null;
    /* Flechas del plano activo: par de flechas sobre la sábana que enseñan
       hacia dónde se puede arrastrar. */
    var bufFlecha = null, bufFlechaNor = null, flechaVerts = 0, flechaColor = null;
    var flechaSeg = null;   /* extremos en mundo de la flecha del plano, para agarrarla */
    var centroides = null;              // centros de triángulo, para el pincel
    var marcas = { pos: null, nor: null, n: 0, cap: 0, rangos: [],
                   bufP: null, bufN: null };

    var centro = [0, 0, 0];
    var radio = 1;

    var yaw = -0.85, pitch = 0.50, zoom = 1;
    /* quieto: true apaga el giro de reposo — en un editor con mangos que
       agarrar, que la escena derive sola es hostil, no vistoso. */
    var interactuado = !!(opciones && opciones.quieto);
    var reducido = movimientoReducido();

    var vivo = true, contextoPerdido = false;
    var enPantalla = true, pestanaVisible = true;
    var pintar = true;                  // hay algo nuevo que dibujar
    var cuadro = 0, ultimoT = 0;

    var mProy = new Float32Array(16);
    var mVista = new Float32Array(16);
    var mNor = new Float32Array(9);
    var ojo = [0, 0, 0];
    var ARRIBA = [0, 0, 1];             // los STL/3MF vienen con Z hacia arriba

    var oyentes = [];
    var obsTam = null, obsVis = null, mqMovimiento = null;
    var tareaConstruir = null;
    var tamCss = null;                  // último tamaño de maqueta creíble
    var touchAnterior = canvas.style.touchAction;
    var anchoAnterior = canvas.style.width;
    var altoAnterior = canvas.style.height;

    /* ------------------------------------------------------- utilidades */

    function escuchar(objetivo, tipo, fn, opciones) {
      if (!objetivo || !objetivo.addEventListener) return;
      objetivo.addEventListener(tipo, fn, opciones);
      oyentes.push([objetivo, tipo, fn, opciones]);
    }

    function compilar(tipo, fuente) {
      var s = gl.createShader(tipo);
      gl.shaderSource(s, fuente);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        gl.deleteShader(s);
        return null;
      }
      return s;
    }

    function crearPrograma() {
      var vs = compilar(gl.VERTEX_SHADER, VS);
      var fs = compilar(gl.FRAGMENT_SHADER, FS);
      if (!vs || !fs) {
        if (vs) gl.deleteShader(vs);
        if (fs) gl.deleteShader(fs);
        return false;
      }
      var p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      /* Los shaders quedan marcados para borrado; el programa los retiene. */
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        gl.deleteProgram(p);
        return false;
      }
      programa = p;
      attrPos = gl.getAttribLocation(p, 'aPos');
      attrNor = gl.getAttribLocation(p, 'aNor');
      ubic = {
        proy:   gl.getUniformLocation(p, 'uProy'),
        vista:  gl.getUniformLocation(p, 'uVista'),
        norMat: gl.getUniformLocation(p, 'uNorMat'),
        centro: gl.getUniformLocation(p, 'uCentro'),
        color:  gl.getUniformLocation(p, 'uColor'),
        mod:    gl.getUniformLocation(p, 'uMod'),
        piv:    gl.getUniformLocation(p, 'uPiv'),
        desp:   gl.getUniformLocation(p, 'uDesp'),
        corteOn:  gl.getUniformLocation(p, 'uCorteOn'),
        corteEje: gl.getUniformLocation(p, 'uCorteEje'),
        corteVal: gl.getUniformLocation(p, 'uCorteVal')
      };

      /* El programa de líneas es prescindible: sin él solo se pierde la
         cama dibujada, nunca la pieza. */
      programaLin = null;
      var vsl = compilar(gl.VERTEX_SHADER, VS_LIN);
      var fsl = compilar(gl.FRAGMENT_SHADER, FS_LIN);
      if (vsl && fsl) {
        var pl = gl.createProgram();
        gl.attachShader(pl, vsl);
        gl.attachShader(pl, fsl);
        gl.linkProgram(pl);
        gl.deleteShader(vsl);
        gl.deleteShader(fsl);
        if (gl.getProgramParameter(pl, gl.LINK_STATUS)) {
          programaLin = pl;
          attrPosLin = gl.getAttribLocation(pl, 'aPos');
          ubicLin = {
            proy:   gl.getUniformLocation(pl, 'uProy'),
            vista:  gl.getUniformLocation(pl, 'uVista'),
            centro: gl.getUniformLocation(pl, 'uCentro'),
            color:  gl.getUniformLocation(pl, 'uColor')
          };
        } else {
          gl.deleteProgram(pl);
        }
      } else {
        if (vsl) gl.deleteShader(vsl);
        if (fsl) gl.deleteShader(fsl);
      }
      return true;
    }

    /* ------------------------------------------- construcción por tajadas

       Una malla de 200 000 triángulos son 1.8 millones de dobles: hacerlo de
       un jalón congela la pestaña medio segundo largo. Se parte en dos fases
       y cada una avanza sólo unos milisegundos por cuadro:

         Fase 1  caja envolvente -> centro
         Fase 2  radio real: distancia máxima de un vértice al centro. Es más
                 ajustado que la esfera de la caja (una pieza torneada o un
                 anillo dejan las esquinas vacías) y sigue sin recortarse al
                 orbitar, porque no depende del ángulo de cámara.
         Fase 3  posiciones + normales planas por cara, subiendo a la GPU
                 por trozos, de modo que la pieza aparece progresivamente.
       ------------------------------------------------------------------- */

    function cancelarConstruccion() {
      if (tareaConstruir) {
        tareaConstruir.cancelada = true;
        tareaConstruir = null;
      }
    }

    function construir(datos) {
      cancelarConstruccion();

      var norm = normalizarDatos(datos);
      var tri = norm.tri;
      rangos = norm.rangos;

      if (!tri || typeof tri.length !== 'number' || tri.length < 9) {
        posArr = null; norArr = null;
        vertices = 0; trisListos = 0;
        pintar = true;
        return;
      }

      var n = Math.floor(tri.length / 9);
      var pos, nor;
      try {
        pos = new Float32Array(n * 9);
        nor = new Float32Array(n * 9);
      } catch (e) {
        return;                       // malla imposible de alojar: no tocamos nada
      }

      /* Los datos llegan en float64; a la GPU van en float32. Con piezas de
         hasta ~800 mm la pérdida de precisión es de micras: irrelevante. */
      var tarea = {
        cancelada: false,
        fase: 1,
        i: 0,
        n: n,
        tri: tri,
        pos: pos,
        nor: nor,
        minX: Infinity, minY: Infinity, minZ: Infinity,
        maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
        r2: 0
      };
      tareaConstruir = tarea;

      /* La geometría anterior se descarta ya: más vale un cuadro vacío que
         mostrar la pieza equivocada junto a un precio nuevo. */
      vertices = 0;
      trisListos = 0;
      posArr = pos; norArr = nor;
      centroides = null;
      quitarMarcas();
      asegurarBuffers(n * 9 * 4);
      pintar = true;
    }

    function asegurarBuffers(bytes) {
      if (contextoPerdido) return;
      if (!bufPos) bufPos = gl.createBuffer();
      if (!bufNor) bufNor = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufNor);
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    function avanzarConstruccion() {
      var t = tareaConstruir;
      if (!t || t.cancelada) return;
      var limite = ahora() + MS_POR_TAJADA;
      var tri = t.tri, n = t.n, k;

      if (t.fase === 1) {
        while (t.i < n) {
          var hasta = Math.min(n, t.i + TRI_POR_BLOQUE);
          for (k = t.i * 9; k < hasta * 9; k += 3) {
            var bx = tri[k], by = tri[k + 1], bz = tri[k + 2];
            if (bx < t.minX) t.minX = bx;
            if (bx > t.maxX) t.maxX = bx;
            if (by < t.minY) t.minY = by;
            if (by > t.maxY) t.maxY = by;
            if (bz < t.minZ) t.minZ = bz;
            if (bz > t.maxZ) t.maxZ = bz;
          }
          t.i = hasta;
          if (ahora() >= limite) return;
        }
        centrar(t);
        t.fase = 2;
        t.i = 0;
        if (ahora() >= limite) return;
      }

      /* Fase 2: radio verdadero de la nube de vértices respecto al centro. */
      if (t.fase === 2) {
        var ccx = centro[0], ccy = centro[1], ccz = centro[2];
        while (t.i < n) {
          var hasta2 = Math.min(n, t.i + TRI_POR_BLOQUE);
          for (k = t.i * 9; k < hasta2 * 9; k += 3) {
            var rx = tri[k] - ccx, ry = tri[k + 1] - ccy, rz = tri[k + 2] - ccz;
            var d2 = rx * rx + ry * ry + rz * rz;
            if (d2 > t.r2) t.r2 = d2;
          }
          t.i = hasta2;
          if (ahora() >= limite) return;
        }
        fijarRadio(t);
        t.fase = 3;
        t.i = 0;
        if (ahora() >= limite) return;
      }

      /* Fase 3: normal plana por cara (los datos no traen normales) y
         volcado incremental a la GPU. */
      var pos = t.pos, nor = t.nor;
      while (t.i < n) {
        var desde = t.i;
        var tope = Math.min(n, t.i + TRI_POR_BLOQUE);
        for (var f = desde; f < tope; f++) {
          var o = f * 9;
          var ax = tri[o],     ay = tri[o + 1], az = tri[o + 2];
          var cx = tri[o + 3], cy = tri[o + 4], cz = tri[o + 5];
          var dx = tri[o + 6], dy = tri[o + 7], dz = tri[o + 8];

          pos[o]     = ax; pos[o + 1] = ay; pos[o + 2] = az;
          pos[o + 3] = cx; pos[o + 4] = cy; pos[o + 5] = cz;
          pos[o + 6] = dx; pos[o + 7] = dy; pos[o + 8] = dz;

          var ux = cx - ax, uy = cy - ay, uz = cz - az;
          var vx = dx - ax, vy = dy - ay, vz = dz - az;
          var nx = uy * vz - uz * vy;
          var ny = uz * vx - ux * vz;
          var nz = ux * vy - uy * vx;
          var lg = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (lg > 1e-20) { nx /= lg; ny /= lg; nz /= lg; }
          else { nx = 0; ny = 0; nz = 1; }   // triángulo degenerado

          nor[o]     = nx; nor[o + 1] = ny; nor[o + 2] = nz;
          nor[o + 3] = nx; nor[o + 4] = ny; nor[o + 5] = nz;
          nor[o + 6] = nx; nor[o + 7] = ny; nor[o + 8] = nz;
        }
        t.i = tope;
        trisListos = tope;
        subirTrozo(pos, nor, desde, tope);
        if (ahora() >= limite) return;
      }

      t.tri = null;                    // soltamos el float64 del cotizador
      tareaConstruir = null;
    }

    function subirTrozo(pos, nor, desde, hasta) {
      if (contextoPerdido || !bufPos || !bufNor) return;
      var ini = desde * 9, fin = hasta * 9;
      gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
      gl.bufferSubData(gl.ARRAY_BUFFER, ini * 4, pos.subarray(ini, fin));
      gl.bindBuffer(gl.ARRAY_BUFFER, bufNor);
      gl.bufferSubData(gl.ARRAY_BUFFER, ini * 4, nor.subarray(ini, fin));
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      vertices = hasta * 3;
      pintar = true;
    }

    /* Encuadre automático. El centro sale de la caja envolvente, así que da
       igual que la pieza esté en el origen o plantada a 790 mm de él. */
    function centrar(t) {
      var ok = isFinite(t.minX) && isFinite(t.maxX) &&
               isFinite(t.minY) && isFinite(t.maxY) &&
               isFinite(t.minZ) && isFinite(t.maxZ);
      if (!ok) {
        /* Coordenadas no finitas (NaN en el archivo): se deja una cámara
           cuerda en vez de romper el visor. */
        centro = [0, 0, 0]; radio = 1; t.malo = true; pintar = true;
        return;
      }
      centro = [(t.minX + t.maxX) / 2, (t.minY + t.maxY) / 2, (t.minZ + t.maxZ) / 2];
      var ex = t.maxX - t.minX, ey = t.maxY - t.minY, ez = t.maxZ - t.minZ;
      radio = 0.5 * Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (!(radio > 1e-6)) radio = 1;
      cajaMin = [t.minX, t.minY, t.minZ];
      cajaMax = [t.maxX, t.maxY, t.maxZ];
      construirCama();
      pintar = true;
    }

    /* Camas de impresión bajo el modelo, para dar la escala. Si opciones
       trae camas explícitas ({camas: [[cx,cy,z0], …]}, una por placa real
       del proyecto), se dibuja un cuadro centrado en cada una. Si no, un
       mosaico automático: una cama si el modelo cabe en una, las que hagan
       falta si abarca varias. Con una sola cama se dibuja además el
       volumen útil de la impresora. */
    function construirCama() {
      linVerts = 0;
      planosVerts = 0;
      planosFillVerts = 0;
      planosLista = [];
      radioClip = radio;
      if (!opCama || !(opCama.camaMm > 0) || !cajaMin ||
          contextoPerdido || !programaLin) return;

      var cama = opCama.camaMm;
      var alto = opCama.alturaMm > 0 ? opCama.alturaMm : cama;
      var v = [];
      function seg(ax, ay, az, bx, by, bz) { v.push(ax, ay, az, bx, by, bz); }
      function cuadro(xa, ya, xb, yb, z) {
        seg(xa, ya, z, xb, ya, z);
        seg(xb, ya, z, xb, yb, z);
        seg(xb, yb, z, xa, yb, z);
        seg(xa, yb, z, xa, ya, z);
      }
      function volumen(x0, y0, z0) {
        var x1 = x0 + cama, y1 = y0 + cama, z1 = z0 + alto;
        seg(x0, y0, z0, x0, y0, z1); seg(x1, y0, z0, x1, y0, z1);
        seg(x1, y1, z0, x1, y1, z1); seg(x0, y1, z0, x0, y1, z1);
        cuadro(x0, y0, x1, y1, z1);
      }

      var esquinas = [];                 // [x0, y0, z0] de cada cama dibujada
      if (opCama.camas && opCama.camas.length && opCama.camas.length <= 64) {
        for (var c = 0; c < opCama.camas.length; c++) {
          var cc = opCama.camas[c];
          esquinas.push([cc[0] - cama / 2, cc[1] - cama / 2, cc[2] || 0]);
        }
      } else {
        var nx = Math.max(1, Math.ceil((cajaMax[0] - cajaMin[0] - 0.1) / cama));
        var ny = Math.max(1, Math.ceil((cajaMax[1] - cajaMin[1] - 0.1) / cama));
        if (nx * ny > 64) return;        // datos absurdos: mejor sin cama
        var mx = (cajaMin[0] + cajaMax[0]) / 2 - nx * cama / 2;
        var my = (cajaMin[1] + cajaMax[1]) / 2 - ny * cama / 2;
        for (var i = 0; i < nx; i++) {
          for (var j = 0; j < ny; j++) {
            esquinas.push([mx + i * cama, my + j * cama, cajaMin[2]]);
          }
        }
      }

      for (var e = 0; e < esquinas.length; e++) {
        var q = esquinas[e];
        cuadro(q[0], q[1], q[0] + cama, q[1] + cama, q[2]);
      }
      if (esquinas.length === 1) volumen(esquinas[0][0], esquinas[0][1], esquinas[0][2]);

      if (!bufLin) bufLin = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufLin);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      linVerts = v.length / 3;

      /* Planos de corte editables: un marco por cada plano, un pelo más
         grande que LA PIEZA que se corta — no que la escena entera: en un
         proyecto de varias piezas una sábana del tamaño del modelo completo
         se ve rota. opciones.cajaPlanos trae los límites de esa pieza; sin
         ella se cae a la caja de toda la malla. Cada marco se recuerda en
         planosLista para poder agarrarlo con el ratón. */
      planosVerts = 0;
      planosFillVerts = 0;
      planosLista = [];
      if (opCama.planos) {
        var cp = opCama.cajaPlanos;
        var pMin = (cp && cp.min) ? cp.min : cajaMin;
        var pMax = (cp && cp.max) ? cp.max : cajaMax;
        var vp = [], vf = [];
        var mrg = [(pMax[0] - pMin[0]) * 0.10 + 4,
                   (pMax[1] - pMin[1]) * 0.10 + 4,
                   (pMax[2] - pMin[2]) * 0.10 + 4];
        var lados = [
          ['x', 1, 2, 0], ['y', 0, 2, 1], ['z', 0, 1, 2]
        ];
        for (var la = 0; la < 3; la++) {
          var lista = opCama.planos[lados[la][0]] || [];
          var u = lados[la][1], w2 = lados[la][2], f = lados[la][3];
          for (var pi = 0; pi < lista.length && vp.length < 3000; pi++) {
            var q0 = [0, 0, 0], q1 = [0, 0, 0], q2 = [0, 0, 0], q3 = [0, 0, 0];
            q0[f] = q1[f] = q2[f] = q3[f] = lista[pi];
            q0[u] = pMin[u] - mrg[u]; q0[w2] = pMin[w2] - mrg[w2];
            q1[u] = pMax[u] + mrg[u]; q1[w2] = pMin[w2] - mrg[w2];
            q2[u] = pMax[u] + mrg[u]; q2[w2] = pMax[w2] + mrg[w2];
            q3[u] = pMin[u] - mrg[u]; q3[w2] = pMax[w2] + mrg[w2];
            vp.push(q0[0], q0[1], q0[2], q1[0], q1[1], q1[2],
                    q1[0], q1[1], q1[2], q2[0], q2[1], q2[2],
                    q2[0], q2[1], q2[2], q3[0], q3[1], q3[2],
                    q3[0], q3[1], q3[2], q0[0], q0[1], q0[2]);
            planosLista.push({ eje: lados[la][0], f: f, idx: pi,
                               valor: lista[pi], q: [q0, q1, q2, q3] });
            /* Relleno translúcido del plano: dos triángulos por marco. */
            vf.push(q0[0], q0[1], q0[2], q1[0], q1[1], q1[2], q2[0], q2[1], q2[2],
                    q0[0], q0[1], q0[2], q2[0], q2[1], q2[2], q3[0], q3[1], q3[2]);
          }
        }
        if (vp.length) {
          if (!bufPlanos) bufPlanos = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, bufPlanos);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vp), gl.STATIC_DRAW);
          if (!bufPlanosFill) bufPlanosFill = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, bufPlanosFill);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vf), gl.STATIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          planosVerts = vp.length / 3;
          planosFillVerts = vf.length / 3;
        }
      }

      /* Los planos de recorte tienen que alcanzar las esquinas de las
         camas, que con piezas chicas quedan mucho más lejos que la pieza. */
      var alcance = radio;
      for (var a = 0; a < esquinas.length; a++) {
        var qa = esquinas[a];
        var dx = Math.max(Math.abs(qa[0] - centro[0]), Math.abs(qa[0] + cama - centro[0]));
        var dy = Math.max(Math.abs(qa[1] - centro[1]), Math.abs(qa[1] + cama - centro[1]));
        var dz = Math.max(Math.abs(qa[2] - centro[2]), Math.abs(qa[2] + alto - centro[2]));
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > alcance) alcance = d;
      }
      radioClip = alcance;
      pintar = true;
    }

    function fijarRadio(t) {
      if (t.malo) return;
      var r = Math.sqrt(t.r2);
      if (r > 1e-6 && isFinite(r)) radio = r;   // malla plana o de un solo punto
      pintar = true;
    }

    /* --------------------------------------------------- tamaño y cámara */

    function ajustarTamano() {
      var dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
      var cw = canvas.clientWidth || canvas.width || 1;
      var ch = canvas.clientHeight || canvas.height || 1;

      /* Un lienzo sin tamaño por CSS toma su ancho de maqueta del atributo
         width, así que escribirlo multiplicado por dpr lo haría crecer en
         cada cuadro hasta reventar la página. Cuando se detecta esa
         realimentación se ancla el tamaño CSS una sola vez y se acabó; un
         lienzo con CSS propio nunca entra por aquí. */
      if (tamCss && dpr > 1 && cw === canvas.width && ch === canvas.height &&
          (cw !== tamCss[0] || ch !== tamCss[1])) {
        cw = tamCss[0]; ch = tamCss[1];
        canvas.style.width = cw + 'px';
        canvas.style.height = ch + 'px';
      } else {
        tamCss = [cw, ch];
      }

      /* Tope duro adicional, por si acaso: ningún lienzo necesita más. */
      var w = Math.min(4096, Math.max(1, Math.round(cw * dpr)));
      var h = Math.min(4096, Math.max(1, Math.round(ch * dpr)));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        pintar = true;
      }
    }

    function distancia() {
      var aspecto = canvas.width / (canvas.height || 1);
      var medioV = FOV / 2;
      var medioH = Math.atan(Math.tan(medioV) * aspecto);
      var medio = Math.min(medioV, medioH);
      if (!(medio > 0.01)) medio = 0.01;
      return (radio / Math.sin(medio)) * MARGEN_ENCUADRE * zoom;
    }

    /* ------------------------------------------------------------ dibujo */

    function dibujar() {
      if (contextoPerdido || !programa) return;
      var w = canvas.width, h = canvas.height;
      if (!w || !h) return;

      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);          // transparente: manda la página
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!vertices) return;

      var d = distancia();
      var extra = Math.sqrt(objetivo[0] * objetivo[0] + objetivo[1] * objetivo[1]
                          + objetivo[2] * objetivo[2]);
      var cerca = Math.max(d - (radioClip + extra) * 2.2, radio * 0.005, 0.01);
      var lejos = d + (radioClip + extra) * 3;
      matPerspectiva(mProy, FOV, w / (h || 1), cerca, lejos);
      miraX = centro[0] + objetivo[0];
      miraY = centro[1] + objetivo[1];
      miraZ = centro[2] + objetivo[2];

      var cp = Math.cos(pitch);
      ojo[0] = d * cp * Math.cos(yaw);
      ojo[1] = d * cp * Math.sin(yaw);
      ojo[2] = d * Math.sin(pitch);
      matVista(mVista, ojo, ARRIBA);
      matNormales(mNor, mVista);

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      /* Sin descarte de caras traseras: muchas mallas de cliente no son
         cerradas ni tienen orientación consistente. */
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);

      gl.useProgram(programa);
      gl.uniformMatrix4fv(ubic.proy, false, mProy);
      gl.uniformMatrix4fv(ubic.vista, false, mVista);
      gl.uniformMatrix3fv(ubic.norMat, false, mNor);
      gl.uniform3f(ubic.centro, miraX, miraY, miraZ);
      gl.uniform3f(ubic.color, COLOR_MALLA[0], COLOR_MALLA[1], COLOR_MALLA[2]);
      gl.uniformMatrix3fv(ubic.mod, false, MAT3_IDENT);
      gl.uniform3f(ubic.piv, 0, 0, 0);
      gl.uniform3f(ubic.desp, 0, 0, 0);
      gl.uniform1f(ubic.corteOn, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
      gl.enableVertexAttribArray(attrPos);
      gl.vertexAttribPointer(attrPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufNor);
      gl.enableVertexAttribArray(attrNor);
      gl.vertexAttribPointer(attrNor, 3, gl.FLOAT, false, 0, 0);

      if (rangos) {
        var conTrans = false, conCorte = false;
        for (var rg = 0; rg < rangos.length; rg++) {
          var r = rangos[rg];
          var fin = Math.min(r.fin, vertices);
          if (fin <= r.ini) continue;
          /* El tramo agarrado se dibuja con la transformación de arrastre;
             el resto con la identidad. Se cambia de uniforme solo cuando
             el estado cambia, no en cada tramo. */
          var quiere = !!(prevTrans && r.ini >= prevTrans.ini && r.fin <= prevTrans.fin);
          if (quiere !== conTrans) {
            conTrans = quiere;
            if (quiere) {
              gl.uniformMatrix3fv(ubic.mod, false, prevTrans.mat);
              gl.uniform3f(ubic.piv, prevTrans.piv[0], prevTrans.piv[1], prevTrans.piv[2]);
              gl.uniform3f(ubic.desp, prevTrans.desp[0], prevTrans.desp[1], prevTrans.desp[2]);
            } else {
              gl.uniformMatrix3fv(ubic.mod, false, MAT3_IDENT);
              gl.uniform3f(ubic.piv, 0, 0, 0);
              gl.uniform3f(ubic.desp, 0, 0, 0);
            }
          }
          /* La vista previa del corte tiñe solo la pieza con plano activo. */
          var quiereC = !!(corteVista && r.ini >= corteVista.ini && r.fin <= corteVista.fin);
          if (quiereC !== conCorte) {
            conCorte = quiereC;
            gl.uniform1f(ubic.corteOn, quiereC ? 1 : 0);
            if (quiereC) {
              gl.uniform1f(ubic.corteEje, corteVista.eje);
              gl.uniform1f(ubic.corteVal, corteVista.val);
            }
          }
          var col = r.color || COLOR_MALLA;
          gl.uniform3f(ubic.color, col[0], col[1], col[2]);
          gl.drawArrays(gl.TRIANGLES, r.ini, fin - r.ini);
        }
        if (conTrans) {
          gl.uniformMatrix3fv(ubic.mod, false, MAT3_IDENT);
          gl.uniform3f(ubic.piv, 0, 0, 0);
          gl.uniform3f(ubic.desp, 0, 0, 0);
        }
        if (conCorte) gl.uniform1f(ubic.corteOn, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, vertices);
      }

      /* Marcas del pincel: los mismos triángulos, adelantados un pelo en
         profundidad para que se vean encima de la malla. */
      if (marcas.n && marcas.bufP && marcas.bufN) {
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-1.0, -2.0);
        gl.bindBuffer(gl.ARRAY_BUFFER, marcas.bufP);
        gl.vertexAttribPointer(attrPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, marcas.bufN);
        gl.vertexAttribPointer(attrNor, 3, gl.FLOAT, false, 0, 0);
        for (var mr = 0; mr < marcas.rangos.length; mr++) {
          var mg = marcas.rangos[mr];
          gl.uniform3f(ubic.color, mg.color[0], mg.color[1], mg.color[2]);
          gl.drawArrays(gl.TRIANGLES, mg.ini * 3, mg.n * 3);
        }
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }

      /* La cama al final: son cuatro líneas y el fondo ya está pintado. */
      if ((linVerts || planosVerts) && programaLin) {
        gl.disableVertexAttribArray(attrNor);
        gl.useProgram(programaLin);
        gl.uniformMatrix4fv(ubicLin.proy, false, mProy);
        gl.uniformMatrix4fv(ubicLin.vista, false, mVista);
        gl.uniform3f(ubicLin.centro, miraX, miraY, miraZ);
        gl.enableVertexAttribArray(attrPosLin);
        if (linVerts && bufLin) {
          gl.uniform4f(ubicLin.color, 0.63, 0.68, 0.75, 1);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufLin);
          gl.vertexAttribPointer(attrPosLin, 3, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.LINES, 0, linVerts);
        }
        if (planosFillVerts && bufPlanosFill) {
          /* Relleno translúcido del plano de corte, estilo dora: se ve el
             plano completo cruzando la pieza, sin tapar nada. */
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          gl.uniform4f(ubicLin.color, 0.38, 0.62, 0.95, 0.16);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufPlanosFill);
          gl.vertexAttribPointer(attrPosLin, 3, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.TRIANGLES, 0, planosFillVerts);
          gl.depthMask(true);
          gl.disable(gl.BLEND);
        }
        if (planosVerts && bufPlanos) {
          gl.uniform4f(ubicLin.color, 0.38, 0.62, 0.95, 1);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufPlanos);
          gl.vertexAttribPointer(attrPosLin, 3, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.LINES, 0, planosVerts);
        }
        /* Si quedara habilitado apuntando al búfer chico de líneas, el
           siguiente dibujo de la malla no pasaría la validación de WebGL. */
        gl.disableVertexAttribArray(attrPosLin);
      }

      /* El gizmo de ejes y las flechas del plano van al último y sin
         profundidad: siempre encima. */
      if ((gizmoCfg && gizmoVerts && bufGizmo) || (flechaVerts && bufFlecha)) {
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(programa);
        gl.uniformMatrix3fv(ubic.mod, false, MAT3_IDENT);
        gl.uniform3f(ubic.piv, 0, 0, 0);
        gl.uniform3f(ubic.desp, 0, 0, 0);
        gl.uniform1f(ubic.corteOn, 0);
        gl.enableVertexAttribArray(attrPos);
        gl.enableVertexAttribArray(attrNor);
        if (gizmoCfg && gizmoVerts && bufGizmo) {
          gl.bindBuffer(gl.ARRAY_BUFFER, bufGizmo);
          gl.vertexAttribPointer(attrPos, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufGizmoNor);
          gl.vertexAttribPointer(attrNor, 3, gl.FLOAT, false, 0, 0);
          for (var gz = 0; gz < gizmoRangos.length; gz++) {
            var gr = gizmoRangos[gz];
            gl.uniform3f(ubic.color, gr.color[0], gr.color[1], gr.color[2]);
            gl.drawArrays(gl.TRIANGLES, gr.ini, gr.n);
          }
        }
        if (flechaVerts && bufFlecha && flechaColor) {
          gl.bindBuffer(gl.ARRAY_BUFFER, bufFlecha);
          gl.vertexAttribPointer(attrPos, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufFlechaNor);
          gl.vertexAttribPointer(attrNor, 3, gl.FLOAT, false, 0, 0);
          gl.uniform3f(ubic.color, flechaColor[0], flechaColor[1], flechaColor[2]);
          gl.drawArrays(gl.TRIANGLES, 0, flechaVerts);
        }
        gl.enable(gl.DEPTH_TEST);
      }
    }

    function bucle(t) {
      if (!vivo) return;
      cuadro = pedirCuadro(bucle);

      var dt = ultimoT ? Math.min((t - ultimoT) / 1000, 0.1) : 0;
      ultimoT = t;

      if (tareaConstruir) avanzarConstruccion();

      /* Fuera de pantalla o con la pestaña oculta no se gasta GPU ni batería,
         pero la construcción de arriba sí sigue avanzando. */
      if (!enPantalla || !pestanaVisible) return;
      ajustarTamano();

      if (!interactuado && !reducido && vertices) {
        yaw += GIRO_INACTIVO * dt;
        pintar = true;
      }
      if (!pintar) return;
      pintar = false;
      dibujar();
    }

    /* -------------------------------------------------------- interacción

       Ratón, rueda y tacto. Dentro del lienzo el gesto es nuestro: se llama
       preventDefault para que la página no se desplace mientras se orbita. */

    var arrastrando = false, paneando = false, px = 0, py = 0, pinchD = 0;

    function primeraInteraccion() {
      if (!interactuado) { interactuado = true; pintar = true; }
    }

    function orbitar(dx, dy) {
      yaw -= dx * RAD_POR_PX;
      pitch += dy * RAD_POR_PX;
      if (pitch > PITCH_MAX) pitch = PITCH_MAX;
      if (pitch < -PITCH_MAX) pitch = -PITCH_MAX;
      pintar = true;
    }

    /* Paneo: el punto de mira se corre sobre los ejes de la cámara, de
       modo que la escena siga al cursor. */
    function panear(dx, dy) {
      var porPx = 2 * distancia() * Math.tan(FOV / 2) / (canvas.clientHeight || 1);
      var cp = Math.cos(pitch), sp = Math.sin(pitch);
      var cy = Math.cos(yaw), sy = Math.sin(yaw);
      objetivo[0] += (-dx * -sy + dy * -cy * sp) * porPx;
      objetivo[1] += (-dx *  cy + dy * -sy * sp) * porPx;
      objetivo[2] += (dy * cp) * porPx;
      pintar = true;
    }

    /* ------------------------------------------------ pincel de corte */

    function prepararCentroides() {
      if (centroides || !posArr || tareaConstruir) return;
      var n = Math.floor(posArr.length / 9);
      centroides = new Float32Array(n * 3);
      for (var t = 0; t < n; t++) {
        var o = t * 9;
        centroides[t * 3]     = (posArr[o]     + posArr[o + 3] + posArr[o + 6]) / 3;
        centroides[t * 3 + 1] = (posArr[o + 1] + posArr[o + 4] + posArr[o + 7]) / 3;
        centroides[t * 3 + 2] = (posArr[o + 2] + posArr[o + 5] + posArr[o + 8]) / 3;
      }
    }

    /* Qué triángulos caen bajo el cursor: cada triángulo se proyecta a la
       pantalla con las matrices del último cuadro y se mide la distancia
       del cursor al triángulo COMPLETO (adentro cuenta como cero) — con el
       centro no basta: en mallas gruesas, como una caja de doce triángulos,
       el centro queda lejos aunque el cursor esté encima de la cara. Solo
       se pintan los triángulos que miran a la cámara.                     */
    function distPuntoSegmento2(pxq, pyq, ax, ay, bx, by) {
      var ux = bx - ax, uy = by - ay;
      var l2 = ux * ux + uy * uy;
      var t = l2 > 0 ? ((pxq - ax) * ux + (pyq - ay) * uy) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      var dx = pxq - (ax + ux * t), dy = pyq - (ay + uy * t);
      return dx * dx + dy * dy;
    }

    function pintarEn(clienteX, clienteY) {
      if (!alPintar || !radioPincel || !posArr || tareaConstruir) return;
      prepararCentroides();
      if (!centroides) return;

      var rect = canvas.getBoundingClientRect();
      var kx = canvas.width / (rect.width || 1);
      var cx = (clienteX - rect.left) * kx;
      var cyp = (clienteY - rect.top) * (canvas.height / (rect.height || 1));
      var r2 = radioPincel * kx * radioPincel * kx;

      var w = canvas.width, h = canvas.height;
      var m = mVista, pr0 = mProy[0], pr5 = mProy[5];
      var ojoX = ojo[0] + miraX, ojoY = ojo[1] + miraY, ojoZ = ojo[2] + miraZ;
      var n = Math.floor(posArr.length / 9);
      var elegidos = [];
      var sx = [0, 0, 0], sy = [0, 0, 0];

      for (var t = 0; t < n; t++) {
        var o9 = t * 9, malo = false, v;
        for (v = 0; v < 3; v++) {
          var lx = posArr[o9 + v * 3]     - miraX;
          var ly = posArr[o9 + v * 3 + 1] - miraY;
          var lz = posArr[o9 + v * 3 + 2] - miraZ;
          var vz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
          if (vz >= -1e-6) { malo = true; break; }     // detrás de la cámara
          var vx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
          var vy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
          sx[v] = (pr0 * vx / -vz * 0.5 + 0.5) * w;
          sy[v] = (1 - (pr5 * vy / -vz * 0.5 + 0.5)) * h;
        }
        if (malo) continue;

        /* ¿el cursor cae dentro del triángulo proyectado? */
        var d0 = (sx[1] - sx[0]) * (cyp - sy[0]) - (sy[1] - sy[0]) * (cx - sx[0]);
        var d1 = (sx[2] - sx[1]) * (cyp - sy[1]) - (sy[2] - sy[1]) * (cx - sx[1]);
        var d2 = (sx[0] - sx[2]) * (cyp - sy[2]) - (sy[0] - sy[2]) * (cx - sx[2]);
        var dentro = (d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0);
        if (!dentro) {
          var dd = distPuntoSegmento2(cx, cyp, sx[0], sy[0], sx[1], sy[1]);
          var d22 = distPuntoSegmento2(cx, cyp, sx[1], sy[1], sx[2], sy[2]);
          if (d22 < dd) dd = d22;
          d22 = distPuntoSegmento2(cx, cyp, sx[2], sy[2], sx[0], sy[0]);
          if (d22 < dd) dd = d22;
          if (dd > r2) continue;
        }

        // de frente: la normal apunta hacia el ojo
        var gx = centroides[t * 3], gy = centroides[t * 3 + 1], gz = centroides[t * 3 + 2];
        var nx = norArr[o9], ny = norArr[o9 + 1], nz = norArr[o9 + 2];
        if (nx * (ojoX - gx) + ny * (ojoY - gy) + nz * (ojoZ - gz) <= 0) continue;
        elegidos.push(t);
      }
      if (elegidos.length) alPintar(elegidos);
    }

    /* Qué triángulo está más al frente bajo el cursor. Mismo esquema de
       proyección que el pincel, pero se queda con uno solo: el más cercano
       a la cámara. Sin prueba de orientación: en un STL con normales
       volteadas la cara de enfrente sigue siendo la pieza correcta. */
    function elegirEn(clienteX, clienteY) {
      if (!alElegir) return;
      alElegir(triEn(clienteX, clienteY));
    }

    function triEn(clienteX, clienteY) {
      if (!posArr || tareaConstruir) return -1;
      var rect = canvas.getBoundingClientRect();
      var kx = canvas.width / (rect.width || 1);
      var cx = (clienteX - rect.left) * kx;
      var cyp = (clienteY - rect.top) * (canvas.height / (rect.height || 1));
      var tol2 = 6 * kx * 6 * kx;          // tolerancia de ~6 px en triángulos finos

      var w = canvas.width, h = canvas.height;
      var m = mVista, pr0 = mProy[0], pr5 = mProy[5];
      var n = Math.floor(posArr.length / 9);
      var mejor = -1, mejorZ = -Infinity;
      var sx = [0, 0, 0], sy = [0, 0, 0];

      for (var t = 0; t < n; t++) {
        var o9 = t * 9, malo = false, v, prof = 0;
        for (v = 0; v < 3; v++) {
          var lx = posArr[o9 + v * 3]     - miraX;
          var ly = posArr[o9 + v * 3 + 1] - miraY;
          var lz = posArr[o9 + v * 3 + 2] - miraZ;
          var vz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
          if (vz >= -1e-6) { malo = true; break; }
          var vx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
          var vy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
          sx[v] = (pr0 * vx / -vz * 0.5 + 0.5) * w;
          sy[v] = (1 - (pr5 * vy / -vz * 0.5 + 0.5)) * h;
          prof += vz;
        }
        if (malo) continue;

        var d0 = (sx[1] - sx[0]) * (cyp - sy[0]) - (sy[1] - sy[0]) * (cx - sx[0]);
        var d1 = (sx[2] - sx[1]) * (cyp - sy[1]) - (sy[2] - sy[1]) * (cx - sx[1]);
        var d2 = (sx[0] - sx[2]) * (cyp - sy[2]) - (sy[0] - sy[2]) * (cx - sx[2]);
        var dentro = (d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0);
        if (!dentro) {
          var dd = distPuntoSegmento2(cx, cyp, sx[0], sy[0], sx[1], sy[1]);
          var d22 = distPuntoSegmento2(cx, cyp, sx[1], sy[1], sx[2], sy[2]);
          if (d22 < dd) dd = d22;
          d22 = distPuntoSegmento2(cx, cyp, sx[2], sy[2], sx[0], sy[0]);
          if (d22 < dd) dd = d22;
          if (dd > tol2) continue;
        }
        prof /= 3;                        // negativo; mayor = más cerca del ojo
        if (prof > mejorZ) { mejorZ = prof; mejor = t; }
      }
      return mejor;
    }

    /* ¿Qué marco de plano de corte queda bajo el cursor? Se proyectan las
       cuatro aristas de cada marco y se mide la distancia en pantalla. */
    function planoEn(clienteX, clienteY) {
      if (!planosLista.length) return null;
      var rect = canvas.getBoundingClientRect();
      var kx = canvas.width / (rect.width || 1);
      var cx = (clienteX - rect.left) * kx;
      var cyp = (clienteY - rect.top) * (canvas.height / (rect.height || 1));
      var tol2 = 9 * kx * 9 * kx;

      /* La flecha del plano activo es el mango natural: se prueba primero
         y con tolerancia generosa. Gana el plano cuyo valor quede más
         cerca del corte en vista. */
      if (flechaSeg) {
        var fa = proyectarPantalla(flechaSeg.p0);
        var fb = proyectarPantalla(flechaSeg.p1);
        if (fa && fb) {
          var tolF = 14 * kx * 14 * kx;
          if (distPuntoSegmento2(cx, cyp, fa[0], fa[1], fb[0], fb[1]) < tolF) {
            var pfl = null, pflD = Infinity;
            for (var k = 0; k < planosLista.length; k++) {
              if (planosLista[k].f !== flechaSeg.f) continue;
              var dv = Math.abs(planosLista[k].valor - flechaSeg.val);
              if (dv < pflD) { pflD = dv; pfl = planosLista[k]; }
            }
            if (pfl) return pfl;
          }
        }
      }

      var w = canvas.width, h = canvas.height;
      var m = mVista, pr0 = mProy[0], pr5 = mProy[5];
      var sx = [0, 0, 0, 0], sy = [0, 0, 0, 0];
      var mejor = null, mejorD = tol2, mejorDentro = null, mejorDentroD = Infinity;

      for (var i = 0; i < planosLista.length; i++) {
        var pl = planosLista[i], malo = false;
        for (var v = 0; v < 4; v++) {
          var lx = pl.q[v][0] - miraX, ly = pl.q[v][1] - miraY, lz = pl.q[v][2] - miraZ;
          var vz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
          if (vz >= -1e-6) { malo = true; break; }
          var vx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
          var vy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
          sx[v] = (pr0 * vx / -vz * 0.5 + 0.5) * w;
          sy[v] = (1 - (pr5 * vy / -vz * 0.5 + 0.5)) * h;
        }
        if (malo) continue;
        var dMin = Infinity, dentroCnt = 0;
        for (var a = 0; a < 4; a++) {
          var b = (a + 1) % 4;
          var d = distPuntoSegmento2(cx, cyp, sx[a], sy[a], sx[b], sy[b]);
          if (d < dMin) dMin = d;
          var cruz = (sx[b] - sx[a]) * (cyp - sy[a]) - (sy[b] - sy[a]) * (cx - sx[a]);
          if (cruz >= 0) dentroCnt++;
        }
        if (dMin < mejorD) { mejorD = dMin; mejor = pl; }
        /* La sábana completa también se puede agarrar, no solo su borde. */
        if ((dentroCnt === 4 || dentroCnt === 0) && dMin < mejorDentroD) {
          mejorDentroD = dMin;
          mejorDentro = pl;
        }
      }
      return mejor || mejorDentro;
    }

    /* Cuánto se mueve el mundo bajo el cursor con un delta de pantalla:
       el mismo cálculo del paneo, con el signo para que lo agarrado siga
       al ratón. Devuelve [wx, wy, wz] en milímetros. */
    function deltaMundo(dx, dy) {
      var porPx = 2 * distancia() * Math.tan(FOV / 2) / (canvas.clientHeight || 1);
      var cp = Math.cos(pitch), sp = Math.sin(pitch);
      var cy = Math.cos(yaw), sy = Math.sin(yaw);
      return [(-dx * sy + dy * cy * sp) * porPx,
              (dx * cy + dy * sy * sp) * porPx,
              (-dy * cp) * porPx];
    }

    /* ------------------------------------------------- gizmo de ejes ---
       Tres flechas sólidas (X roja, Y verde, Z azul) desde el centro de la
       pieza seleccionada. Se dibujan al final, sin prueba de profundidad,
       para que siempre queden encima. Arrastrar una flecha mueve solo en
       ese eje. */

    function construirGizmo() {
      gizmoVerts = 0;
      gizmoRangos = [];
      if (!gizmoCfg || contextoPerdido) return;
      var c = gizmoCfg.c, L = gizmoCfg.tam || radio * 0.6;
      var modo = gizmoCfg.modo || 'mover';
      var v = [], nrm = [];
      var EJES = [
        ['x', [1, 0, 0], [0, 1, 0], [0, 0, 1]],
        ['y', [0, 1, 0], [1, 0, 0], [0, 0, 1]],
        ['z', [0, 0, 1], [1, 0, 0], [0, 1, 0]]
      ];
      function punto(t, du, dv) {
        return [c[0] + a[0] * t + u[0] * du + w2[0] * dv,
                c[1] + a[1] * t + u[1] * du + w2[1] * dv,
                c[2] + a[2] * t + u[2] * du + w2[2] * dv];
      }
      function tri(p0, p1, p2) {
        var ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
        var vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
        var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        var lg = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= lg; ny /= lg; nz /= lg;
        v.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
        for (var q = 0; q < 3; q++) nrm.push(nx, ny, nz);
      }
      function cajita(t0, t1, medio) {
        var e8 = [
          punto(t0, -medio, -medio), punto(t0, medio, -medio),
          punto(t0, medio, medio), punto(t0, -medio, medio),
          punto(t1, -medio, -medio), punto(t1, medio, -medio),
          punto(t1, medio, medio), punto(t1, -medio, medio)
        ];
        [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
         [4, 5, 6, 7], [3, 2, 1, 0]].forEach(function (f) {
          tri(e8[f[0]], e8[f[1]], e8[f[2]]);
          tri(e8[f[0]], e8[f[2]], e8[f[3]]);
        });
      }
      var a, u, w2;

      if (modo === 'girar') {
        /* Anillo plano alrededor de Z: arrastrarlo gira la pieza. */
        a = [0, 0, 1]; u = [1, 0, 0]; w2 = [0, 1, 0];
        var R = L * 0.62, g2 = L * 0.035, SEG = 48;
        var ini0 = 0;
        for (var s2 = 0; s2 < SEG; s2++) {
          var a0 = s2 / SEG * Math.PI * 2, a1 = (s2 + 1) / SEG * Math.PI * 2;
          var p00 = punto(0, Math.cos(a0) * (R - g2), Math.sin(a0) * (R - g2));
          var p01 = punto(0, Math.cos(a0) * (R + g2), Math.sin(a0) * (R + g2));
          var p10 = punto(0, Math.cos(a1) * (R - g2), Math.sin(a1) * (R - g2));
          var p11 = punto(0, Math.cos(a1) * (R + g2), Math.sin(a1) * (R + g2));
          tri(p00, p01, p11);
          tri(p00, p11, p10);
        }
        gizmoRangos.push({ eje: 'rz', ini: ini0, n: v.length / 3,
                           color: COLOR_EJE.z, radioAnillo: R });
      } else {
        for (var e = 0; e < 3; e++) {
          a = EJES[e][1]; u = EJES[e][2]; w2 = EJES[e][3];
          var ini = v.length / 3;
          var g = L * 0.024, cuerpo = modo === 'escalar' ? L * 0.86 : L * 0.74;
          cajita(0, cuerpo, g);
          if (modo === 'escalar') {
            /* mango cúbico: el clásico gizmo de escala */
            cajita(L * 0.86, L, L * 0.07);
          } else {
            /* punta: pirámide de flecha */
            var punta = L * 0.10;
            var base = [punto(cuerpo, -punta, -punta), punto(cuerpo, punta, -punta),
                        punto(cuerpo, punta, punta), punto(cuerpo, -punta, punta)];
            var apice = punto(L, 0, 0);
            for (var s = 0; s < 4; s++) tri(base[s], base[(s + 1) % 4], apice);
            tri(base[0], base[2], base[1]);
            tri(base[0], base[3], base[2]);
          }
          gizmoRangos.push({ eje: EJES[e][0], ini: ini, n: v.length / 3 - ini,
                             color: COLOR_EJE[EJES[e][0]] });
        }
      }
      if (!bufGizmo) { bufGizmo = gl.createBuffer(); bufGizmoNor = gl.createBuffer(); }
      gl.bindBuffer(gl.ARRAY_BUFFER, bufGizmo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufGizmoNor);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(nrm), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gizmoVerts = v.length / 3;
      pintar = true;
    }

    /* Proyección de un punto del mundo a píxeles del lienzo, con las
       matrices del último cuadro. Devuelve null si cae tras la cámara. */
    function proyectarPantalla(p) {
      var m = mVista;
      var lx = p[0] - miraX, ly = p[1] - miraY, lz = p[2] - miraZ;
      var vz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
      if (vz >= -1e-6) return null;
      var vx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
      var vy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
      return [(mProy[0] * vx / -vz * 0.5 + 0.5) * canvas.width,
              (1 - (mProy[5] * vy / -vz * 0.5 + 0.5)) * canvas.height];
    }

    function cursorEnLienzo(clienteX, clienteY) {
      var rect = canvas.getBoundingClientRect();
      var kx = canvas.width / (rect.width || 1);
      return [(clienteX - rect.left) * kx,
              (clienteY - rect.top) * (canvas.height / (rect.height || 1)),
              kx];
    }

    /* Flecha de dos puntas atravesando la sábana del plano activo, como el
       manipulador clásico: cuerpo continuo que cruza el plano y pirámide en
       cada extremo. Sin cuerpo, las puntas parecían triángulos sueltos
       flotando. Se reconstruye cada vez que el plano cambia de sitio. */
    function construirFlechasPlano() {
      flechaVerts = 0;
      flechaSeg = null;
      if (!corteVista || !cajaMin || contextoPerdido) return;
      var f = corteVista.eje;
      var EJES = ['x', 'y', 'z'];
      flechaColor = COLOR_EJE[EJES[f]];
      var cp = opCama && opCama.cajaPlanos;
      var pMin = (cp && cp.min) ? cp.min : cajaMin;
      var pMax = (cp && cp.max) ? cp.max : cajaMax;
      var c = [(pMin[0] + pMax[0]) / 2,
               (pMin[1] + pMax[1]) / 2,
               (pMin[2] + pMax[2]) / 2];
      c[f] = corteVista.val;
      var tamE = Math.max(pMax[0] - pMin[0], pMax[1] - pMin[1], pMax[2] - pMin[2]);
      var La = Math.max(16, Math.min(tamE * 0.26, 48));
      var a = [0, 0, 0]; a[f] = 1;
      var u = [0, 0, 0], w2 = [0, 0, 0];
      u[(f + 1) % 3] = 1; w2[(f + 2) % 3] = 1;

      var v = [], nrm = [];
      function pt(dir, t, du, dv) {
        return [c[0] + a[0] * dir * t + u[0] * du + w2[0] * dv,
                c[1] + a[1] * dir * t + u[1] * du + w2[1] * dv,
                c[2] + a[2] * dir * t + u[2] * du + w2[2] * dv];
      }
      function tri(p0, p1, p2) {
        var ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
        var vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
        var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        var lg = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        v.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
        for (var q = 0; q < 3; q++) nrm.push(nx / lg, ny / lg, nz / lg);
      }
      var cuerpo = La * 0.62, g = Math.max(0.9, La * 0.05);
      var e8 = [
        pt(1, -cuerpo, -g, -g), pt(1, -cuerpo, g, -g),
        pt(1, -cuerpo, g, g), pt(1, -cuerpo, -g, g),
        pt(1, cuerpo, -g, -g), pt(1, cuerpo, g, -g),
        pt(1, cuerpo, g, g), pt(1, cuerpo, -g, g)
      ];
      [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]].forEach(function (q4) {
        tri(e8[q4[0]], e8[q4[1]], e8[q4[2]]);
        tri(e8[q4[0]], e8[q4[2]], e8[q4[3]]);
      });
      [1, -1].forEach(function (dir) {
        var p = La * 0.14, s;
        var base = [pt(dir, cuerpo, -p, -p), pt(dir, cuerpo, p, -p),
                    pt(dir, cuerpo, p, p), pt(dir, cuerpo, -p, p)];
        var apice = pt(dir, La, 0, 0);
        for (s = 0; s < 4; s++) tri(base[s], base[(s + 1) % 4], apice);
        tri(base[0], base[2], base[1]);
        tri(base[0], base[3], base[2]);
      });
      flechaSeg = { p0: pt(1, -La, 0, 0), p1: pt(1, La, 0, 0),
                    f: f, val: corteVista.val };

      if (!bufFlecha) { bufFlecha = gl.createBuffer(); bufFlechaNor = gl.createBuffer(); }
      gl.bindBuffer(gl.ARRAY_BUFFER, bufFlecha);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufFlechaNor);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(nrm), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      flechaVerts = v.length / 3;
    }

    /* ¿Qué mango del gizmo queda bajo el cursor? Flechas: distancia en
       pantalla al segmento centro→punta. Anillo de giro: distancia a la
       circunferencia proyectada. */
    function gizmoEn(clienteX, clienteY) {
      if (!gizmoCfg) return null;
      var cur = cursorEnLienzo(clienteX, clienteY);
      var cx = cur[0], cyp = cur[1], kx = cur[2];
      var tol2 = 14 * kx * 14 * kx;
      var c = gizmoCfg.c, L = gizmoCfg.tam || radio * 0.6;

      if (gizmoCfg.modo === 'girar') {
        var R = L * 0.62, SEG = 32;
        var prev = null, mejorD2 = tol2, toca = false;
        for (var s3 = 0; s3 <= SEG; s3++) {
          var an = s3 / SEG * Math.PI * 2;
          var pr = proyectarPantalla([c[0] + Math.cos(an) * R,
                                      c[1] + Math.sin(an) * R, c[2]]);
          if (pr && prev) {
            var dseg = distPuntoSegmento2(cx, cyp, prev[0], prev[1], pr[0], pr[1]);
            if (dseg < mejorD2) { mejorD2 = dseg; toca = true; }
          }
          prev = pr;
        }
        return toca ? 'rz' : null;
      }

      var p0 = proyectarPantalla(c);
      if (!p0) return null;
      var mejor = null, mejorD = tol2;
      ['x', 'y', 'z'].forEach(function (eje, i) {
        var fin = c.slice();
        fin[i] += L;
        var p1 = proyectarPantalla(fin);
        if (!p1) return;
        var d = distPuntoSegmento2(cx, cyp, p0[0], p0[1], p1[0], p1[1]);
        if (d < mejorD) { mejorD = d; mejor = eje; }
      });
      return mejor;
    }

    /* Aro del pincel: un div fijo que sigue al cursor sobre el lienzo, del
       diámetro real del pincel, para que se vea cuánto vas a pintar. */
    function moverCirculo(ev) {
      if (!circuloPincel) return;
      circuloPincel.style.left = ev.clientX + 'px';
      circuloPincel.style.top = ev.clientY + 'px';
      circuloPincel.style.display = 'block';
    }
    function ocultarCirculo() {
      if (circuloPincel) circuloPincel.style.display = 'none';
    }

    /* -------------------------------------------------- marcas del pincel */

    function quitarMarcas() {
      marcas.pos = null; marcas.nor = null;
      marcas.n = 0; marcas.cap = 0; marcas.rangos = [];
      pintar = true;
    }

    function ponerMarcas(indices, color) {
      if (!indices || !indices.length || !posArr || contextoPerdido) return;
      var falta = marcas.n + indices.length;
      if (falta > marcas.cap) {
        var cap = Math.max(4096, marcas.cap * 2, falta);
        var np = new Float32Array(cap * 9), nn = new Float32Array(cap * 9);
        if (marcas.pos) { np.set(marcas.pos.subarray(0, marcas.n * 9)); nn.set(marcas.nor.subarray(0, marcas.n * 9)); }
        marcas.pos = np; marcas.nor = nn; marcas.cap = cap;
        if (marcas.bufP) { gl.deleteBuffer(marcas.bufP); gl.deleteBuffer(marcas.bufN); }
        marcas.bufP = null; marcas.bufN = null;
      }
      var ini = marcas.n;
      for (var i = 0; i < indices.length; i++) {
        var o = indices[i] * 9, d = (marcas.n + i) * 9;
        for (var k = 0; k < 9; k++) {
          marcas.pos[d + k] = posArr[o + k];
          marcas.nor[d + k] = norArr[o + k];
        }
      }
      marcas.n += indices.length;

      var ultimo = marcas.rangos[marcas.rangos.length - 1];
      if (ultimo && ultimo.color === color && ultimo.ini + ultimo.n === ini) {
        ultimo.n += indices.length;
      } else {
        marcas.rangos.push({ ini: ini, n: indices.length, color: color });
      }

      if (!marcas.bufP) {
        marcas.bufP = gl.createBuffer();
        marcas.bufN = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, marcas.bufP);
        gl.bufferData(gl.ARRAY_BUFFER, marcas.pos, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, marcas.bufN);
        gl.bufferData(gl.ARRAY_BUFFER, marcas.nor, gl.DYNAMIC_DRAW);
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, marcas.bufP);
        gl.bufferSubData(gl.ARRAY_BUFFER, ini * 9 * 4, marcas.pos.subarray(ini * 9, marcas.n * 9));
        gl.bindBuffer(gl.ARRAY_BUFFER, marcas.bufN);
        gl.bufferSubData(gl.ARRAY_BUFFER, ini * 9 * 4, marcas.nor.subarray(ini * 9, marcas.n * 9));
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      pintar = true;
    }

    function acercar(factor) {
      zoom *= factor;
      if (zoom < ZOOM_MIN) zoom = ZOOM_MIN;
      if (zoom > ZOOM_MAX) zoom = ZOOM_MAX;
      pintar = true;
    }

    function alBajarRaton(ev) {
      primeraInteraccion();
      if (ev.button === 0 && radioPincel && alPintar) {
        pintando = true;
        pintarEn(ev.clientX, ev.clientY);
      } else if (ev.button === 1 || ev.button === 2 || (ev.button === 0 && ev.shiftKey)) {
        paneando = true;
      } else if (ev.button === 0) {
        /* Con la herramienta activa, agarrar gana sobre orbitar: primero el
           gizmo, luego un marco de plano de corte, después la pieza. */
        if (gizmoCfg && alGizmo) {
          var ejeG = gizmoEn(ev.clientX, ev.clientY);
          if (ejeG) {
            gizmoDrag = ejeG;
            px = ev.clientX; py = ev.clientY;
            if (ev.preventDefault) ev.preventDefault();
            return;
          }
        }
        if (alPlano) {
          var pl = planoEn(ev.clientX, ev.clientY);
          if (pl) {
            planoDrag = pl;
            px = ev.clientX; py = ev.clientY;
            if (ev.preventDefault) ev.preventDefault();
            return;
          }
        }
        if (alAgarreProbar && alAgarreMover) {
          var tri = triEn(ev.clientX, ev.clientY);
          if (tri >= 0 && alAgarreProbar(tri)) {
            agarrando = true;
            px = ev.clientX; py = ev.clientY;
            if (ev.preventDefault) ev.preventDefault();
            return;
          }
        }
        arrastrando = true;
        clicX = ev.clientX; clicY = ev.clientY; clicMovido = false;
      } else {
        return;
      }
      px = ev.clientX; py = ev.clientY;
      if (ev.preventDefault) ev.preventDefault();
    }

    function alMoverRaton(ev) {
      if (pintando) { pintarEn(ev.clientX, ev.clientY); return; }
      if (gizmoDrag) {
        if (gizmoDrag === 'rz') {
          /* Giro: ángulo del cursor alrededor del centro proyectado. El
             sentido se corrige según de qué lado mira la cámara, para que
             arrastrar en círculo gire la pieza hacia el mismo lado. */
          var pcG = gizmoCfg && proyectarPantalla(gizmoCfg.c);
          if (pcG) {
            var c0 = cursorEnLienzo(px, py);
            var c1 = cursorEnLienzo(ev.clientX, ev.clientY);
            var a0G = Math.atan2(c0[1] - pcG[1], c0[0] - pcG[0]);
            var a1G = Math.atan2(c1[1] - pcG[1], c1[0] - pcG[0]);
            var dA = a1G - a0G;
            if (dA > Math.PI) dA -= 2 * Math.PI;
            if (dA < -Math.PI) dA += 2 * Math.PI;
            var dGrados = -dA * 180 / Math.PI * (pitch >= 0 ? 1 : -1);
            alGizmo({ eje: 'rz', delta: dGrados, fase: 'mover' });
          }
        } else {
          var dmG = deltaMundo(ev.clientX - px, ev.clientY - py);
          var idxG = { x: 0, y: 1, z: 2 }[gizmoDrag];
          var dG = dmG[idxG];
          if (gizmoCfg && gizmoCfg.modo === 'mover') {
            gizmoCfg.c[idxG] += dG;
            construirGizmo();
          }
          alGizmo({ eje: gizmoDrag, delta: dG, fase: 'mover' });
        }
        px = ev.clientX; py = ev.clientY;
        return;
      }
      if (planoDrag) {
        /* El plano solo se mueve sobre su propio eje. Se actualiza la lista
           de opciones en sitio (es el mismo objeto de la página) y se
           redibuja el marco; el recorte caro lo decide la página al soltar. */
        var dm = deltaMundo(ev.clientX - px, ev.clientY - py);
        planoDrag.valor += dm[planoDrag.f];
        if (opCama && opCama.planos && opCama.planos[planoDrag.eje]) {
          opCama.planos[planoDrag.eje][planoDrag.idx] = planoDrag.valor;
        }
        var guardado = planoDrag;
        construirCama();                 // reconstruye marcos y vacía la lista
        planoDrag = guardado;
        if (alPlano) alPlano({ eje: planoDrag.eje, idx: planoDrag.idx,
                               valor: planoDrag.valor, fase: 'mover' });
        px = ev.clientX; py = ev.clientY;
        return;
      }
      if (agarrando) {
        var dx = ev.clientX - px, dy = ev.clientY - py;
        var w = deltaMundo(dx, dy);
        alAgarreMover({ dx: dx, dy: dy, wx: w[0], wy: w[1], wz: w[2], fase: 'mover' });
        px = ev.clientX; py = ev.clientY;
        return;
      }
      if (paneando) {
        panear(ev.clientX - px, ev.clientY - py);
      } else if (arrastrando) {
        if (Math.abs(ev.clientX - clicX) + Math.abs(ev.clientY - clicY) > 4) clicMovido = true;
        orbitar(ev.clientX - px, ev.clientY - py);
      } else {
        return;
      }
      px = ev.clientX; py = ev.clientY;
    }

    function alSoltarRaton() {
      /* Un clic sin arrastre elige la pieza bajo el cursor. */
      if (arrastrando && alElegir && !clicMovido) elegirEn(clicX, clicY);
      if (gizmoDrag) {
        var ejeFin = gizmoDrag;
        gizmoDrag = null;
        if (alGizmo) alGizmo({ eje: ejeFin, delta: 0, fase: 'fin' });
      }
      if (planoDrag) {
        var pd = planoDrag;
        planoDrag = null;
        if (alPlano) alPlano({ eje: pd.eje, idx: pd.idx, valor: pd.valor, fase: 'fin' });
      }
      if (agarrando) {
        agarrando = false;
        if (alAgarreMover) alAgarreMover({ dx: 0, dy: 0, wx: 0, wy: 0, wz: 0, fase: 'fin' });
      }
      arrastrando = false; paneando = false; pintando = false;
    }

    function alRodar(ev) {
      var d = ev.deltaY;
      if (typeof d !== 'number') d = -(ev.wheelDelta || 0) / 2;
      if (ev.deltaMode === 1) d *= 16;          // líneas
      else if (ev.deltaMode === 2) d *= 100;    // páginas
      primeraInteraccion();
      acercar(Math.exp(d * 0.0016));
      ev.preventDefault();                      // nunca desplaza la página
    }

    function distTocada(ts) {
      var ax = ts[0].clientX - ts[1].clientX;
      var ay = ts[0].clientY - ts[1].clientY;
      return Math.sqrt(ax * ax + ay * ay) || 1;
    }

    function alTocar(ev) {
      var ts = ev.touches;
      primeraInteraccion();
      if (ts.length === 1) {
        if (radioPincel && alPintar) {
          pintando = true;
          pintarEn(ts[0].clientX, ts[0].clientY);
        } else {
          arrastrando = true;
          tapPosible = !!alElegir;
          clicX = ts[0].clientX; clicY = ts[0].clientY;
        }
        px = ts[0].clientX; py = ts[0].clientY;
        pinchD = 0;
      } else if (ts.length >= 2) {
        arrastrando = false; pintando = false; tapPosible = false;
        pinchD = distTocada(ts);
        px = (ts[0].clientX + ts[1].clientX) / 2;
        py = (ts[0].clientY + ts[1].clientY) / 2;
      }
      ev.preventDefault();
    }

    function alArrastrarDedo(ev) {
      var ts = ev.touches;
      if (ts.length === 1 && pintando) {
        pintarEn(ts[0].clientX, ts[0].clientY);
        px = ts[0].clientX; py = ts[0].clientY;
      } else if (ts.length === 1 && arrastrando) {
        if (Math.abs(ts[0].clientX - clicX) + Math.abs(ts[0].clientY - clicY) > 4) tapPosible = false;
        orbitar(ts[0].clientX - px, ts[0].clientY - py);
        px = ts[0].clientX; py = ts[0].clientY;
      } else if (ts.length >= 2) {
        var d = distTocada(ts);
        if (pinchD) acercar(pinchD / d);
        pinchD = d;
        // dos dedos también panean con el punto medio
        var mx = (ts[0].clientX + ts[1].clientX) / 2;
        var my = (ts[0].clientY + ts[1].clientY) / 2;
        panear(mx - px, my - py);
        px = mx; py = my;
      }
      ev.preventDefault();               // bloquea el desplazamiento del documento
    }

    function alLevantarDedo(ev) {
      var ts = ev.touches;
      if (!ts || ts.length === 0) {
        if (tapPosible) { tapPosible = false; elegirEn(clicX, clicY); }
        arrastrando = false; pinchD = 0;
      }
      else if (ts.length === 1) {
        arrastrando = true; pinchD = 0;
        px = ts[0].clientX; py = ts[0].clientY;
      }
    }

    /* -------------------------------------------------- contexto perdido

       Safari de iOS tira el contexto al pasar la pestaña a segundo plano;
       hay que poder rearmarlo con lo que ya tenemos en CPU. */

    function alPerderContexto(ev) {
      ev.preventDefault();
      contextoPerdido = true;
      programa = null; bufPos = null; bufNor = null;
      programaLin = null; bufLin = null; linVerts = 0;
      bufPlanos = null; planosVerts = 0;
      bufPlanosFill = null; planosFillVerts = 0;
      bufGizmo = null; bufGizmoNor = null; gizmoVerts = 0;
      bufFlecha = null; bufFlechaNor = null; flechaVerts = 0;
      marcas.bufP = null; marcas.bufN = null;
      marcas.n = 0; marcas.rangos = []; marcas.cap = 0;
      marcas.pos = null; marcas.nor = null;
      vertices = 0;
      /* La construcción sigue: es trabajo de CPU y al recuperar el contexto
         subimos de golpe todo lo que se haya resuelto mientras tanto. */
    }

    function alRecuperarContexto() {
      contextoPerdido = false;
      if (!crearPrograma()) return;
      try { construirGizmo(); construirFlechasPlano(); } catch (e) {}
      if (posArr && norArr && trisListos > 0) {
        asegurarBuffers(posArr.length * 4);
        var fin = trisListos * 9;
        gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, posArr.subarray(0, fin));
        gl.bindBuffer(gl.ARRAY_BUFFER, bufNor);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, norArr.subarray(0, fin));
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        vertices = trisListos * 3;
      }
      construirCama();
      pintar = true;
    }

    /* ------------------------------------------------------------ arranque */

    escuchar(canvas, 'webglcontextlost', alPerderContexto, false);
    escuchar(canvas, 'webglcontextrestored', alRecuperarContexto, false);

    if (!crearPrograma()) {
      /* Sin programa no hay nada que enseñar; se sale en silencio. */
      var i;
      for (i = 0; i < oyentes.length; i++) {
        oyentes[i][0].removeEventListener(oyentes[i][1], oyentes[i][2], oyentes[i][3]);
      }
      return NULO;
    }

    canvas.style.touchAction = 'none';   // el gesto lo maneja el lienzo

    escuchar(canvas, 'mousedown', alBajarRaton, false);
    escuchar(window, 'mousemove', alMoverRaton, false);
    escuchar(window, 'mouseup', alSoltarRaton, false);
    escuchar(canvas, 'contextmenu', function (ev) { ev.preventDefault(); }, false);
    escuchar(canvas, 'wheel', alRodar, OPC_ACTIVO);
    escuchar(canvas, 'touchstart', alTocar, OPC_ACTIVO);
    escuchar(canvas, 'touchmove', alArrastrarDedo, OPC_ACTIVO);
    escuchar(canvas, 'touchend', alLevantarDedo, false);
    escuchar(canvas, 'touchcancel', alLevantarDedo, false);
    escuchar(document, 'visibilitychange', function () {
      pestanaVisible = !document.hidden;
      if (pestanaVisible) { pintar = true; ultimoT = 0; }
    }, false);

    if (window.ResizeObserver) {
      try {
        obsTam = new window.ResizeObserver(function () { pintar = true; });
        obsTam.observe(canvas);
      } catch (e) { obsTam = null; }
    }
    if (!obsTam) escuchar(window, 'resize', function () { pintar = true; }, false);

    /* Si el lienzo no está a la vista no gastamos GPU ni batería. */
    if (window.IntersectionObserver) {
      try {
        obsVis = new window.IntersectionObserver(function (entradas) {
          for (var j = 0; j < entradas.length; j++) {
            enPantalla = entradas[j].isIntersecting;
          }
          if (enPantalla) { pintar = true; ultimoT = 0; }
        });
        obsVis.observe(canvas);
      } catch (e) { obsVis = null; }
    }

    /* El usuario puede cambiar la preferencia de movimiento sin recargar. */
    try {
      if (window.matchMedia) {
        mqMovimiento = window.matchMedia('(prefers-reduced-motion: reduce)');
        var alCambiarMovimiento = function (ev) {
          reducido = ev.matches;
          pintar = true;
        };
        if (mqMovimiento.addEventListener) {
          mqMovimiento.addEventListener('change', alCambiarMovimiento);
          oyentes.push([mqMovimiento, 'change', alCambiarMovimiento, false]);
        } else if (mqMovimiento.addListener) {
          mqMovimiento.addListener(alCambiarMovimiento);
          mqMovimiento.__emishaFn = alCambiarMovimiento;
        }
      }
    } catch (e) { mqMovimiento = null; }

    ajustarTamano();
    construir(datos);
    cuadro = pedirCuadro(bucle);

    /* ------------------------------------------------------- controlador */

    return {
      actualizar: function (nuevos, nuevasOpciones) {
        if (!vivo) return;
        try {
          if (arguments.length > 1) opCama = nuevasOpciones || null;
          construir(nuevos);
        } catch (e) { /* una malla rota no puede tumbar el cotizador */ }
      },

      /* Cambia cama/planos sin tocar la geometría: barato, para arrastrar
         los planos de corte en vivo. */
      configurar: function (nuevasOpciones) {
        if (!vivo) return;
        try {
          opCama = nuevasOpciones || null;
          construirCama();
          pintar = true;
        } catch (e) {}
      },

      /* Encuadre limpio: zoom y paneo a cero (al cambiar de pieza). */
      reencuadrar: function () {
        if (!vivo) return;
        zoom = 1;
        objetivo[0] = 0; objetivo[1] = 0; objetivo[2] = 0;
        pintar = true;
      },

      /* Encuadrar un punto con un radio dado (tecla F: enfocar la pieza). */
      enfocar: function (c, r) {
        if (!vivo || !c) return;
        primeraInteraccion();
        objetivo[0] = c[0] - centro[0];
        objetivo[1] = c[1] - centro[1];
        objetivo[2] = c[2] - centro[2];
        if (r > 0 && radio > 0) {
          zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, r / radio));
        }
        pintar = true;
      },

      /* Agarre de pieza: probar(tri) dice si el arrastre se queda con la
         pieza bajo el cursor; mover({dx,dy,wx,wy,wz,fase}) recibe cada
         delta y el 'fin' al soltar. */
      agarre: function (probar, mover) {
        if (!vivo) return;
        alAgarreProbar = probar || null;
        alAgarreMover = mover || null;
        agarrando = false;
      },

      /* Arrastre de los marcos de plano de corte: fn({eje,idx,valor,fase}). */
      alMoverPlano: function (fn) {
        if (!vivo) return;
        alPlano = fn || null;
        planoDrag = null;
      },

      /* Gizmo de ejes sobre la pieza seleccionada. cfg = {c:[x,y,z], tam}
         o null para apagarlo; fn({eje,delta,fase}) recibe el arrastre de
         cada flecha, ya proyectado sobre su eje. */
      gizmo: function (cfg, fn) {
        if (!vivo) return;
        gizmoCfg = cfg ? { c: cfg.c.slice(), tam: cfg.tam, modo: cfg.modo || 'mover' } : null;
        if (fn !== undefined) alGizmo = fn || null;
        gizmoDrag = null;
        try { construirGizmo(); } catch (e) {}
        pintar = true;
      },

      /* Vista previa del corte: tiñe azul/rosa los dos lados del plano
         activo dentro de un rango de vértices. {ini, fin, eje:0|1|2, val}
         o null. Es un uniforme del sombreador: gratis de actualizar. */
      corteVista: function (cv) {
        if (!vivo) return;
        corteVista = cv || null;
        try { construirFlechasPlano(); } catch (e) {}
        pintar = true;
      },

      /* Transformación de previsualización sobre un rango de vértices:
         {ini, fin, piv:[x,y,z], desp:[dx,dy,dz], rz (rad), esc}. Con null
         se apaga. No toca la geometría: es solo cómo se dibuja. */
      previsualizar: function (t) {
        if (!vivo) return;
        if (!t) { prevTrans = null; pintar = true; return; }
        var c = Math.cos(t.rz || 0), s = Math.sin(t.rz || 0);
        var e = t.esc > 0 ? t.esc : 1;
        prevTrans = {
          ini: t.ini, fin: t.fin,
          piv: t.piv || [0, 0, 0],
          desp: t.desp || [0, 0, 0],
          mat: new Float32Array([c * e, s * e, 0, -s * e, c * e, 0, 0, 0, e])
        };
        pintar = true;
      },

      /* Pincel: radio en píxeles (0 apaga) y a quién avisar con los
         índices de triángulo pintados. */
      pincel: function (radioPx, fn) {
        if (!vivo) return;
        radioPincel = radioPx > 0 ? radioPx : 0;
        alPintar = radioPincel ? (fn || null) : null;
        canvas.style.cursor = radioPincel ? 'crosshair' : '';
        pintando = false;
        if (radioPincel) {
          if (!circuloPincel) {
            circuloPincel = document.createElement('div');
            circuloPincel.style.cssText =
              'position:fixed;z-index:60;pointer-events:none;display:none;' +
              'border:1.5px solid rgba(20,30,55,.6);background:rgba(70,120,220,.10);' +
              'border-radius:50%;transform:translate(-50%,-50%)';
            document.body.appendChild(circuloPincel);
            escuchar(canvas, 'mousemove', moverCirculo, false);
            escuchar(canvas, 'mouseleave', ocultarCirculo, false);
          }
          circuloPincel.style.width = (radioPincel * 2) + 'px';
          circuloPincel.style.height = (radioPincel * 2) + 'px';
        } else {
          ocultarCirculo();
        }
      },

      /* Clic (o toque) sin arrastre: avisa con el índice del triángulo más
         al frente bajo el cursor, o -1 si el clic cayó en el vacío. */
      elegir: function (fn) {
        if (!vivo) return;
        alElegir = fn || null;
      },

      marcar: function (indices, color) {
        if (!vivo) return;
        try { ponerMarcas(indices, color); } catch (e) {}
      },

      desmarcar: function () {
        if (!vivo) return;
        quitarMarcas();
      },

      destruir: function () {
        if (!vivo) return;
        vivo = false;
        cancelarConstruccion();
        if (cuadro) cancelarCuadro(cuadro);
        cuadro = 0;

        var k;
        for (k = 0; k < oyentes.length; k++) {
          try {
            oyentes[k][0].removeEventListener(oyentes[k][1], oyentes[k][2], oyentes[k][3]);
          } catch (e) {}
        }
        oyentes.length = 0;

        if (mqMovimiento && mqMovimiento.__emishaFn && mqMovimiento.removeListener) {
          try { mqMovimiento.removeListener(mqMovimiento.__emishaFn); } catch (e) {}
        }
        if (obsTam) { try { obsTam.disconnect(); } catch (e) {} obsTam = null; }
        if (obsVis) { try { obsVis.disconnect(); } catch (e) {} obsVis = null; }

        try {
          if (!contextoPerdido) {
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            if (bufPos) gl.deleteBuffer(bufPos);
            if (bufNor) gl.deleteBuffer(bufNor);
            if (bufLin) gl.deleteBuffer(bufLin);
            if (bufPlanos) gl.deleteBuffer(bufPlanos);
            if (bufPlanosFill) gl.deleteBuffer(bufPlanosFill);
            if (bufGizmo) gl.deleteBuffer(bufGizmo);
            if (bufGizmoNor) gl.deleteBuffer(bufGizmoNor);
            if (bufFlecha) gl.deleteBuffer(bufFlecha);
            if (bufFlechaNor) gl.deleteBuffer(bufFlechaNor);
            if (marcas.bufP) gl.deleteBuffer(marcas.bufP);
            if (marcas.bufN) gl.deleteBuffer(marcas.bufN);
            gl.useProgram(null);
            if (programa) gl.deleteProgram(programa);
            if (programaLin) gl.deleteProgram(programaLin);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            /* Soltar el búfer de dibujo importa en iOS, donde la memoria de
               GPU es escasa. Si se vuelve a montar, se redimensiona solo. */
            canvas.width = 1;
            canvas.height = 1;
          }
        } catch (e) {}

        if (circuloPincel && circuloPincel.parentNode) {
          circuloPincel.parentNode.removeChild(circuloPincel);
        }
        circuloPincel = null;
        alElegir = null;
        alAgarreProbar = null; alAgarreMover = null;
        alPlano = null; planoDrag = null; prevTrans = null; corteVista = null;
        flechaSeg = null;
        gizmoCfg = null; alGizmo = null;
        bufPos = null; bufNor = null; programa = null;
        bufLin = null; programaLin = null; linVerts = 0;
        posArr = null; norArr = null; rangos = null;
        vertices = 0; trisListos = 0;
        canvas.style.touchAction = touchAnterior || '';
        canvas.style.width = anchoAnterior || '';
        canvas.style.height = altoAnterior || '';
      }
    };
  }

  window.EmishaPreview = {
    montar: function (canvas, datos, opciones) {
      try {
        return montar(canvas, datos, opciones);
      } catch (e) {
        return NULO;                    // degradar en silencio, nunca romper
      }
    }
  };
}());
