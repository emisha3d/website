/* ==========================================================================
   Emisha — cotizador de corte y grabado láser (/cotizador-laser/)

   Sube cada archivo a la API de Emisha Láser, que lo convierte a un SVG
   normalizado en mm y lo analiza (capas por color, piezas, rasters). Aquí se
   eligen operaciones, material y entrega, se pide la cotización al servidor
   (con rebote: se recotiza sola al cambiar algo) y se pinta:
     · vista 2D con los colores de cada operación,
     · vista 3D (three.js vendorizado, se carga solo al abrir la pestaña),
     · acomodo de las piezas en la hoja (nesting que devuelve el servidor).
   El pedido va a POST /trabajos: el servidor recotiza, nunca confía en el
   precio que calculó el navegador.

   ?trabajo=<uuid>  muestra el estado de un pedido ya hecho.
   ?mock=1          modo de prueba sin API (datos ficticios, nada se sube).
   ========================================================================== */
(function () {
  'use strict';

  var SCRIPT_URL = (document.currentScript && document.currentScript.src) || (location.origin + '/assets/js/cotizador-laser.js');
  var API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
    ? 'http://localhost:3000'
    : 'https://laser.emisha.com.mx';
  var TENANT = 'emisha';
  var BASE = API + '/api/p/' + TENANT;
  var PARAMS = new URLSearchParams(location.search);
  var MOCK = PARAMS.get('mock') === '1';
  var WHATSAPP = '525575639255';
  var MAX_MB = 50;
  var SUBIDAS_SIMULTANEAS = 2;
  var REBOTE_MS = 450;
  var TZ = 'America/Mexico_City';
  var DATOS_LS = 'emisha-datos-envio-v1';     // los mismos que recuerdan la tienda y el cotizador 3D
  var EXTENSIONES = ['svg', 'dxf', 'dwg', 'pdf', 'ai', 'eps', 'cdr', 'png', 'jpg', 'jpeg',
                     'webp', 'tif', 'tiff', 'bmp', 'heic', 'psd'];

  var COLOR_OP = { corte: '#e02424', marcado: '#1d6fe0', grabado: '#1b1f24', ignorar: '#9aa4b1' };
  var OPERACIONES = [['corte', 'Cortar'], ['marcado', 'Marcar'], ['grabado', 'Grabar'], ['ignorar', 'Ignorar']];
  var PALETA_ARCHIVOS = ['#0b6bcb', '#d2590b', '#067647', '#7a3fc1', '#b42318', '#0e7490'];

  /* Sentido de rotacionGrados en el acomodo. Con y hacia abajo (como SVG),
     rotate(90) de SVG gira en el sentido del reloj en pantalla. Si el motor
     de nesting usa el sentido contrario, cambiar a false. */
  var ROTACION_HORARIA = true;

  /* ================================================================ utilidades */

  var $ = function (s, r) { return (r || document).querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function num(n, dec) {
    return Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: dec == null ? 1 : dec });
  }

  function mxn(cent) {
    if (cent == null || !isFinite(cent)) return '—';
    return '$' + Math.round(cent / 100).toLocaleString('es-MX') + ' MXN';
  }

  function medidas(anchoMm, altoMm) {
    return num(anchoMm) + ' × ' + num(altoMm) + ' mm · ' +
           num(anchoMm / 10) + ' × ' + num(altoMm / 10) + ' cm';
  }

  function longitud(mm) {
    return mm >= 1000 ? num(mm / 1000, 2) + ' m' : num(mm, 0) + ' mm';
  }

  function area(mm2) { return num(mm2 / 100, 1) + ' cm²'; }

  function tiempo(s) {
    s = Math.max(0, Math.round(s || 0));
    if (s < 60) return s + ' s';
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    if (!h) return m + ' min';
    return h + ' h' + (m ? ' ' + (m < 10 ? '0' : '') + m + ' min' : '');
  }

  function aFecha(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + 'T12:00:00');
    return new Date(v);
  }

  function fechaLarga(v) {
    var d = aFecha(v);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
  }

  function fechaCorta(v) {
    var d = aFecha(v);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
  }

  // Aproximación del navegador (sin feriados): la fecha buena la da la cotización.
  function sumarDiasHabiles(desde, dias) {
    var d = new Date(desde.getTime());
    var n = 0;
    while (n < dias) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) n++;
    }
    return d;
  }

  function hexRgb(h) {
    h = String(h || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n) || h.length !== 6) return [200, 162, 122];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbHex(c) {
    return '#' + c.map(function (v) {
      var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return s.length < 2 ? '0' + s : s;
    }).join('');
  }

  function mezclar(a, b, t) {
    var x = hexRgb(a), y = hexRgb(b);
    return rgbHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
  }

  // Material oscuro (acrílico negro): el grabado se ve claro, no más oscuro.
  function esOscuro(hex) {
    var c = hexRgb(hex);
    return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 < 0.4;
  }

  function urlApi(u) {
    if (!u) return '';
    return /^(https?:|data:|blob:)/.test(u) ? u : API + (u.charAt(0) === '/' ? '' : '/') + u;
  }

  function cajaDe(puntos) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < puntos.length; i++) {
      var p = puntos[i];
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, w: 0, h: 0 };
    return { minX: minX, minY: minY, w: maxX - minX, h: maxY - minY };
  }

  function r2(n) { return Math.round(n * 100) / 100; }

  function rutaSvg(puntos, cerrada) {
    if (!puntos || !puntos.length) return '';
    var s = 'M' + r2(puntos[0][0]) + ' ' + r2(puntos[0][1]);
    for (var i = 1; i < puntos.length; i++) s += 'L' + r2(puntos[i][0]) + ' ' + r2(puntos[i][1]);
    return s + (cerrada ? 'Z' : '');
  }

  function rutaPieza(p) {
    var d = rutaSvg(p.exterior, true);
    (p.agujeros || []).forEach(function (h) { d += rutaSvg(h, true); });
    return d;
  }

  function leerLS(clave) {
    try { return JSON.parse(localStorage.getItem(clave) || 'null'); } catch (e) { return null; }
  }
  function guardarLS(clave, v) {
    try { localStorage.setItem(clave, JSON.stringify(v)); } catch (e) { /* modo privado */ }
  }

  /* ================================================================ mensajes */

  var ERRORES_COTIZACION = {
    sin_maquina: 'Ninguna de nuestras máquinas puede trabajar este material con tu diseño — escríbenos por WhatsApp y buscamos cómo hacerlo.',
    no_cabe: 'Ninguna de nuestras máquinas puede cortar este material con ese tamaño — escríbenos por WhatsApp.',
    sin_material: 'Ese material ya no está disponible. Elige otro o escríbenos por WhatsApp.'
  };

  var AVISOS = {
    texto_sin_convertir: 'Tu diseño tiene texto sin convertir a curvas: podría salir con otra tipografía.',
    escala_dudosa: 'Las medidas se ven raras. Revisa que el diseño esté en milímetros y a escala 1:1.',
    contorno_abierto: 'Hay contornos de corte que no cierran: esa pieza podría quedar pegada a la hoja.',
    lineas_duplicadas: 'Hay líneas repetidas una encima de otra; el láser las pasaría dos veces.',
    raster_baja_resolucion: 'La imagen tiene poca resolución para grabarse nítida.',
    conversion_parcial: 'No pudimos leer todo el archivo. Revisa que la vista coincida con tu diseño.',
    fuera_de_cama: 'El diseño es más grande que la cama de nuestras máquinas.',
    sin_vectores: 'El archivo no tiene líneas para cortar: solo se puede grabar.',
    otro: 'Revisa el diseño: algo no se ve como esperábamos.'
  };

  function textoAviso(a) { return (a && (a.mensaje || AVISOS[a.codigo])) || AVISOS.otro; }

  function errorApi(status, datos) {
    var e = new Error((datos && datos.error) || ('HTTP ' + status));
    e.status = status; e.codigo = datos && datos.codigo; e.datos = datos;
    return e;
  }

  function mensajeError(e, contexto) {
    if (e && e.codigo && ERRORES_COTIZACION[e.codigo]) return ERRORES_COTIZACION[e.codigo];
    if (!e || e.status == null) {
      return 'No pudimos conectar con el cotizador. Revisa tu conexión e inténtalo de nuevo, o escríbenos por WhatsApp al +52 55 7563 9255.';
    }
    if (e.status === 413) return 'El archivo pesa más de ' + MAX_MB + ' MB. Reduce las imágenes que trae o mándanoslo por WhatsApp.';
    if (e.status === 429) return 'Subiste muchos archivos en poco tiempo. Espera unos minutos y vuelve a intentar.';
    if (e.status >= 500) {
      return contexto === 'subida'
        ? 'No pudimos leer este archivo. Prueba exportarlo como SVG o PDF, o mándanoslo por WhatsApp.'
        : 'Algo falló de nuestro lado. Inténtalo en un momento o escríbenos por WhatsApp.';
    }
    return (e.datos && e.datos.error) || 'No se pudo completar. Inténtalo de nuevo o escríbenos por WhatsApp.';
  }

  /* ================================================================ HTTP */

  function pedirJSON(metodo, ruta, cuerpo, senal) {
    if (MOCK) return mock.pedir(metodo, ruta, cuerpo);
    var op = { method: metodo, signal: senal };
    if (cuerpo) { op.headers = { 'Content-Type': 'application/json' }; op.body = JSON.stringify(cuerpo); }
    return fetch(BASE + ruta, op).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (e) { /* no era JSON */ }
        if (!r.ok) throw errorApi(r.status, d);
        return d;
      });
    }, function (err) {
      if (err && err.name === 'AbortError') throw err;
      throw errorApi(null, null);
    });
  }

  function subirArchivo(ar) {
    if (MOCK) return mock.subir(ar);
    return new Promise(function (ok, mal) {
      var xhr = new XMLHttpRequest();
      ar.xhr = xhr;
      xhr.open('POST', BASE + '/archivos');
      xhr.timeout = 180000;
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) progreso(ar, e.loaded / e.total); };
      xhr.upload.onload = function () { progreso(ar, 1); };
      xhr.onload = function () {
        var d = null;
        try { d = JSON.parse(xhr.responseText); } catch (e) { /* no era JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && d) ok(d);
        else mal(errorApi(xhr.status, d));
      };
      xhr.onerror = function () { mal(errorApi(null, null)); };
      xhr.ontimeout = function () {
        mal(errorApi(504, { error: 'El análisis tardó demasiado. Prueba con un archivo más ligero o mándanoslo por WhatsApp.' }));
      };
      xhr.onabort = function () { var e = new Error('cancelado'); e.cancelado = true; mal(e); };
      var fd = new FormData();
      fd.append('archivo', ar.file, ar.nombre);
      xhr.send(fd);
    });
  }

  /* ================================================================ estado */

  var estado = {
    catalogo: null,
    archivos: [],          // ver nuevoArchivo()
    sel: null,             // uid del archivo en las vistas 2D/3D
    vista: '2d',
    hoja: 0,
    original: false,       // 2D: ver el SVG normalizado tal cual
    cotizacion: null,
    errorCot: null,
    cotizando: false
  };
  var uidSig = 1;

  /* ================================================================ elementos */

  var herramienta = $('[data-lz-herramienta]');
  var conf = $('[data-lz-conf]');
  if (!herramienta || !conf) return;

  var avisoGeneral = $('[data-lz-aviso]');
  var zona = $('#lz-dropzone');
  var input = $('#lz-archivo');
  var lista = $('[data-lz-archivos]');
  var selMaterial = $('[data-lz-material]');
  var hintMaterial = $('[data-lz-material-hint]');
  var chkPropio = $('[data-lz-propio]');
  var selMaquina = $('[data-lz-maquina]');
  var radiosEntrega = document.querySelectorAll('input[name="lz-entrega"]');
  var txtEstandar = $('[data-lz-entrega-estandar]');
  var txtUrgente = $('[data-lz-entrega-urgente]');
  var txtUrgentePct = $('[data-lz-urgente-pct]');

  var cajaTotal = $('.lz-total');
  var elTotal = $('[data-lz-total]');
  var elTotalEstado = $('[data-lz-total-estado]');
  var btnPedir = $('[data-lz-pedir]');
  var btnWa = $('[data-lz-wa]');
  var elEstimado = $('[data-lz-estimado]');
  var elError = $('[data-lz-error]');
  var elDesglose = $('[data-lz-desglose]');
  var elQAvisos = $('[data-lz-q-avisos]');

  var vistas = $('[data-lz-vistas]');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.lz-tabs [role="tab"]'));
  var cajaSelArchivo = $('[data-lz-sel-archivo-caja]');
  var selArchivo = $('[data-lz-sel-archivo]');
  var lienzo2d = $('[data-lz-2d]');
  var nota2d = $('[data-lz-2d-nota]');
  var cont3d = $('[data-lz-3d]');
  var canvas3d = $('[data-lz-3d-canvas]');
  var msg3d = $('[data-lz-3d-msg]');
  var nota3d = $('[data-lz-3d-nota]');
  var btnCentrar = $('[data-lz-3d-centrar]');
  var cajaHojas = $('[data-lz-hojas]');
  var lienzoHoja = $('[data-lz-hoja]');
  var notaHoja = $('[data-lz-hoja-nota]');

  function avisar(texto) {
    avisoGeneral.textContent = texto || '';
    avisoGeneral.hidden = !texto;
  }

  /* ================================================================ catálogo y opciones */

  function material() {
    var c = estado.catalogo;
    if (!c) return null;
    for (var i = 0; i < c.materiales.length; i++) if (c.materiales[i].id === selMaterial.value) return c.materiales[i];
    return null;
  }

  function nombreMaterial(m) { return m ? m.nombre + ' ' + num(m.espesorMm) + ' mm' : ''; }

  function maquinaPorId(id) {
    var ms = (estado.catalogo && estado.catalogo.maquinas) || [];
    for (var i = 0; i < ms.length; i++) if (ms[i].id === id) return ms[i];
    return null;
  }

  function urgente() {
    for (var i = 0; i < radiosEntrega.length; i++) if (radiosEntrega[i].checked) return radiosEntrega[i].value === 'urgente';
    return false;
  }

  function cargarCatalogo() {
    return pedirJSON('GET', '/catalogo').then(function (c) {
      c.materiales = (c.materiales || []).filter(function (m) { return m.activo !== false; });
      c.maquinas = (c.maquinas || []).filter(function (m) { return m.activa !== false; });
      c.ajustes = c.ajustes || {};
      estado.catalogo = c;
      pintarCatalogo();
      programarCotizacion();
    }).catch(function () {
      selMaterial.innerHTML = '<option>No disponible</option>';
      avisar('Ahorita no podemos cargar el cotizador láser. Escríbenos por WhatsApp al +52 55 7563 9255 ' +
             'con tu archivo y te cotizamos a mano.');
    });
  }

  function materialPorDefecto(c) {
    var mejor = c.materiales[0], mejorCuenta = -1, mejorPrecio = Infinity;
    c.materiales.forEach(function (m) {
      var cuenta = 0;
      (c.maquinas || []).forEach(function (q) {
        if (q.materialIds && q.materialIds.indexOf(m.id) !== -1) cuenta++;
      });
      var area = (m.hojaAnchoMm * m.hojaAltoMm) || 1;
      var precio = (m.precioHojaCentavos || 0) / area;
      if (cuenta > mejorCuenta || (cuenta === mejorCuenta && precio < mejorPrecio)) {
        mejor = m; mejorCuenta = cuenta; mejorPrecio = precio;
      }
    });
    return mejor;
  }

  function pintarCatalogo() {
    var c = estado.catalogo;
    var mats = c.materiales.slice().sort(function (a, b) {
      return a.nombre.localeCompare(b.nombre, 'es') || a.espesorMm - b.espesorMm;
    });
    var grupos = [], porNombre = {};
    mats.forEach(function (m) {
      if (!porNombre[m.nombre]) { porNombre[m.nombre] = []; grupos.push(m.nombre); }
      porNombre[m.nombre].push(m);
    });
    selMaterial.innerHTML = grupos.map(function (g) {
      return '<optgroup label="' + esc(g) + '">' + porNombre[g].map(function (m) {
        return '<option value="' + esc(m.id) + '">' + esc(g) + ' · ' + esc(num(m.espesorMm)) + ' mm</option>';
      }).join('') + '</optgroup>';
    }).join('');
    selMaterial.disabled = !mats.length;
    if (!mats.length) selMaterial.innerHTML = '<option>Sin materiales disponibles</option>';
    // Las opciones van por nombre; la elegida de entrada es la que más máquinas
    // pueden procesar (MDF antes que acero), y en empate la más barata por área.
    else selMaterial.value = materialPorDefecto(c).id;

    selMaquina.innerHTML = '<option value="">La más conveniente</option>' + c.maquinas.map(function (m) {
      var cama = m.camaAnchoMm ? ' · cama ' + num(m.camaAnchoMm / 10, 0) + ' × ' + num(m.camaAltoMm / 10, 0) + ' cm' : '';
      return '<option value="' + esc(m.id) + '">' + esc(m.nombre) + esc(cama) + '</option>';
    }).join('');
    selMaquina.closest('.field').hidden = c.maquinas.length < 2;

    var pct = Math.round((c.ajustes.urgentePct || 0) * 100);
    txtUrgentePct.textContent = pct ? '+' + pct + ' %' : '';
    pintarMaterialHint();
    pintarEntrega();
  }

  function pintarMaterialHint() {
    var m = material();
    hintMaterial.textContent = m ? 'Hoja de ' + num(m.hojaAnchoMm / 10) + ' × ' + num(m.hojaAltoMm / 10) + ' cm' : '';
  }

  function pintarEntrega() {
    var aj = (estado.catalogo && estado.catalogo.ajustes) || {};
    var ahora = new Date();
    var q = estado.cotizacion;
    var esUrg = urgente();
    function texto(dias, esEste) {
      var fecha = (esEste && q && q.entregaEstimada) ? fechaCorta(q.entregaEstimada) : fechaCorta(sumarDiasHabiles(ahora, dias));
      return (dias ? dias + (dias === 1 ? ' día hábil' : ' días hábiles') + ' · ' : '') + 'aprox. ' + fecha;
    }
    txtEstandar.textContent = aj.diasEstandar != null ? texto(aj.diasEstandar, !esUrg) : '—';
    txtUrgente.textContent = aj.diasUrgente != null ? texto(aj.diasUrgente, esUrg) : '—';
  }

  selMaterial.addEventListener('change', function () {
    pintarMaterialHint();
    actualizarVistas();
    programarCotizacion();
  });
  selMaquina.addEventListener('change', programarCotizacion);
  chkPropio.addEventListener('change', programarCotizacion);
  Array.prototype.forEach.call(radiosEntrega, function (r) {
    r.addEventListener('change', function () { pintarEntrega(); programarCotizacion(); });
  });

  /* ================================================================ archivos */

  var cola = [], subiendo = 0;

  zona.addEventListener('click', function () { input.click(); });
  zona.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  zona.addEventListener('dragover', function (e) { e.preventDefault(); zona.classList.add('is-over'); });
  zona.addEventListener('dragleave', function () { zona.classList.remove('is-over'); });
  zona.addEventListener('drop', function (e) {
    e.preventDefault();
    zona.classList.remove('is-over');
    if (e.dataTransfer && e.dataTransfer.files) agregar(e.dataTransfer.files);
  });
  input.addEventListener('change', function () {
    agregar(input.files);
    input.value = '';
  });

  function agregar(files, opciones) {
    Array.prototype.forEach.call(files || [], function (file) {
      var ext = (file.name.split('.').pop() || '').toLowerCase();
      var ar = {
        uid: uidSig++, nombre: file.name, file: file, estado: 'en_cola', progreso: 0,
        error: '', analisis: null, cantidad: (opciones && opciones.cantidad) || 1,
        operaciones: {}, grabarRasters: true, xhr: null
      };
      if (EXTENSIONES.indexOf(ext) < 0) {
        ar.estado = 'error';
        ar.error = 'Este formato no lo leemos. Sube SVG, DXF, DWG, PDF, AI, EPS, CDR o una imagen.';
      } else if (file.size > MAX_MB * 1024 * 1024) {
        ar.estado = 'error';
        ar.error = 'Pesa ' + num(file.size / 1048576, 0) + ' MB y el máximo es ' + MAX_MB + ' MB. Reduce las imágenes que trae o mándanoslo por WhatsApp.';
      } else {
        cola.push(ar);
      }
      estado.archivos.push(ar);
    });
    renderArchivos();
    siguienteSubida();
  }

  function siguienteSubida() {
    while (subiendo < SUBIDAS_SIMULTANEAS && cola.length) {
      (function (ar) {
        subiendo++;
        ar.estado = 'subiendo';
        renderArchivos();
        subirArchivo(ar).then(function (a) {
          ar.analisis = a;
          ar.estado = 'listo';
          (a.capas || []).forEach(function (c) { ar.operaciones[c.id] = c.operacionSugerida || 'corte'; });
          if (!estado.sel || !archivoSel()) estado.sel = ar.uid;
        }).catch(function (e) {
          if (e && e.cancelado) return;
          ar.estado = 'error';
          ar.error = mensajeError(e, 'subida');
        }).then(function () {
          ar.xhr = null;
          subiendo--;
          if (estado.archivos.indexOf(ar) >= 0) {
            renderArchivos();
            actualizarVistas();
            programarCotizacion();
          }
          siguienteSubida();
        });
      })(cola.shift());
    }
  }

  function progreso(ar, f) {
    ar.progreso = f;
    if (f >= 1 && ar.estado === 'subiendo') ar.estado = 'analizando';
    if (ar._barra) {
      ar._barra.parentNode.classList.toggle('lz-progreso--indeterminado', ar.estado === 'analizando');
      ar._barra.style.width = Math.round(f * 100) + '%';
      ar._barra.parentNode.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    }
    if (ar._meta) ar._meta.textContent = metaArchivo(ar);
  }

  function quitar(ar) {
    if (ar.xhr) ar.xhr.abort();
    if (ar.mockTimer) clearTimeout(ar.mockTimer);
    var i = cola.indexOf(ar);
    if (i >= 0) cola.splice(i, 1);
    estado.archivos.splice(estado.archivos.indexOf(ar), 1);
    if (estado.sel === ar.uid) {
      var otro = listos()[0];
      estado.sel = otro ? otro.uid : null;
    }
    renderArchivos();
    actualizarVistas();
    programarCotizacion();
  }

  function listos() { return estado.archivos.filter(function (a) { return a.estado === 'listo'; }); }
  function pendientes() {
    return estado.archivos.filter(function (a) { return a.estado === 'en_cola' || a.estado === 'subiendo' || a.estado === 'analizando'; }).length;
  }
  function archivoSel() {
    for (var i = 0; i < estado.archivos.length; i++) {
      var a = estado.archivos[i];
      if (a.uid === estado.sel && a.estado === 'listo') return a;
    }
    return null;
  }

  function metaArchivo(ar) {
    if (ar.estado === 'en_cola') return 'En espera…';
    if (ar.estado === 'subiendo') return 'Subiendo… ' + Math.round(ar.progreso * 100) + ' %';
    if (ar.estado === 'analizando') return 'Analizando el archivo…';
    if (ar.estado === 'error') return ar.error;
    var a = ar.analisis;
    var partes = [medidas(a.anchoMm, a.altoMm)];
    var np = (a.piezas || []).length;
    if (np) partes.push(np + (np === 1 ? ' pieza' : ' piezas'));
    return partes.join(' · ');
  }

  function renderArchivos() {
    lista.textContent = '';
    zona.classList.toggle('dropzone--compacta', estado.archivos.length > 0);

    estado.archivos.forEach(function (ar) {
      var card = document.createElement('div');
      card.className = 'lz-archivo' + (ar.estado === 'error' ? ' lz-archivo--error' : '') +
        (ar.estado === 'listo' && ar.uid === estado.sel && listos().length > 1 ? ' lz-archivo--activo' : '');

      var cab = document.createElement('div');
      cab.className = 'lz-archivo__cab';
      var izq = document.createElement('div');
      var nombre = document.createElement(ar.estado === 'listo' ? 'button' : 'div');
      nombre.className = 'lz-archivo__nombre';
      nombre.textContent = ar.nombre;
      if (ar.estado === 'listo') {
        nombre.type = 'button';
        nombre.title = 'Ver este archivo en las vistas';
        nombre.addEventListener('click', function () { seleccionar(ar.uid, true); });
      }
      var meta = document.createElement('div');
      meta.className = 'lz-archivo__meta';
      meta.textContent = metaArchivo(ar);
      ar._meta = meta;
      izq.appendChild(nombre);
      izq.appendChild(meta);

      var der = document.createElement('div');
      der.className = 'lz-archivo__ctl';
      if (ar.estado === 'listo') {
        var cant = document.createElement('input');
        cant.type = 'number'; cant.min = '1'; cant.max = '10000'; cant.step = '1';
        cant.value = ar.cantidad;
        cant.className = 'filerow__qty';
        cant.id = 'lz-cant-' + ar.uid;
        cant.addEventListener('input', function () {
          var v = parseInt(cant.value, 10);
          if (isFinite(v) && v > 0) { ar.cantidad = Math.min(v, 10000); programarCotizacion(); }
        });
        cant.addEventListener('change', function () { cant.value = ar.cantidad; });
        var lab = document.createElement('label');
        lab.className = 'filerow__ctl';
        lab.setAttribute('for', cant.id);
        lab.innerHTML = '<span>pzas</span>';
        lab.appendChild(cant);
        cant.setAttribute('aria-label', 'Cantidad de ' + ar.nombre);
        der.appendChild(lab);
      }
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'filerow__remove';
      del.setAttribute('aria-label', 'Quitar ' + ar.nombre);
      del.textContent = '×';
      del.addEventListener('click', function () { quitar(ar); });
      der.appendChild(del);

      cab.appendChild(izq);
      cab.appendChild(der);
      card.appendChild(cab);

      ar._barra = null;
      if (ar.estado === 'subiendo' || ar.estado === 'analizando' || ar.estado === 'en_cola') {
        var prog = document.createElement('div');
        prog.className = 'lz-progreso' + (ar.estado === 'analizando' ? ' lz-progreso--indeterminado' : '');
        prog.setAttribute('role', 'progressbar');
        prog.setAttribute('aria-label', 'Subiendo ' + ar.nombre);
        prog.setAttribute('aria-valuemin', '0');
        prog.setAttribute('aria-valuemax', '100');
        prog.setAttribute('aria-valuenow', String(Math.round(ar.progreso * 100)));
        var barra = document.createElement('span');
        barra.style.width = Math.round(ar.progreso * 100) + '%';
        prog.appendChild(barra);
        card.appendChild(prog);
        ar._barra = barra;
      }

      if (ar.estado === 'listo') pintarDetalle(ar, card);
      lista.appendChild(card);
    });
  }

  function pintarDetalle(ar, card) {
    var a = ar.analisis;

    if (a.avisos && a.avisos.length) {
      var ul = document.createElement('ul');
      ul.className = 'lz-avisos';
      a.avisos.forEach(function (av) {
        var li = document.createElement('li');
        li.textContent = textoAviso(av);
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }

    if (a.rasters && a.rasters.length) {
      var chk = document.createElement('label');
      chk.className = 'lz-check';
      chk.innerHTML = '<input type="checkbox"><span>Grabar ' + (a.rasters.length === 1 ? 'la imagen' : 'las ' + a.rasters.length + ' imágenes') +
        '<small>' + esc(a.rasters.map(function (r) {
          return num(r.anchoMm) + ' × ' + num(r.altoMm) + ' mm' + (r.dpi ? ' a ' + Math.round(r.dpi) + ' dpi' : '');
        }).join(' · ')) + '</small></span>';
      var caja = chk.querySelector('input');
      caja.checked = ar.grabarRasters;
      caja.addEventListener('change', function () {
        ar.grabarRasters = caja.checked;
        actualizarVistas();
        programarCotizacion();
      });
      card.appendChild(chk);
    }

    var capas = a.capas || [];
    if (!capas.length) return;
    var det = document.createElement('details');
    det.className = 'lz-capas';
    det.open = capas.length <= 6;
    var sum = document.createElement('summary');
    sum.textContent = 'Capas y operaciones (' + capas.length + ')';
    det.appendChild(sum);
    var ol = document.createElement('ul');
    ol.className = 'lz-capas__lista';
    capas.forEach(function (c, i) {
      var li = document.createElement('li');
      li.className = 'lz-capa';
      var idSel = 'lz-capa-' + ar.uid + '-' + i;
      var detalle = c.numRutas + (c.numRutas === 1 ? ' ruta' : ' rutas');
      if (c.tipo === 'relleno') detalle += ' · ' + area(c.areaMm2) + ' · contorno ' + longitud(c.longitudMm);
      else detalle += ' · ' + longitud(c.longitudMm);
      li.innerHTML =
        '<span class="lz-capa__muestra' + (c.tipo === 'trazo' ? ' lz-capa__muestra--trazo' : '') + '" style="' +
          (c.tipo === 'trazo' ? 'border-color:' : 'background:') + esc(c.color) + '" aria-hidden="true"></span>' +
        '<label class="lz-capa__texto" for="' + idSel + '"><b>' + (c.tipo === 'trazo' ? 'Líneas ' : 'Relleno ') +
          esc(String(c.color).toUpperCase()) + '</b><small>' + esc(detalle) + '</small></label>' +
        '<select id="' + idSel + '">' + OPERACIONES.map(function (o) {
          return '<option value="' + o[0] + '"' + (ar.operaciones[c.id] === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select>';
      li.querySelector('select').addEventListener('change', function (e) {
        ar.operaciones[c.id] = e.target.value;
        if (estado.sel !== ar.uid) seleccionar(ar.uid, false);
        else actualizarVistas();
        programarCotizacion();
      });
      ol.appendChild(li);
    });
    det.appendChild(ol);
    card.appendChild(det);
  }

  function seleccionar(uid, mover) {
    estado.sel = uid;
    estado.original = false;
    renderArchivos();
    actualizarVistas();
    if (mover && vistas.scrollIntoView && window.innerWidth < 960) vistas.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ================================================================ cotización */

  var timerCot = null, secuencia = 0, controlador = null;

  function solicitud() {
    var s = {
      materialId: selMaterial.value,
      materialDelCliente: chkPropio.checked,
      urgente: urgente(),
      lineas: listos().map(function (ar) {
        var ops = {};
        Object.keys(ar.operaciones).forEach(function (k) { ops[k] = ar.operaciones[k]; });
        return { archivoId: ar.analisis.archivoId, cantidad: ar.cantidad, operaciones: ops, grabarRasters: ar.grabarRasters };
      })
    };
    if (selMaquina.value) s.maquinaId = selMaquina.value;
    return s;
  }

  function programarCotizacion() {
    clearTimeout(timerCot);
    if (!estado.catalogo || !material() || !listos().length) {
      if (controlador) controlador.abort();
      secuencia++;
      estado.cotizacion = null;
      estado.errorCot = null;
      estado.cotizando = false;
      pintarResultado();
      return;
    }
    estado.cotizando = true;
    pintarResultado();
    timerCot = setTimeout(cotizar, REBOTE_MS);
  }

  function cotizar() {
    var mia = ++secuencia;
    if (controlador) controlador.abort();
    controlador = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    pedirJSON('POST', '/cotizar', solicitud(), controlador && controlador.signal).then(function (c) {
      if (mia !== secuencia) return;
      estado.cotizacion = c;
      estado.errorCot = null;
    }, function (e) {
      if (mia !== secuencia || (e && e.name === 'AbortError')) return;
      estado.cotizacion = null;
      estado.errorCot = e;
    }).then(function () {
      if (mia !== secuencia) return;
      estado.cotizando = false;
      pintarResultado();
      if (estado.vista === 'hoja') dibujarHoja();
    });
  }

  function fila(dt, sub, dd, clase) {
    return '<div' + (clase ? ' class="' + clase + '"' : '') + '><dt>' + esc(dt) +
      (sub ? '<small>' + esc(sub) + '</small>' : '') + '</dt><dd>' + esc(dd) + '</dd></div>';
  }

  function pintarResultado() {
    var q = estado.cotizacion;
    var n = listos().length;
    var pend = pendientes();

    cajaTotal.classList.toggle('lz-total--cargando', estado.cotizando);
    elError.hidden = !estado.errorCot || estado.cotizando;
    if (estado.errorCot) {
      elError.innerHTML = esc(mensajeError(estado.errorCot, 'cotizar')) +
        ' <a href="' + esc(enlaceWhatsApp()) + '" target="_blank" rel="noopener">Abrir WhatsApp</a>';
    }

    if (estado.cotizando) {
      elTotalEstado.textContent = 'Calculando…';
    } else if (!n) {
      elTotal.textContent = '—';
      elTotalEstado.textContent = pend ? 'Esperando a que termine el análisis…' : 'Sube un archivo para ver el precio.';
    } else if (!q) {
      elTotal.textContent = '—';
      elTotalEstado.textContent = estado.errorCot ? 'No pudimos cotizar con estas opciones.' : '';
    }

    if (q && !estado.cotizando) {
      elTotal.textContent = mxn(q.totalCentavos);
      var piezas = listos().reduce(function (s, a) { return s + a.cantidad * Math.max(1, (a.analisis.piezas || []).length); }, 0);
      elTotalEstado.textContent = n + (n === 1 ? ' archivo' : ' archivos') + ' · ' + piezas + (piezas === 1 ? ' pieza' : ' piezas') +
        ' · entrega aprox. ' + fechaCorta(q.entregaEstimada) + (pend ? ' · faltan ' + pend + ' por analizar' : '');
    }

    elEstimado.hidden = !(q && q.esEstimado);
    pintarDesglose(q);
    pintarEntrega();

    btnPedir.disabled = !q || estado.cotizando || pend > 0;
    btnPedir.title = pend > 0 ? 'Espera a que terminen de analizarse tus archivos.' : '';
    btnWa.href = enlaceWhatsApp();
  }

  function pintarDesglose(q) {
    elQAvisos.hidden = true;
    if (!q) { elDesglose.hidden = true; elDesglose.innerHTML = ''; return; }
    var m = material();
    var maq = maquinaPorId(q.maquinaId);
    var t = q.tiempo || {};
    var partes = [];
    if (t.corteS) partes.push('corte ' + tiempo(t.corteS));
    if (t.marcadoS) partes.push('marcado ' + tiempo(t.marcadoS));
    if (t.grabadoS) partes.push('grabado ' + tiempo(t.grabadoS));
    if (t.perforacionS || t.trasladoS) partes.push('movimientos ' + tiempo((t.perforacionS || 0) + (t.trasladoS || 0)));

    var ne = q.nesting || {};
    var hojasTxt = ne.hojas ? ne.hojas + (ne.hojas === 1 ? ' hoja' : ' hojas') + ' de ' +
      num(ne.hojaAnchoMm / 10) + ' × ' + num(ne.hojaAltoMm / 10) + ' cm' : '';
    var aprov = ne.hojas ? ' · aprovechamiento ' + Math.round((ne.aprovechamiento || 0) * 100) + ' %' : '';
    var propio = chkPropio.checked;

    var html = '';
    html += fila('Tiempo de láser', partes.join(' · '), tiempo(t.totalS));
    html += fila('Máquina', (maq ? maq.nombre : '') + (!selMaquina.value && maq ? ' · la más conveniente' : ''), mxn(q.maquinaCentavos));
    html += fila('Material', nombreMaterial(m) + (hojasTxt ? ' · ' + (propio ? 'traes ' : '') + hojasTxt : '') + aprov,
                 propio ? 'Lo traes tú' : mxn(q.materialCentavos));
    html += fila('Preparación', 'Revisar el archivo y alistar la máquina', mxn(q.preparacionCentavos));
    if (q.urgenteCentavos || urgente()) html += fila('Entrega urgente', '', mxn(q.urgenteCentavos || 0));
    var suma = (q.maquinaCentavos || 0) + (q.materialCentavos || 0) + (q.preparacionCentavos || 0) + (q.urgenteCentavos || 0);
    var dif = (q.totalCentavos || 0) - suma;
    if (Math.abs(dif) >= 100) html += fila(dif > 0 ? 'Servicio, mínimo y redondeo' : 'Redondeo', '', mxn(dif));
    html += fila('Total', q.esEstimado ? 'Precio estimado' : '', mxn(q.totalCentavos), 'lz-desglose__total');
    html += fila('Entrega estimada', urgente() ? 'Urgente' : 'Estándar', fechaLarga(q.entregaEstimada));
    elDesglose.innerHTML = html;
    elDesglose.hidden = false;

    var avisos = (q.avisos || []).map(textoAviso);
    var sin = (ne.sinColocar || []).length;
    if (sin) avisos.push(sin + (sin === 1 ? ' pieza no cabe' : ' piezas no caben') + ' en la hoja de este material. Escríbenos por WhatsApp y lo resolvemos.');
    if (avisos.length) {
      elQAvisos.innerHTML = avisos.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
      elQAvisos.hidden = false;
    }
  }

  function enlaceWhatsApp() {
    var l = ['Hola, quiero cotizar un corte láser:', ''];
    listos().forEach(function (ar) {
      l.push('• ' + ar.nombre + ' · ' + ar.cantidad + ' pza · ' + num(ar.analisis.anchoMm) + ' × ' + num(ar.analisis.altoMm) + ' mm');
    });
    var m = material();
    if (m) l.push('', 'Material: ' + nombreMaterial(m) + (chkPropio.checked ? ' (lo llevo yo)' : ''));
    l.push('Entrega: ' + (urgente() ? 'urgente' : 'estándar'));
    if (estado.cotizacion) l.push('Estimado del sitio: ' + mxn(estado.cotizacion.totalCentavos));
    if (listos().length) l.push('', listos().length === 1 ? 'Enseguida te mando el archivo por aquí.' : 'Enseguida te mando los archivos por aquí.');
    return 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(listos().length ? l.join('\n') : 'Hola, quiero cotizar un corte láser.');
  }

  /* ================================================================ vistas */

  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { activarVista(t.getAttribute('data-vista')); });
    t.addEventListener('keydown', function (e) {
      var j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j == null) return;
      e.preventDefault();
      tabs[j].focus();
      activarVista(tabs[j].getAttribute('data-vista'));
    });
  });

  selArchivo.addEventListener('change', function () { seleccionar(parseInt(selArchivo.value, 10), false); });

  function activarVista(v) {
    estado.vista = v;
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-vista') === v;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    });
    cajaSelArchivo.hidden = v === 'hoja' || listos().length < 2;
    actualizarVistas();
  }

  function actualizarVistas() {
    var ls = listos();
    vistas.classList.toggle('is-hidden', !ls.length);
    if (!ls.length) return;
    if (!archivoSel()) estado.sel = ls[0].uid;
    selArchivo.innerHTML = ls.map(function (a) {
      return '<option value="' + a.uid + '"' + (a.uid === estado.sel ? ' selected' : '') + '>' + esc(a.nombre) + '</option>';
    }).join('');
    cajaSelArchivo.hidden = estado.vista === 'hoja' || ls.length < 2;
    if (estado.vista === '2d') dibujar2D();
    else if (estado.vista === '3d') mostrar3D();
    else dibujarHoja();
  }

  /* ------------------------------------------------------------ 2D */

  var barra2d = document.createElement('div');
  barra2d.className = 'visor-barra';
  var btnOriginal = document.createElement('button');
  btnOriginal.type = 'button';
  btnOriginal.className = 'visor-btn';
  btnOriginal.setAttribute('aria-pressed', 'false');
  btnOriginal.textContent = 'Ver archivo original';
  btnOriginal.addEventListener('click', function () { estado.original = !estado.original; dibujar2D(); });
  barra2d.appendChild(btnOriginal);
  lienzo2d.parentNode.insertBefore(barra2d, lienzo2d.nextSibling);

  function dibujar2D() {
    var ar = archivoSel();
    if (!ar) return;
    var a = ar.analisis;
    var m = material();
    btnOriginal.setAttribute('aria-pressed', String(estado.original));
    btnOriginal.classList.toggle('visor-btn--activo', estado.original);
    btnOriginal.hidden = !a.svgNormalizadoUrl;

    if (estado.original && a.svgNormalizadoUrl) {
      lienzo2d.innerHTML = '<img class="lz-original" alt="' + esc('Archivo ' + a.nombreOriginal + ' tal como lo leímos') +
        '" src="' + esc(urlApi(a.svgNormalizadoUrl)) + '">';
      nota2d.textContent = a.nombreOriginal + ' · ' + medidas(a.anchoMm, a.altoMm) + ' · archivo convertido, sin colores de operación';
      return;
    }

    var W = a.anchoMm || 1, H = a.altoMm || 1;
    var pad = Math.max(W, H) * 0.04 + 1;
    var fondo = m ? m.colorVista : '#e6d3bd';
    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + r2(-pad) + ' ' + r2(-pad) + ' ' + r2(W + 2 * pad) + ' ' + r2(H + 2 * pad) +
      '" role="img" aria-label="' + esc('Vista 2D de ' + a.nombreOriginal + ' con las operaciones elegidas') + '">';
    s += '<rect x="0" y="0" width="' + r2(W) + '" height="' + r2(H) + '" fill="' + esc(mezclar(fondo, '#ffffff', 0.45)) + '"/>';

    // En 2D la pieza va en un tono claro del material para que el grabado
    // (casi negro) se distinga también en materiales oscuros.
    var tonoPieza = esOscuro(fondo) ? mezclar(fondo, '#ffffff', 0.62) : fondo;
    (a.piezas || []).forEach(function (p) {
      s += '<path d="' + rutaPieza(p) + '" fill="' + esc(tonoPieza) + '" fill-rule="evenodd"/>';
    });

    (a.rasters || []).forEach(function (r) {
      s += '<image href="' + esc(urlApi(r.vistaUrl)) + '" x="' + r2(r.x) + '" y="' + r2(r.y) + '" width="' + r2(r.anchoMm) +
        '" height="' + r2(r.altoMm) + '" preserveAspectRatio="none" style="mix-blend-mode:multiply" opacity="' + (ar.grabarRasters ? 0.9 : 0.18) + '"/>';
    });

    var orden = { grabado: 0, ignorar: 1, marcado: 2, corte: 3 };
    (a.capas || []).slice().sort(function (x, y) {
      return orden[ar.operaciones[x.id]] - orden[ar.operaciones[y.id]];
    }).forEach(function (c) {
      var op = ar.operaciones[c.id] || c.operacionSugerida;
      var d = (c.polilineas || []).map(function (pl) { return rutaSvg(pl.puntos, pl.cerrada); }).join('');
      if (!d) return;
      var col = COLOR_OP[op];
      if (op === 'grabado' && c.tipo === 'relleno') {
        s += '<path d="' + d + '" fill="' + col + '" fill-opacity=".85" fill-rule="evenodd" stroke="none"/>';
      } else if (op === 'grabado') {
        s += '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-opacity=".85" stroke-width="2.2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>';
      } else if (op === 'ignorar') {
        s += '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1" stroke-dasharray="4 3" opacity=".75" vector-effect="non-scaling-stroke"/>';
      } else {
        s += '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="' + (op === 'corte' ? 1.6 : 1.2) +
          '" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>';
      }
    });
    s += '</svg>';
    lienzo2d.innerHTML = s;
    nota2d.textContent = a.nombreOriginal + ' · ' + medidas(a.anchoMm, a.altoMm) + (m ? ' · sobre ' + nombreMaterial(m) : '');
  }

  /* ------------------------------------------------------------ 3D */

  var tres = { promesa: null, T: null, renderer: null, escena: null, camara: null, controles: null, grupo: null, clave: '', radio: 100, fallo: false };

  function hayWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
  }

  function cargarThree() {
    if (!tres.promesa) {
      var url = new URL('vendor/three-0.186.0.min.js', SCRIPT_URL).href;
      try {
        // import() dentro de new Function: así este archivo sigue siendo un
        // script clásico que un navegador viejo puede leer sin error de sintaxis.
        tres.promesa = (new Function('u', 'return import(u)'))(url);
      } catch (e) {
        tres.promesa = Promise.reject(e);
      }
    }
    return tres.promesa;
  }

  function mensaje3D(t) {
    msg3d.textContent = t || '';
    msg3d.hidden = !t;
  }

  function mostrar3D() {
    var ar = archivoSel();
    if (!ar) return;
    if (tres.fallo) return;
    if (!hayWebGL()) {
      tres.fallo = true;
      mensaje3D('Tu navegador no puede mostrar la vista 3D (necesita WebGL). La cotización y las vistas 2D y de acomodo funcionan igual.');
      btnCentrar.hidden = true;
      return;
    }
    if (!tres.T) mensaje3D('Cargando la vista 3D…');
    cargarThree().then(function (T) {
      tres.T = T;
      if (!tres.renderer) iniciar3D();
      mensaje3D('');
      if (estado.vista !== '3d') return;
      construir3D();
    }).catch(function () {
      tres.fallo = true;
      mensaje3D('No pudimos cargar la vista 3D. La cotización y las vistas 2D y de acomodo funcionan igual.');
      btnCentrar.hidden = true;
    });
  }

  function iniciar3D() {
    var T = tres.T;
    var r = new T.WebGLRenderer({ canvas: canvas3d, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = T.SRGBColorSpace;
    tres.renderer = r;
    tres.escena = new T.Scene();
    tres.camara = new T.PerspectiveCamera(35, 1, 0.5, 100000);
    tres.escena.add(new T.HemisphereLight(0xffffff, 0x7d8590, 1.9));
    var sol = new T.DirectionalLight(0xffffff, 1.7);
    sol.position.set(0.6, 1, 0.8);
    tres.escena.add(sol);
    var relleno = new T.DirectionalLight(0xffffff, 0.5);
    relleno.position.set(-0.8, 0.4, -0.6);
    tres.escena.add(relleno);
    tres.controles = new T.OrbitControls(tres.camara, canvas3d);
    tres.controles.enableDamping = false;
    tres.controles.addEventListener('change', render3D);
    btnCentrar.addEventListener('click', encuadrar);

    function medir() {
      var w = cont3d.clientWidth, h = cont3d.clientHeight;
      if (!w || !h) return;
      r.setSize(w, h, false);
      tres.camara.aspect = w / h;
      tres.camara.updateProjectionMatrix();
      render3D();
    }
    if (window.ResizeObserver) new ResizeObserver(medir).observe(cont3d);
    else window.addEventListener('resize', medir);
    tres.medir = medir;
  }

  function render3D() {
    if (tres.renderer) tres.renderer.render(tres.escena, tres.camara);
  }

  function liberar(obj) {
    obj.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      var mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      mats.forEach(function (mt) { if (mt.map) mt.map.dispose(); mt.dispose(); });
    });
  }

  function construir3D() {
    var T = tres.T;
    var ar = archivoSel();
    var m = material();
    if (!ar || !T) return;
    var a = ar.analisis;
    var clave = ar.uid + '|' + (m ? m.id : '') + '|' + JSON.stringify(ar.operaciones) + '|' + ar.grabarRasters;
    tres.medir();
    if (clave === tres.clave) { render3D(); return; }
    tres.clave = clave;

    if (tres.grupo) { tres.escena.remove(tres.grupo); liberar(tres.grupo); }
    var grupo = new T.Group();
    tres.grupo = grupo;

    var espesor = (m && m.espesorMm) || 3;
    var colorMat = (m && m.colorVista) || '#c8a27a';
    var W = a.anchoMm || 1, H = a.altoMm || 1;
    var tex = texturaGrabado(T, ar, colorMat);

    var matCara = new T.MeshStandardMaterial({ color: new T.Color(colorMat), roughness: 0.85, metalness: 0 });
    var matCanto = new T.MeshStandardMaterial({ color: new T.Color(mezclar(colorMat, '#2a1a0c', 0.35)), roughness: 0.9, metalness: 0 });
    var matGrabado = new T.MeshStandardMaterial({
      map: tex, transparent: true, depthWrite: false, roughness: 0.95, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });

    var piezas = (a.piezas && a.piezas.length) ? a.piezas
      : [{ id: 'hoja', exterior: [[0, 0], [W, 0], [W, H], [0, H]], agujeros: [] }];

    piezas.forEach(function (p) {
      try {
        var forma = new T.Shape(p.exterior.map(function (q) { return new T.Vector2(q[0], -q[1]); }));
        (p.agujeros || []).forEach(function (h) {
          forma.holes.push(new T.Path(h.map(function (q) { return new T.Vector2(q[0], -q[1]); })));
        });
        var geo = new T.ExtrudeGeometry(forma, { depth: espesor, bevelEnabled: false, curveSegments: 1 });
        grupo.add(new T.Mesh(geo, [matCara, matCanto]));
        var tapa = new T.Mesh(new T.ShapeGeometry(forma), matGrabado);
        tapa.position.z = espesor + 0.01;
        grupo.add(tapa);
      } catch (e) { /* una pieza degenerada no tumba la vista */ }
    });

    grupo.rotation.x = -Math.PI / 2;        // la pieza acostada, cara grabada hacia arriba
    grupo.updateMatrixWorld(true);
    var caja = new T.Box3().setFromObject(grupo);
    var centro = caja.getCenter(new T.Vector3());
    grupo.position.set(-centro.x, -caja.min.y, -centro.z);
    tres.escena.add(grupo);
    var tam = caja.getSize(new T.Vector3());
    tres.radio = Math.max(tam.length() / 2, 5);
    tres.altura = tam.y;
    encuadrar();

    var extra = [];
    if (!(a.piezas && a.piezas.length)) extra.push('sin contorno de corte: se muestra el rectángulo del diseño');
    if (ar.cantidad > 1) extra.push('se muestra 1 de ' + ar.cantidad + ' copias');
    nota3d.textContent = (m ? nombreMaterial(m) : 'Material') + ' · ' + medidas(W, H) + (extra.length ? ' · ' + extra.join(' · ') : '');
  }

  function encuadrar() {
    if (!tres.camara) return;
    var R = tres.radio;
    var dist = R / Math.sin((tres.camara.fov * Math.PI / 180) / 2) * (tres.camara.aspect < 1 ? 1.35 / tres.camara.aspect : 1.1);
    tres.camara.near = Math.max(0.1, dist / 200);
    tres.camara.far = dist * 20;
    tres.camara.position.set(dist * 0.35, dist * 0.72, dist * 0.6);
    tres.camara.updateProjectionMatrix();
    tres.controles.target.set(0, (tres.altura || 0) / 2, 0);
    tres.controles.minDistance = R * 0.3;
    tres.controles.maxDistance = dist * 6;
    tres.controles.update();
    render3D();
  }

  /* La cara de arriba lleva una textura transparente con lo grabado (más
     oscuro que el material) y lo marcado (líneas finas). Las coordenadas UV
     de la tapa son (x, -y) en mm; repeat/offset las llevan a 0..1. */
  function texturaGrabado(T, ar, colorMat) {
    var a = ar.analisis;
    var W = a.anchoMm || 1, H = a.altoMm || 1;
    var esc2 = Math.min(2048 / Math.max(W, H), 24);
    var cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.ceil(W * esc2));
    cv.height = Math.max(2, Math.ceil(H * esc2));
    var ctx = cv.getContext('2d');
    ctx.setTransform(esc2, 0, 0, esc2, 0, 0);
    var claro = esOscuro(colorMat);
    var oscuro = claro ? mezclar(colorMat, '#ffffff', 0.5) : mezclar(colorMat, '#1a120b', 0.72);
    var linea = claro ? mezclar(colorMat, '#ffffff', 0.7) : mezclar(colorMat, '#000000', 0.82);

    function trazar(c) {
      ctx.beginPath();
      (c.polilineas || []).forEach(function (pl) {
        var p = pl.puntos;
        if (!p || !p.length) return;
        ctx.moveTo(p[0][0], p[0][1]);
        for (var i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
        if (pl.cerrada) ctx.closePath();
      });
    }

    var tex = new T.CanvasTexture(cv);
    tex.colorSpace = T.SRGBColorSpace;
    tex.repeat.set(1 / W, 1 / H);
    tex.offset.set(0, 1);
    tex.anisotropy = 4;

    if (ar.grabarRasters) {
      (a.rasters || []).forEach(function (r) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
          var rw = Math.max(1, Math.round(r.anchoMm * esc2)), rh = Math.max(1, Math.round(r.altoMm * esc2));
          var tmp = document.createElement('canvas');
          tmp.width = rw; tmp.height = rh;
          var tc = tmp.getContext('2d');
          tc.drawImage(img, 0, 0, rw, rh);
          var rgb = hexRgb(oscuro);
          try {
            var id = tc.getImageData(0, 0, rw, rh), d = id.data;
            for (var i = 0; i < d.length; i += 4) {
              var lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              d[i + 3] = (255 - lum) * (d[i + 3] / 255) * 0.92;
              d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
            }
            tc.putImageData(id, 0, 0);
            ctx.drawImage(tmp, r.x, r.y, r.anchoMm, r.altoMm);
          } catch (e) {
            ctx.globalAlpha = 0.55;
            ctx.globalCompositeOperation = 'multiply';
            ctx.drawImage(img, r.x, r.y, r.anchoMm, r.altoMm);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
          }
          tex.needsUpdate = true;
          render3D();
        };
        img.src = urlApi(r.vistaUrl);
      });
    }

    (a.capas || []).forEach(function (c) {
      var op = ar.operaciones[c.id] || c.operacionSugerida;
      if (op === 'grabado') {
        trazar(c);
        if (c.tipo === 'relleno') { ctx.fillStyle = oscuro; ctx.fill('evenodd'); }
        else { ctx.strokeStyle = oscuro; ctx.lineWidth = Math.max(0.6, 2 / esc2); ctx.lineJoin = 'round'; ctx.stroke(); }
      }
    });
    (a.capas || []).forEach(function (c) {
      if ((ar.operaciones[c.id] || c.operacionSugerida) !== 'marcado') return;
      trazar(c);
      ctx.strokeStyle = linea;
      ctx.lineWidth = Math.max(0.25, 1.4 / esc2);
      ctx.stroke();
    });
    tex.needsUpdate = true;
    return tex;
  }

  /* ------------------------------------------------------------ acomodo en hoja */

  function dibujarHoja() {
    var q = estado.cotizacion;
    cajaHojas.textContent = '';
    if (!q || !q.nesting || !q.nesting.hojas) {
      lienzoHoja.innerHTML = '<p class="lz-lienzo__msg">' + esc(
        estado.cotizando ? 'Calculando el acomodo…'
          : estado.errorCot ? 'No hay acomodo: ' + mensajeError(estado.errorCot, 'cotizar')
          : 'Aquí verás cómo se acomodan tus piezas en la hoja en cuanto esté la cotización.') + '</p>';
      notaHoja.textContent = '';
      return;
    }
    var n = q.nesting;
    if (estado.hoja >= n.hojas) estado.hoja = 0;

    if (n.hojas > 1) {
      for (var i = 0; i < n.hojas; i++) {
        (function (k) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'visor-btn' + (k === estado.hoja ? ' visor-btn--activo' : '');
          b.setAttribute('aria-pressed', String(k === estado.hoja));
          b.textContent = 'Hoja ' + (k + 1);
          b.addEventListener('click', function () {
            estado.hoja = k;
            dibujarHoja();
            var foco = cajaHojas.querySelectorAll('button')[k];
            if (foco) foco.focus();
          });
          cajaHojas.appendChild(b);
        })(i);
      }
    }

    var porArchivo = {}, indice = {};
    listos().forEach(function (ar, k) {
      porArchivo[ar.analisis.archivoId] = ar;
      indice[ar.analisis.archivoId] = k;
    });
    var m = material();
    var colorMat = m ? m.colorVista : '#e6d3bd';
    var W = n.hojaAnchoMm, H = n.hojaAltoMm;
    var pad = Math.max(W, H) * 0.02;

    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + r2(-pad) + ' ' + r2(-pad) + ' ' + r2(W + 2 * pad) + ' ' + r2(H + 2 * pad) +
      '" role="img" aria-label="' + esc('Acomodo de las piezas en la hoja ' + (estado.hoja + 1) + ' de ' + n.hojas) + '">';
    s += '<rect x="0" y="0" width="' + r2(W) + '" height="' + r2(H) + '" fill="' + esc(mezclar(colorMat, '#ffffff', 0.55)) +
      '" stroke="#9aa4b1" stroke-width="1" vector-effect="non-scaling-stroke"/>';

    var enHoja = 0;
    (n.colocaciones || []).forEach(function (c) {
      if (c.hoja !== estado.hoja) return;
      var ar = porArchivo[c.archivoId];
      if (!ar) return;
      var p = null;
      for (var j = 0; j < ar.analisis.piezas.length; j++) if (ar.analisis.piezas[j].id === c.piezaId) { p = ar.analisis.piezas[j]; break; }
      if (!p) return;
      enHoja++;
      var b = cajaDe(p.exterior);
      var rot = ((Math.round(c.rotacionGrados || 0) % 360) + 360) % 360;
      var giro = ROTACION_HORARIA ? rot : (360 - rot) % 360;
      // Tras girar alrededor de la esquina (0,0) de la caja, se corre para
      // que la caja girada vuelva a empezar en (0,0): (x, y) es su esquina.
      var tx = 0, ty = 0;
      if (giro === 90) tx = b.h;
      else if (giro === 180) { tx = b.w; ty = b.h; }
      else if (giro === 270) ty = b.w;
      var tono = PALETA_ARCHIVOS[indice[c.archivoId] % PALETA_ARCHIVOS.length];
      s += '<g transform="translate(' + r2(c.x + tx) + ' ' + r2(c.y + ty) + ') rotate(' + giro + ') translate(' + r2(-b.minX) + ' ' + r2(-b.minY) + ')">' +
        '<title>' + esc(ar.nombre + ' · copia ' + ((c.copia || 0) + 1)) + '</title>' +
        '<path d="' + rutaPieza(p) + '" fill="' + esc(mezclar(colorMat, tono, 0.28)) + '" fill-rule="evenodd" stroke="' +
        esc(mezclar(tono, '#000000', 0.2)) + '" stroke-width="1" vector-effect="non-scaling-stroke"/></g>';
    });
    s += '</svg>';
    lienzoHoja.innerHTML = s;

    var partes = ['Hoja ' + (estado.hoja + 1) + ' de ' + n.hojas, num(W) + ' × ' + num(H) + ' mm',
                  enHoja + (enHoja === 1 ? ' pieza' : ' piezas'),
                  'aprovechamiento ' + Math.round((n.aprovechamiento || 0) * 100) + ' %'];
    if (chkPropio.checked) partes.push('trae ' + n.hojas + (n.hojas === 1 ? ' hoja' : ' hojas') + ' de esta medida');
    if (n.sinColocar && n.sinColocar.length) partes.push(n.sinColocar.length + ' sin acomodar');
    notaHoja.textContent = partes.join(' · ');
  }

  /* ================================================================ pedido */

  var dialogo = $('[data-lz-dialogo]');
  var formPedido = $('[data-lz-pedido]');
  var avisoPedido = $('[data-lz-pedido-aviso]');
  var resumenPedido = $('[data-lz-pedido-resumen]');
  var introPedido = $('[data-lz-pedido-intro]');
  var btnConfirmar = $('[data-lz-confirmar]');

  function avisarPedido(t) {
    avisoPedido.textContent = t || '';
    avisoPedido.hidden = !t;
  }

  function telefonoLimpio(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length === 13 && d.indexOf('521') === 0) d = d.slice(3);
    else if (d.length === 12 && d.indexOf('52') === 0) d = d.slice(2);
    return d;
  }

  btnPedir.addEventListener('click', function () {
    var q = estado.cotizacion;
    if (!q) return;
    avisarPedido('');
    var m = material();
    introPedido.textContent = q.esEstimado
      ? 'Revisamos tus archivos y te confirmamos precio y fecha antes de cobrar. No cortamos nada sin tu autorización.'
      : 'Al enviar el pedido te damos el enlace para pagar y lo ponemos en la fila de corte.';
    resumenPedido.innerHTML =
      '<div><span>' + esc(listos().length + (listos().length === 1 ? ' archivo' : ' archivos')) + '</span><span>' +
        esc(nombreMaterial(m) + (chkPropio.checked ? ' (lo traes tú)' : '')) + '</span></div>' +
      '<div><span>Entrega ' + (urgente() ? 'urgente' : 'estándar') + '</span><span>' + esc(fechaLarga(q.entregaEstimada)) + '</span></div>' +
      '<div class="checkout__total"><span>' + (q.esEstimado ? 'Total estimado' : 'Total') + '</span><span>' + esc(mxn(q.totalCentavos)) + '</span></div>';
    var guardado = leerLS(DATOS_LS) || {};
    var f = formPedido.elements;
    if (!f.nombre.value && guardado.nombre) f.nombre.value = guardado.nombre;
    if (!f.correo.value && guardado.email) f.correo.value = guardado.email;
    if (!f.telefono.value && guardado.telefono) f.telefono.value = guardado.telefono;
    if (dialogo.showModal) dialogo.showModal(); else dialogo.setAttribute('open', '');
    f.nombre.focus();
  });

  function cerrarPedido() {
    if (dialogo.close) dialogo.close(); else dialogo.removeAttribute('open');
    btnPedir.focus();
  }
  $('[data-lz-cerrar]').addEventListener('click', cerrarPedido);
  dialogo.addEventListener('click', function (e) { if (e.target === dialogo) cerrarPedido(); });

  formPedido.elements.telefono.addEventListener('input', function () {
    formPedido.elements.telefono.removeAttribute('aria-invalid');
  });

  formPedido.addEventListener('submit', function (e) {
    e.preventDefault();
    avisarPedido('');
    var f = formPedido.elements;
    var nombre = f.nombre.value.trim(), correo = f.correo.value.trim();
    var tel = telefonoLimpio(f.telefono.value);
    if (nombre.length < 2) { avisarPedido('Escribe tu nombre.'); f.nombre.focus(); return; }
    if (!correo || !f.correo.checkValidity()) { avisarPedido('Revisa tu correo: ahí te mandamos la confirmación.'); f.correo.focus(); return; }
    if (tel.length !== 10) {
      f.telefono.setAttribute('aria-invalid', 'true');
      avisarPedido('El teléfono debe tener 10 dígitos, por ejemplo 55 1234 5678.');
      f.telefono.focus();
      return;
    }
    btnConfirmar.disabled = true;
    btnConfirmar.textContent = 'Enviando…';
    var guardado = leerLS(DATOS_LS) || {};
    guardado.nombre = nombre; guardado.email = correo; guardado.telefono = f.telefono.value.trim();
    guardarLS(DATOS_LS, guardado);

    pedirJSON('POST', '/trabajos', {
      cliente: { nombre: nombre, correo: correo, telefono: tel },
      solicitud: solicitud(),
      notas: f.notas.value.trim()
    }).then(function (r) {
      if (dialogo.close) dialogo.close(); else dialogo.removeAttribute('open');
      if (r.id) history.replaceState(null, '', location.pathname + '?trabajo=' + encodeURIComponent(r.id) + (MOCK ? '&mock=1' : ''));
      mostrarConfirmacion(r, true);
    }).catch(function (err) {
      avisarPedido(mensajeError(err, 'pedido'));
    }).then(function () {
      btnConfirmar.disabled = false;
      btnConfirmar.textContent = 'Enviar pedido';
    });
  });

  /* ================================================================ confirmación y estado */

  var ESTADOS = {
    recibido:    ['Pedido recibido', 'Recibimos tu pedido', 'Revisamos tus archivos y te confirmamos el precio antes de cobrar. Te escribimos por correo o WhatsApp.'],
    en_revision: ['En revisión', 'Estamos revisando tus archivos', 'En cuanto terminemos te mandamos el precio final y el enlace de pago.'],
    cotizado:    ['Listo para pagar', 'Tu cotización está lista', 'Te mandamos el enlace de pago por correo. En cuanto se acredite, programamos el corte.'],
    pagado:      ['Pagado', 'Recibimos tu pago', 'Tu trabajo entra a la fila de corte. Te avisamos cuando esté listo.'],
    en_cola:     ['En fila', 'Tu trabajo está en la fila de corte', 'Te avisamos por correo o WhatsApp en cuanto esté listo.'],
    cortando:    ['Cortando', 'Tu trabajo está en la máquina', 'Te avisamos en cuanto esté listo.'],
    listo:       ['Listo', 'Tu pedido está listo', 'Pasa por él al taller o escríbenos para coordinar el envío.'],
    entregado:   ['Entregado', 'Gracias por confiar en Emisha', 'Si necesitas otro corte, aquí estamos.'],
    cancelado:   ['Cancelado', 'Este pedido fue cancelado', 'Si fue un error o quieres pedirlo de nuevo, escríbenos por WhatsApp.']
  };

  function boton(texto, href, clase) {
    var a = document.createElement('a');
    a.className = clase;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = texto;
    return a;
  }

  function mostrarConfirmacion(d, recien) {
    var t = ESTADOS[d.estado] || ESTADOS.recibido;
    var q = d.cotizacion || null;
    var total = d.totalCentavos != null ? d.totalCentavos : (q ? q.totalCentavos : null);
    var fecha = d.fechaCompromiso || (q && q.entregaEstimada);
    var estimado = q ? q.esEstimado : (d.estado === 'recibido' || d.estado === 'en_revision');

    $('[data-conf-eyebrow]', conf).textContent = t[0];
    $('[data-conf-titulo]', conf).textContent = t[1];
    $('[data-conf-folio]', conf).textContent = d.folio ? 'Folio ' + d.folio : '';

    var datos = [['Estado', esc(t[0])]];
    if (fecha) datos.push([d.estado === 'entregado' ? 'Entrega' : 'Entrega estimada', esc(fechaLarga(fecha))]);
    if (total != null) datos.push(['Total', esc(mxn(total)) + (estimado ? ' <span class="muted">(estimado, lo confirmamos antes de cobrar)</span>' : '')]);
    datos.push(['Seguimiento', 'Guarda <a href="' + esc(location.href) + '">este enlace</a>: aquí ves el estado de tu pedido.']);
    $('[data-conf-datos]', conf).innerHTML = datos.map(function (p) {
      return '<div><dt>' + p[0] + '</dt><dd>' + p[1] + '</dd></div>';
    }).join('');

    var acciones = $('[data-conf-acciones]', conf);
    acciones.textContent = '';
    var pagable = d.pagoUrl && ['pagado', 'en_cola', 'cortando', 'listo', 'entregado', 'cancelado'].indexOf(d.estado) < 0;
    if (pagable) acciones.appendChild(boton('Pagar ahora', d.pagoUrl, 'btn btn--accent btn--lg'));
    acciones.appendChild(boton('WhatsApp', 'https://wa.me/' + WHATSAPP + '?text=' +
      encodeURIComponent('Hola, tengo el pedido de corte láser ' + (d.folio || '') + '.'), pagable ? 'btn btn--ghost btn--lg' : 'btn btn--primary btn--lg'));
    var otro = document.createElement('button');
    otro.type = 'button';
    otro.className = 'btn btn--ghost btn--lg';
    otro.textContent = 'Cotizar otro trabajo';
    otro.addEventListener('click', function () {
      history.replaceState(null, '', location.pathname + (MOCK ? '?mock=1' : ''));
      conf.hidden = true;
      herramienta.hidden = false;
      herramienta.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    acciones.appendChild(otro);

    $('[data-conf-nota]', conf).textContent =
      (recien ? 'Te mandamos la confirmación a tu correo (revisa también la carpeta de spam). ' : '') + t[2];

    herramienta.hidden = true;
    conf.hidden = false;
    if (recien) {
      conf.focus({ preventScroll: true });
      conf.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ================================================================ modo de prueba (?mock=1) */

  var mock = MOCK ? crearMock() : null;

  function crearMock() {
    var analisisPorId = {};
    var sig = 1;
    var rasterUrl = null;

    function circulo(cx, cy, r, n) {
      var p = [];
      for (var i = 0; i < n; i++) { var a = i / n * Math.PI * 2; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      return p;
    }
    function rectRedondo(x, y, w, h, r) {
      var p = [], esq = [[x + w - r, y + r, -90], [x + w - r, y + h - r, 0], [x + r, y + h - r, 90], [x + r, y + r, 180]];
      esq.forEach(function (c) {
        for (var i = 0; i <= 6; i++) {
          var a = (c[2] + i * 15) * Math.PI / 180;
          p.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
        }
      });
      return p;
    }
    function estrella(cx, cy, R, r) {
      var p = [];
      for (var i = 0; i < 10; i++) {
        var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R;
        p.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
      }
      return p;
    }
    function largo(pl) {
      var s = 0, p = pl.puntos, n = p.length;
      for (var i = 1; i < n; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      if (pl.cerrada && n > 1) s += Math.hypot(p[0][0] - p[n - 1][0], p[0][1] - p[n - 1][1]);
      return s;
    }
    function areaPol(p) {
      var s = 0;
      for (var i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
      return Math.abs(s / 2);
    }
    function capa(id, color, tipo, op, pols) {
      return {
        id: id, color: color, tipo: tipo, operacionSugerida: op, numRutas: pols.length,
        longitudMm: pols.reduce(function (s, pl) { return s + largo(pl); }, 0),
        areaMm2: tipo === 'relleno' ? pols.reduce(function (s, pl) { return s + areaPol(pl.puntos); }, 0) : 0,
        polilineas: pols
      };
    }
    function imagenRaster() {
      if (rasterUrl) return rasterUrl;
      var c = document.createElement('canvas');
      c.width = 132; c.height = 84;
      var x = c.getContext('2d');
      var g = x.createLinearGradient(0, 0, 132, 0);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#222222');
      x.fillStyle = g; x.fillRect(0, 0, 132, 84);
      x.fillStyle = '#000000';
      for (var i = 0; i < 6; i++) for (var j = 0; j < 4; j++) if ((i * 7 + j * 3) % 3 === 0) x.fillRect(8 + i * 20, 8 + j * 19, 12, 12);
      rasterUrl = c.toDataURL('image/png');
      return rasterUrl;
    }

    function analisis(nombre) {
      var id = 'mock-' + (sig++);
      var exterior = rectRedondo(0, 0, 120, 80, 6);
      var h1 = circulo(14, 40, 5, 32), h2 = circulo(106, 40, 5, 32);
      var logo = estrella(60, 34, 17, 7.5);
      var barra = [[42, 58], [78, 58], [78, 63], [42, 63]];
      var borde = rectRedondo(4, 4, 112, 72, 3);
      var capas = [
        capa('stroke-#ff0000', '#ff0000', 'trazo', 'corte', [
          { puntos: exterior, cerrada: true }, { puntos: h1, cerrada: true }, { puntos: h2, cerrada: true }]),
        capa('fill-#000000', '#000000', 'relleno', 'grabado', [
          { puntos: logo, cerrada: true }, { puntos: barra, cerrada: true }]),
        capa('stroke-#0000ff', '#0000ff', 'trazo', 'marcado', [{ puntos: borde, cerrada: true }])
      ];
      var raster = { id: 'r1', x: 84, y: 54, anchoMm: 20, altoMm: 13, dpi: 170, coberturaOscura: 0.42, vistaUrl: imagenRaster() };
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" width="120mm" height="80mm">' +
        '<rect width="120" height="80" fill="#fff"/>' +
        '<path d="' + rutaSvg(logo, true) + rutaSvg(barra, true) + '" fill="#000"/>' +
        '<path d="' + rutaSvg(borde, true) + '" fill="none" stroke="#0000ff" stroke-width=".3"/>' +
        '<path d="' + rutaSvg(exterior, true) + rutaSvg(h1, true) + rutaSvg(h2, true) + '" fill="none" stroke="#ff0000" stroke-width=".3"/>' +
        '<image href="' + raster.vistaUrl + '" x="84" y="54" width="20" height="13" preserveAspectRatio="none"/></svg>';
      var a = {
        archivoId: id, nombreOriginal: nombre, formato: 'svg', anchoMm: 120, altoMm: 80,
        capas: capas, rasters: [raster],
        piezas: [{ id: 'p1', exterior: exterior, agujeros: [h1, h2], anchoMm: 120, altoMm: 80,
                   areaMm2: areaPol(exterior) - areaPol(h1) - areaPol(h2) }],
        svgNormalizadoUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
        avisos: [
          { codigo: 'texto_sin_convertir', mensaje: '' },
          { codigo: 'raster_baja_resolucion', mensaje: 'La imagen está a 170 dpi: se grabará un poco borrosa. Lo ideal es 300 dpi.' }
        ]
      };
      analisisPorId[id] = a;
      return a;
    }

    var catalogo = {
      maquinas: [
        { id: 'm1', nombre: 'CO2 1390 150W', tipo: 'co2', potenciaW: 150, camaAnchoMm: 1300, camaAltoMm: 900 },
        { id: 'm2', nombre: 'Diodo 40W', tipo: 'diodo', potenciaW: 40, camaAnchoMm: 400, camaAltoMm: 400 }
      ],
      materiales: [
        { id: 'mdf-3', nombre: 'MDF', espesorMm: 3, hojaAnchoMm: 600, hojaAltoMm: 400, precioHojaCentavos: 8500, mermaPct: 0.05, colorVista: '#c8a27a', activo: true },
        { id: 'mdf-6', nombre: 'MDF', espesorMm: 6, hojaAnchoMm: 600, hojaAltoMm: 400, precioHojaCentavos: 14000, mermaPct: 0.05, colorVista: '#bf9468', activo: true },
        { id: 'tri-3', nombre: 'Triplay de pino', espesorMm: 3, hojaAnchoMm: 600, hojaAltoMm: 400, precioHojaCentavos: 12000, mermaPct: 0.08, colorVista: '#dcb98a', activo: true },
        { id: 'acr-3', nombre: 'Acrílico transparente', espesorMm: 3, hojaAnchoMm: 600, hojaAltoMm: 400, precioHojaCentavos: 26000, mermaPct: 0.05, colorVista: '#cfe6ee', activo: true },
        { id: 'acr-10', nombre: 'Acrílico transparente', espesorMm: 10, hojaAnchoMm: 600, hojaAltoMm: 400, precioHojaCentavos: 78000, mermaPct: 0.05, colorVista: '#bcdde8', activo: true },
        { id: 'acn-3', nombre: 'Acrílico negro', espesorMm: 3, hojaAnchoMm: 600, hojaAltoMm: 400, precioHojaCentavos: 28000, mermaPct: 0.05, colorVista: '#2e2f33', activo: true }
      ],
      ajustes: { diasEstandar: 3, diasUrgente: 1, urgentePct: 0.5, pagoAutomatico: false, whatsapp: WHATSAPP }
    };

    function rechazo(status, codigo, error) { return Promise.reject(errorApi(status, { error: error, codigo: codigo })); }
    function buscar(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }

    // Estantes simples; la hoja 2 va girada 90° para probar la rotación.
    function anidar(items, W, H) {
      var sep = 3, mar = 5, col = [], sin = [], hoja = 0, x = mar, y = mar, fila = 0, rot = 0, areaTot = 0;
      function cabe(d) { return d[0] <= W - 2 * mar && d[1] <= H - 2 * mar; }
      items.forEach(function (it) {
        var b = cajaDe(it.pieza.exterior);
        function dims(r) { return r % 180 ? [b.h, b.w] : [b.w, b.h]; }
        if (!cabe(dims(0)) && !cabe(dims(90))) { sin.push({ piezaId: it.pieza.id, archivoId: it.archivoId, motivo: 'No cabe en la hoja' }); return; }
        if (!cabe(dims(rot))) rot = rot ? 0 : 90;
        var d = dims(rot);
        if (x + d[0] > W - mar) { x = mar; y += fila + sep; fila = 0; }
        if (y + d[1] > H - mar) {
          hoja++; x = mar; y = mar; fila = 0;
          rot = hoja % 2 ? 90 : 0;
          if (!cabe(dims(rot))) rot = rot ? 0 : 90;
          d = dims(rot);
        }
        col.push({ piezaId: it.pieza.id, archivoId: it.archivoId, copia: it.copia, hoja: hoja, x: x, y: y, rotacionGrados: rot });
        x += d[0] + sep; fila = Math.max(fila, d[1]); areaTot += it.pieza.areaMm2;
      });
      var hojas = col.length ? hoja + 1 : 0;
      return { hojaAnchoMm: W, hojaAltoMm: H, hojas: hojas, colocaciones: col,
               aprovechamiento: hojas ? areaTot / (hojas * W * H) : 0, sinColocar: sin };
    }

    function cotizar(sol) {
      var mat = buscar(catalogo.materiales, sol.materialId);
      if (!mat) return rechazo(422, 'sin_material', 'Material inexistente');
      if (mat.id === 'acr-10') return rechazo(422, 'sin_maquina', 'Sin parámetros para acrílico de 10 mm');
      var t = { corteS: 0, marcadoS: 0, grabadoS: 0, perforacionS: 0, trasladoS: 0, totalS: 0 };
      var items = [];
      sol.lineas.forEach(function (l) {
        var a = analisisPorId[l.archivoId];
        if (!a) return;
        var n = Math.max(1, l.cantidad | 0);
        a.capas.forEach(function (c) {
          var op = l.operaciones[c.id] || c.operacionSugerida;
          if (op === 'corte') { t.corteS += c.longitudMm / 18 * (mat.espesorMm / 3) * n; t.perforacionS += c.numRutas * 0.4 * n; }
          else if (op === 'marcado') t.marcadoS += c.longitudMm / 80 * n;
          else if (op === 'grabado') t.grabadoS += (c.tipo === 'relleno' ? c.areaMm2 : c.longitudMm * 0.4) / 30 * n;
        });
        if (l.grabarRasters) a.rasters.forEach(function (r) { t.grabadoS += r.anchoMm * r.altoMm * r.coberturaOscura / 30 * n; });
        a.piezas.forEach(function (p) { for (var i = 0; i < n; i++) items.push({ pieza: p, archivoId: a.archivoId, copia: i }); });
      });
      t.trasladoS = (t.corteS + t.marcadoS) * 0.15;
      var base = t.corteS + t.marcadoS + t.grabadoS + t.perforacionS + t.trasladoS;

      var opciones = catalogo.maquinas.filter(function (m) {
        if (sol.maquinaId && m.id !== sol.maquinaId) return false;
        return m.id === 'm1' || ((mat.nombre === 'MDF' || mat.nombre === 'Triplay de pino') && mat.espesorMm <= 3);
      }).map(function (m) {
        var f = m.id === 'm1' ? 1 : 2.4, tarifa = m.id === 'm1' ? 1215 : 540;
        return { m: m, f: f, costo: Math.round(base * f / 60 * tarifa) };
      }).sort(function (a, b) { return a.costo - b.costo; });
      if (!opciones.length) return rechazo(422, 'sin_maquina', 'Ninguna máquina puede con ese material');
      var elegida = opciones[0];

      var nesting = anidar(items, mat.hojaAnchoMm, mat.hojaAltoMm);
      if (items.length && !nesting.colocaciones.length) return rechazo(422, 'no_cabe', 'Las piezas no caben en la hoja');
      var materialC = sol.materialDelCliente ? 0 : Math.round(nesting.hojas * mat.precioHojaCentavos * (1 + mat.mermaPct) * 1.35);
      var prep = 6750;
      var urg = sol.urgente ? Math.round((elegida.costo + materialC + prep) * 0.5) : 0;
      var total = Math.max(15000, Math.round((elegida.costo + materialC + prep + urg) / 100) * 100);
      ['corteS', 'marcadoS', 'grabadoS', 'perforacionS', 'trasladoS'].forEach(function (k) { t[k] = Math.round(t[k] * elegida.f); });
      t.totalS = t.corteS + t.marcadoS + t.grabadoS + t.perforacionS + t.trasladoS;
      var entrega = sumarDiasHabiles(new Date(), sol.urgente ? catalogo.ajustes.diasUrgente : catalogo.ajustes.diasEstandar);
      return Promise.resolve({
        maquinaId: elegida.m.id, materialId: mat.id, tiempo: t, nesting: nesting,
        maquinaCentavos: elegida.costo, materialCentavos: materialC, preparacionCentavos: prep, urgenteCentavos: urg,
        totalCentavos: total, entregaEstimada: entrega.toISOString().slice(0, 10), avisos: [], esEstimado: true
      });
    }

    function uuid() {
      return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, function () { return (Math.random() * 16 | 0).toString(16); });
    }

    function pedir(metodo, ruta, cuerpo) {
      return new Promise(function (ok) { setTimeout(ok, 250); }).then(function () {
        if (metodo === 'GET' && ruta === '/catalogo') return JSON.parse(JSON.stringify(catalogo));
        if (metodo === 'POST' && ruta === '/cotizar') return cotizar(cuerpo);
        if (metodo === 'POST' && ruta === '/trabajos') {
          if (!cuerpo.cliente || !cuerpo.cliente.nombre) return rechazo(400, 'datos', 'Falta el nombre');
          return cotizar(cuerpo.solicitud).then(function (q) {
            // pagoUrl solo para ver el botón en pruebas (el real llega si ajustes.pagoAutomatico).
            return { id: uuid(), folio: 'L-2609-0042', estado: 'recibido', cotizacion: q, pagoUrl: 'https://www.emisha.com.mx/?pago-de-prueba' };
          });
        }
        var m = /^\/trabajos\/([0-9a-f-]{36})$/.exec(ruta);
        if (metodo === 'GET' && m) {
          return { folio: 'L-2609-0042', estado: 'cotizado', fechaCompromiso: sumarDiasHabiles(new Date(), 3).toISOString(),
                   pagoUrl: 'https://www.emisha.com.mx/?pago-de-prueba', totalCentavos: 45600 };
        }
        return rechazo(404, 'no_encontrado', 'No existe');
      });
    }

    function subir(ar) {
      return new Promise(function (ok) {
        var f = 0;
        (function paso() {
          f = Math.min(1, f + 0.2);
          progreso(ar, f);
          if (f < 1) { ar.mockTimer = setTimeout(paso, 120); return; }
          ar.mockTimer = setTimeout(function () { ok(analisis(ar.nombre)); }, 500);
        })();
      });
    }

    return { pedir: pedir, subir: subir };
  }

  /* ================================================================ arranque */

  activarVista('2d');
  pintarResultado();
  var idTrabajo = PARAMS.get('trabajo');
  var cargaCatalogo = cargarCatalogo();

  if (MOCK) avisar('Modo de prueba: datos ficticios, no se sube nada ni se crea ningún pedido de verdad.');

  if (idTrabajo && /^[0-9a-f-]{36}$/i.test(idTrabajo)) {
    herramienta.hidden = true;
    pedirJSON('GET', '/trabajos/' + encodeURIComponent(idTrabajo)).then(function (d) {
      mostrarConfirmacion(d, false);
    }).catch(function (e) {
      herramienta.hidden = false;
      history.replaceState(null, '', location.pathname + (MOCK ? '?mock=1' : ''));
      avisar(e && e.status === 404
        ? 'No encontramos ese pedido. Revisa el enlace de tu correo o escríbenos por WhatsApp con tu folio.'
        : 'No pudimos consultar tu pedido ahorita. Inténtalo en un momento o escríbenos por WhatsApp con tu folio.');
    });
  } else if (MOCK) {
    cargaCatalogo.then(function () {
      try { agregar([new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'placa-logo.svg', { type: 'image/svg+xml' })], { cantidad: 20 }); }
      catch (e) { /* navegador sin constructor File */ }
    });
  }
})();
