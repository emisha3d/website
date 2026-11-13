/* Emisha — citas de reparación: días y turnos disponibles + formulario +
   confirmación. Los turnos los calcula el worker (horario, cupo, días
   cerrados): aquí solo se pintan y se manda la elección. Si el worker no
   responde, la página no se rompe: ofrece WhatsApp.

   ?cita=<uuid> en la URL (enlace del correo) muestra el estado de esa cita
   y permite cancelarla mientras siga como "nueva". */
(function () {
  'use strict';

  var API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
    ? 'http://localhost:8787'
    : 'https://citas.emisha.com.mx';
  var WA = 'https://wa.me/525575639255?text=' + encodeURIComponent('Hola, quiero agendar la reparación de mi impresora Bambu Lab.');

  var form = document.querySelector('[data-cita-form]');
  var conf = document.querySelector('[data-confirmacion]');
  var aviso = document.querySelector('[data-cita-aviso]');
  if (!form || !conf) return;

  var cajaDias = form.querySelector('[data-dias]');
  var cajaTurnos = form.querySelector('[data-turnos]');
  var turnosVacio = form.querySelector('[data-turnos-vacio]');
  var elegida = form.querySelector('[data-elegida]');
  var botonEnviar = form.querySelector('[data-enviar]');
  var dias = [];               // lo que manda /disponibilidad
  var diaSel = null, horaSel = null;

  /* --- Utilidades ------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function mxn(cent) {
    if (cent == null) return '';
    return '$' + (cent / 100).toLocaleString('es-MX', { maximumFractionDigits: 2 }) + ' MXN';
  }

  function avisar(texto, tipo, sinMover) {
    aviso.textContent = texto || '';
    aviso.hidden = !texto;
    aviso.className = 'cita-aviso' + (tipo ? ' cita-aviso--' + tipo : '');
    if (texto && !sinMover && aviso.scrollIntoView) aviso.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Tope de espera (15 s leer, 30 s agendar): si el worker no contesta, el
  // .catch ofrece WhatsApp en vez de un «Reservando…» eterno. Sin
  // AbortSignal.timeout (Safari < 16) la petición va sin tope, como antes.
  function pedir(ruta, opciones) {
    opciones = opciones || {};
    if (window.AbortSignal && AbortSignal.timeout) {
      opciones.signal = AbortSignal.timeout(opciones.method && opciones.method !== 'GET' ? 30000 : 15000);
    }
    return fetch(API + ruta, opciones).then(function (r) {
      return r.json().then(function (d) { return { status: r.status, datos: d }; });
    });
  }

  // 'lun 18 ago' a partir de 'lunes 18 de agosto' que manda el worker.
  function partesDia(d) {
    var t = d.legible.split(' ');
    return { semana: t[0].slice(0, 3), num: t[1], mes: (t[3] || '').slice(0, 3) };
  }

  /* --- Días y turnos ---------------------------------------------------- */

  function cargarDisponibilidad(mantener) {
    return pedir('/disponibilidad').then(function (r) {
      if (r.status !== 200 || !r.datos.dias) throw new Error('sin datos');
      dias = r.datos.dias;
      pintarDias();
      if (mantener && diaSel && dias.some(function (d) { return d.fecha === diaSel; })) {
        elegirDia(diaSel);
      } else if (!mantener) {
        // Primer día con lugar, para que el formulario ya muestre horas.
        var primero = dias.filter(function (d) { return d.libres > 0; })[0];
        if (primero) elegirDia(primero.fecha);
      }
    }).catch(function () {
      cajaDias.innerHTML = '';
      cajaTurnos.hidden = true;
      // Al cargar no movemos la página: el aviso ya está arriba del formulario.
      avisar('Ahorita no podemos cargar los turnos en línea. Escríbenos por WhatsApp al ' +
        '+52 55 7563 9255 con el modelo de tu impresora y el día que te acomoda, y te apartamos el lugar.', 'error', true);
      // Habilitado: antes quedaba disabled y su clic nunca llegaba. Un solo
      // listener aunque esto corra otra vez (cargarDisponibilidad(true)).
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
        '<small>' + (d.libres === 0 ? 'lleno' : d.libres + (d.libres === 1 ? ' lugar' : ' lugares')) + '</small>';
      b.addEventListener('click', function () { elegirDia(d.fecha); });
      cajaDias.appendChild(b);
    });
  }

  function elegirDia(fecha) {
    diaSel = fecha;
    horaSel = null;
    form.elements.fecha.value = fecha;
    form.elements.hora.value = '';
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
    // En móvil, que el día elegido quede a la vista dentro de la tira de
    // días. Solo se mueve la tira (horizontal), nunca la página: con
    // scrollIntoView la página brincaba hasta aquí al cargar.
    var activo = cajaDias.querySelector('[aria-pressed="true"]');
    if (activo && cajaDias.scrollTo) {
      cajaDias.scrollTo({
        left: activo.offsetLeft - (cajaDias.clientWidth - activo.offsetWidth) / 2,
        behavior: 'smooth'
      });
    }
  }

  function elegirHora(hora) {
    horaSel = hora;
    form.elements.hora.value = hora;
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

  /* --- Selectores de modelo y falla (tarjetas de radio) ------------------ */
  /* form.elements.modelo es un RadioNodeList: .value da el elegido. La clase
     is-checked replica :has(input:checked) para navegadores viejos. */

  var cajaOtro = form.querySelector('[data-modelo-otro]');
  /* --- Impresoras (se puede traer más de una) ---------------------------- */

  var cajaEquipos = form.querySelector('[data-equipos]');
  var botonAgregar = form.querySelector('[data-agregar-equipo]');

  function equipos() { return Array.prototype.slice.call(cajaEquipos.querySelectorAll('[data-equipo]')); }
  function campo(bloque, nombre) { return bloque.querySelector('[data-campo="' + nombre + '"]'); }
  function valorRadio(bloque, nombre) {
    var m = bloque.querySelector('[data-campo="' + nombre + '"]:checked');
    return m ? m.value : '';
  }
  function pintarPicker(bloque, nombre) {
    bloque.querySelectorAll('[data-campo="' + nombre + '"]').forEach(function (r) {
      r.closest('.picker__item').classList.toggle('is-checked', r.checked);
    });
  }
  function refrescarBloque(bloque) {
    pintarPicker(bloque, 'modelo');
    pintarPicker(bloque, 'tipo_falla');
    var esOtro = valorRadio(bloque, 'modelo') === 'Otro';
    var caja = bloque.querySelector('[data-modelo-otro]');
    var otro = campo(bloque, 'modelo_otro');
    if (caja) caja.hidden = !esOtro;
    if (otro) otro.required = esOtro;
    return esOtro;
  }
  // Cada bloque numerado, y con su botón de quitar a partir del segundo.
  function renumerar() {
    var lista = equipos();
    lista.forEach(function (b, i) {
      var t = b.querySelector('[data-equipo-titulo]');
      if (t) t.textContent = lista.length > 1 ? 'Impresora ' + (i + 1) : '';
      var q = b.querySelector('[data-quitar-equipo]');
      if (q) q.hidden = lista.length < 2;
    });
    botonAgregar.hidden = lista.length >= 40;
  }

  form.addEventListener('change', function (e) {
    var bloque = e.target.closest('[data-equipo]');
    if (!bloque) return;
    if (e.target.dataset.campo === 'modelo') {
      if (refrescarBloque(bloque)) campo(bloque, 'modelo_otro').focus();
    }
    if (e.target.dataset.campo === 'tipo_falla') pintarPicker(bloque, 'tipo_falla');
  });

  botonAgregar.addEventListener('click', function () {
    var lista = equipos();
    if (lista.length >= 40) return;
    var n = lista.length + 1;
    var clon = lista[0].cloneNode(true);
    // Los radios necesitan un grupo propio, si no el segundo bloque
    // desmarcaría al primero. Los id también, por las etiquetas.
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
    refrescarBloque(clon);
    renumerar();
    clon.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  cajaEquipos.addEventListener('click', function (e) {
    var q = e.target.closest('[data-quitar-equipo]');
    if (!q) return;
    var lista = equipos();
    if (lista.length < 2) return;
    q.closest('[data-equipo]').remove();
    renumerar();
  });

  equipos().forEach(refrescarBloque);
  renumerar();

  /* --- Envío ------------------------------------------------------------ */

  // «¿Cómo nos encontraste?»: el renglón de detalle solo aparece cuando
  // sirve de algo (quién lo recomendó, cuál es el «otro»).
  var refDetalle = form.querySelector('[data-referencia-detalle]');
  if (refDetalle && form.elements.referencia) {
    form.elements.referencia.addEventListener('change', function () {
      var v = form.elements.referencia.value;
      refDetalle.hidden = !(v === 'otro' || v === 'recomendacion');
    });
  }


  // Lo que el snippet del <head> guardó del primer toque (referrer, utm_*,
  // página de aterrizaje). Si no hay nada, no se manda nada.
  function origenWeb() {
    try { return JSON.parse(localStorage.getItem('emisha-origen-v1')) || undefined; } catch (e) { return undefined; }
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    avisar('');
    var lista = equipos(), listos = [], falla = null;
    for (var i = 0; i < lista.length; i++) {
      var b = lista[i], cual = lista.length > 1 ? ' de la impresora ' + (i + 1) : ' de tu impresora';
      if (!valorRadio(b, 'modelo')) { falla = ['Elige el modelo' + cual + '.', b.querySelector('[data-picker-modelo]')]; break; }
      if (!valorRadio(b, 'tipo_falla')) { falla = ['Elige el tipo de falla' + cual + '.', b.querySelector('[data-picker-falla]')]; break; }
      listos.push({
        modelo: valorRadio(b, 'modelo'),
        modelo_otro: (campo(b, 'modelo_otro').value || '').trim(),
        tipo_falla: valorRadio(b, 'tipo_falla'),
        descripcion: (campo(b, 'descripcion').value || '').trim(),
        trae_ams: campo(b, 'trae_ams').checked
      });
    }
    if (falla) {
      avisar(falla[0], 'error');
      if (falla[1]) falla[1].scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
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
      diagnostico_previo: f.diagnostico_previo.checked,
      referencia: f.referencia ? f.referencia.value : '',
      referencia_detalle: f.referencia_detalle ? f.referencia_detalle.value.trim() : '',
      origen_web: origenWeb(),
      fecha: diaSel,
      hora: horaSel,
      sitio_web: f.sitio_web.value
    };
    botonEnviar.disabled = true;
    botonEnviar.textContent = 'Reservando…';

    pedir('/cita', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo)
    }).then(function (r) {
      if ((r.status === 201 || r.status === 200) && r.datos.cita_id) {
        try { localStorage.setItem('emisha-ultima-cita', r.datos.cita_id); } catch (e) {}
        history.replaceState(null, '', location.pathname + '?cita=' + r.datos.cita_id);
        mostrarConfirmacion(r.datos, true);
        return;
      }
      restaurarBoton();
      if (r.status === 409 && r.datos.turno) {
        // Alguien más lo tomó o ya pasó: refrescar y que elija otro.
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
    botonEnviar.textContent = 'Reservar mi turno';
  }

  /* --- Confirmación / estado de la cita ---------------------------------- */

  var TEXTO_ESTADO = {
    nueva: ['Cita confirmada', 'Te esperamos el {cuando}', 'Si no vas a poder venir, cancela aquí mismo o avísanos por WhatsApp para que otra persona pueda usar el turno.'],
    recibida: ['Impresora recibida', 'Ya tenemos tu {modelo} en el taller', 'Te avisamos por WhatsApp o correo en cuanto tengamos el diagnóstico.'],
    en_diagnostico: ['En diagnóstico', 'Estamos revisando tu {modelo}', 'En cuanto sepamos qué tiene te mandamos la cotización. No reparamos nada sin tu autorización.'],
    cotizada: ['Cotización enviada', 'Ya revisamos tu {modelo}', 'Te mandamos la cotización por correo. Autorízala (o no) desde el botón de abajo; no tocamos nada hasta que respondas.'],
    diagnosticada: ['Diagnóstico listo', 'Ya revisamos tu {modelo}', 'Te mandamos la cotización. Si tienes dudas, escríbenos por WhatsApp.'],
    en_reparacion: ['En reparación', 'Estamos trabajando en tu {modelo}', 'Te avisamos en cuanto esté lista.'],
    lista: ['Lista para entrega', 'Tu {modelo} ya está lista', 'Pasa por ella al taller de lunes a viernes de 9:00 a 18:00. Si prefieres otro horario, escríbenos.'],
    entregada: ['Entregada', 'Gracias por confiar en Emisha', 'Si vuelve a fallar o necesitas otra cosa, aquí estamos.'],
    cancelada: ['Cita cancelada', 'Esta cita fue cancelada', 'Si quieres, agenda otra abajo o escríbenos por WhatsApp.'],
    no_llego: ['Cita vencida', 'No recibimos tu impresora ese día', 'Puedes agendar otra cita cuando gustes.']
  };
  // Con varias impresoras: «tus 8 impresoras» en vez de «tu X1 Carbon + X1 Carbon + …».
  var TEXTO_VARIAS = {
    recibida: [null, 'Ya tenemos tus {n} impresoras en el taller'],
    en_diagnostico: [null, 'Estamos revisando tus {n} impresoras'],
    cotizada: [null, 'Ya revisamos tus {n} impresoras'],
    en_reparacion: [null, 'Estamos trabajando en tus {n} impresoras', 'Abajo ves en qué va cada una. Te avisamos en cuanto estén listas.'],
    lista: ['Listas para entrega', 'Tus {n} impresoras ya están listas', 'Pasa por ellas al taller de lunes a viernes de 9:00 a 18:00. Si prefieres otro horario, escríbenos.']
  };

  // Creality tiene su propia lista ($400 que se abonan, $1,000 en total sin
  // refacciones). Una cita mixta lleva las dos.
  function esCreality(e) { return /^Creality /.test(String((e && e.modelo) || '')); }
  function costosCita(lista) {
    var cr = lista.some(esCreality), bl = lista.some(function (e) { return !esCreality(e); });
    var t = [];
    if (bl) t.push((cr ? 'Bambu Lab: ' : '') + 'Diagnóstico $300 · Reparación $700 (con diagnóstico previo, $400).');
    if (cr) t.push((bl ? 'Creality: ' : '') + 'Diagnóstico $400, que se abona a la reparación · Reparada sin refacciones, $1,000 en total' +
      (lista.some(function (e) { return esCreality(e) && e.trae_ams; }) ? ' (el CFS que viene con su impresora va en el mismo precio).' : '.'));
    return t.join('<br>') + ' Refacciones aparte, siempre con tu autorización.';
  }

  // Una impresora de la lista: número, modelo, serie y falla, y su estado si ya está en el taller.
  function filaEquipo(e, i, conAvance) {
    var nombre = (i + 1) + '. ' + esc(e.modelo) + (e.trae_ams ? (esCreality(e) ? ' · con CFS' : ' · con AMS') : '');
    var sub = [e.serie ? 'Serie ' + esc(e.serie) : '', esc(e.tipo_falla)].filter(Boolean).join(' · ');
    if (!conAvance) return esc(e.modelo) + (e.trae_ams ? (esCreality(e) ? ' · con CFS' : ' · con AMS') : '') + ' · ' + esc(e.tipo_falla);
    return '<li><span>' + nombre + '<small>' + sub + '</small></span>' +
      '<b class="avance__e avance__e--' + esc(e.estado || 'fuera') + '">' + esc(e.estado_legible || 'Va tal como llegó') + '</b></li>';
  }

  // Qué decirle debajo del desglose, segun donde va su cotizacion.
  var TEXTO_COSTOS = {
    pendiente: 'Falta que la autorices. No conseguimos ni instalamos nada hasta que respondas.',
    aceptada: 'Autorizaste esta cotización. Se paga al recoger tu impresora.',
    aceptada_sin_opcionales: 'Autorizaste la cotización poniendo tú las piezas marcadas: esos renglones ya salieron del total.',
    rechazada: 'No autorizaste la reparación, así que solo se cobra el diagnóstico.'
  };

  // Los renglones de totales: [[texto, centavos, fuerte, signo]]. Lo que ya
  // pagó por adelantado (los diagnósticos al dejarla) se resta.
  function filasTotales(cita, porEq, pendEq) {
    var ya = cita.pagado_centavos || 0, a = cita.a_pagar_centavos || 0;
    if (porEq) {
      if (!pendEq && !ya) return [['Total a pagar', a, true]];
      var f = [['Lo ya hecho', a, false]];
      if (ya) f.push(['Ya pagaste', ya, false, '− ']);
      if (pendEq) f.push(['Si autorizas lo pendiente', cita.por_autorizar_centavos, false, '+ ']);
      f.push([pendEq ? 'Por pagar si autorizas todo' : 'Por pagar al recoger', Math.max(0, a + (pendEq ? cita.por_autorizar_centavos : 0) - ya), true]);
      return f;
    }
    var etiqueta = cita.cotizacion_pendiente ? 'Total cotizado' : 'Total a pagar';
    if (!ya) return [[etiqueta, a, true]];
    return [[cita.cotizacion_pendiente ? 'Total cotizado' : 'Total', a, false], ['Ya pagaste', ya, false, '− '],
      [cita.cotizacion_pendiente ? 'Por pagar si autorizas' : 'Por pagar al recoger', Math.max(0, a - ya), true]];
  }

  // En qué va una impresora de una cita cotizada por impresora.
  function chipEquipo(e) {
    var k = e.por_autorizar ? 'cotizada' : e.respuesta === 'rechazada' ? 'fuera' : (e.estado || 'fuera');
    var t = e.por_autorizar ? 'Falta tu respuesta' : e.respuesta === 'rechazada' ? 'No autorizada' : (e.estado_legible || '');
    return t ? '<b class="avance__e avance__e--' + esc(k) + '" style="margin-left:6px;vertical-align:1px">' + esc(t) + '</b>' : '';
  }

  function mostrarConfirmacion(cita, recien) {
    var t = TEXTO_ESTADO[cita.estado] || TEXTO_ESTADO.nueva;
    var equipos = cita.equipos || [];
    // Varias impresoras ya en el taller: cada una con su estado.
    var conAvance = equipos.length > 1 && equipos.some(function (e) { return e.estado; });
    var trabajadas = equipos.filter(function (e) { return !e.no_se_repara; }).length;
    var tv = trabajadas > 1 && TEXTO_VARIAS[cita.estado];
    if (tv) t = [tv[0] || t[0], tv[1].replace('{n}', trabajadas), tv[2] || t[2]];
    var cuando = cita.fecha_legible + ' a las ' + cita.hora;
    conf.querySelector('[data-conf-eyebrow]').textContent = t[0];
    conf.querySelector('[data-conf-titulo]').textContent = t[1].replace('{cuando}', cuando).replace('{modelo}', cita.modelo);
    conf.querySelector('[data-conf-folio]').textContent = 'Folio ' + cita.folio;

    // «3 de 8 listas para recoger» cuando no van al parejo.
    var listas = equipos.filter(function (e) { return e.estado === 'lista'; }).length;
    var resumen = conAvance && listas && listas < trabajadas
      ? '<p class="avance-resumen">' + listas + ' de ' + trabajadas + (listas === 1 ? ' lista' : ' listas') + ' para recoger</p>' : '';

    // Ya puede pasar a recoger: todo, o solo las listas (entrega parcial).
    var rc = cita.recoger;
    if (rc) {
      var nr = rc.parcial ? rc.nombres.length : 0;
      resumen += '<p class="recoger-caja">' +
        '<b>' + (rc.parcial
          ? 'Ya puedes pasar por ' + (nr === 1 ? 'tu ' + esc(rc.nombres[0]) : esc(rc.nombres.join(' y '))) + '.'
          : 'Ya puedes pasar por ' + (trabajadas > 1 ? 'tus impresoras' : 'tu impresora') + '.') + '</b>' +
        (rc.parcial ? ' No tienes que esperar: ' + esc(rc.siguen.join(' y ')) + (rc.siguen.length === 1 ? ' sigue' : ' siguen') + ' en el taller y te avisamos en cuanto ' + (rc.siguen.length === 1 ? 'quede' : 'queden') + '.' : '') +
        (rc.a_pagar ? '<br>A pagar ese día: <b>' + esc(rc.a_pagar) + '</b>' : '') +
        (rc.recoge_fecha_legible ? '<br>Quedaste de pasar el <b>' + esc(rc.recoge_fecha_legible) + ' cerca de las ' + esc(rc.recoge_hora) + '</b>.'
          : rc.espera ? '<br>Nos dijiste que prefieres esperar a que estén todas.' : '') +
        '</p>';
    }

    var datos = [
      ['Cuándo', esc(cuando)],
      ['Dónde', 'Av. División del Norte 1354, Piso 1, Letrán del Valle, Benito Juárez, CDMX 03650. Estacionamiento con valet parking.'],
      [equipos.length > 1 ? 'Impresoras' : 'Impresora',
        conAvance
          ? resumen + '<ul class="avance">' + equipos.map(function (e, i) { return filaEquipo(e, i, true); }).join('') + '</ul>'
          : equipos.length
            ? equipos.map(function (e, i) { return filaEquipo(e, i, false); }).join('<br>')
            : esc(cita.modelo) + (cita.trae_ams ? ' · con AMS' : '') + ' · ' + esc(cita.tipo_falla)],
      ['Qué traer', ((cita.equipos && cita.equipos.length > 1) ? 'Las impresoras' : 'La impresora') + ' con su cable de corriente' + (cita.trae_ams ? (esCreality(cita) ? ' y el CFS con el suyo' : ' y el AMS con el suyo') : '') + '. Si la falla pasa con un filamento en particular, tráelo.'],
      ['Costos', costosCita(equipos.length ? equipos : [cita])]
    ];
    // Con el equipo ya adentro, lo de traer y los precios de mostrador sobran:
    // en su lugar va lo que encontramos al revisarla.
    if (cita.estado !== 'nueva') {
      datos = datos.slice(0, 3);
      if (cita.diagnostico) datos.push(['Diagnóstico', esc(cita.diagnostico).replace(/\n/g, '<br>')]);
    }
    conf.querySelector('[data-conf-datos]').innerHTML = datos.map(function (p) {
      return '<div><dt>' + p[0] + '</dt><dd>' + p[1] + '</dd></div>';
    }).join('');

    // El desglose de su cotización: los mismos renglones y el mismo total que
    // le llegaron por correo. Sin esto solo veía la lista de precios de
    // mostrador, que no dice cuánto va a pagar él.
    var costos = conf.querySelector('[data-conf-costos]');
    var costosT = conf.querySelector('[data-conf-costos-t]');
    var costosNota = conf.querySelector('[data-conf-costos-nota]');
    var conceptos = cita.conceptos || [];
    // Cotizada por impresora (unas listas, otras esperando su respuesta, otra
    // en revisión): cada impresora dice en qué va y abajo van los totales.
    var porEq = !!cita.por_equipo;
    var pendEq = porEq ? (cita.equipos_por_autorizar || []).length : 0;
    costos.hidden = costosT.hidden = !conceptos.length;
    if (conceptos.length) {
      costos.innerHTML = conceptos.map(function (x, i) {
        var eq = porEq && x.equipo != null ? (cita.equipos || [])[x.equipo] : null;
        // Con varias impresoras: encabezado por impresora y su subtotal.
        var cab = x.grupo && (i === 0 || conceptos[i - 1].grupo !== x.grupo)
          ? '<div style="display:block;margin-top:12px;font-weight:700">' + esc(x.grupo) + (eq ? ' ' + chipEquipo(eq) : '') +
            (x.grupo_diag ? '<span style="display:block;font-weight:400;font-size:.88rem;opacity:.8;white-space:pre-wrap">' + esc(x.grupo_diag) + '</span>' : '') + '</div>' : '';
        var sub = '';
        if (x.grupo && (i === conceptos.length - 1 || conceptos[i + 1].grupo !== x.grupo)) {
          var st = conceptos.filter(function (y) { return y.grupo === x.grupo; }).reduce(function (t, y) { return t + (y.pagado ? 0 : (y.centavos || 0)); }, 0);
          sub = '<div style="opacity:.75"><span>' + (eq && eq.por_autorizar ? 'Si la autorizas' : 'Subtotal') + '</span><b>' + esc(mxn(st)) + '</b></div>';
        }
        // Lo que ya pagó (el diagnóstico al dejarla): a la vista, tachado, sin contar.
        return cab + (x.pagado
          ? '<div><span>' + esc(x.nombre) + ' <span style="color:#067647">· ya pagado</span></span><b style="font-weight:400;opacity:.6"><s>' + esc(mxn(x.centavos)) + '</s></b></div>'
          : '<div><span>' + esc(x.nombre) + (x.opcional ? ' *' : '') + '</span><b>' + esc(mxn(x.centavos)) + '</b></div>') + sub;
      }).join('') + filasTotales(cita, porEq, pendEq).map(function (f) {
        return '<div' + (f[2] ? ' class="total"' : '') + '><span>' + esc(f[0]) + '</span><b>' + (f[3] || '') + esc(mxn(f[1])) + '</b></div>';
      }).join('');
    }
    var sinPrecio = porEq && (cita.equipos_sin_precio || []).length
      ? ' Sin contar ' + cita.equipos_sin_precio.join(', ') + ': su costo se suma en cuanto terminemos de revisar' + (cita.equipos_sin_precio.length > 1 ? 'las' : 'la') + '.' : '';
    var notaCostos = porEq
      ? (pendEq
          ? (pendEq === 1 ? 'Una impresora espera' : pendEq + ' impresoras esperan') + ' tu respuesta: autorízalas (o no) con el botón de abajo. No las tocamos hasta que respondas; las demás se pagan al recogerlas.'
          : 'Ya respondiste por todas las impresoras cotizadas. Se paga al recogerlas.') +
        (cita.diagnosticos_pagados ? ' Los diagnósticos ya los pagaste: no se cobran otra vez.' : '') + sinPrecio
      : cita.cotizacion_pendiente
        ? TEXTO_COSTOS.pendiente
        : (TEXTO_COSTOS[cita.cotizacion_respuesta] || '');
    costosNota.hidden = !conceptos.length || !notaCostos;
    costosNota.textContent = notaCostos;
    // Con su cotización a la vista, la lista de precios de mostrador estorba:
    // esos $300/$700 no son lo que él paga.
    var generales = document.querySelector('[data-precios-generales]');
    if (generales) generales.hidden = !!conceptos.length;

    // Fotos y video que el taller marcó como visibles.
    var gal = conf.querySelector('[data-conf-galeria]'), galT = conf.querySelector('[data-conf-galeria-t]');
    // Solo rutas del propio worker ("/cita/…"): API + "@otro.com/…" o
    // "//otro.com" apuntarían a otro sitio.
    var archivos = (cita.archivos || []).filter(function (a) {
      return typeof a.url === 'string' && /^\/[^\/\\]/.test(a.url);
    });
    gal.hidden = galT.hidden = !archivos.length;
    gal.innerHTML = archivos.map(function (a, i) {
      var url = API + a.url;
      // Con varias impresoras, un encabezado cuando cambia de impresora.
      var cab = a.grupo && (i === 0 || archivos[i - 1].grupo !== a.grupo)
        ? '<p style="grid-column:1/-1;margin:10px 0 0;font-weight:700;font-size:.9rem">' + esc(a.grupo) + '</p>' : '';
      var medio = a.es_video
        ? '<video src="' + esc(url) + '" preload="metadata" muted playsinline></video><span class="play">▶</span>'
        : '<img src="' + esc(url) + '" alt="' + esc(a.nota || 'Foto de la reparación') + '" loading="lazy">';
      return cab + '<figure><a role="button" tabindex="0" data-src="' + esc(url) + '" data-visor' + (a.es_video ? ' data-video' : '') + ' data-nota="' + esc(a.nota || '') + '">' + medio + '</a>' +
        (a.nota ? '<figcaption>' + esc(a.nota) + '</figcaption>' : '') + '</figure>';
    }).join('');

    if (!gal._visor) { gal._visor = true; visorGaleria(gal); }

    var acciones = conf.querySelector('[data-conf-acciones]');
    acciones.textContent = '';
    if (rc) {
      acciones.appendChild(boton(rc.recoge_fecha_legible ? 'Cambiar el día que paso' : 'Decir cuándo paso', API + rc.url, 'btn btn--accent'));
      if (rc.parcial && !rc.recoge_fecha_legible && !rc.espera) acciones.appendChild(boton('Prefiero esperar a que estén todas', API + rc.url + '?esperar=1', 'btn btn--ghost'));
    }
    if (cita.cotizacion_pendiente) {
      acciones.appendChild(boton(cita.por_equipo ? 'Autorizar las impresoras pendientes' : 'Ver y autorizar mi cotización', API + '/cotizacion/' + cita.cita_id, 'btn btn--accent'));
      acciones.appendChild(boton('WhatsApp', 'https://wa.me/525575639255?text=' + encodeURIComponent('Hola, tengo dudas de la cotización ' + cita.folio + ': '), 'btn btn--ghost'));
    } else if (cita.estado === 'nueva') {
      acciones.appendChild(boton('Agregar a mi calendario', cita.calendario_url, 'btn btn--primary'));
      // ¿No puede venir (vive fuera, cambió de idea)? Manda la impresora por
      // paquetería: la página de envío llega con sus datos de esta cita.
      var enviar = boton('Quiero enviar mi impresora', '/reparacion/envio/?cita=' + encodeURIComponent(cita.cita_id), 'btn btn--accent');
      enviar.removeAttribute('target');
      enviar.removeAttribute('rel');
      acciones.appendChild(enviar);
      acciones.appendChild(boton('WhatsApp', 'https://wa.me/525575639255?text=' + encodeURIComponent('Hola, tengo la cita ' + cita.folio + ' y '), 'btn btn--ghost'));
      var cancelar = document.createElement('button');
      cancelar.type = 'button';
      cancelar.className = 'btn btn--ghost';
      cancelar.textContent = 'Cancelar mi cita';
      cancelar.addEventListener('click', function () { cancelarCita(cita, cancelar); });
      acciones.appendChild(cancelar);
    } else if (cita.estado === 'cancelada' || cita.estado === 'no_llego') {
      var otra = document.createElement('button');
      otra.type = 'button';
      otra.className = 'btn btn--accent';
      otra.textContent = 'Agendar otra cita';
      otra.addEventListener('click', function () {
        history.replaceState(null, '', location.pathname);
        conf.hidden = true;
        form.hidden = false;
        cargarDisponibilidad(false);
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      acciones.appendChild(otra);
      acciones.appendChild(boton('WhatsApp', WA, 'btn btn--ghost'));
    } else {
      acciones.appendChild(boton('WhatsApp', 'https://wa.me/525575639255?text=' + encodeURIComponent('Hola, pregunto por mi impresora, folio ' + cita.folio + '.'), 'btn btn--primary'));
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
    if (!window.confirm('¿Cancelar tu cita del ' + cita.fecha_legible + ' a las ' + cita.hora + '?')) return;
    btn.disabled = true;
    btn.textContent = 'Cancelando…';
    pedir('/cita/' + cita.cita_id + '/cancelar', { method: 'POST' }).then(function (r) {
      if (r.status === 200) { mostrarConfirmacion(r.datos, false); return; }
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
      if (r.status === 200) { mostrarConfirmacion(r.datos, false); return; }
      history.replaceState(null, '', location.pathname);
      cargarDisponibilidad(false);
    }).catch(function () { cargarDisponibilidad(false); });
  } else {
    cargarDisponibilidad(false);
  }

  // Visor de fotos/video: se abre encima de la página (no en otra pestaña).
  // Flechas, teclado (← → Esc) y deslizar con el dedo.
  function visorGaleria(gal) {
    var css = document.createElement('style');
    css.textContent =
      '.visor{position:fixed;inset:0;z-index:9999;background:rgba(8,10,14,.94);display:flex;align-items:center;justify-content:center;touch-action:pan-y}' +
      '.visor[hidden]{display:none}' +
      '.visor__medio{max-width:94vw;max-height:80vh;display:flex;align-items:center;justify-content:center}' +
      '.visor__medio img,.visor__medio video{max-width:94vw;max-height:80vh;object-fit:contain;border-radius:8px;user-select:none;-webkit-user-drag:none}' +
      '.visor__pie{position:absolute;left:16px;right:16px;bottom:18px;text-align:center;color:#e6e8eb;font-size:.92rem;line-height:1.4}' +
      '.visor__cuenta{opacity:.65;font-size:.8rem;margin-top:4px}' +
      '.visor button{position:absolute;border:0;background:rgba(255,255,255,.12);color:#fff;width:48px;height:48px;border-radius:50%;font-size:26px;line-height:1;cursor:pointer;display:grid;place-items:center}' +
      '.visor button:hover{background:rgba(255,255,255,.24)}' +
      '.visor__cerrar{top:14px;right:14px}' +
      '.visor__ant{left:14px;top:50%;transform:translateY(-50%)}' +
      '.visor__sig{right:14px;top:50%;transform:translateY(-50%)}' +
      '@media (max-width:600px){.visor__ant,.visor__sig{width:40px;height:40px;font-size:22px;left:8px}.visor__sig{left:auto;right:8px}}';
    document.head.appendChild(css);

    var v = document.createElement('div');
    v.className = 'visor';
    v.hidden = true;
    v.setAttribute('role', 'dialog');
    v.setAttribute('aria-modal', 'true');
    v.setAttribute('aria-label', 'Fotos de tu reparación');
    v.innerHTML =
      '<div class="visor__medio"></div>' +
      '<div class="visor__pie"><div class="visor__nota"></div><div class="visor__cuenta"></div></div>' +
      '<button type="button" class="visor__ant" aria-label="Anterior">‹</button>' +
      '<button type="button" class="visor__sig" aria-label="Siguiente">›</button>' +
      '<button type="button" class="visor__cerrar" aria-label="Cerrar">✕</button>';
    document.body.appendChild(v);
    var medio = v.querySelector('.visor__medio'), nota = v.querySelector('.visor__nota'), cuenta = v.querySelector('.visor__cuenta');
    var lista = [], i = 0, antesOverflow = '';

    function mostrar(n) {
      i = (n + lista.length) % lista.length;
      var a = lista[i];
      medio.textContent = '';
      var el;
      if (a.hasAttribute('data-video')) {
        el = document.createElement('video');
        el.controls = true; el.playsInline = true; el.autoplay = true;
      } else {
        el = document.createElement('img');
        el.alt = a.getAttribute('data-nota') || 'Foto de la reparación';
      }
      el.src = a.getAttribute('data-src');
      medio.appendChild(el);
      nota.textContent = a.getAttribute('data-nota') || '';
      cuenta.textContent = lista.length > 1 ? (i + 1) + ' / ' + lista.length : '';
      v.querySelector('.visor__ant').hidden = v.querySelector('.visor__sig').hidden = lista.length < 2;
    }
    function abrir(a) {
      lista = Array.prototype.slice.call(gal.querySelectorAll('a[data-visor]'));
      antesOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      v.hidden = false;
      mostrar(lista.indexOf(a));
      v.querySelector('.visor__cerrar').focus();
    }
    function cerrar() {
      v.hidden = true;
      medio.textContent = '';  // detiene el video
      document.body.style.overflow = antesOverflow;
    }

    gal.addEventListener('click', function (e) {
      var a = e.target.closest('a[data-visor]');
      if (!a) return;
      e.preventDefault();
      abrir(a);
    });
    gal.addEventListener('keydown', function (e) {
      var a = e.target.closest('a[data-visor]');
      if (a && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); abrir(a); }
    });
    v.querySelector('.visor__ant').onclick = function () { mostrar(i - 1); };
    v.querySelector('.visor__sig').onclick = function () { mostrar(i + 1); };
    v.querySelector('.visor__cerrar').onclick = cerrar;
    v.addEventListener('click', function (e) { if (e.target === v || e.target === medio) cerrar(); });
    document.addEventListener('keydown', function (e) {
      if (v.hidden) return;
      if (e.key === 'Escape') cerrar();
      else if (e.key === 'ArrowLeft') mostrar(i - 1);
      else if (e.key === 'ArrowRight') mostrar(i + 1);
    });
    var x0 = null, y0 = 0;
    v.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    v.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && lista.length > 1) mostrar(dx < 0 ? i + 1 : i - 1);
    }, { passive: true });
  }
})();
