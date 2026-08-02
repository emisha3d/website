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

  var VS = [
    'attribute vec3 aPos;',
    'attribute vec3 aNor;',
    'uniform mat4 uProy;',
    'uniform mat4 uVista;',
    'uniform mat3 uNorMat;',
    'uniform vec3 uCentro;',
    'varying vec3 vNor;',
    'varying vec3 vVista;',
    'void main() {',
    '  vec4 p = uVista * vec4(aPos - uCentro, 1.0);',
    '  vVista = p.xyz;',
    '  vNor = uNorMat * aNor;',
    '  gl_Position = uProy * p;',
    '}'
  ].join('\n');

  /* Luz direccional fija respecto a la cámara (así la pieza nunca se apaga
     al girarla) + ambiente + un relleno tenue y un realce de silueta.
     Las normales se voltean en las caras traseras porque los STL de los
     clientes vienen con orientaciones inconsistentes bastante seguido. */
  var FS = [
    'precision mediump float;',
    'varying vec3 vNor;',
    'varying vec3 vVista;',
    'uniform vec3 uColor;',
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
    '  vec3 col = uColor * (0.34 + 0.66 * dif + rel) + vec3(esp + sil);',
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

    var opCama = opciones || null;      // {camaMm, alturaMm} o null
    var programaLin = null, ubicLin = null, attrPosLin = -1;
    var bufLin = null, linVerts = 0;
    var cajaMin = null, cajaMax = null;
    var radioClip = 1;                  // alcance de los planos de recorte

    var centro = [0, 0, 0];
    var radio = 1;

    var yaw = -0.85, pitch = 0.50, zoom = 1;
    var interactuado = false;
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
        color:  gl.getUniformLocation(p, 'uColor')
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
      var cerca = Math.max(d - radioClip * 2.2, radio * 0.005, 0.01);
      var lejos = d + radioClip * 3;
      matPerspectiva(mProy, FOV, w / (h || 1), cerca, lejos);

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
      gl.uniform3f(ubic.centro, centro[0], centro[1], centro[2]);
      gl.uniform3f(ubic.color, COLOR_MALLA[0], COLOR_MALLA[1], COLOR_MALLA[2]);

      gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
      gl.enableVertexAttribArray(attrPos);
      gl.vertexAttribPointer(attrPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufNor);
      gl.enableVertexAttribArray(attrNor);
      gl.vertexAttribPointer(attrNor, 3, gl.FLOAT, false, 0, 0);

      if (rangos) {
        for (var rg = 0; rg < rangos.length; rg++) {
          var r = rangos[rg];
          var fin = Math.min(r.fin, vertices);
          if (fin <= r.ini) continue;
          var col = r.color || COLOR_MALLA;
          gl.uniform3f(ubic.color, col[0], col[1], col[2]);
          gl.drawArrays(gl.TRIANGLES, r.ini, fin - r.ini);
        }
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, vertices);
      }

      /* La cama al final: son cuatro líneas y el fondo ya está pintado. */
      if (linVerts && bufLin && programaLin) {
        gl.disableVertexAttribArray(attrNor);
        gl.useProgram(programaLin);
        gl.uniformMatrix4fv(ubicLin.proy, false, mProy);
        gl.uniformMatrix4fv(ubicLin.vista, false, mVista);
        gl.uniform3f(ubicLin.centro, centro[0], centro[1], centro[2]);
        gl.uniform4f(ubicLin.color, 0.63, 0.68, 0.75, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufLin);
        gl.enableVertexAttribArray(attrPosLin);
        gl.vertexAttribPointer(attrPosLin, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, linVerts);
        /* Si quedara habilitado apuntando al búfer chico de líneas, el
           siguiente dibujo de la malla no pasaría la validación de WebGL. */
        gl.disableVertexAttribArray(attrPosLin);
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

    var arrastrando = false, px = 0, py = 0, pinchD = 0;

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

    function acercar(factor) {
      zoom *= factor;
      if (zoom < ZOOM_MIN) zoom = ZOOM_MIN;
      if (zoom > ZOOM_MAX) zoom = ZOOM_MAX;
      pintar = true;
    }

    function alBajarRaton(ev) {
      if (ev.button !== 0) return;
      arrastrando = true;
      px = ev.clientX; py = ev.clientY;
      primeraInteraccion();
      if (ev.preventDefault) ev.preventDefault();
    }

    function alMoverRaton(ev) {
      if (!arrastrando) return;
      orbitar(ev.clientX - px, ev.clientY - py);
      px = ev.clientX; py = ev.clientY;
    }

    function alSoltarRaton() { arrastrando = false; }

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
        arrastrando = true;
        px = ts[0].clientX; py = ts[0].clientY;
        pinchD = 0;
      } else if (ts.length >= 2) {
        arrastrando = false;
        pinchD = distTocada(ts);
      }
      ev.preventDefault();
    }

    function alArrastrarDedo(ev) {
      var ts = ev.touches;
      if (ts.length === 1 && arrastrando) {
        orbitar(ts[0].clientX - px, ts[0].clientY - py);
        px = ts[0].clientX; py = ts[0].clientY;
      } else if (ts.length >= 2) {
        var d = distTocada(ts);
        if (pinchD) acercar(pinchD / d);
        pinchD = d;
      }
      ev.preventDefault();               // bloquea el desplazamiento del documento
    }

    function alLevantarDedo(ev) {
      var ts = ev.touches;
      if (!ts || ts.length === 0) { arrastrando = false; pinchD = 0; }
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
      vertices = 0;
      /* La construcción sigue: es trabajo de CPU y al recuperar el contexto
         subimos de golpe todo lo que se haya resuelto mientras tanto. */
    }

    function alRecuperarContexto() {
      contextoPerdido = false;
      if (!crearPrograma()) return;
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
          zoom = 1;                     // encuadre limpio para cada pieza
          construir(nuevos);
        } catch (e) { /* una malla rota no puede tumbar el cotizador */ }
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
