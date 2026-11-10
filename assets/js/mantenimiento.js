/* Emisha — agendar un mantenimiento preventivo (/reparacion/mantenimiento-preventivo/agendar/).

   Mismo worker y misma agenda que /reparacion/ (un mantenimiento ocupa el
   mismo turno de recepción), pero su propio formulario: impresoras con AMS,
   horas de uso y notas; sin tipo de falla ni diagnóstico. Precio fijo: $700 por
   impresora y $300 por AMS, IVA incluido. Manda a POST /mantenimiento.

   ?cita=<uuid> (el enlace de sus correos) muestra cómo va ese mantenimiento.
   Si el uuid es de una reparación, manda a /reparacion/?cita=, que es su página.
   reparacion.js no se toca: las reparaciones siguen igual. */
(function () {
  'use strict';

  var API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
    ? 'http://localhost:8787'
    : 'https://citas.emisha.com.mx';
  var WA_NUM = 'https://wa.me/525575639255';
  var WA = WA_NUM + '?text=' + encodeURIComponent('Hola, quiero agendar un mantenimiento preventivo para mi Bambu Lab.');
  var PRECIO = 700, PRECIO_AMS = 300;   // pesos, IVA incluido (los cobra el worker igual)
  var MAX_IMPRESORAS = 40;

  var form = document.querySelector('[data-mant-form]');
  var conf = document.querySelector('[data-confirmacion]');
  var aviso = document.querySelector('[data-cita-aviso]');
  if (!form || !conf) return;

  var cajaDias = form.querySelector('[data-dias]');
  var cajaTurnos = form.querySelector('[data-turnos]');
  var turnosVacio = form.querySelector('[data-turnos-vacio]');
  var elegida = form.querySelector('[data-elegida]');
  var botonEnviar = form.querySelector('[data-enviar]');
  var cajaEquipos = form.querySelector('[data-equipos]');
  var botonAgregar = form.querySelector('[data-agregar-equipo]');
  var resumen = document.querySelector('[data-resumen]');
  var dias = [], diaSel = null, horaSel = null;

  /* --- Utilidades ------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pesos(n) { return '$' + Number(n).toLocaleString('es-MX', { maximumFractionDigits: 0 }) + ' MXN'; }
  function mxn(cent) { return cent == null ? '' : pesos(cent / 100); }
  function plural(n, una, varias) { return n === 1 ? una : varias; }

  function avisar(texto, tipo, sinMover) {
    aviso.textContent = texto || '';
    aviso.hidden = !texto;
    aviso.className = 'cita-aviso' + (tipo ? ' cita-aviso--' + tipo : '');
    if (texto && !sinMover && aviso.scrollIntoView) aviso.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Igual que reparacion.js: 15 s para leer, 30 s para agendar.
  function pedir(ruta, opciones) {
    opciones = opciones || {};
    if (window.AbortSignal && AbortSignal.timeout) {
      opciones.signal = AbortSignal.timeout(opciones.method && opciones.method !== 'GET' ? 30000 : 15000);
    }
    return fetch(API + ruta, opciones).then(function (r) {
      return r.json().then(function (d) { return { status: r.status, datos: d }; });
    });
  }

  function partesDia(d) {
    var t = d.legible.split(' ');
    return { semana: t[0].slice(0, 3), num: t[1], mes: (t[3] || '').slice(0, 3) };
  }

  /* --- Días y turnos (los mismos de /reparacion/) ------------------------ */

  function cargarDisponibilidad(mantener) {
    return pedir('/disponibilidad').then(function (r) {
      if (r.status !== 200 || !r.datos.dias) throw new Error('sin datos');
      dias = r.datos.dias;
      pintarDias();
      if (mantener && diaSel && dias.some(function (d) { return d.fecha === diaSel; })) {
        elegirDia(diaSel);
      } else if (!mantener) {
        var primero = dias.filter(function (d) { return d.libres > 0; })[0];
        if (primero) elegirDia(primero.fecha);
      }
    }).catch(function () {
      cajaDias.innerHTML = '';
      cajaTurnos.hidden = true;
      avisar('Ahorita no podemos cargar los turnos en línea. Escríbenos por WhatsApp al ' +
        '+52 55 7563 9255 con el modelo de tu impresora y el día que te acomoda, y te apartamos el lugar.', 'error', true);
      botonEnviar.disabled = false;
      botonEnviar.textContent = 'Agendar por WhatsApp';
      botonEnviar.type = 'button';
      if (!botonEnviar.dataset.wa) {
        botonEnviar.dataset.wa = '1';
        botonEnviar.addEventListener('click', function () {
          if (botonEnviar.dataset.wa === '1') window.open(WA, '_blank', 'noopener');
        });
      }
    });
  }

  function pintarDias() {
    cajaDias.textContent = '';
    if (!dias.length) {
      cajaDias.innerHTML = '<span class="muted" style="font-size:.9rem">No hay turnos en línea las próximas semanas. Escríbenos por WhatsApp.</span>';
      return;
    }
    dias.forEach(function (d) {
      var p = partesDia(d);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dia';
      b.dataset.fecha = d.fecha;
      b.setAttribute('aria-pressed', String(d.fecha === diaSel));
      b.disabled = d.libres === 0;
      b.innerHTML = '<small>' + esc(p.semana) + '</small><b>' + esc(p.num) + ' ' + esc(p.mes) + '</b>' +
        '<small>' + (d.libres === 0 ? 'lleno' : d.libres + plural(d.libres, ' lugar', ' lugares')) + '</small>';
      b.addEventListener('click', function () { elegirDia(d.fecha); });
      cajaDias.appendChild(b);
    });
  }

  function elegirDia(fecha) {
    diaSel = fecha;
    horaSel = null;
    cajaDias.querySelectorAll('.dia').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.fecha === fecha));
    });
    var d = dias.filter(function (x) { return x.fecha === fecha; })[0];
    if (!d) return;
    cajaTurnos.textContent = '';
    d.turnos.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'turno';
      b.textContent = t.hora;
      b.disabled = !t.libre;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () { elegirHora(t.hora); });
      cajaTurnos.appendChild(b);
    });
    cajaTurnos.hidden = false;
    turnosVacio.hidden = d.libres > 0;
    turnosVacio.textContent = d.libres > 0 ? '' : 'Ese día ya está lleno. Elige otro.';
    pintarElegida();
    var activo = cajaDias.querySelector('[aria-pressed="true"]');
    if (activo && cajaDias.scrollTo) {
      cajaDias.scrollTo({ left: activo.offsetLeft - (cajaDias.clientWidth - activo.offsetWidth) / 2, behavior: 'smooth' });
    }
  }

  function elegirHora(hora) {
    horaSel = hora;
    cajaTurnos.querySelectorAll('.turno').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.textContent === hora));
    });
    pintarElegida();
  }

  function pintarElegida() {
    var d = dias.filter(function (x) { return x.fecha === diaSel; })[0];
    if (!d || !horaSel) { elegida.hidden = true; return; }
    elegida.innerHTML = 'Tu turno: <b>' + esc(d.legible) + ' a las ' + esc(horaSel) + '</b>.';
    elegida.hidden = false;
  }

  /* --- Impresoras (una o varias) y el total ------------------------------ */

  function equipos() { return Array.prototype.slice.call(cajaEquipos.querySelectorAll('[data-equipo]')); }
  function campo(bloque, nombre) { return bloque.querySelector('[data-campo="' + nombre + '"]'); }
  function modeloDe(bloque) {
    var m = bloque.querySelector('[data-campo="modelo"]:checked');
    return m ? m.value : '';
  }
  function pintarPicker(bloque) {
    bloque.querySelectorAll('[data-campo="modelo"]').forEach(function (r) {
      r.closest('.picker__item').classList.toggle('is-checked', r.checked);
    });
  }

  function renumerar() {
    var lista = equipos();
    lista.forEach(function (b, i) {
      var t = b.querySelector('[data-equipo-titulo]');
      if (t) t.textContent = lista.length > 1 ? 'Impresora ' + (i + 1) : '';
      var q = b.querySelector('[data-quitar-equipo]');
      if (q) q.hidden = lista.length < 2;
    });
    botonAgregar.hidden = lista.length >= MAX_IMPRESORAS;
    pintarTotal();
  }

  // $700 por impresora + $300 por AMS. Cada bloque cuenta como una impresora
  // aunque todavía no escoja el modelo: así el total nunca baja al escogerlo.
  function pintarTotal() {
    var lista = equipos(), n = lista.length;
    var ams = lista.filter(function (b) { return campo(b, 'trae_ams').checked; }).length;
    var total = n * PRECIO + ams * PRECIO_AMS;
    var detalle = n + plural(n, ' impresora', ' impresoras') + (ams ? ' + ' + ams + ' AMS' : '');
    form.querySelector('[data-total]').textContent = pesos(total);
    form.querySelector('[data-total-detalle]').textContent = detalle;
    if (resumen) {
      var filas = lista.map(function (b, i) {
        var m = modeloDe(b) || (n > 1 ? 'Impresora ' + (i + 1) : 'Tu impresora');
        return '<div><span>Mantenimiento · ' + esc(m) + '</span><b>' + esc(pesos(PRECIO)) + '</b></div>' +
          (campo(b, 'trae_ams').checked ? '<div><span>AMS · ' + esc(m) + '</span><b>' + esc(pesos(PRECIO_AMS)) + '</b></div>' : '');
      }).join('');
      resumen.innerHTML = filas +
        '<div><span>Diagnóstico</span><b>Incluido</b></div>' +
        '<div><span>Refacciones</span><b>Solo si las autorizas</b></div>' +
        '<div class="total"><span>Total</span><b>' + esc(pesos(total)) + '</b></div>';
    }
  }

  form.addEventListener('change', function (e) {
    var bloque = e.target.closest('[data-equipo]');
    if (!bloque) return;
    if (e.target.dataset.campo === 'modelo') pintarPicker(bloque);
    pintarTotal();
  });

  botonAgregar.addEventListener('click', function () {
    var lista = equipos();
    if (lista.length >= MAX_IMPRESORAS) return;
    var n = lista.length + 1;
    var clon = lista[0].cloneNode(true);
    // Cada bloque con su grupo de radios y sus id (si no, el segundo desmarca al primero).
    clon.querySelectorAll('input[type="radio"]').forEach(function (r) {
      r.name = r.name.replace(/-\d+$/, '') + '-' + n;
      r.checked = false;
    });
    clon.querySelectorAll('[id]').forEach(function (el) {
      var viejo = el.id, nuevo = viejo.replace(/-\d+$/, '') + '-' + n;
      el.id = nuevo;
      var lab = clon.querySelector('label[for="' + viejo + '"]');
      if (lab) lab.setAttribute('for', nuevo);
    });
    clon.querySelectorAll('input[type="checkbox"]').forEach(function (c) { c.checked = false; });
    clon.querySelectorAll('textarea, input[type="text"], input:not([type])').forEach(function (c) { c.value = ''; });
    cajaEquipos.appendChild(clon);
    pintarPicker(clon);
    renumerar();
    clon.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  cajaEquipos.addEventListener('click', function (e) {
    var q = e.target.closest('[data-quitar-equipo]');
    if (!q || equipos().length < 2) return;
    q.closest('[data-equipo]').remove();
    renumerar();
  });

  equipos().forEach(pintarPicker);
  renumerar();

  /* --- Envío ------------------------------------------------------------ */

  var refDetalle = form.querySelector('[data-referencia-detalle]');
  if (refDetalle && form.elements.referencia) {
    form.elements.referencia.addEventListener('change', function () {
      var v = form.elements.referencia.value;
      refDetalle.hidden = !(v === 'otro' || v === 'recomendacion');
    });
  }

  // Lo que guardó el snippet del <head> del primer toque (referrer, utm_*, aterrizaje).
  function origenWeb() {
    try { return JSON.parse(localStorage.getItem('emisha-origen-v1')) || undefined; } catch (e) { return undefined; }
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    avisar('');
    var lista = equipos(), listos = [], falla = null;
    for (var i = 0; i < lista.length; i++) {
      var b = lista[i], cual = lista.length > 1 ? ' de la impresora ' + (i + 1) : ' de tu impresora';
      if (!modeloDe(b)) { falla = ['Elige el modelo' + cual + '.', b.querySelector('[data-picker-modelo]')]; break; }
      var horas = (campo(b, 'horas').value || '').replace(/[\s,]/g, '');
      if (horas && !/^\d{1,6}$/.test(horas)) { falla = ['Las horas de uso' + cual + ' van en número, por ejemplo 800. Si no sabes, déjalo vacío.', campo(b, 'horas')]; break; }
      listos.push({
        modelo: modeloDe(b),
        trae_ams: campo(b, 'trae_ams').checked,
        horas: horas || null,
        notas: (campo(b, 'notas').value || '').trim()
      });
    }
    if (falla) {
      avisar(falla[0], 'error');
      if (falla[1]) falla[1].scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!form.checkValidity()) { form.reportValidity(); return; }
    if (!diaSel || !horaSel) {
      avisar('Elige el día y la hora en que traes ' + (lista.length > 1 ? 'tus impresoras' : 'tu impresora') + '.', 'error');
      cajaDias.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    var f = form.elements;
    var cuerpo = {
      nombre: f.nombre.value.trim(),
      telefono: f.telefono.value.trim(),
      email: f.email.value.trim(),
      equipos: listos,
      referencia: f.referencia ? f.referencia.value : '',
      referencia_detalle: f.referencia_detalle ? f.referencia_detalle.value.trim() : '',
      origen_web: origenWeb(),
      fecha: diaSel,
      hora: horaSel,
      sitio_web: f.sitio_web.value
    };
    botonEnviar.disabled = true;
    botonEnviar.textContent = 'Reservando…';

    pedir('/mantenimiento', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo)
    }).then(function (r) {
      if ((r.status === 201 || r.status === 200) && r.datos.cita_id) {
        try { localStorage.setItem('emisha-ultima-cita', r.datos.cita_id); } catch (e) {}
        history.replaceState(null, '', location.pathname + '?cita=' + r.datos.cita_id);
        mostrarCita(r.datos, true);
        return;
      }
      restaurarBoton();
      if (r.status === 409 && r.datos.turno) {
        avisar(r.datos.error || 'Ese turno ya no está disponible. Elige otro.', 'error');
        cargarDisponibilidad(true);
        return;
      }
      avisar((r.datos && r.datos.error) || 'No se pudo agendar. Inténtalo de nuevo o escríbenos por WhatsApp.', 'error');
    }).catch(function () {
      restaurarBoton();
      avisar('No se pudo agendar. Revisa tu conexión e inténtalo de nuevo, o escríbenos por WhatsApp al +52 55 7563 9255.', 'error');
    });
  });

  function restaurarBoton() {
    botonEnviar.disabled = false;
    botonEnviar.textContent = 'Reservar mi mantenimiento';
  }

  /* --- La cita: confirmación y cómo va ------------------------------------ */

  // [eyebrow, título, nota]. Sin diagnóstico ni reparación: es un mantenimiento.
  var TEXTO = {
    nueva: ['Mantenimiento agendado', 'Te esperamos el {cuando}', 'Si no vas a poder venir, cambia el día o cancela aquí mismo, o avísanos por WhatsApp para que otra persona pueda usar el turno.'],
    recibida: ['Impresora recibida', 'Ya tenemos tu {modelo} en el taller', 'Te avisamos por correo en cuanto esté lista. Si encontramos una pieza gastada, te mandamos la cotización antes de cambiarla.'],
    en_diagnostico: ['En mantenimiento', 'Estamos con el mantenimiento de tu {modelo}', 'La estamos limpiando, lubricando y calibrando. Refacciones, nunca sin tu autorización.'],
    cotizada: ['Cotización de piezas', 'Encontramos piezas que conviene cambiar', 'Te mandamos la cotización por correo. Autorízala (o no) desde el botón de abajo: no cambiamos nada hasta que respondas.'],
    en_reparacion: ['Cambiando piezas', 'Estamos terminando tu {modelo}', 'Te avisamos en cuanto esté lista.'],
    lista: ['Lista para entrega', 'Tu {modelo} ya está lista', 'Pasa por ella al taller de lunes a viernes de 9:00 a 18:00. Dinos qué día pasas y la dejamos en el mostrador.'],
    entregada: ['Entregada', 'Gracias por confiar en Emisha', 'Como referencia, el siguiente mantenimiento toca en 6 meses o 500 horas de impresión, lo que llegue primero.'],
    cancelada: ['Cita cancelada', 'Esta cita fue cancelada', 'Si quieres, agenda otro mantenimiento o escríbenos por WhatsApp.'],
    no_llego: ['Cita vencida', 'No recibimos tu impresora ese día', 'Puedes agendar otro mantenimiento cuando gustes.']
  };
  var TEXTO_VARIAS = {
    recibida: [null, 'Ya tenemos tus {n} impresoras en el taller', 'Te avisamos por correo en cuanto estén listas. Si encontramos una pieza gastada, te mandamos la cotización antes de cambiarla.'],
    en_diagnostico: [null, 'Estamos con el mantenimiento de tus {n} impresoras', 'Las estamos limpiando, lubricando y calibrando. Refacciones, nunca sin tu autorización.'],
    en_reparacion: [null, 'Estamos terminando tus {n} impresoras', 'Te avisamos en cuanto estén listas.'],
    lista: ['Listas para entrega', 'Tus {n} impresoras ya están listas', 'Pasa por ellas al taller de lunes a viernes de 9:00 a 18:00. Dinos qué día pasas y las dejamos en el mostrador.']
  };
  var ETIQUETA_EQUIPO = {
    recibida: 'Recibida', en_diagnostico: 'En mantenimiento', cotizada: 'Cotización enviada',
    en_reparacion: 'Cambiando piezas', lista: 'Lista para recoger', entregada: 'Entregada'
  };
  // El mantenimiento se paga al dejar la impresora; las piezas, al recogerla.
  var TEXTO_COSTOS = {
    pendiente: 'Falta que la autorices. No cambiamos ninguna pieza hasta que respondas; si las autorizas, se pagan al recoger tu impresora.',
    aceptada: 'Autorizaste las piezas: se pagan al recoger tu impresora.',
    aceptada_sin_opcionales: 'Autorizaste la cotización poniendo tú las piezas marcadas: esos renglones ya salieron del total.',
    rechazada: 'No autorizaste las piezas: no pagas nada más, el mantenimiento lo pagaste al dejarla.'
  };

  function mostrarCita(cita, recien) {
    var eq = cita.equipos || [];
    var t = TEXTO[cita.estado] || TEXTO.nueva;
    var tv = eq.length > 1 && TEXTO_VARIAS[cita.estado];
    if (tv) t = [tv[0] || t[0], tv[1].replace('{n}', eq.length), tv[2] || t[2]];
    var cuando = cita.fecha_legible + ' a las ' + cita.hora;
    conf.querySelector('[data-conf-eyebrow]').textContent = t[0];
    conf.querySelector('[data-conf-titulo]').textContent = t[1].replace('{cuando}', cuando).replace('{modelo}', cita.modelo);
    conf.querySelector('[data-conf-folio]').textContent = 'Folio ' + cita.folio;

    var enTaller = eq.length > 1 && eq.some(function (e) { return e.estado; });
    var impresoras = eq.map(function (e, i) {
      var nombre = (eq.length > 1 ? (i + 1) + '. ' : '') + esc(e.modelo) + (e.trae_ams ? ' · con AMS' : '');
      var estado = enTaller ? ' — <b>' + esc(ETIQUETA_EQUIPO[e.estado] || 'Va tal como llegó') + '</b>' : '';
      return '<span class="impresora">' + nombre + estado + (e.descripcion ? '<small>' + esc(e.descripcion) + '</small>' : '') + '</span>';
    }).join('');
    var ams = eq.filter(function (e) { return e.trae_ams; }).length;
    var total = cita.mantenimiento_centavos != null ? cita.mantenimiento_centavos : (eq.length * PRECIO + ams * PRECIO_AMS) * 100;

    var datos = [
      ['Cuándo', esc(cuando)],
      ['Dónde', 'Av. División del Norte 1354, Piso 1, Letrán del Valle, Benito Juárez, CDMX 03650. Estacionamiento con valet parking.'],
      [eq.length > 1 ? 'Impresoras' : 'Impresora', impresoras || esc(cita.modelo)]
    ];
    if (cita.estado === 'nueva') {
      datos.push(['Qué traer', (eq.length > 1 ? 'Las impresoras' : 'La impresora') + ' con su cable de corriente' + (ams ? ', y el AMS con el suyo' : '') + '. No hace falta la caja.']);
      datos.push(['Costo', 'Mantenimiento preventivo — $700 por impresora (+$300 AMS), IVA incluido.<br>Tu total: <b>' + esc(mxn(total)) +
        '</b>. <b>Se paga al dejar la impresora.</b> Refacciones aparte: solo si hacen falta, con tu autorización, y se pagan al recogerla.']);
    } else {
      if (cita.diagnostico) datos.push(['Lo que encontramos', esc(cita.diagnostico).replace(/\n/g, '<br>')]);
      if (['cancelada', 'no_llego'].indexOf(cita.estado) < 0) {
        datos.push(['Pago', 'Mantenimiento: ' + esc(mxn(total)) + ', se paga al dejar la impresora.' +
          (cita.a_pagar_al_recoger_centavos ? '<br>Al recogerla: <b>' + esc(mxn(cita.a_pagar_al_recoger_centavos)) + '</b> de piezas.' : '')]);
      }
    }
    conf.querySelector('[data-conf-datos]').innerHTML = datos.map(function (p) {
      return '<div><dt>' + p[0] + '</dt><dd>' + p[1] + '</dd></div>';
    }).join('');

    // El desglose, cuando ya hay cotización (mantenimiento + piezas).
    var costos = conf.querySelector('[data-conf-costos]');
    var costosT = conf.querySelector('[data-conf-costos-t]');
    var costosNota = conf.querySelector('[data-conf-costos-nota]');
    var conceptos = cita.conceptos || [];
    costos.hidden = costosT.hidden = !conceptos.length;
    if (conceptos.length) {
      costos.innerHTML = conceptos.map(function (x, i) {
        var cab = x.grupo && (i === 0 || conceptos[i - 1].grupo !== x.grupo)
          ? '<div style="display:block;margin-top:12px;font-weight:700">' + esc(x.grupo) + '</div>' : '';
        return cab + '<div><span>' + esc(x.nombre) + (x.opcional ? ' *' : '') + '</span><b>' + esc(mxn(x.centavos)) + '</b></div>';
      }).join('') +
        '<div><span>' + (cita.cotizacion_pendiente ? 'Total cotizado' : 'Total') + '</span><b>' + esc(mxn(cita.a_pagar_centavos)) + '</b></div>' +
        '<div><span>Pagado al dejarla</span><b>−' + esc(mxn(total)) + '</b></div>' +
        '<div class="total"><span>' + (cita.cotizacion_pendiente ? 'A pagar al recoger, si autorizas' : 'A pagar al recoger') + '</span><b>' +
        esc(mxn(cita.cotizacion_pendiente ? Math.max(0, (cita.a_pagar_centavos || 0) - total) : (cita.a_pagar_al_recoger_centavos || 0))) + '</b></div>';
    }
    var nota = cita.cotizacion_pendiente ? TEXTO_COSTOS.pendiente : (TEXTO_COSTOS[cita.cotizacion_respuesta] || '');
    costosNota.hidden = !conceptos.length || !nota;
    costosNota.textContent = nota;
    var generales = document.querySelector('[data-precios-generales]');
    if (generales) generales.hidden = true;

    // Fotos que el taller marcó como visibles. Solo rutas del propio worker.
    var gal = conf.querySelector('[data-conf-galeria]'), galT = conf.querySelector('[data-conf-galeria-t]');
    var archivos = (cita.archivos || []).filter(function (a) { return typeof a.url === 'string' && /^\/[^\/\\]/.test(a.url); });
    gal.hidden = galT.hidden = !archivos.length;
    gal.innerHTML = archivos.map(function (a) {
      var url = API + a.url;
      var medio = a.es_video
        ? '<video src="' + esc(url) + '" preload="metadata" muted playsinline></video>'
        : '<img src="' + esc(url) + '" alt="' + esc(a.nota || 'Foto del mantenimiento') + '" loading="lazy">';
      return '<figure><a href="' + esc(url) + '" target="_blank" rel="noopener">' + medio + '</a>' +
        (a.nota ? '<figcaption>' + esc(a.nota) + '</figcaption>' : '') + '</figure>';
    }).join('');

    var acciones = conf.querySelector('[data-conf-acciones]');
    acciones.textContent = '';
    if (cita.cotizacion_pendiente) {
      acciones.appendChild(boton('Ver y autorizar mi cotización', API + '/cotizacion/' + cita.cita_id, 'btn btn--accent'));
      acciones.appendChild(boton('WhatsApp', WA_NUM + '?text=' + encodeURIComponent('Hola, tengo dudas de la cotización ' + cita.folio + ': '), 'btn btn--ghost'));
    } else if (cita.estado === 'nueva') {
      acciones.appendChild(boton('Agregar a mi calendario', cita.calendario_url, 'btn btn--primary'));
      acciones.appendChild(boton('Cambiar de día', API + '/reagendar/' + cita.cita_id, 'btn btn--ghost'));
      acciones.appendChild(boton('WhatsApp', WA_NUM + '?text=' + encodeURIComponent('Hola, tengo el mantenimiento ' + cita.folio + ' y '), 'btn btn--ghost'));
      var cancelar = document.createElement('button');
      cancelar.type = 'button';
      cancelar.className = 'btn btn--ghost';
      cancelar.textContent = 'Cancelar mi cita';
      cancelar.addEventListener('click', function () { cancelarCita(cita, cancelar); });
      acciones.appendChild(cancelar);
    } else if (cita.estado === 'lista') {
      acciones.appendChild(boton('Decir cuándo paso', API + '/recoger/' + cita.cita_id, 'btn btn--accent'));
      acciones.appendChild(boton('WhatsApp', WA_NUM + '?text=' + encodeURIComponent('Hola, pregunto por mi impresora, folio ' + cita.folio + '.'), 'btn btn--ghost'));
    } else if (cita.estado === 'cancelada' || cita.estado === 'no_llego') {
      var otra = document.createElement('button');
      otra.type = 'button';
      otra.className = 'btn btn--accent';
      otra.textContent = 'Agendar otro mantenimiento';
      otra.addEventListener('click', function () {
        history.replaceState(null, '', location.pathname);
        conf.hidden = true;
        form.hidden = false;
        if (generales) generales.hidden = false;
        cargarDisponibilidad(false);
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      acciones.appendChild(otra);
      acciones.appendChild(boton('WhatsApp', WA, 'btn btn--ghost'));
    } else {
      acciones.appendChild(boton('WhatsApp', WA_NUM + '?text=' + encodeURIComponent('Hola, pregunto por mi impresora, folio ' + cita.folio + '.'), 'btn btn--primary'));
    }
    conf.querySelector('[data-conf-nota]').textContent =
      (recien && cita.correo ? 'Te mandamos la confirmación a tu correo (revisa también la carpeta de spam). ' : '') +
      (recien && !cita.correo ? 'Guarda esta página o toma captura: aquí está tu folio. ' : '') + t[2];

    form.hidden = true;
    conf.hidden = false;
    avisar('');
    if (recien && conf.scrollIntoView) conf.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function boton(texto, href, clase) {
    var a = document.createElement('a');
    a.className = clase;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = texto;
    return a;
  }

  function cancelarCita(cita, btn) {
    if (!window.confirm('¿Cancelar tu mantenimiento del ' + cita.fecha_legible + ' a las ' + cita.hora + '?')) return;
    btn.disabled = true;
    btn.textContent = 'Cancelando…';
    pedir('/cita/' + cita.cita_id + '/cancelar', { method: 'POST' }).then(function (r) {
      if (r.status === 200) { mostrarCita(r.datos, false); return; }
      btn.disabled = false;
      btn.textContent = 'Cancelar mi cita';
      avisar((r.datos && r.datos.error) || 'No se pudo cancelar. Escríbenos por WhatsApp.', 'error');
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = 'Cancelar mi cita';
      avisar('No se pudo cancelar. Revisa tu conexión o escríbenos por WhatsApp.', 'error');
    });
  }

  /* --- Arranque --------------------------------------------------------- */

  var idCita = new URLSearchParams(location.search).get('cita');
  if (idCita && /^[0-9a-f-]{36}$/.test(idCita)) {
    pedir('/cita/' + idCita).then(function (r) {
      if (r.status === 200 && r.datos.servicio !== 'mantenimiento') {
        // Es una reparación: su página es /reparacion/.
        location.replace('/reparacion/?cita=' + encodeURIComponent(idCita));
        return;
      }
      if (r.status === 200) { mostrarCita(r.datos, false); return; }
      history.replaceState(null, '', location.pathname);
      cargarDisponibilidad(false);
    }).catch(function () { cargarDisponibilidad(false); });
  } else {
    cargarDisponibilidad(false);
  }
})();
