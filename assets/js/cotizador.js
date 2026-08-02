/* ==========================================================================
   Emisha — cotizador de impresión 3D
   Lee archivos STL y 3MF en el navegador, calcula el volumen real de la malla
   y estima el precio. Los archivos NUNCA se suben a ningún servidor.
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     CONFIGURACIÓN DE PRECIOS — ajustar aquí y en ningún otro lado.
     Los valores de abajo son un punto de partida, no precios definitivos.
     ====================================================================== */
  var CONFIG = {
    materiales: {
      pla:  { nombre: 'PLA',  densidad: 1.24, precioKg: 249 },
      petg: { nombre: 'PETG', densidad: 1.27, precioKg: 249 }
    },
    // Material realmente depositado = cascarón + relleno.
    fraccionSolida: function (relleno) { return 0.25 + 0.75 * relleno; },
    velocidadCm3PorHora: 12,   // ritmo típico con boquilla de 0.4 mm
    tarifaHora: 60,            // MXN por hora de máquina
    margen: 1.35,              // sobre material + máquina
    preparacionPorPieza: 35,   // MXN, preparación del archivo
    minimoPorPieza: 80,        // MXN, cobro mínimo
    camaMm: 256                // Bambu Lab A1 / P1S / X1: 256 mm por lado
  };

  var $  = function (s, r) { return (r || document).querySelector(s); };
  var fmt = function (n) {
    return '$' + Math.round(n).toLocaleString('es-MX') + ' MXN';
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

  async function parse3MF(buffer) {
    var entries = readZipEntries(buffer);
    var target = entries.filter(function (e) { return /3dmodel\.model$/i.test(e.name); })[0]
              || entries.filter(function (e) { return /\.model$/i.test(e.name); })[0];
    if (!target) throw new Error('El 3MF no contiene un modelo 3D.');

    var xml = await inflateEntry(buffer, target);
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('El modelo dentro del 3MF no se pudo leer.');

    var root  = doc.documentElement;
    var escala = UNIDADES[(root.getAttribute('unit') || 'millimeter').toLowerCase()] || 1;

    // Volumen y caja por cada objeto con malla.
    var porObjeto = {};
    Array.prototype.forEach.call(doc.getElementsByTagName('object'), function (obj) {
      var mesh = obj.getElementsByTagName('mesh')[0];
      if (!mesh) return;
      var vs = mesh.getElementsByTagName('vertex');
      if (!vs.length) return;
      var verts = new Float64Array(vs.length * 3);
      for (var i = 0; i < vs.length; i++) {
        verts[i * 3]     = parseFloat(vs[i].getAttribute('x')) * escala;
        verts[i * 3 + 1] = parseFloat(vs[i].getAttribute('y')) * escala;
        verts[i * 3 + 2] = parseFloat(vs[i].getAttribute('z')) * escala;
      }
      var ts = mesh.getElementsByTagName('triangle');
      var tri = new Float64Array(ts.length * 9), k = 0;
      for (var t = 0; t < ts.length; t++) {
        [ts[t].getAttribute('v1'), ts[t].getAttribute('v2'), ts[t].getAttribute('v3')]
          .forEach(function (idx) {
            var b = (+idx) * 3;
            tri[k++] = verts[b]; tri[k++] = verts[b + 1]; tri[k++] = verts[b + 2];
          });
      }
      porObjeto[obj.getAttribute('id')] = tri;
    });

    // <build> dice qué objetos se imprimen y con qué transformación.
    var items = doc.getElementsByTagName('item');
    var volumen = 0, caja = null;
    if (items.length) {
      Array.prototype.forEach.call(items, function (it) {
        var tri = porObjeto[it.getAttribute('objectid')];
        if (!tri) return;
        var esc = escalaDeTransformacion(it.getAttribute('transform'));
        volumen += volumenDeMalla(tri) * esc;
        caja = unirCaja(caja, cajaDeMalla(tri));
      });
    }
    if (!volumen) {
      Object.keys(porObjeto).forEach(function (id) {
        volumen += volumenDeMalla(porObjeto[id]);
        caja = unirCaja(caja, cajaDeMalla(porObjeto[id]));
      });
    }
    if (!volumen) throw new Error('El 3MF no contiene geometría medible.');
    return { volumenMm3: volumen, caja: caja };
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

  function cajaDeMalla(tri) {
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < tri.length; i += 3) {
      for (var a = 0; a < 3; a++) {
        var val = tri[i + a];
        if (val < min[a]) min[a] = val;
        if (val > max[a]) max[a] = val;
      }
    }
    return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  }

  function unirCaja(a, b) {
    if (!a) return b;
    return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  }

  /* ============================================================ precios */
  function cotizar(volumenCm3, materialKey, relleno, cantidad) {
    var mat = CONFIG.materiales[materialKey];
    var cm3 = volumenCm3 * CONFIG.fraccionSolida(relleno);
    var gramos = cm3 * mat.densidad;
    var material = (gramos / 1000) * mat.precioKg;
    var horas = cm3 / CONFIG.velocidadCm3PorHora;
    var maquina = horas * CONFIG.tarifaHora;
    var unitario = (material + maquina) * CONFIG.margen + CONFIG.preparacionPorPieza;
    unitario = Math.max(unitario, CONFIG.minimoPorPieza);
    return { gramos: gramos, horas: horas, unitario: unitario, total: unitario * cantidad };
  }

  /* ================================================================= UI */
  var piezas = [];
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
  if (!zona) return;

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
  [selMat, selRell].forEach(function (el) { el.addEventListener('change', render); });

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
              return { volumenMm3: volumenDeMalla(tri), caja: cajaDeMalla(tri) };
            }
            return parse3MF(reader.result);
          })
          .then(function (r) {
            pieza.cargando = false;
            pieza.volumenCm3 = r.volumenMm3 / 1000;
            pieza.caja = r.caja;
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

  function render() {
    lista.innerHTML = '';
    vacio.classList.toggle('is-hidden', piezas.length > 0);
    resumen.classList.toggle('is-hidden', piezas.length === 0);

    var relleno = parseFloat(selRell.value);
    var mat = selMat.value;
    var total = 0, gramosTot = 0, horasTot = 0, listas = 0;

    piezas.forEach(function (p, idx) {
      var row = document.createElement('div');
      row.className = 'filerow' + (p.error ? ' filerow--error' : '');

      var meta;
      if (p.cargando)      meta = 'Leyendo el modelo…';
      else if (p.error)    meta = p.error;
      else {
        var c = p.caja.map(function (v) { return v.toFixed(0); }).join(' × ');
        var q = cotizar(p.volumenCm3, mat, relleno, p.cantidad);
        meta = p.volumenCm3.toFixed(1) + ' cm³ · ' + q.gramos.toFixed(0) + ' g · '
             + c + ' mm · ' + q.horas.toFixed(1) + ' h';
        if (Math.max.apply(null, p.caja) > CONFIG.camaMm) {
          meta += ' · ⚠ excede la cama de ' + CONFIG.camaMm + ' mm';
        }
        total += q.total; gramosTot += q.gramos * p.cantidad;
        horasTot += q.horas * p.cantidad; listas++;
      }

      var left = document.createElement('div');
      left.innerHTML = '<div class="filerow__name"></div><div class="filerow__meta"></div>';
      left.querySelector('.filerow__name').textContent = p.nombre;
      left.querySelector('.filerow__meta').textContent = meta;

      var right = document.createElement('div');
      right.className = 'filerow__right';

      if (!p.error && !p.cargando) {
        var qty = document.createElement('input');
        qty.type = 'number'; qty.min = '1'; qty.value = p.cantidad;
        qty.className = 'filerow__qty';
        qty.setAttribute('aria-label', 'Cantidad de ' + p.nombre);
        qty.addEventListener('input', function () {
          p.cantidad = Math.max(1, parseInt(qty.value, 10) || 1); render();
        });
        var price = document.createElement('span');
        price.className = 'filerow__price';
        price.textContent = fmt(cotizar(p.volumenCm3, mat, relleno, p.cantidad).total);
        right.appendChild(qty); right.appendChild(price);
      }

      var del = document.createElement('button');
      del.type = 'button'; del.className = 'filerow__remove';
      del.setAttribute('aria-label', 'Quitar ' + p.nombre);
      del.textContent = '×';
      del.addEventListener('click', function () { piezas.splice(idx, 1); render(); });
      right.appendChild(del);

      row.appendChild(left); row.appendChild(right);
      lista.appendChild(row);
    });

    totalEl.textContent = listas ? fmt(total) : '—';
    detalle.textContent = listas
      ? listas + (listas === 1 ? ' modelo' : ' modelos') + ' · '
        + gramosTot.toFixed(0) + ' g de ' + CONFIG.materiales[mat].nombre
        + ' · ~' + horasTot.toFixed(1) + ' h de impresión'
      : 'Agrega un modelo para ver el estimado.';

    btnMail.href = 'mailto:3dprint@emisha.com.mx?subject='
      + encodeURIComponent('Cotización de impresión 3D')
      + '&body=' + encodeURIComponent(cuerpoCorreo(mat, relleno, total));
  }

  function cuerpoCorreo(mat, relleno, total) {
    var l = ['Hola, quiero cotizar estas piezas:', ''];
    piezas.forEach(function (p) {
      if (p.error || p.cargando) return;
      var q = cotizar(p.volumenCm3, mat, relleno, p.cantidad);
      l.push('• ' + p.nombre + ' — ' + p.cantidad + ' pza · '
             + p.volumenCm3.toFixed(1) + ' cm³ · ' + q.gramos.toFixed(0) + ' g');
    });
    l.push('', 'Material: ' + CONFIG.materiales[mat].nombre,
           'Relleno: ' + Math.round(relleno * 100) + '%',
           'Estimado del sitio: ' + fmt(total), '',
           'Adjunto los archivos a este correo.', '');
    return l.join('\n');
  }

  render();

  /* Gancho de pruebas: expone el motor de geometría para poder verificarlo
     desde la consola o desde un script de pruebas. No lo usa la interfaz. */
  window.__emishaQuote = {
    parseSTL: parseSTL, parse3MF: parse3MF,
    volumen: volumenDeMalla, caja: cajaDeMalla, cotizar: cotizar
  };
})();
