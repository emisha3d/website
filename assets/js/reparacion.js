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
    : 'https://emisha-reparaciones.matosic-hrvoje.workers.dev';
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

  function avisar(texto, tipo, sinMover) {
    aviso.textContent = texto || '';
    aviso.hidden = !texto;
    aviso.className = 'cita-aviso' + (tipo ? ' cita-aviso--' + tipo : '');
    if (texto && !sinMover && aviso.scrollIntoView) aviso.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function pedir(ruta, opciones) {
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
      botonEnviar.disabled = true;
      botonEnviar.textContent = 'Agendar por WhatsApp';
      botonEnviar.type = 'button';
      botonEnviar.addEventListener('click', function () { window.open(WA, '_blank', 'noopener'); });
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
    botonAgregar.hidden = lista.length >= 6;
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
    if (lista.length >= 6) return;
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
    lista: ['Lista para entrega', 'Tu {modelo} ya está lista', 'Pasa por ella al taller de lunes a viernes de 9:00 a 19:00. Si prefieres otro horario, escríbenos.'],
    entregada: ['Entregada', 'Gracias por confiar en Emisha', 'Si vuelve a fallar o necesitas otra cosa, aquí estamos.'],
    cancelada: ['Cita cancelada', 'Esta cita fue cancelada', 'Si quieres, agenda otra abajo o escríbenos por WhatsApp.'],
    no_llego: ['Cita vencida', 'No recibimos tu impresora ese día', 'Puedes agendar otra cita cuando gustes.']
  };

  function mostrarConfirmacion(cita, recien) {
    var t = TEXTO_ESTADO[cita.estado] || TEXTO_ESTADO.nueva;
    var cuando = cita.fecha_legible + ' a las ' + cita.hora;
    conf.querySelector('[data-conf-eyebrow]').textContent = t[0];
    conf.querySelector('[data-conf-titulo]').textContent = t[1].replace('{cuando}', cuando).replace('{modelo}', cita.modelo);
    conf.querySelector('[data-conf-folio]').textContent = 'Folio ' + cita.folio;

    var datos = [
      ['Cuándo', esc(cuando)],
      ['Dónde', 'Av. División del Norte 1354, Piso 1, Letrán del Valle, Benito Juárez, CDMX 03650. Estacionamiento con valet parking.'],
      [(cita.equipos && cita.equipos.length > 1) ? 'Impresoras' : 'Impresora',
        (cita.equipos && cita.equipos.length)
          ? cita.equipos.map(function (e) {
              return esc(e.modelo) + (e.trae_ams ? ' · con AMS' : '') + ' · ' + esc(e.tipo_falla);
            }).join('<br>')
          : esc(cita.modelo) + (cita.trae_ams ? ' · con AMS' : '') + ' · ' + esc(cita.tipo_falla)],
      ['Qué traer', ((cita.equipos && cita.equipos.length > 1) ? 'Las impresoras' : 'La impresora') + ' con su cable de corriente' + (cita.trae_ams ? ' y el AMS con el suyo' : '') + '. Si la falla pasa con un filamento en particular, tráelo.'],
      ['Costos', 'Diagnóstico $300 · Reparación $700 (con diagnóstico previo, $400). Refacciones aparte, siempre con tu autorización.']
    ];
    if (cita.estado !== 'nueva') datos = datos.slice(0, 3);
    conf.querySelector('[data-conf-datos]').innerHTML = datos.map(function (p) {
      return '<div><dt>' + p[0] + '</dt><dd>' + p[1] + '</dd></div>';
    }).join('');

    var acciones = conf.querySelector('[data-conf-acciones]');
    acciones.textContent = '';
    if (cita.cotizacion_pendiente) {
      acciones.appendChild(boton('Ver y autorizar mi cotización', API + '/cotizacion/' + cita.cita_id, 'btn btn--accent'));
      acciones.appendChild(boton('WhatsApp', 'https://wa.me/525575639255?text=' + encodeURIComponent('Hola, tengo dudas de la cotización ' + cita.folio + ': '), 'btn btn--ghost'));
    } else if (cita.estado === 'nueva') {
      acciones.appendChild(boton('Agregar a mi calendario', cita.calendario_url, 'btn btn--primary'));
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
})();
