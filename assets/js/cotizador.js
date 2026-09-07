/* ==========================================================================
   Emisha — cotizador de impresión 3D
   Lee archivos STL y 3MF en el navegador, calcula el volumen real de la malla
   y estima el precio. Los archivos NUNCA se suben a ningún servidor.

   Si la pieza (o el tamaño final que pida el cliente) no cabe en la cama,
   el cotizador la corta solo, en una cuadrícula de secciones imprimibles,
   las enseña separadas en el visor 3D y suma el ensamble al estimado.
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     CONFIGURACIÓN DE PRECIOS — ajustar aquí y en ningún otro lado.
     Los valores de abajo son un punto de partida, no precios definitivos.
     ====================================================================== */
  var CONFIG = {
    materiales: {
      pla:  { nombre: 'PLA',  densidad: 1.24, precioKg: 300 },
      petg: { nombre: 'PETG', densidad: 1.27, precioKg: 300 }
    },
    /* Material realmente depositado = cascarón + relleno. Cuando se conoce
       el área superficial de la malla, el cascarón se calcula de verdad
       (área × paredMm): una pieza chica y delgada es casi pura pared y una
       grande es casi puro relleno. fraccionSolida queda de respaldo para
       cuando solo hay volumen. */
    paredMm: 1.2,              // espesor efectivo: perímetros + tapas
    fraccionSolida: function (relleno) { return 0.25 + 0.75 * relleno; },
    /* Imprimir con varios colores purga material en cada cambio (torre y
       flush del AMS): fracción extra de material por cada color adicional. */
    purgaPorColor: 0.08,
    velocidadCm3PorHora: 12,   // ritmo típico con boquilla de 0.4 mm
    tarifaHora: 90,            // MXN por hora de máquina
    margen: 1.35,               // sobre material + máquina
    preparacionPorArchivo: 35,  // MXN, una sola vez por modelo: revisarlo y prepararlo
    alistadoPorCama: 45,        // MXN, por cada cama que hay que montar y desmontar
    ensamblePorPieza: 25,       // MXN, por cada sección extra al cortar: pegar y acabar la unión
    minimoPorPieza: 80,         // MXN, cobro mínimo
    camaMm: 256,                // Bambu Lab A1 / P1S / X1: 256 mm por lado
    alturaMm: 256,              // altura útil
    separacionMm: 6,            // hueco entre piezas al acomodarlas en la cama
    margenCorteMm: 4,           // holgura al cortar: ninguna sección llega al borde de la cama
    tamanoMaxMm: 2000           // tope del tamaño final que se puede pedir
  };

  // Número de WhatsApp en formato internacional, sin + ni espacios.
  var WHATSAPP = '525575639255';

  var $  = function (s, r) { return (r || document).querySelector(s); };
  var fmt = function (n) {
    return '$' + Math.round(n).toLocaleString('es-MX') + ' MXN';
  };
  var fmtPeso = function (g) {
    return g >= 1000 ? (g / 1000).toFixed(g >= 10000 ? 0 : 1) + ' kg'
                     : g.toFixed(0) + ' g';
  };

  /* ============================================================== STL === */
  function parseSTL(buffer) {
    var dv = new DataView(buffer);
    if (buffer.byteLength >= 84) {
      var n = dv.getUint32(80, true);
      if (84 + n * 50 === buffer.byteLength) return parseBinarySTL(dv, n);
    }
    return parseAsciiSTL(new TextDecoder().decode(buffer));
  }

  function parseBinarySTL(dv, n) {
    var tri = new Float32Array(n * 9), o = 84, k = 0;
    for (var i = 0; i < n; i++) {
      o += 12;                                   // la normal no se usa
      for (var j = 0; j < 9; j++) { tri[k++] = dv.getFloat32(o, true); o += 4; }
      o += 2;                                    // atributo
    }
    return tri;
  }

  function parseAsciiSTL(text) {
    var re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
    var out = [], m;
    while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
    if (out.length < 9) throw new Error('El archivo STL no contiene triángulos legibles.');
    return new Float32Array(out);
  }

  /* ============================================================== ZIP === */
  /* 3MF es un ZIP. Se localiza 3D/3dmodel.model y se descomprime con la
     API DecompressionStream del navegador — sin librerías externas.        */
  function readZipEntries(buffer) {
    var dv = new DataView(buffer), len = buffer.byteLength;
    var eocd = -1, max = Math.min(len - 22, 65557);
    for (var i = len - 22; i >= len - 22 - max && i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('El archivo 3MF está dañado (no es un ZIP válido).');

    var count = dv.getUint16(eocd + 10, true);
    var off   = dv.getUint32(eocd + 16, true);
    var dec = new TextDecoder(), entries = [];
    for (var e = 0; e < count; e++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      var fnLen = dv.getUint16(off + 28, true);
      var exLen = dv.getUint16(off + 30, true);
      var cmLen = dv.getUint16(off + 32, true);
      entries.push({
        name:   dec.decode(new Uint8Array(buffer, off + 46, fnLen)),
        method: dv.getUint16(off + 10, true),
        cSize:  dv.getUint32(off + 20, true),
        local:  dv.getUint32(off + 42, true)
      });
      off += 46 + fnLen + exLen + cmLen;
    }
    return entries;
  }

  async function inflateEntry(buffer, entry) {
    var dv = new DataView(buffer);
    if (dv.getUint32(entry.local, true) !== 0x04034b50) {
      throw new Error('El archivo 3MF tiene una entrada corrupta.');
    }
    var fnLen = dv.getUint16(entry.local + 26, true);
    var exLen = dv.getUint16(entry.local + 28, true);
    var start = entry.local + 30 + fnLen + exLen;
    var raw   = new Uint8Array(buffer, start, entry.cSize);

    if (entry.method === 0) return new TextDecoder().decode(raw);
    if (entry.method !== 8) throw new Error('El 3MF usa una compresión no soportada.');
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Este navegador no puede leer 3MF. Prueba con un archivo STL.');
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([raw]).stream().pipeThrough(ds);
    return await new Response(stream).text();
  }

  /* ============================================================== 3MF === */
  var UNIDADES = { micron: 0.001, millimeter: 1, centimeter: 10,
                   inch: 25.4, foot: 304.8, meter: 1000 };

  /* --- matrices de 3MF -------------------------------------------------
     El atributo transform trae 12 números en orden fila-mayor: las tres
     primeras filas son la rotación/escala y la última la traslación.     */
  var IDENTIDAD = [1,0,0, 0,1,0, 0,0,1, 0,0,0];

  function leerMatriz(s) {
    if (!s) return IDENTIDAD.slice();
    var v = s.trim().split(/\s+/).map(Number);
    return (v.length === 12 && v.every(function (n) { return isFinite(n); }))
      ? v : IDENTIDAD.slice();
  }

  // Componer: aplicar "a" y después "b".
  function componer(a, b) {
    var r = new Array(12), i, j;
    for (i = 0; i < 3; i++)
      for (j = 0; j < 3; j++)
        r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    for (j = 0; j < 3; j++)
      r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
    return r;
  }

  var NS_PRODUCCION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

  /* Pintura multicolor por triángulo (atributo paint_color de Bambu/Orca,
     mmu_segmentation en Prusa). El código es un flujo de bits guardado en
     nibbles que se leen desde el FINAL de la cadena: 2 bits de "¿dividido?"
     (0 = triángulo uniforme) y 2 bits de estado; el estado 3 significa que
     el número real viene en el siguiente nibble (estado = 3 + ese valor).
     Estado k = pintado con el filamento k; 0 = sin pintar. Un triángulo
     subdividido (pintado a medias) codifica un árbol largo: se devuelve -1
     y conserva el color base — es solo la costura del pintado.            */
  function estadoDePintura(s) {
    if (!s) return 0;
    var nib = parseInt(s.charAt(s.length - 1), 16);
    if (!isFinite(nib) || (nib & 3) !== 0) return -1;   // raíz dividida
    var estado = (nib >> 2) & 3;
    if (estado < 3) return s.length === 1 ? estado : -1;
    if (s.length !== 2) return -1;
    var ext = parseInt(s.charAt(0), 16);
    return isFinite(ext) ? 3 + ext : -1;
  }

  function rutaDeComponente(comp) {
    return comp.getAttributeNS(NS_PRODUCCION, 'path') || comp.getAttribute('p:path') || '';
  }

  /* Creality Print escribe atributos con el prefijo p: (p:path, p:UUID) pero
     nunca declara xmlns:p. Para un parser de XML eso es un error fatal y el
     modelo entero se pierde. Se inyecta la declaración que falta y se vuelve
     a intentar; si el XML estaba mal por otra razón, se devuelve null.      */
  function repararPrefijoP(xml) {
    if (/xmlns:p\s*=/.test(xml)) return null;     // ya está declarado
    if (!/\sp:[A-Za-z_]/.test(xml)) return null;  // no usa el prefijo
    var m = /<model\b/.exec(xml);
    if (!m) return null;
    var corte = m.index + m[0].length;
    return xml.slice(0, corte) + ' xmlns:p="' + NS_PRODUCCION + '"' + xml.slice(corte);
  }

  /* Bambu Studio y PrusaSlicer usan la extensión "production" de 3MF: el
     archivo 3D/3dmodel.model no trae ni un solo vértice, solo <component>
     que apuntan a 3D/Objects/object_N.model dentro del mismo ZIP. Hay que
     seguir esas referencias y componer las transformaciones; si no, el
     modelo se ve vacío. Un mismo objeto puede aparecer varias veces con
     distinta transformación y cada copia cuenta.                          */
  async function parse3MF(buffer) {
    var entries = readZipEntries(buffer);

    function normalizar(p) { return String(p || '').replace(/^\/+/, '').toLowerCase(); }

    var raiz = entries.filter(function (e) { return /3dmodel\.model$/i.test(e.name); })[0]
            || entries.filter(function (e) { return /\.model$/i.test(e.name); })[0];
    if (!raiz) throw new Error('El 3MF no contiene un modelo 3D.');

    var cache = {};
    var mallaCache = {};        // ruta#objectid -> malla sin transformar
    var triangulosVistos = 0;
    /* Tope de seguridad. Cada triángulo retenido cuesta 72 bytes, así que
       12 millones son ~865 MB: pesado pero sobrevivible. El archivo legítimo
       más grande que hemos medido trae 6.9 millones, o sea que queda margen.
       Sin este tope, un proyecto que repite la misma malla 200 veces pide
       decenas de GB y la pestaña muere en silencio, sin ningún aviso.        */
    var MAX_TRIANGULOS = 12000000;

    async function cargar(ruta) {
      var clave = normalizar(ruta);
      if (cache[clave]) return cache[clave];
      var e = entries.filter(function (x) { return normalizar(x.name) === clave; })[0];
      if (!e) return (cache[clave] = null);
      var xml = await inflateEntry(buffer, e);
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.querySelector('parsererror')) {
        var arreglado = repararPrefijoP(xml);
        if (arreglado) doc = new DOMParser().parseFromString(arreglado, 'application/xml');
      }
      if (doc.querySelector('parsererror')) return (cache[clave] = null);
      var objs = {};
      Array.prototype.forEach.call(doc.getElementsByTagName('object'), function (o) {
        objs[o.getAttribute('id')] = o;
      });
      return (cache[clave] = {
        doc: doc,
        objs: objs,
        escala: UNIDADES[(doc.documentElement.getAttribute('unit') || 'millimeter').toLowerCase()] || 1
      });
    }

    var trozos = [];

    async function acumular(ruta, objectId, mat, profundidad) {
      if (profundidad > 12) return;              // corta referencias circulares
      var mod = await cargar(ruta);
      if (!mod) return;
      var obj = mod.objs[objectId];
      if (!obj) return;
      var esc = mod.escala;

      var mesh = obj.getElementsByTagName('mesh')[0];
      if (mesh) {
        /* La malla se lee del DOM UNA sola vez por objeto y se guarda sin
           transformar. Un proyecto puede referenciar el mismo objeto cientos
           de veces; volver a recorrer el DOM en cada copia costaba segundos
           por instancia y llenaba la memoria hasta tumbar la pestaña.        */
        var clave = normalizar(ruta) + '#' + objectId;
        var base = mallaCache[clave];
        if (base === undefined) {
          base = null;
          var vs = mesh.getElementsByTagName('vertex');
          var ts = mesh.getElementsByTagName('triangle');
          if (vs.length && ts.length) {
            var verts = new Float64Array(vs.length * 3), i;
            for (i = 0; i < vs.length; i++) {
              verts[i * 3]     = parseFloat(vs[i].getAttribute('x')) * esc;
              verts[i * 3 + 1] = parseFloat(vs[i].getAttribute('y')) * esc;
              verts[i * 3 + 2] = parseFloat(vs[i].getAttribute('z')) * esc;
            }
            var triBase = new Float64Array(ts.length * 9);
            var pintura = null;
            var k = 0;
            for (var t = 0; t < ts.length; t++) {
              var idx = [ts[t].getAttribute('v1'), ts[t].getAttribute('v2'), ts[t].getAttribute('v3')];
              for (var n = 0; n < 3; n++) {
                var b = (+idx[n]) * 3;
                triBase[k++] = verts[b]; triBase[k++] = verts[b + 1]; triBase[k++] = verts[b + 2];
              }
              var pc = ts[t].getAttribute('paint_color') ||
                       ts[t].getAttribute('slic3r:mmu_segmentation');
              if (pc) {
                if (!pintura) pintura = new Int16Array(ts.length);
                pintura[t] = estadoDePintura(pc);
              }
            }
            base = { tri: triBase, pintura: pintura };
          }
          mallaCache[clave] = base;
        }

        if (base) {
          triangulosVistos += base.tri.length / 9;
          if (triangulosVistos > MAX_TRIANGULOS) {
            throw new Error('El modelo es demasiado pesado para medirlo en el navegador. '
                          + 'Mándanoslo por WhatsApp y lo cotizamos nosotros.');
          }
          var tri = new Float64Array(base.tri.length);
          for (var v = 0; v < base.tri.length; v += 3) {
            var x = base.tri[v], y = base.tri[v + 1], z = base.tri[v + 2];
            tri[v]     = x * mat[0] + y * mat[3] + z * mat[6] + mat[9];
            tri[v + 1] = x * mat[1] + y * mat[4] + z * mat[7] + mat[10];
            tri[v + 2] = x * mat[2] + y * mat[5] + z * mat[8] + mat[11];
          }
          /* Se recuerda de qué objeto salió cada trozo: en Bambu las partes
             de un objeto multicolor son sub-objetos con su propio extrusor,
             y ese id es el que después decide el color de este trozo. La
             pintura por triángulo (si la hay) viaja junto y es compartida
             entre todas las instancias del mismo objeto. */
          trozos.push({ tri: tri, idMalla: objectId, pintura: base.pintura });
        }
      }

      var comps = obj.getElementsByTagName('component');
      for (var c = 0; c < comps.length; c++) {
        var destino = rutaDeComponente(comps[c]) || ruta;
        await acumular(destino,
                       comps[c].getAttribute('objectid'),
                       componer(leerMatriz(comps[c].getAttribute('transform')), mat),
                       profundidad + 1);
      }
    }

    var modRaiz = await cargar(raiz.name);
    if (!modRaiz) throw new Error('El modelo dentro del 3MF no se pudo leer.');

    /* <build> dice qué objetos se imprimen y con qué transformación. Se usa
       el documento que ya quedó en caché: volver a descomprimir y a parsear
       la raíz cuesta el doble y, si el XML necesitó reparación, la segunda
       lectura se quedaría sin ella.                                        */
    var items = modRaiz.doc.getElementsByTagName('item');

    /* Cada <item> del build es una pieza que se imprime por separado —en un
       proyecto de Bambu con varias placas, todas vienen aquí, desplazadas en
       X/Y. Las medimos una por una para poder mostrar el desglose y para
       saber cuántas caben en una cama.                                      */
    var partes = [];

    function cerrarParte(objectId) {
      if (!trozos.length) return;
      var v = 0, len = 0, z;
      for (z = 0; z < trozos.length; z++) {
        v += volumenDeMalla(trozos[z].tri);
        len += trozos[z].tri.length;
      }
      var m = new Float64Array(len), pos = 0, rangos = [];
      for (z = 0; z < trozos.length; z++) {
        var tz = trozos[z];
        if (!tz.pintura) {
          m.set(tz.tri, pos);
          rangos.push({ ini: pos, fin: pos + tz.tri.length,
                        idMalla: tz.idMalla, pintado: 0, color: null });
          pos += tz.tri.length;
          continue;
        }
        /* Malla pintada: los triángulos se reordenan agrupados por color
           para que cada grupo sea un tramo continuo del búfer y el visor
           lo pinte de un jalón. El volumen no depende del orden. */
        var grupos = {}, t, e;
        for (t = 0; t < tz.pintura.length; t++) {
          e = tz.pintura[t];
          (grupos[e] || (grupos[e] = [])).push(t);
        }
        for (e in grupos) {
          var lista = grupos[e], ini = pos;
          for (t = 0; t < lista.length; t++) {
            var o = lista[t] * 9;
            for (var c9 = 0; c9 < 9; c9++) m[pos + c9] = tz.tri[o + c9];
            pos += 9;
          }
          rangos.push({ ini: ini, fin: pos, idMalla: tz.idMalla,
                        pintado: +e > 0 ? +e : 0, color: null });
        }
      }
      /* La caja sale de la malla completa de la parte, no de la unión de
         las cajas de sus componentes: dos componentes separados miden lo
         que abarcan juntos, no lo que mide el mayor. Los límites absolutos
         se guardan para poder pintar la cama debajo de cada placa.        */
      var lim = limitesDeMalla(m);
      partes.push({
        volumenMm3: Math.abs(v),
        caja: [lim.max[0] - lim.min[0], lim.max[1] - lim.min[1], lim.max[2] - lim.min[2]],
        limites: lim, malla: m, rangos: rangos,
        objectId: objectId || null, color: null, placa: null
      });
      trozos = [];
    }

    for (var i = 0; i < items.length; i++) {
      await acumular(raiz.name,
                     items[i].getAttribute('objectid'),
                     leerMatriz(items[i].getAttribute('transform')),
                     0);
      cerrarParte(items[i].getAttribute('objectid'));
    }

    // Sin <build> utilizable, medimos todos los objetos de la raíz.
    if (!partes.length) {
      var ids = Object.keys(modRaiz.objs);
      for (var j = 0; j < ids.length; j++) {
        await acumular(raiz.name, ids[j], IDENTIDAD.slice(), 0);
        cerrarParte(ids[j]);
      }
    }

    var volumen = 0, caja = null, numTri = 0;
    for (var q = 0; q < partes.length; q++) {
      volumen += partes[q].volumenMm3;
      caja = unirCaja(caja, partes[q].caja);
      numTri += partes[q].malla.length;
    }

    if (!volumen) throw new Error('El 3MF no contiene geometría medible.');

    var bambu = await leerMetadatosBambu(buffer, entries, normalizar, partes);

    /* Una sola malla continua para el visor y para el corte automático. */
    var malla = new Float64Array(numTri), pos = 0;
    for (var m = 0; m < partes.length; m++) {
      malla.set(partes[m].malla, pos);
      pos += partes[m].malla.length;
    }

    return { volumenMm3: volumen, caja: caja, partes: partes, malla: malla,
             placas: bambu.placas, gramosSlicer: bambu.gramos,
             horasSlicer: bambu.horas };
  }

  /* Metadatos de Bambu Studio / Orca, si vienen. La paleta de filamentos
     está en Metadata/project_settings.config (JSON), en
     Metadata/model_settings.config (XML) van el extrusor de cada objeto y
     el reparto de objetos en placas (<plate> con plater_id y sus
     <model_instance>), y si el proyecto se guardó ya laminado,
     Metadata/slice_info.config trae por placa el peso real en gramos
     (weight) y el tiempo estimado en segundos (prediction) que calculó el
     propio laminador — el mejor dato posible, purga incluida. Todo es
     opcional: un STL o un 3MF genérico no lo traen, el visor pinta gris y
     material y camas se estiman por geometría. Nada de aquí puede tumbar
     la cotización. Devuelve {placas, gramos, horas} con ceros en lo que
     el archivo no traiga.                                               */
  function hexARgb(h) {
    var m = /^#?([0-9a-f]{6})/i.exec(String(h || ''));
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  async function leerMetadatosBambu(buffer, entries, normalizar, partes) {
    var res = { placas: 0, gramos: 0, horas: 0 };

    function entrada(nombre) {
      return entries.filter(function (x) { return normalizar(x.name) === nombre; })[0];
    }

    /* --- lo que ya midió el laminador -------------------------------- */
    try {
      var sli = entrada('metadata/slice_info.config');
      if (sli) {
        var docS = new DOMParser().parseFromString(
          await inflateEntry(buffer, sli), 'application/xml');
        if (!docS.querySelector('parsererror')) {
          var pls = docS.getElementsByTagName('plate');
          var g = 0, seg = 0;
          for (var sp = 0; sp < pls.length; sp++) {
            var mdsS = pls[sp].getElementsByTagName('metadata');
            for (var sy = 0; sy < mdsS.length; sy++) {
              var kS = mdsS[sy].getAttribute('key');
              var vS = parseFloat(mdsS[sy].getAttribute('value'));
              if (kS === 'weight' && isFinite(vS)) g += vS;
              else if (kS === 'prediction' && isFinite(vS)) seg += vS;
            }
          }
          if (g > 0) res.gramos = g;
          if (seg > 0) res.horas = seg / 3600;
          if (pls.length) res.placas = pls.length;
        }
      }
    } catch (e) { /* metadatos opcionales */ }

    try {
      var mset = entrada('metadata/model_settings.config');
      if (!mset) return res;

      var doc = new DOMParser().parseFromString(
        await inflateEntry(buffer, mset), 'application/xml');
      if (doc.querySelector('parsererror')) return res;

      var p, y;

      /* --- placas: qué objeto vive en qué placa ------------------------ */
      var placaDe = {};
      var nodosPlaca = doc.getElementsByTagName('plate');
      for (p = 0; p < nodosPlaca.length; p++) {
        var idPlaca = null;
        var mdsP = nodosPlaca[p].getElementsByTagName('metadata');
        for (y = 0; y < mdsP.length; y++) {
          if (mdsP[y].getAttribute('key') === 'plater_id') {
            idPlaca = mdsP[y].getAttribute('value'); break;
          }
        }
        if (idPlaca === null) idPlaca = String(p + 1);
        var inst = nodosPlaca[p].getElementsByTagName('model_instance');
        for (y = 0; y < inst.length; y++) {
          var mdsI = inst[y].getElementsByTagName('metadata');
          for (var w = 0; w < mdsI.length; w++) {
            if (mdsI[w].getAttribute('key') === 'object_id') {
              placaDe[mdsI[w].getAttribute('value')] = idPlaca;
            }
          }
        }
      }
      var vistas = {};
      for (p = 0; p < partes.length; p++) {
        partes[p].placa = placaDe[partes[p].objectId] || null;
        if (partes[p].placa !== null) vistas[partes[p].placa] = true;
      }
      if (Object.keys(vistas).length) res.placas = Object.keys(vistas).length;

      /* --- colores: extrusor por objeto + paleta del proyecto ---------- */
      var proj = entrada('metadata/project_settings.config');
      if (proj) {
        var conf = JSON.parse(await inflateEntry(buffer, proj));
        var colores = (conf.filament_colour || conf.filament_color || []).map(hexARgb);
        if (colores.length) {
          /* Extrusor por objeto Y por parte. En Bambu un objeto multicolor
             es un objeto con <part> hijas, cada una con su extrusor, y el
             id de la parte es el del sub-objeto que trae su malla — pero
             ese id es LOCAL al objeto (el mismo "1" se repite en cada
             objeto del proyecto), así que la clave buena es el par
             objeto/parte; el id suelto queda de respaldo para las
             versiones del formato que numeran las partes de corrido.     */
          var extrusorObj = {}, extrusorPar = {};
          Array.prototype.forEach.call(doc.getElementsByTagName('object'), function (o) {
            var id = o.getAttribute('id');
            var mds = o.getElementsByTagName('metadata');
            for (var k = 0; k < mds.length; k++) {
              if (mds[k].getAttribute('key') === 'extruder' && mds[k].parentNode === o) {
                extrusorObj[id] = +mds[k].getAttribute('value'); break;
              }
            }
            Array.prototype.forEach.call(o.getElementsByTagName('part'), function (pt) {
              var pid = pt.getAttribute('id');
              var valor = null;
              var mdp = pt.getElementsByTagName('metadata');
              for (var k2 = 0; k2 < mdp.length; k2++) {
                if (mdp[k2].getAttribute('key') === 'extruder' && mdp[k2].parentNode === pt) {
                  valor = +mdp[k2].getAttribute('value'); break;
                }
              }
              if (valor === null && (id in extrusorObj)) valor = extrusorObj[id];
              if (valor === null) return;
              extrusorPar[id + '/' + pid] = valor;
              /* El id suelto solo sirve si es inequívoco en todo el
                 proyecto: dos partes con el mismo id y distinto extrusor
                 lo anulan. Mejor sin color que con el color equivocado. */
              if (!(pid in extrusorPar)) extrusorPar[pid] = valor;
              else if (extrusorPar[pid] !== valor) extrusorPar[pid] = null;
            });
          });
          for (p = 0; p < partes.length; p++) {
            var oid = partes[p].objectId;
            var ex = extrusorObj[oid] || 1;
            partes[p].color = colores[ex - 1] || null;
            var rgs = partes[p].rangos || [];
            for (var rr = 0; rr < rgs.length; rr++) {
              /* La pintura por triángulo mana sobre el extrusor de la parte. */
              if (rgs[rr].pintado > 0) {
                rgs[rr].color = colores[rgs[rr].pintado - 1] || partes[p].color;
                continue;
              }
              var exR = extrusorPar[oid + '/' + rgs[rr].idMalla];
              if (exR === undefined) exR = extrusorPar[rgs[rr].idMalla];
              rgs[rr].color = (exR ? colores[exR - 1] : null) || partes[p].color;
            }
          }
        }
      }
    } catch (e) { /* metadatos opcionales */ }
    return res;
  }

  function escalaDeTransformacion(str) {
    if (!str) return 1;
    var m = str.trim().split(/\s+/).map(Number);
    if (m.length < 9 || m.some(isNaN)) return 1;
    var det = m[0] * (m[4] * m[8] - m[5] * m[7])
            - m[1] * (m[3] * m[8] - m[5] * m[6])
            + m[2] * (m[3] * m[7] - m[4] * m[6]);
    return Math.abs(det) || 1;
  }

  /* =========================================================== geometría */
  function volumenDeMalla(tri) {
    var v = 0;
    for (var i = 0; i < tri.length; i += 9) {
      var ax = tri[i],   ay = tri[i+1], az = tri[i+2];
      var bx = tri[i+3], by = tri[i+4], bz = tri[i+5];
      var cx = tri[i+6], cy = tri[i+7], cz = tri[i+8];
      // producto mixto a · (b × c) / 6
      v += (ax * (by * cz - bz * cy)
          - ay * (bx * cz - bz * cx)
          + az * (bx * cy - by * cx)) / 6;
    }
    return Math.abs(v);
  }

  function limitesDeMalla(tri) {
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < tri.length; i += 3) {
      for (var a = 0; a < 3; a++) {
        var val = tri[i + a];
        if (val < min[a]) min[a] = val;
        if (val > max[a]) max[a] = val;
      }
    }
    return { min: min, max: max };
  }

  function cajaDeMalla(tri) {
    var l = limitesDeMalla(tri);
    return [l.max[0] - l.min[0], l.max[1] - l.min[1], l.max[2] - l.min[2]];
  }

  function areaDeMalla(tri) {
    var s = 0;
    for (var i = 0; i < tri.length; i += 9) {
      s += areaDeTriangulo(tri[i], tri[i + 1], tri[i + 2],
                           tri[i + 3], tri[i + 4], tri[i + 5],
                           tri[i + 6], tri[i + 7], tri[i + 8]);
    }
    return s;
  }

  function unirCaja(a, b) {
    if (!a) return b;
    return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  }

  /* ================================================== corte automático ===

     Estilo "cut pieces": cuando la pieza (al tamaño final pedido) no cabe
     en la impresora, se reparte en una cuadrícula de celdas de a lo más
     maxMm por lado. Cada triángulo cae entero en su celda o, si cruza un
     plano de corte, se recorta contra la caja de cada celda que toca
     (Sutherland–Hodgman). Es geometría de superficie: suficiente para
     contar secciones, medir cada una y enseñarlas separadas en el visor.

     Ojo: una celda totalmente interior a un sólido macizo no tiene ningún
     triángulo de superficie y no se cuenta. En modelos reales (cascarones)
     no pasa; con un macizo enorme el conteo se queda corto, nunca de más. */

  var EPS_CORTE = 1e-6;

  function recortarPoligono(pts, eje, c, lado) {
    // lado +1 conserva v[eje] >= c; lado -1 conserva v[eje] <= c.
    var out = [], n = pts.length, i;
    for (i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      var da = lado * (a[eje] - c);
      var db = lado * (b[eje] - c);
      if (da >= -EPS_CORTE) out.push(a);
      if ((da >= -EPS_CORTE) !== (db >= -EPS_CORTE)) {
        var t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t,
                  a[1] + (b[1] - a[1]) * t,
                  a[2] + (b[2] - a[2]) * t]);
      }
    }
    return out;
  }

  function areaDeTriangulo(ax, ay, az, bx, by, bz, cx, cy, cz) {
    var ux = bx - ax, uy = by - ay, uz = bz - az;
    var vx = cx - ax, vy = cy - ay, vz = cz - az;
    var nx = uy * vz - uz * vy;
    var ny = uz * vx - ux * vz;
    var nz = ux * vy - uy * vx;
    return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
  }

  /* planos (opcional): posiciones de corte elegidas a mano por eje, en mm
     ya escalados: {x:[...], y:[...], z:[...]}. Sin planos, la cuadrícula
     se reparte pareja para que ninguna sección exceda maxMm.              */
  function cortarEnPiezas(malla, escala, maxMm, planos) {
    if (!malla || malla.length < 9) return null;

    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    var i, a, v;
    for (i = 0; i < malla.length; i += 3) {
      for (a = 0; a < 3; a++) {
        v = malla[i + a] * escala;
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    if (!isFinite(min[0])) return null;

    var dim = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    var EJES = ['x', 'y', 'z'];
    var bordes = [null, null, null];    // fronteras por eje, extremos incluidos
    var n = [1, 1, 1], totalCeldas = 1;
    for (a = 0; a < 3; a++) {
      var interiores = null;
      if (planos && planos[EJES[a]]) {
        interiores = planos[EJES[a]].filter(function (q) {
          return isFinite(q) && q > min[a] + EPS_CORTE && q < max[a] - EPS_CORTE;
        }).sort(function (q, r) { return q - r; });
      }
      if (interiores === null) {
        var cuantos = Math.max(1, Math.ceil((dim[a] - EPS_CORTE) / maxMm));
        interiores = [];
        for (i = 1; i < cuantos; i++) interiores.push(min[a] + dim[a] * i / cuantos);
      }
      bordes[a] = [min[a]].concat(interiores);
      bordes[a].push(max[a]);
      n[a] = bordes[a].length - 1;
      totalCeldas *= n[a];
    }
    if (totalCeldas === 1) return null;

    var tam = [dim[0] / n[0], dim[1] / n[1], dim[2] / n[2]];

    function celdaDe(valor, eje) {
      var b = bordes[eje], ultimo = b.length - 2;
      for (var c = 1; c <= ultimo; c++) {
        if (valor < b[c]) return c - 1;
      }
      return ultimo;
    }

    var tris  = new Array(totalCeldas);   // números sueltos por celda
    var areas = new Float64Array(totalCeldas);

    function meter(c, ax, ay, az, bx, by, bz, cx, cy, cz) {
      var arr = tris[c] || (tris[c] = []);
      arr.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      areas[c] += areaDeTriangulo(ax, ay, az, bx, by, bz, cx, cy, cz);
    }

    for (i = 0; i < malla.length; i += 9) {
      var ax = malla[i]     * escala, ay = malla[i + 1] * escala, az = malla[i + 2] * escala;
      var bx = malla[i + 3] * escala, by = malla[i + 4] * escala, bz = malla[i + 5] * escala;
      var cx = malla[i + 6] * escala, cy = malla[i + 7] * escala, cz = malla[i + 8] * escala;

      var i0 = celdaDe(Math.min(ax, bx, cx), 0), i1 = celdaDe(Math.max(ax, bx, cx), 0);
      var j0 = celdaDe(Math.min(ay, by, cy), 1), j1 = celdaDe(Math.max(ay, by, cy), 1);
      var k0 = celdaDe(Math.min(az, bz, cz), 2), k1 = celdaDe(Math.max(az, bz, cz), 2);

      if (i0 === i1 && j0 === j1 && k0 === k1) {
        // Camino rápido: el triángulo vive entero en una sola celda.
        meter((i0 * n[1] + j0) * n[2] + k0, ax, ay, az, bx, by, bz, cx, cy, cz);
        continue;
      }

      for (var ci = i0; ci <= i1; ci++) {
        for (var cj = j0; cj <= j1; cj++) {
          for (var ck = k0; ck <= k1; ck++) {
            var poli = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
            poli = recortarPoligono(poli, 0, bordes[0][ci], 1);
            if (poli.length > 2) poli = recortarPoligono(poli, 0, bordes[0][ci + 1], -1);
            if (poli.length > 2) poli = recortarPoligono(poli, 1, bordes[1][cj], 1);
            if (poli.length > 2) poli = recortarPoligono(poli, 1, bordes[1][cj + 1], -1);
            if (poli.length > 2) poli = recortarPoligono(poli, 2, bordes[2][ck], 1);
            if (poli.length > 2) poli = recortarPoligono(poli, 2, bordes[2][ck + 1], -1);
            if (poli.length < 3) continue;

            var c = (ci * n[1] + cj) * n[2] + ck;
            for (var f = 1; f < poli.length - 1; f++) {
              meter(c,
                    poli[0][0], poli[0][1], poli[0][2],
                    poli[f][0], poli[f][1], poli[f][2],
                    poli[f + 1][0], poli[f + 1][1], poli[f + 1][2]);
            }
          }
        }
      }
    }

    /* Celdas con geometría de verdad; las esquirlas numéricas no cuentan. */
    var celdas = [], cajaMayor = null;
    for (var ci2 = 0; ci2 < n[0]; ci2++) {
      for (var cj2 = 0; cj2 < n[1]; cj2++) {
        for (var ck2 = 0; ck2 < n[2]; ck2++) {
          var idx = (ci2 * n[1] + cj2) * n[2] + ck2;
          if (!tris[idx] || areas[idx] < 0.01) continue;
          var t = new Float64Array(tris[idx]);
          var caja = cajaDeMalla(t);
          cajaMayor = unirCaja(cajaMayor, caja);
          celdas.push({ tri: t, caja: caja, ijk: [ci2, cj2, ck2] });
        }
      }
    }
    if (celdas.length < 2) return null;

    return {
      celdas: celdas, n: n, tam: tam, cajaMayor: cajaMayor,
      limites: { min: min, max: max },
      fronteras: { x: bordes[0].slice(1, -1),
                   y: bordes[1].slice(1, -1),
                   z: bordes[2].slice(1, -1) }
    };
  }

  /* Corte por pincel: cada etiqueta pintada es una sección; lo no pintado
     es la sección base. Se separa el modelo por etiquetas, sin planos.    */
  function cortarPorEtiquetas(malla, escala, etiquetas) {
    if (!malla || !etiquetas) return null;
    var nTri = Math.floor(malla.length / 9);
    var grupos = {}, t, e;
    for (t = 0; t < nTri; t++) {
      e = t < etiquetas.length ? etiquetas[t] : 0;
      (grupos[e] || (grupos[e] = [])).push(t);
    }
    var claves = Object.keys(grupos);
    if (claves.length < 2) return null;

    var celdas = [], cajaMayor = null;
    var minG = [Infinity, Infinity, Infinity], maxG = [-Infinity, -Infinity, -Infinity];
    claves.forEach(function (k) {
      var lista = grupos[k];
      var tri = new Float64Array(lista.length * 9), p = 0;
      for (var i = 0; i < lista.length; i++) {
        var o = lista[i] * 9;
        for (var c = 0; c < 9; c++) tri[p++] = malla[o + c] * escala;
      }
      var lim = limitesDeMalla(tri);
      var caja = [lim.max[0] - lim.min[0], lim.max[1] - lim.min[1], lim.max[2] - lim.min[2]];
      cajaMayor = unirCaja(cajaMayor, caja);
      for (var a = 0; a < 3; a++) {
        if (lim.min[a] < minG[a]) minG[a] = lim.min[a];
        if (lim.max[a] > maxG[a]) maxG[a] = lim.max[a];
      }
      /* Normal promedio del grupo: si su centro coincide con el del modelo
         (un parche pintado al frente de una caja), el despiece sale por la
         normal, no por el centro. */
      var nx = 0, ny = 0, nz = 0;
      for (var q = 0; q < tri.length; q += 9) {
        var ux = tri[q + 3] - tri[q], uy = tri[q + 4] - tri[q + 1], uz = tri[q + 5] - tri[q + 2];
        var wx = tri[q + 6] - tri[q], wy = tri[q + 7] - tri[q + 1], wz = tri[q + 8] - tri[q + 2];
        nx += uy * wz - uz * wy;
        ny += uz * wx - ux * wz;
        nz += ux * wy - uy * wx;
      }
      celdas.push({ tri: tri, caja: caja, lim: lim, etiqueta: +k,
                    normal: [nx, ny, nz] });
    });

    /* Despiece: cada sección se aparta del centro en la dirección de su
       propio centro, como en la separación por colores. */
    var centro = [(minG[0] + maxG[0]) / 2, (minG[1] + maxG[1]) / 2, (minG[2] + maxG[2]) / 2];
    var tamM = Math.max(maxG[0] - minG[0], maxG[1] - minG[1], maxG[2] - minG[2]);
    var gap = Math.max(8, Math.min(tamM * 0.14, 45));
    var total = 0;
    celdas.forEach(function (cel) { total += cel.tri.length; });
    var out = new Float64Array(total), pos = 0;
    celdas.forEach(function (cel) {
      var d = [0, 0, 0], lg = 0, a;
      for (a = 0; a < 3; a++) {
        d[a] = (cel.lim.min[a] + cel.lim.max[a]) / 2 - centro[a];
        lg += d[a] * d[a];
      }
      lg = Math.sqrt(lg);
      if (lg < tamM * 0.03 && cel.etiqueta > 0) {
        d = cel.normal.slice();
        lg = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      }
      lg = lg || 1;
      for (a = 0; a < 3; a++) d[a] = d[a] / lg * gap;
      for (var i = 0; i < cel.tri.length; i += 3) {
        out[pos++] = cel.tri[i] + d[0];
        out[pos++] = cel.tri[i + 1] + d[1];
        out[pos++] = cel.tri[i + 2] + d[2];
      }
    });

    return { celdas: celdas, cajaMayor: cajaMayor, explotada: out, pincel: true };
  }

  /* Las secciones separadas unos milímetros, para que se vea el corte. */
  function mallaExplotada(corte) {
    if (corte.explotada) return corte.explotada;
    var gap = Math.max(6, Math.min(Math.max(corte.tam[0], corte.tam[1], corte.tam[2]) * 0.10, 28));
    var total = 0, i;
    for (i = 0; i < corte.celdas.length; i++) total += corte.celdas[i].tri.length;

    var out = new Float64Array(total), pos = 0;
    for (i = 0; i < corte.celdas.length; i++) {
      var cel = corte.celdas[i];
      var ox = (cel.ijk[0] - (corte.n[0] - 1) / 2) * gap;
      var oy = (cel.ijk[1] - (corte.n[1] - 1) / 2) * gap;
      var oz = (cel.ijk[2] - (corte.n[2] - 1) / 2) * gap;
      var t = cel.tri;
      for (var k = 0; k < t.length; k += 3) {
        out[pos++] = t[k] + ox;
        out[pos++] = t[k + 1] + oy;
        out[pos++] = t[k + 2] + oz;
      }
    }
    corte.explotada = out;
    return out;
  }

  /* ============================================================ precios */

  /* Cuántas copias de una pieza caben acostadas en una cama. Es una
     aproximación por cuadrícula: no reacomoda ni rota las piezas, así que
     se queda corta con formas irregulares. Preferimos quedarnos cortos:
     cobrar de más una cama es mejor que prometer una que no cabe.          */
  function piezasPorCama(caja) {
    if (!caja) return 1;
    var s = CONFIG.separacionMm, cama = CONFIG.camaMm;
    var w = caja[0], d = caja[1], h = caja[2];
    if (h > CONFIG.alturaMm) return 0;                 // no cabe de altura
    function cupo(a, b) {
      var na = Math.floor((cama + s) / (a + s));
      var nb = Math.floor((cama + s) / (b + s));
      return (na > 0 && nb > 0) ? na * nb : 0;
    }
    var n = Math.max(cupo(w, d), cupo(d, w));          // probamos girada 90°
    return n;
  }

  /* El costo no escala lineal con la cantidad: preparar el archivo se hace
     una sola vez, y alistar la cama se paga por cama, no por pieza. Si te
     caben 20 piezas en una cama, son 20 piezas con un solo alistado. Con
     corte automático cada modelo son varias secciones: las camas se cuentan
     sobre las secciones y cada sección extra suma su ensamble.

     partesCajas (opcional): cajas de las partes de un modelo de varias
     piezas, ya escaladas. Con eso las camas se cuentan sumando la fracción
     de cama que ocupa cada parte, no como si el juego entero fuera una
     sola pieza del tamaño de la mayor.                                     */
  /* regiones (opcional): número de piezas al cortar el modelo POR COLOR,
     estilo "optimización de color": cada región se imprime en un solo
     color (sin purga) y se pegan al final. Quien llama ya debe haber
     pasado colores=1, medido=null y las cajas de las regiones como
     partesCajas para las camas.                                          */
  function cotizar(volumenCm3, materialKey, relleno, cantidad, caja, corte, partesCajas, placas, areaMm2, colores, medido, regiones) {
    var mat = CONFIG.materiales[materialKey];
    var gramos, horas, delLaminador = false;
    if (medido && medido.gramos > 0) {
      /* El proyecto viene laminado: gramos y tiempo son los del propio
         laminador del cliente, con purga y soportes ya incluidos. No hay
         estimación que le gane a eso. */
      delLaminador = true;
      gramos = medido.gramos;
      horas = medido.horas > 0
        ? medido.horas
        : (medido.gramos / mat.densidad) / CONFIG.velocidadCm3PorHora;
    } else {
      var cm3;
      if (areaMm2 > 0) {
        /* Cascarón real (área × pared) + relleno de lo que queda adentro.
           En piezas chicas o delgadas el cascarón ES casi todo el material:
           un modelo plano de "36 % a relleno de 15 %" las cobra a la mitad. */
        var cascaron = Math.min(volumenCm3, areaMm2 * CONFIG.paredMm / 1000);
        cm3 = cascaron + Math.max(0, volumenCm3 - cascaron) * relleno;
      } else {
        cm3 = volumenCm3 * CONFIG.fraccionSolida(relleno);
      }
      var purga = colores > 1 ? 1 + CONFIG.purgaPorColor * (colores - 1) : 1;
      gramos = cm3 * mat.densidad * purga;
      horas = cm3 / CONFIG.velocidadCm3PorHora;
    }
    var material = (gramos / 1000) * mat.precioKg;
    var maquina = horas * CONFIG.tarifaHora;

    var n = Math.max(1, cantidad || 1);
    var secciones = corte ? corte.celdas.length : (regiones > 1 ? regiones : 1);
    var porCama, camas;
    if (!corte && partesCajas && partesCajas.length > 1) {
      var frac = 0;
      for (var pc = 0; pc < partesCajas.length; pc++) {
        var cupoP = piezasPorCama(partesCajas[pc]);
        frac += cupoP > 0 ? 1 / cupoP : 1;
      }
      porCama = frac > 0 && frac <= 1 ? Math.floor(1 / frac) : 1;  // juegos por cama
      camas = Math.max(1, Math.ceil(n * frac));
      /* Si el proyecto trae sus placas armadas (Bambu), nunca cobramos
         menos camas de las que el propio archivo dice que necesita: los
         repartos por color no se pueden fusionar en una sola cama. Con
         varias copias sí se aprovechan los huecos de cada placa.          */
      if (placas > 0 && camas < placas) camas = placas;
      /* Al separar por color cada color imprime en su propia corrida:
         nunca menos de una cama por color, sin importar lo chico que sea. */
      if (regiones > 1 && camas < regiones) camas = regiones;
    } else {
      var cajaPack = corte ? corte.cajaMayor : caja;
      porCama = piezasPorCama(cajaPack);
      camas = porCama > 0 ? Math.ceil(n * secciones / porCama) : n * secciones;
    }
    var ensamble = (corte || regiones > 1)
      ? CONFIG.ensamblePorPieza * (secciones - 1) * n : 0;

    var directo = (material + maquina) * CONFIG.margen * n;
    var total = directo + CONFIG.preparacionPorArchivo
              + CONFIG.alistadoPorCama * camas + ensamble;
    var unitario = Math.max(total / n, CONFIG.minimoPorPieza);

    return {
      gramos: gramos, horas: horas, delLaminador: delLaminador,
      unitario: unitario, total: unitario * n,
      porCama: porCama, camas: camas,
      secciones: secciones, ensamble: ensamble
    };
  }

  /* ================================================================= UI */
  var piezas = [];
  /* Gancho de pruebas: expone el motor de geometría para verificarlo desde
     la consola o desde un script. La interfaz no lo usa. Va aquí arriba a
     propósito, antes del `return` que corta cuando no existe el HTML del
     cotizador: así el motor se puede probar en una página vacía. */
  /* El cortador de piezas (/cortador/) carga este archivo solo por el motor:
     al no existir #dropzone en esa página, la interfaz de abajo no corre. */
  window.__emishaQuote = {
    parseSTL: parseSTL, parse3MF: parse3MF,
    volumen: volumenDeMalla, caja: cajaDeMalla, area: areaDeMalla,
    limites: limitesDeMalla, porCama: piezasPorCama,
    cotizar: cotizar, cortar: cortarEnPiezas,
    cortarEtiquetas: cortarPorEtiquetas, explotar: mallaExplotada,
    config: CONFIG, whatsapp: WHATSAPP
  };

  var zona     = $('#dropzone');
  var input    = $('#file-input');
  var lista    = $('#filelist');
  var vacio    = $('#empty-state');
  var resumen  = $('#resultado');
  var totalEl  = $('#total');
  var detalle  = $('#total-detalle');
  var selMat   = $('#material');
  var selRell  = $('#relleno');
  var btnMail  = $('#solicitar');
  var visor    = $('#visor');
  var lienzo   = $('#visor-lienzo');
  var visorNota = $('#visor-nota');
  if (!zona) return;

  var soportaGL = (function () {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (e) { return false; }
  })();

  ['dragenter', 'dragover'].forEach(function (ev) {
    zona.addEventListener(ev, function (e) {
      e.preventDefault(); zona.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    zona.addEventListener(ev, function (e) {
      e.preventDefault(); zona.classList.remove('is-over');
    });
  });
  zona.addEventListener('drop', function (e) { agregar(e.dataTransfer.files); });
  zona.addEventListener('click', function () { input.click(); });
  zona.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', function () { agregar(input.files); input.value = ''; });
  [selMat, selRell].forEach(function (el) { el.addEventListener('change', refrescar); });

  /* ------------------------------------------------- escala y corte --- */

  function coloresDistintos(partes) {
    if (!partes) return 1;
    var vistos = {}, n = 0;
    function ver(c) {
      if (!c) return;
      var k = c.join(',');
      if (!vistos[k]) { vistos[k] = 1; n++; }
    }
    for (var i = 0; i < partes.length; i++) {
      ver(partes[i].color);
      var rgs = partes[i].rangos || [];
      for (var j = 0; j < rgs.length; j++) ver(rgs[j].color);
    }
    return n || 1;
  }

  function escalaDe(p) {
    if (!(p.tamanoNatural > 0)) return 1;
    var d = p.tamanoDeseado || p.tamanoNatural;
    if (Math.abs(d - p.tamanoNatural) < 0.5) return 1;   // “el mismo tamaño”
    return d / p.tamanoNatural;
  }

  /* El corte se decide en este orden: el pincel del usuario mana sobre
     todo; luego el corte automático (con los planos que el usuario haya
     movido) cuando la pieza —al tamaño pedido— no cabe en la impresora ni
     girada. Se guarda por clave porque cortar una malla grande cuesta
     trabajo y el usuario mueve los números seguido.                        */
  function corteDe(p, s) {
    if (!p.malla) return null;

    if (p.pincelListo && p.pincel) {
      var clavePin = 'pin|' + s.toFixed(4) + '|' + (p.pincelVersion || 0);
      if (!p._cortePin || p._cortePin.clave !== clavePin) {
        p._cortePin = { clave: clavePin,
                        datos: cortarPorEtiquetas(p.malla, s, p.pincel) };
      }
      if (p._cortePin.datos) return p._cortePin.datos;
    }

    var cajaE = [p.caja[0] * s, p.caja[1] * s, p.caja[2] * s];
    if (piezasPorCama(cajaE) > 0) return null;
    var lim = Math.min(CONFIG.camaMm, CONFIG.alturaMm) - CONFIG.margenCorteMm;
    var planos = (p.planos && p._planosEscala === s) ? p.planos : null;
    var clave = s.toFixed(4) + '|' + lim + '|'
              + (planos ? JSON.stringify(planos) : 'auto');
    if (!p._corte || p._corte.clave !== clave) {
      p._corte = { clave: clave, datos: cortarEnPiezas(p.malla, s, lim, planos) };
    }
    return p._corte.datos;
  }

  /* ------------------------------------------------------- visor 3D --- */

  var visorCtrl = null, visorSel = -1, visorClave = '', visorPiezaAnt = -1;
  var visorModo = 'ver';               // 'ver' | 'editar' | 'pincel'
  var timerPlanos = null;

  /* Secciones del pincel: 0 = borrador (sin sección). */
  var SECCIONES_PINCEL = [
    { nombre: 'A', color: [0.86, 0.26, 0.22] },
    { nombre: 'B', color: [0.12, 0.47, 0.75] },
    { nombre: 'C', color: [0.24, 0.65, 0.36] },
    { nombre: 'D', color: [0.92, 0.55, 0.10] }
  ];
  var pincelSeccion = 1;               // 1..4, 0 = borrador
  var pincelRadio = 34;

  function piezaVisible() {
    if (visorSel >= 0 && piezas[visorSel] && piezas[visorSel].malla) return visorSel;
    for (var i = piezas.length - 1; i >= 0; i--) {
      if (piezas[i].malla) return i;
    }
    return -1;
  }

  /* Trozos de colores de la pieza entera, en el MISMO orden de p.malla:
     el pincel depende de que el índice de triángulo del visor coincida
     con el de la malla. */
  function trozosEnteros(p, s, separar) {
    var conColor = p.partes && p.partes.some(function (x) {
      return x.color || (x.rangos && x.rangos.some(function (r) { return r.color; }));
    });
    if (!conColor) return escalarMalla(p.malla, s);
    var datos = [];
    p.partes.forEach(function (x) {
      rangosDe(x).forEach(function (rg) {
        var tri = escalarMalla(x.malla.subarray(rg.ini, rg.fin), s);
        var col = rg.color || x.color;
        if (separar) {
          var d = separar[col ? col.join(',') : 'base'];
          if (d && (d[0] || d[1] || d[2])) {
            var mov = new Float64Array(tri.length);
            for (var mv = 0; mv < tri.length; mv += 3) {
              mov[mv]     = tri[mv]     + d[0];
              mov[mv + 1] = tri[mv + 1] + d[1];
              mov[mv + 2] = tri[mv + 2] + d[2];
            }
            tri = mov;
          }
        }
        datos.push({ tri: tri, color: col });
      });
    });
    return datos;
  }

  function actualizarVisor() {
    if (!visor || !lienzo) return;
    var idx = piezaVisible();
    var puede = idx >= 0 && soportaGL && window.EmishaPreview;
    visor.classList.toggle('is-hidden', !puede);

    piezas.forEach(function (p, i) {
      if (p._rowEl) p._rowEl.classList.toggle('filerow--activa', puede && i === idx && piezas.length > 1);
    });
    if (!puede) { actualizarBarraVisor(null, null); return; }

    var p = piezas[idx];
    if (idx !== visorPiezaAnt) {
      visorPiezaAnt = idx;
      visorModo = 'ver';
      if (visorCtrl) visorCtrl.reencuadrar();
    }
    var s = escalaDe(p);
    var corte = corteDe(p, s);
    if (visorModo === 'editar' && (!corte || corte.pincel)) visorModo = 'ver';

    var clave = idx + '|' + p.nombre + '|' + s.toFixed(4) + '|' + visorModo + '|'
              + (corte ? (corte.pincel ? p._cortePin.clave : p._corte.clave) : 'entera')
              + (!corte && p.porColor ? '|pc' : '')
              + '|' + (p.pincelVersion || 0);
    if (clave === visorClave) {
      ponerNotaVisor(p, corte);
      actualizarBarraVisor(p, corte);
      return;
    }
    visorClave = clave;

    /* Ver: el resultado (cortada => despiece; entera => sobre la cama).
       Editar: la pieza entera con los planos de corte encima.
       Pincel: la pieza entera y se pinta sobre ella. */
    var datos, opciones;
    if (visorModo === 'ver' && corte) {
      datos = mallaExplotada(corte);
      opciones = null;
    } else if (visorModo === 'editar') {
      datos = trozosEnteros(p, s, null);
      opciones = { camaMm: CONFIG.camaMm, alturaMm: CONFIG.alturaMm,
                   camas: centrosDePlacas(p, s),
                   planos: corte ? corte.fronteras : null };
    } else if (visorModo === 'pincel') {
      datos = trozosEnteros(p, s, null);
      opciones = { camaMm: CONFIG.camaMm, alturaMm: CONFIG.alturaMm,
                   camas: centrosDePlacas(p, s) };
    } else {
      var separar = p.porColor ? desplazamientosPorColor(p, s) : null;
      datos = trozosEnteros(p, s, separar);
      opciones = { camaMm: CONFIG.camaMm, alturaMm: CONFIG.alturaMm,
                   camas: centrosDePlacas(p, s) };
    }
    if (!visorCtrl) visorCtrl = window.EmishaPreview.montar(lienzo, datos, opciones);
    else visorCtrl.actualizar(datos, opciones);

    if (visorModo === 'pincel') {
      visorCtrl.pincel(pincelRadio, function (indices) { alPintarPincel(p, indices); });
      repintarMarcas(p);
    } else {
      visorCtrl.pincel(0);
    }
    ponerNotaVisor(p, corte);
    actualizarBarraVisor(p, corte);
  }

  function escalarMalla(m, s) {
    if (s === 1) return m;
    var out = new Float64Array(m.length);
    for (var i = 0; i < m.length; i++) out[i] = m[i] * s;
    return out;
  }

  function cajasEscaladas(p, s) {
    if (!p.partes || p.partes.length < 2) return null;
    return p.partes.map(function (x) {
      return [x.caja[0] * s, x.caja[1] * s, x.caja[2] * s];
    });
  }

  /* Los datos del laminador valen tal cual solo si la pieza va al tamaño
     original, sin corte y sin separar por color: cambiada ya no es el mismo
     trabajo que se laminó, y se vuelve a estimar por geometría. */
  function medidoDe(p, s, corte) {
    if (s !== 1 || corte || p.porColor || !(p.gramosSlicer > 0)) return null;
    return { gramos: p.gramosSlicer, horas: p.horasSlicer || 0 };
  }

  function rangosDe(x) {
    return (x.rangos && x.rangos.length)
      ? x.rangos
      : [{ ini: 0, fin: x.malla.length, color: x.color, pintado: 0 }];
  }

  /* Cada región de color se aparta del centro del modelo en la dirección
     de su propio centro: el clásico despiece. La región más grande (el
     cuerpo) casi no se mueve; los detalles se apartan más.               */
  function desplazamientosPorColor(p, s) {
    var regiones = regionesPorColor(p);
    if (!regiones) return null;
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    var i, a;
    for (i = 0; i < regiones.length; i++) {
      for (a = 0; a < 3; a++) {
        if (regiones[i].min[a] < min[a]) min[a] = regiones[i].min[a];
        if (regiones[i].max[a] > max[a]) max[a] = regiones[i].max[a];
      }
    }
    var centro = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    var tam = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * s;
    var gap = Math.max(8, Math.min(tam * 0.12, 40));
    var por = {};
    for (i = 0; i < regiones.length; i++) {
      var g = regiones[i];
      var d = [0, 0, 0], lg = 0;
      for (a = 0; a < 3; a++) {
        d[a] = (g.min[a] + g.max[a]) / 2 - centro[a];
        lg += d[a] * d[a];
      }
      lg = Math.sqrt(lg);
      var clave = g.color ? g.color.join(',') : 'base';
      por[clave] = lg > 1e-6
        ? [d[0] / lg * gap, d[1] / lg * gap, d[2] / lg * gap]
        : [0, 0, 0];
    }
    return por;
  }

  /* Optimización de color, estilo dora: el modelo se separa en una región
     por cada color y cada región se imprime aparte, en un solo color y sin
     purga del AMS, para ensamblarse y pegarse al final. Las regiones ya
     las conocemos: son los mismos tramos que pintan el visor. Devuelve
     null si el modelo es de un solo color.                               */
  function regionesPorColor(p) {
    if (!p.partes || !(p.coloresUsados > 1)) return null;
    if (p._regiones) return p._regiones;
    var por = {};
    p.partes.forEach(function (x) {
      rangosDe(x).forEach(function (rg) {
        if (rg.limites === undefined) {
          rg.limites = (rg.fin > rg.ini)
            ? limitesDeMalla(x.malla.subarray(rg.ini, rg.fin))
            : null;
        }
        if (!rg.limites) return;
        var clave = rg.color ? rg.color.join(',') : 'base';
        var g = por[clave];
        if (!g) {
          por[clave] = { color: rg.color,
                         min: rg.limites.min.slice(), max: rg.limites.max.slice() };
          return;
        }
        for (var a = 0; a < 3; a++) {
          if (rg.limites.min[a] < g.min[a]) g.min[a] = rg.limites.min[a];
          if (rg.limites.max[a] > g.max[a]) g.max[a] = rg.limites.max[a];
        }
      });
    });
    var lista = Object.keys(por).map(function (k) { return por[k]; });
    p._regiones = lista.length > 1 ? lista : null;
    return p._regiones;
  }

  /* Una cama por cada placa del proyecto Bambu, centrada bajo lo que esa
     placa contiene — así el visor enseña las camas donde de verdad están,
     no una cuadrícula inventada. Sin placas devuelve null y el visor cae
     al mosaico automático. */
  function centrosDePlacas(p, s) {
    if (!p.partes || !p.placas) return null;
    var por = {};
    p.partes.forEach(function (x) {
      if (x.placa === null || !x.limites) return;
      var g = por[x.placa];
      if (!g) {
        g = por[x.placa] = {
          min: x.limites.min.slice(),
          max: x.limites.max.slice()
        };
        return;
      }
      for (var a = 0; a < 3; a++) {
        if (x.limites.min[a] < g.min[a]) g.min[a] = x.limites.min[a];
        if (x.limites.max[a] > g.max[a]) g.max[a] = x.limites.max[a];
      }
    });
    var claves = Object.keys(por);
    if (!claves.length) return null;
    return claves.map(function (k) {
      var g = por[k];
      return [(g.min[0] + g.max[0]) / 2 * s,
              (g.min[1] + g.max[1]) / 2 * s,
              g.min[2] * s];
    });
  }

  function ponerNotaVisor(p, corte) {
    if (!visorNota) return;
    if (visorModo === 'pincel') {
      visorNota.textContent = p.nombre + ' — pinta las secciones sobre la pieza · '
        + 'Shift+arrastrar mueve la vista';
      return;
    }
    if (visorModo === 'editar') {
      visorNota.textContent = p.nombre + ' — mueve cada plano con su barra · '
        + 'arrastra para girar · Shift+arrastrar mueve';
      return;
    }
    visorNota.textContent = corte
      ? p.nombre + ' — se corta en ' + corte.celdas.length
        + ' secciones para armar · arrastra para girar · Shift+arrastrar mueve'
      : p.nombre + ' — arrastra para girar · rueda o pellizco acerca · Shift+arrastrar mueve';
  }

  /* ----------------------------- barra del visor: modos, planos, pincel */

  var btnVer     = $('#modo-ver');
  var btnEditar  = $('#modo-editar');
  var btnPincel  = $('#modo-pincel');
  var btnReiniciar = $('#corte-reset');
  var panelPlanos  = $('#planos-panel');
  var panelPincel  = $('#pincel-panel');

  function cambiarModo(m) {
    visorModo = m;
    refrescar();
  }
  if (btnVer)    btnVer.addEventListener('click', function () { cambiarModo('ver'); });
  if (btnEditar) btnEditar.addEventListener('click', function () { cambiarModo('editar'); });
  if (btnPincel) btnPincel.addEventListener('click', function () { cambiarModo('pincel'); });
  if (btnReiniciar) btnReiniciar.addEventListener('click', function () {
    var idx = piezaVisible();
    if (idx < 0) return;
    var p = piezas[idx];
    p.planos = null; p._planosEscala = null;
    p.pincel = null; p.pincelListo = false;
    p.pincelVersion = (p.pincelVersion || 0) + 1;
    if (visorCtrl) visorCtrl.desmarcar();
    refrescar();
  });

  function actualizarBarraVisor(p, corte) {
    var barra = $('#visor-barra');
    if (!barra) return;
    barra.classList.toggle('is-hidden', !p);
    if (!p) {
      if (panelPlanos) panelPlanos.classList.add('is-hidden');
      if (panelPincel) panelPincel.classList.add('is-hidden');
      return;
    }
    [[btnVer, 'ver'], [btnEditar, 'editar'], [btnPincel, 'pincel']].forEach(function (par) {
      if (par[0]) par[0].classList.toggle('visor-btn--activo', visorModo === par[1]);
    });
    if (btnEditar) btnEditar.disabled = !(corte && !corte.pincel);
    if (btnReiniciar) btnReiniciar.disabled = !(p.planos || p.pincelListo || (p.pincel && p.pincel.some(function (e) { return e; })));

    if (panelPlanos) {
      var mostrarPlanos = visorModo === 'editar' && corte && !corte.pincel;
      panelPlanos.classList.toggle('is-hidden', !mostrarPlanos);
      if (mostrarPlanos) construirSlidersPlanos(p, corte);
      else panelPlanos.innerHTML = '';
    }
    if (panelPincel) {
      panelPincel.classList.toggle('is-hidden', visorModo !== 'pincel');
      if (visorModo === 'pincel' && !panelPincel.childNodes.length) construirPanelPincel();
    }
  }

  function construirSlidersPlanos(p, corte) {
    var s = escalaDe(p);
    panelPlanos.innerHTML = '';
    var EJES = ['x', 'y', 'z'];
    var NOMBRES = { x: 'Ancho (X)', y: 'Fondo (Y)', z: 'Alto (Z)' };
    EJES.forEach(function (eje, a) {
      var lista = corte.fronteras[eje];
      if (!lista || !lista.length) return;
      var lo = corte.limites.min[a] + 1, hi = corte.limites.max[a] - 1;
      lista.forEach(function (valor, i) {
        var fila = document.createElement('div');
        fila.className = 'plano-fila';
        var eti = document.createElement('span');
        eti.textContent = NOMBRES[eje] + ' · corte ' + (i + 1);
        var rango = document.createElement('input');
        rango.type = 'range';
        rango.min = lo.toFixed(0); rango.max = hi.toFixed(0);
        rango.step = '1'; rango.value = Math.round(valor);
        var num = document.createElement('span');
        num.className = 'plano-mm';
        num.textContent = Math.round(valor - corte.limites.min[a]) + ' mm';
        rango.addEventListener('input', function () {
          var v = parseFloat(rango.value);
          num.textContent = Math.round(v - corte.limites.min[a]) + ' mm';
          if (!p.planos || p._planosEscala !== s) {
            p.planos = { x: corte.fronteras.x.slice(),
                         y: corte.fronteras.y.slice(),
                         z: corte.fronteras.z.slice() };
            p._planosEscala = s;
          }
          p.planos[eje][i] = v;
          /* la línea se mueve en vivo; el recorte y el precio, con calma */
          if (visorCtrl) visorCtrl.configurar({
            camaMm: CONFIG.camaMm, alturaMm: CONFIG.alturaMm,
            camas: centrosDePlacas(p, s), planos: p.planos
          });
          clearTimeout(timerPlanos);
          timerPlanos = setTimeout(refrescar, 300);
        });
        fila.appendChild(eti); fila.appendChild(rango); fila.appendChild(num);
        panelPlanos.appendChild(fila);
      });
    });
  }

  function construirPanelPincel() {
    panelPincel.innerHTML = '';
    var eti = document.createElement('span');
    eti.textContent = 'Sección:';
    panelPincel.appendChild(eti);

    var botones = [];
    function botonSeccion(nombre, colorCss, valor) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pincel-sec';
      b.textContent = nombre;
      if (colorCss) b.style.background = colorCss;
      b.addEventListener('click', function () {
        pincelSeccion = valor;
        botones.forEach(function (x) { x.classList.remove('pincel-sec--activo'); });
        b.classList.add('pincel-sec--activo');
      });
      botones.push(b);
      panelPincel.appendChild(b);
      return b;
    }
    SECCIONES_PINCEL.forEach(function (sec, i) {
      var css = 'rgb(' + sec.color.map(function (c) { return Math.round(c * 255); }).join(',') + ')';
      var b = botonSeccion(sec.nombre, css, i + 1);
      if (i + 1 === pincelSeccion) b.classList.add('pincel-sec--activo');
    });
    botonSeccion('Borrar', '', 0);

    var etiT = document.createElement('span');
    etiT.textContent = 'Tamaño:';
    panelPincel.appendChild(etiT);
    var rango = document.createElement('input');
    rango.type = 'range'; rango.min = '10'; rango.max = '90';
    rango.value = pincelRadio;
    rango.addEventListener('input', function () {
      pincelRadio = parseInt(rango.value, 10) || 34;
      var idx = piezaVisible();
      if (visorCtrl && idx >= 0 && visorModo === 'pincel') {
        visorCtrl.pincel(pincelRadio, function (indices) { alPintarPincel(piezas[idx], indices); });
      }
    });
    panelPincel.appendChild(rango);

    var aplicar = document.createElement('button');
    aplicar.type = 'button';
    aplicar.className = 'btn btn--primary btn--sm';
    aplicar.textContent = 'Aplicar corte';
    aplicar.addEventListener('click', function () {
      var idx = piezaVisible();
      if (idx < 0) return;
      var p = piezas[idx];
      if (!p.pincel || !p.pincel.some(function (e) { return e; })) return;
      p.pincelListo = true;
      p.pincelVersion = (p.pincelVersion || 0) + 1;
      visorModo = 'ver';
      refrescar();
    });
    panelPincel.appendChild(aplicar);
  }

  function alPintarPincel(p, indices) {
    if (!p.malla) return;
    var nTri = Math.floor(p.malla.length / 9);
    if (!p.pincel) p.pincel = new Uint8Array(nTri);
    var nuevos = [], i, t;
    for (i = 0; i < indices.length; i++) {
      t = indices[i];
      if (t >= nTri || p.pincel[t] === pincelSeccion) continue;
      p.pincel[t] = pincelSeccion;
      nuevos.push(t);
    }
    if (!nuevos.length) return;
    if (pincelSeccion === 0) {
      /* borrar exige redibujar todas las marcas */
      if (visorCtrl) { visorCtrl.desmarcar(); repintarMarcas(p); }
    } else if (visorCtrl) {
      visorCtrl.marcar(nuevos, SECCIONES_PINCEL[pincelSeccion - 1].color);
    }
  }

  function repintarMarcas(p) {
    if (!visorCtrl || !p.pincel) return;
    visorCtrl.desmarcar();
    for (var sec = 1; sec <= SECCIONES_PINCEL.length; sec++) {
      var lista = [];
      for (var t = 0; t < p.pincel.length; t++) {
        if (p.pincel[t] === sec) lista.push(t);
      }
      if (lista.length) visorCtrl.marcar(lista, SECCIONES_PINCEL[sec - 1].color);
    }
  }

  /* ------------------------------------------------------- archivos --- */

  function agregar(files) {
    Array.prototype.forEach.call(files, function (file) {
      var ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ext !== 'stl' && ext !== '3mf') {
        piezas.push({ nombre: file.name, error: 'Formato no soportado. Solo STL o 3MF.', cantidad: 1 });
        render(); return;
      }
      var pieza = { nombre: file.name, cargando: true, cantidad: 1 };
      piezas.push(pieza); render();

      var reader = new FileReader();
      reader.onload = function () {
        Promise.resolve()
          .then(function () {
            if (ext === 'stl') {
              var tri = parseSTL(reader.result);
              return { volumenMm3: volumenDeMalla(tri), caja: cajaDeMalla(tri), malla: tri };
            }
            return parse3MF(reader.result);
          })
          .then(function (r) {
            pieza.cargando = false;
            pieza.volumenCm3 = r.volumenMm3 / 1000;
            pieza.caja = r.caja;
            pieza.malla = r.malla;
            pieza.partes = r.partes || null;
            pieza.placas = r.placas || 0;
            pieza.gramosSlicer = r.gramosSlicer || 0;
            pieza.horasSlicer = r.horasSlicer || 0;
            pieza.areaMm2 = r.malla ? areaDeMalla(r.malla) : 0;
            pieza.coloresUsados = coloresDistintos(r.partes);
            pieza.tamanoNatural = Math.max(r.caja[0], r.caja[1], r.caja[2]);
            pieza.tamanoDeseado = Math.round(pieza.tamanoNatural) || 1;
            if (!(pieza.volumenCm3 > 0)) throw new Error('El modelo no tiene volumen medible.');
            render();
          })
          .catch(function (err) {
            pieza.cargando = false;
            pieza.error = err.message || 'No se pudo leer el archivo.';
            render();
          });
      };
      reader.onerror = function () {
        pieza.cargando = false; pieza.error = 'No se pudo leer el archivo.'; render();
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ------------------------------------------------------ renderizado ---

     render() reconstruye las filas (agregar/quitar archivos); refrescar()
     solo recalcula números y textos sin tocar los inputs, para que el
     usuario no pierda el foco mientras teclea un tamaño o una cantidad.  */

  var timerCorte = null;

  function control(etiqueta, inp) {
    var lab = document.createElement('label');
    lab.className = 'filerow__ctl';
    var sp = document.createElement('span');
    sp.textContent = etiqueta;
    lab.appendChild(sp); lab.appendChild(inp);
    return lab;
  }

  function render() {
    lista.innerHTML = '';
    vacio.classList.toggle('is-hidden', piezas.length > 0);
    resumen.classList.toggle('is-hidden', piezas.length === 0);
    /* Con piezas cargadas la zona de subida se encoge para que el estimado
       quede a la vista sin hacer scroll. */
    zona.classList.toggle('dropzone--compacta', piezas.length > 0);

    piezas.forEach(function (p, idx) {
      var row = document.createElement('div');
      row.className = 'filerow' + (p.error ? ' filerow--error' : '');
      p._rowEl = row;

      var left = document.createElement('div');
      left.innerHTML = '<div class="filerow__name"></div><div class="filerow__meta"></div>';
      left.querySelector('.filerow__name').textContent = p.nombre;
      p._metaEl = left.querySelector('.filerow__meta');

      /* Optimización de color: solo aparece cuando el modelo trae más de
         un color y por lo tanto hay algo que separar. */
      if (!p.error && !p.cargando && p.coloresUsados > 1) {
        var opc = document.createElement('label');
        opc.className = 'filerow__color';
        var chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = !!p.porColor;
        chk.addEventListener('change', function () {
          p.porColor = chk.checked;
          refrescar();
        });
        opc.appendChild(chk);
        opc.appendChild(document.createTextNode(
          ' Imprimir por colores y pegar — sin purga del AMS'));
        left.appendChild(opc);
      }

      var right = document.createElement('div');
      right.className = 'filerow__right';

      if (!p.error && !p.cargando) {
        var tam = document.createElement('input');
        tam.type = 'number'; tam.min = '5'; tam.max = String(CONFIG.tamanoMaxMm);
        tam.step = '1'; tam.value = Math.round(p.tamanoDeseado);
        tam.className = 'filerow__qty filerow__tam';
        tam.setAttribute('aria-label', 'Tamaño final de ' + p.nombre + ' en milímetros, lado mayor');
        tam.title = 'Tamaño final de la pieza (mm, lado mayor). Si no cabe en la impresora, se corta en secciones.';
        tam.addEventListener('input', function () {
          var v = parseFloat(tam.value);
          if (isFinite(v) && v > 0) {
            p.tamanoDeseado = Math.min(Math.max(v, 5), CONFIG.tamanoMaxMm);
          }
          clearTimeout(timerCorte);
          timerCorte = setTimeout(refrescar, 160);   // cortar la malla cuesta
        });
        tam.addEventListener('change', function () {
          tam.value = Math.round(p.tamanoDeseado);
          refrescar();
        });

        var qty = document.createElement('input');
        qty.type = 'number'; qty.min = '1'; qty.value = p.cantidad;
        qty.className = 'filerow__qty';
        qty.setAttribute('aria-label', 'Cantidad de ' + p.nombre);
        qty.addEventListener('input', function () {
          p.cantidad = Math.max(1, parseInt(qty.value, 10) || 1); refrescar();
        });

        var price = document.createElement('span');
        price.className = 'filerow__price';
        p._priceEl = price;

        right.appendChild(control('mm', tam));
        right.appendChild(control('pzas', qty));
        right.appendChild(price);
      } else {
        p._priceEl = null;
      }

      var del = document.createElement('button');
      del.type = 'button'; del.className = 'filerow__remove';
      del.setAttribute('aria-label', 'Quitar ' + p.nombre);
      del.textContent = '×';
      del.addEventListener('click', function () {
        piezas.splice(idx, 1);
        if (visorSel === idx) visorSel = -1;
        else if (visorSel > idx) visorSel--;
        render();
      });
      right.appendChild(del);

      row.appendChild(left); row.appendChild(right);
      row.addEventListener('click', function (e) {
        if (e.target.closest('input, button, a')) return;
        if (!p.malla) return;
        visorSel = idx;
        actualizarVisor();
      });
      lista.appendChild(row);
    });

    refrescar();
  }

  function refrescar() {
    var relleno = parseFloat(selRell.value);
    var mat = selMat.value;
    var total = 0, gramosTot = 0, horasTot = 0, listas = 0;

    piezas.forEach(function (p) {
      if (!p._metaEl) return;
      if (p.cargando) { p._metaEl.textContent = 'Leyendo el modelo…'; return; }
      if (p.error)    { p._metaEl.textContent = p.error; return; }

      var s = escalaDe(p);
      var volE = p.volumenCm3 * s * s * s;
      var cajaE = [p.caja[0] * s, p.caja[1] * s, p.caja[2] * s];
      var corte = corteDe(p, s);
      var regiones = (!corte && p.porColor) ? regionesPorColor(p) : null;
      var q;
      if (regiones) {
        var cajasReg = regiones.map(function (g) {
          return [(g.max[0] - g.min[0]) * s, (g.max[1] - g.min[1]) * s,
                  (g.max[2] - g.min[2]) * s];
        });
        q = cotizar(volE, mat, relleno, p.cantidad, cajaE, null,
                    cajasReg, p.placas, (p.areaMm2 || 0) * s * s,
                    1, null, regiones.length);
      } else {
        q = cotizar(volE, mat, relleno, p.cantidad, cajaE, corte,
                    cajasEscaladas(p, s), p.placas,
                    (p.areaMm2 || 0) * s * s, p.coloresUsados || 1,
                    medidoDe(p, s, corte));
      }

      var dims = cajaE.map(function (v) { return Math.round(v); }).join(' × ');
      var nPartes = p.partes ? p.partes.length : 1;

      var meta = '';
      if (nPartes > 1) meta += nPartes + ' piezas · ';
      meta += volE.toFixed(1) + ' cm³ · ' + fmtPeso(q.gramos);
      if (q.delLaminador) meta += ' y ' + q.horas.toFixed(1) + ' h según tu laminador · ';
      else {
        if (regiones) meta += ' (por colores, sin purga)';
        else if (p.coloresUsados > 1) meta += ' (' + p.coloresUsados + ' colores, con purga)';
        meta += ' · ' + q.horas.toFixed(1) + ' h · ';
      }
      meta += (nPartes > 1 ? 'la mayor ' : '') + dims + ' mm';
      if (s !== 1) meta += ' (escala ×' + (s >= 10 ? s.toFixed(1) : s.toFixed(2)) + ')';

      if (corte) {
        meta += ' · se corta en ' + q.secciones + ' secciones para armar · '
             + q.camas + (q.camas === 1 ? ' cama' : ' camas');
      } else if (regiones) {
        meta += ' · ' + q.secciones + ' piezas por color, se pegan · '
             + q.camas + (q.camas === 1 ? ' cama' : ' camas');
      } else if (nPartes > 1) {
        meta += ' · ' + q.camas + (q.camas === 1 ? ' cama' : ' camas');
      } else if (q.porCama === 0) {
        meta += ' · ⚠ no cabe en la cama de ' + CONFIG.camaMm + ' mm';
      } else if (p.cantidad > 1) {
        meta += ' · caben ' + q.porCama + ' por cama, van ' + q.camas
              + (q.camas === 1 ? ' cama' : ' camas');
      }

      p._metaEl.textContent = meta;
      if (p._priceEl) p._priceEl.textContent = fmt(q.total);

      total += q.total; gramosTot += q.gramos * p.cantidad;
      horasTot += q.horas * p.cantidad; listas++;
    });

    totalEl.textContent = listas ? fmt(total) : '—';
    detalle.textContent = listas
      ? listas + (listas === 1 ? ' modelo' : ' modelos') + ' · '
        + fmtPeso(gramosTot) + ' de ' + CONFIG.materiales[mat].nombre
        + ' · ~' + horasTot.toFixed(1) + ' h de impresión'
      : 'Agrega un modelo para ver el estimado.';

    btnMail.href = 'https://wa.me/' + WHATSAPP + '?text='
      + encodeURIComponent(mensajeWhatsApp(mat, relleno, total));

    actualizarVisor();
  }

  /* WhatsApp solo permite prellenar TEXTO: no existe forma de adjuntar un
     archivo desde un enlace wa.me. Además el modelo nunca sale del navegador
     del cliente, así que tampoco hay una URL que mandar. Por eso el mensaje
     nombra los archivos y le pide al cliente que los adjunte en el chat. */
  function mensajeWhatsApp(mat, relleno, total) {
    var l = ['Hola, quiero cotizar estas piezas:', ''];
    var n = 0;
    piezas.forEach(function (p) {
      if (p.error || p.cargando) return;
      n++;
      var s = escalaDe(p);
      var volE = p.volumenCm3 * s * s * s;
      var cajaE = [p.caja[0] * s, p.caja[1] * s, p.caja[2] * s];
      var corte = corteDe(p, s);
      var regiones = (!corte && p.porColor) ? regionesPorColor(p) : null;
      var q;
      if (regiones) {
        var cajasReg = regiones.map(function (g) {
          return [(g.max[0] - g.min[0]) * s, (g.max[1] - g.min[1]) * s,
                  (g.max[2] - g.min[2]) * s];
        });
        q = cotizar(volE, mat, relleno, p.cantidad, cajaE, null,
                    cajasReg, p.placas, (p.areaMm2 || 0) * s * s,
                    1, null, regiones.length);
      } else {
        q = cotizar(volE, mat, relleno, p.cantidad, cajaE, corte,
                    cajasEscaladas(p, s), p.placas,
                    (p.areaMm2 || 0) * s * s, p.coloresUsados || 1,
                    medidoDe(p, s, corte));
      }
      var linea = '• ' + p.nombre + ' · ' + p.cantidad + ' pza · '
                + Math.round(Math.max(cajaE[0], cajaE[1], cajaE[2])) + ' mm · '
                + volE.toFixed(1) + ' cm³ · ' + fmtPeso(q.gramos);
      if (q.delLaminador) linea += ' (dato del laminador)';
      if (regiones) linea += ' · ' + q.secciones + ' piezas por color, pegadas';
      else if (p.coloresUsados > 1) linea += ' · ' + p.coloresUsados + ' colores';
      if (corte) linea += ' · en ' + q.secciones + ' secciones para armar';
      l.push(linea);
    });
    l.push('', 'Material: ' + CONFIG.materiales[mat].nombre,
           'Relleno: ' + Math.round(relleno * 100) + '%',
           'Estimado del sitio: ' + fmt(total), '',
           n === 1 ? 'Enseguida te mando el archivo por aquí.'
                   : 'Enseguida te mando los archivos por aquí.');
    return l.join('\n');
  }

  render();
})();
