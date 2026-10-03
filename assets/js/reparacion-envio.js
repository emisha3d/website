/* Emisha — /reparacion/envio/: el cliente de fuera de CDMX cotiza y paga la
   guía para mandarnos su impresora. El worker de checkout cotiza en Skydropx
   (del domicilio del cliente al taller), cobra con Mercado Pago lo que cobra
   la paquetería + 10 %, y el taller compra la guía después desde /admin; al
   cliente le llega el PDF por correo. El precio nunca sale de aquí: el
   worker cobra lo que él mismo cotizó. */
(function () {
  'use strict';

  var API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
    ? 'http://localhost:8787'
    : 'https://emisha-checkout.matosic-hrvoje.workers.dev';

  // Las citas viven en el worker de reparaciones (el mismo que usa /reparacion/).
  var API_CITAS = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
    ? 'http://localhost:8788'
    : 'https://emisha-reparaciones.matosic-hrvoje.workers.dev';

  var form = document.querySelector('[data-envio-form]');
  if (!form) return;
  var f = form.elements;
  var aviso = document.querySelector('[data-envio-aviso]');
  var btnCotizar = form.querySelector('[data-cotizar]');
  var estadoCot = form.querySelector('[data-cotizar-estado]');
  var caja = form.querySelector('[data-opciones]');
  var lista = form.querySelector('[data-opciones-lista]');
  var btnPagar = form.querySelector('[data-pagar]');
  var cpEstado = form.querySelector('[data-cp-estado]');
  var coloniaSel = form.querySelector('[data-colonia-sel]');
  var mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

  var cotizacion = null;   // {cotizacion_id, opciones, cp}
  var cpUltimo = '';

  function decir(texto, tipo) {
    if (!texto) { aviso.hidden = true; return; }
    aviso.className = 'cita-aviso' + (tipo ? ' cita-aviso--' + tipo : '');
    aviso.textContent = texto;
    aviso.hidden = false;
    aviso.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /* ---------------- Modelo «Otro» y «¿Cómo nos encontraste?» ------------ */
  var otro = form.querySelector('[data-modelo-otro]');
  f.modelo.addEventListener('change', function () {
    otro.hidden = f.modelo.value !== 'Otro';
    f.modelo_otro.required = !otro.hidden;
  });
  var refDetalle = form.querySelector('[data-referencia-detalle]');
  f.referencia.addEventListener('change', function () {
    refDetalle.hidden = !(f.referencia.value === 'recomendacion' || f.referencia.value === 'otro');
  });

  /* ---------------- Código postal → colonia, municipio, estado ---------- */
  function mostrarInputColonia(valor) {
    coloniaSel.hidden = true;
    f.colonia.hidden = false;
    if (valor != null) f.colonia.value = valor;
  }
  function mostrarSelectColonia(colonias) {
    coloniaSel.innerHTML = '<option value="">Elige tu colonia</option>' +
      colonias.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') +
      '<option value="__otra__">Otra (escribirla)</option>';
    coloniaSel.hidden = false;
    f.colonia.hidden = true;
    f.colonia.value = '';
  }
  coloniaSel.addEventListener('change', function () {
    if (coloniaSel.value === '__otra__') { mostrarInputColonia(''); f.colonia.focus(); return; }
    f.colonia.value = coloniaSel.value;
    invalidar();
  });

  function buscarCp() {
    var codigo = (f.cp.value || '').trim();
    if (!/^[0-9]{5}$/.test(codigo) || codigo === cpUltimo) return;
    cpUltimo = codigo;
    cpEstado.textContent = 'Buscando…';
    fetch(API + '/cp?codigo=' + codigo)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (r) {
        if (!r.ok) {
          // No está en SEPOMEX: casi siempre es un dígito equivocado, y las
          // paqueterías tampoco lo aceptan (Skydropx contesta "no existe").
          mostrarInputColonia();
          f.ciudad.value = f.estado.value = '';
          cpEstado.textContent = 'Ese código postal no existe en el catálogo de Correos de México. Revísalo: viene en tu recibo de luz o en Google Maps.';
          return;
        }
        f.ciudad.value = r.d.municipio;
        f.estado.value = r.d.estado;
        var colonias = r.d.colonias || [];
        if (colonias.length === 1) mostrarInputColonia(colonias[0]);
        else if (colonias.length > 1) mostrarSelectColonia(colonias);
        else mostrarInputColonia();
        cpEstado.textContent = r.d.municipio + ', ' + r.d.estado;
      })
      .catch(function () {
        cpUltimo = '';
        mostrarInputColonia();
        cpEstado.textContent = 'No pudimos consultar el código postal. Escribe los datos a mano.';
      });
  }
  f.cp.addEventListener('input', function () {
    invalidar();
    if (/^[0-9]{5}$/.test(f.cp.value.trim())) buscarCp();
  });

  /* ---------------- Cotizar ------------------------------------------- */
  // Cualquier cambio en la caja o el lugar vuelve a pedir cotización: el
  // precio depende de las dos cosas.
  function invalidar() {
    if (!cotizacion) return;
    cotizacion = null;
    caja.hidden = true;
    lista.innerHTML = '';
    btnPagar.disabled = true;
    btnPagar.textContent = 'Pagar guía';
    estadoCot.textContent = 'Cambiaste datos: vuelve a cotizar.';
  }
  ['peso_kg', 'largo_cm', 'ancho_cm', 'alto_cm', 'colonia', 'ciudad', 'estado', 'valor_mxn'].forEach(function (k) {
    f[k].addEventListener('input', invalidar);
  });

  // Seguro: el valor declarado cambia el precio, y sin caja original no se
  // ofrece Estafeta; las dos cosas piden cotizar otra vez.
  var asegurar = form.querySelector('[data-asegurar]');
  var camposSeguro = form.querySelector('[data-seguro-campos]');
  asegurar.addEventListener('change', function () {
    camposSeguro.hidden = !asegurar.checked;
    f.valor_mxn.required = asegurar.checked;
    invalidar();
  });
  Array.prototype.forEach.call(f.caja_original, function (r) { r.addEventListener('change', invalidar); });
  function datosSeguro() {
    var original = form.querySelector('input[name="caja_original"]:checked');
    return {
      quiere: asegurar.checked,
      valor_mxn: asegurar.checked ? parseFloat(f.valor_mxn.value) : null,
      caja_original: !!(original && original.value === 'si')
    };
  }

  function datosCaja() {
    return {
      peso_kg: parseFloat(f.peso_kg.value),
      largo_cm: parseFloat(f.largo_cm.value),
      ancho_cm: parseFloat(f.ancho_cm.value),
      alto_cm: parseFloat(f.alto_cm.value)
    };
  }

  function revisar(campos) {
    for (var i = 0; i < campos.length; i++) {
      var el = f[campos[i]];
      if (el && !el.checkValidity()) { el.reportValidity(); el.focus(); return false; }
    }
    return true;
  }

  btnCotizar.addEventListener('click', function () {
    decir('');
    // La colonia puede estar escondida tras el select: se revisa aparte.
    if (!revisar(['peso_kg', 'largo_cm', 'ancho_cm', 'alto_cm'])) return;
    if (!form.querySelector('input[name="caja_original"]:checked')) { decir('Dinos si va en su caja original.', 'error'); return; }
    if (asegurar.checked && !revisar(['valor_mxn'])) return;
    if (!revisar(['cp', 'ciudad', 'estado'])) return;
    if (!f.colonia.value.trim()) { decir('Elige tu colonia.', 'error'); return; }
    btnCotizar.disabled = true;
    estadoCot.textContent = 'Preguntando a las paqueterías… (unos segundos)';
    fetch(API + '/recoleccion/cotizar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        direccion: { cp: f.cp.value.trim(), colonia: f.colonia.value.trim(), ciudad: f.ciudad.value.trim(), estado: f.estado.value.trim() },
        caja: datosCaja(),
        seguro: datosSeguro()
      })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.d.error || 'No pudimos cotizar.');
        cotizacion = { cotizacion_id: r.d.cotizacion_id, opciones: r.d.opciones, cp: f.cp.value.trim(), seguro: r.d.seguro };
        var seg = r.d.seguro;
        lista.innerHTML = r.d.opciones.map(function (o, i) {
          var dias = o.dias ? (o.dias === 1 ? '1 día' : o.dias + ' días') : '';
          return '<label class="opcion"><input type="radio" name="tarifa" value="' + esc(o.id) + '"' + (i === 0 ? ' checked' : '') + '>' +
            '<span class="opcion__txt"><b>' + esc(o.paqueteria) + '</b>' +
            '<small>' + esc([o.servicio, dias && 'llega en ' + dias].filter(Boolean).join(' · ')) + '</small>' +
            (seg ? '<small>Guía ' + mxn.format(o.centavos / 100) + ' + seguro ' + mxn.format(seg.centavos / 100) + '</small>' : '') +
            '</span><b class="precio">' + mxn.format(o.total_centavos / 100) + '</b></label>';
        }).join('');
        caja.hidden = false;
        estadoCot.textContent = '';
        btnPagar.disabled = false;
        precioBoton();
      })
      .catch(function (e) {
        estadoCot.textContent = '';
        decir(e.message, 'error');
      })
      .then(function () { btnCotizar.disabled = false; });
  });

  function elegida() {
    if (!cotizacion) return null;
    var r = form.querySelector('input[name="tarifa"]:checked');
    if (!r) return null;
    for (var i = 0; i < cotizacion.opciones.length; i++) if (cotizacion.opciones[i].id === r.value) return cotizacion.opciones[i];
    return null;
  }
  function precioBoton() {
    var o = elegida();
    btnPagar.textContent = o
      ? (cotizacion.seguro ? 'Pagar guía y seguro · ' : 'Pagar guía · ') + mxn.format(o.total_centavos / 100)
      : 'Pagar guía';
  }
  lista.addEventListener('change', precioBoton);

  /* ---------------- Viene de una cita (?cita=<uuid>) ------------------- */
  // «Quiero enviar mi impresora» en la página de su cita: llega con nombre,
  // modelo y falla ya puestos, y el pedido queda ligado a esa cita para que
  // el taller sepa que ya no viene en persona. Correo y WhatsApp no salen de
  // la consulta pública de la cita, así que se piden aquí.
  var citaId = new URLSearchParams(location.search).get('cita');
  var cita = null;
  if (citaId && /^[0-9a-f-]{36}$/.test(citaId)) {
    fetch(API_CITAS + '/cita/' + citaId)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        if (!c || c.estado !== 'nueva') return;
        cita = { id: c.cita_id, folio: c.folio };
        if (!f.nombre.value) f.nombre.value = c.nombre || '';
        var equipos = (c.equipos && c.equipos.length) ? c.equipos : [{ modelo: c.modelo, descripcion: '', tipo_falla: c.tipo_falla }];
        // El modelo de la cita viene legible ("Bambu Lab X1 Carbon"): se busca
        // la opción más larga que aparezca en el texto ("A1 mini" antes que "A1").
        var texto = String(equipos[0].modelo || '');
        var opciones = Array.prototype.map.call(f.modelo.options, function (o) { return o.value; })
          .filter(function (v) { return v && v !== 'Otro'; })
          .sort(function (a, b) { return b.length - a.length; });
        var hallado = opciones.filter(function (v) { return texto.toLowerCase().indexOf(v.toLowerCase()) !== -1; })[0];
        f.modelo.value = hallado || 'Otro';
        if (!hallado) f.modelo_otro.value = texto.slice(0, 50);
        f.modelo.dispatchEvent(new Event('change'));
        if (!f.falla.value) {
          f.falla.value = equipos.map(function (e) {
            return (equipos.length > 1 ? e.modelo + ': ' : '') + [e.tipo_falla, e.descripcion].filter(Boolean).join('. ');
          }).join('\n') + (c.trae_ams ? '\nMando también el AMS.' : '');
        }
        var nota = document.createElement('div');
        nota.className = 'cita-aviso cita-aviso--ok';
        nota.innerHTML = 'Vas a mandar por paquetería la impresora de tu cita <b>' + esc(c.folio) + '</b>. ' +
          'Ya no tienes que venir el ' + esc(c.fecha_legible) + '; tu cita queda como tu orden de reparación. ' +
          'Solo falta la caja, tu dirección y tus datos.';
        form.parentNode.insertBefore(nota, form);
      })
      .catch(function () { /* sin cita, el formulario sirve igual */ });
  }

  /* ---------------- Pagar --------------------------------------------- */
  function origenWeb() {
    try { return JSON.parse(localStorage.getItem('emisha-origen-v1')) || undefined; } catch (e) { return undefined; }
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    decir('');
    var o = elegida();
    if (!o) { decir('Primero cotiza y elige una paquetería.', 'error'); return; }
    if (!revisar(['modelo', 'modelo_otro', 'falla', 'calle', 'nombre', 'telefono', 'correo'])) return;
    var modelo = f.modelo.value === 'Otro' ? (f.modelo_otro.value.trim() || 'Otro') : f.modelo.value;

    btnPagar.disabled = true;
    btnPagar.textContent = 'Abriendo Mercado Pago…';
    fetch(API + '/recoleccion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cotizacion_id: cotizacion.cotizacion_id,
        tarifa_id: o.id,
        cliente: {
          nombre: f.nombre.value.trim(),
          correo: f.correo.value.trim(),
          telefono: f.telefono.value.trim(),
          referencia: f.referencia.value,
          referencia_detalle: f.referencia_detalle.value.trim()
        },
        direccion: {
          calle: f.calle.value.trim(), colonia: f.colonia.value.trim(), cp: f.cp.value.trim(),
          ciudad: f.ciudad.value.trim(), estado: f.estado.value.trim(), referencias: f.referencias.value.trim()
        },
        impresora: { modelo: modelo, falla: f.falla.value.trim() },
        cita: cita || undefined,
        origen_web: origenWeb()
      })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (r) {
        if (!r.ok) {
          // 409 = la cotización venció o cambió el CP: hay que cotizar otra vez.
          if (r.status === 409) invalidar();
          throw new Error(r.d.error || 'No pudimos crear el pago.');
        }
        try { localStorage.setItem('emisha-ultimo-pedido', r.d.pedido_id); } catch (e) {}
        location.href = r.d.url_pago;
      })
      .catch(function (e) {
        decir(e.message + ' Si sigue fallando, escríbenos por WhatsApp al 55 7563 9255.', 'error');
        btnPagar.disabled = !cotizacion;
        precioBoton();
      });
  });
})();
