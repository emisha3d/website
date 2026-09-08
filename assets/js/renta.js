/* Emisha — renta de impresoras: escoger equipo y tarifa, ver lo que se paga y
   apartar el turno. Los precios viven aquí Y en las tarjetas de la página; el
   worker los vuelve a calcular al recibir el apartado, así que nadie puede
   rentar más barato tocando el navegador.

   Si el worker no responde, la página no se rompe: ofrece WhatsApp. */
(function () {
  'use strict';

  var API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
    ? 'http://localhost:8788'
    : 'https://emisha-renta.matosic-hrvoje.workers.dev';
  var WA = 'https://wa.me/525575639255?text=' + encodeURIComponent('Hola, quiero rentar una impresora 3D.');

  /* Precios SIN IVA, en pesos. Salen de aplicar el 40% del valor del equipo al
     mes; la semana es el 40% del mes y el día el 11% del mes. El depósito en
     garantía es el 30% del valor. Cambiar algo aquí obliga a cambiarlo también
     en las tarjetas de /renta/ y en el worker. */
  var MAQUINAS = {
    'A1 mini':   { dia: 220,  semana: 800,  mes: 2000,  valor: 5000,  deposito: 1500 },
    'A1':        { dia: 350,  semana: 1300, mes: 3200,  valor: 8000,  deposito: 2400 },
    'A2':        { dia: 520,  semana: 1900, mes: 4800,  valor: 12000, deposito: 3600 },
    'P1S':       { dia: 650,  semana: 2400, mes: 6000,  valor: 15000, deposito: 4500 },
    'Snapmaker': { dia: 1200, semana: 4300, mes: 10800, valor: 27000, deposito: 8100 },
    'X1 Carbon': { dia: 1200, semana: 4500, mes: 11200, valor: 28000, deposito: 8400 },
    'H2S':       { dia: 1600, semana: 5800, mes: 14400, valor: 36000, deposito: 10800 }
  };

  var IVA = 0.16;
  var ANTICIPO = 0.20;
  var MINIMO_DIAS = 3;

  /* Reglas de cada tarifa: cuántas unidades se pueden pedir y cómo se llaman. */
  var TARIFAS = {
    dia:    { min: MINIMO_DIAS, max: 90, unidad: 'días',   hint: 'Mínimo 3 días.' },
    semana: { min: 1, max: 12, unidad: 'semanas', hint: 'Una semana equivale a unos cuatro días sueltos.' },
    mes:    { min: 1, max: 12, unidad: 'meses',   hint: 'A partir de dos semanas conviene revisar la compra con abono de renta.' }
  };

  var form = document.querySelector('[data-renta-form]');
  var resumen = document.querySelector('[data-resumen]');
  if (!form || !resumen) return;

  var aviso = document.querySelector('[data-renta-aviso]');
  var campoCantidad = form.querySelector('#cantidad');
  var campoInicio = form.querySelector('#inicio');
  var etiquetaUnidad = form.querySelector('[data-unidad]');
  var hintCantidad = form.querySelector('[data-hint-cantidad]');
  var botonEnviar = resumen.querySelector('[data-enviar]');

  /* --- Utilidades ------------------------------------------------------- */

  function mxn(pesos) {
    return '$' + Math.round(pesos).toLocaleString('es-MX');
  }

  function hoyMX() {
    // La fecha del taller, no la del navegador: alguien en otro huso no debe
    // poder apartar "ayer" ni perder el día de hoy.
    var f = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    return f; // YYYY-MM-DD
  }

  function sumarDias(iso, n) {
    var p = iso.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function diaSemana(iso) {
    var p = iso.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(); // 0=dom 6=sáb
  }

  function maquinaElegida() {
    var r = form.querySelector('input[name="maquina"]:checked');
    return r ? r.value : null;
  }

  function tarifaElegida() {
    var r = form.querySelector('input[name="tarifa"]:checked');
    return r ? r.value : 'dia';
  }

  function mostrarError(clave, texto) {
    var el = form.querySelector('[data-error-' + clave + ']');
    if (!el) return;
    if (texto) { el.textContent = texto; el.hidden = false; }
    else { el.hidden = true; }
    var campo = el.closest('.renta-campo');
    if (campo) campo.classList.toggle('is-error', !!texto);
  }

  function limpiarErrores() {
    ['maquina', 'cantidad', 'inicio', 'nombre', 'telefono', 'correo', 'acepto']
      .forEach(function (c) { mostrarError(c, ''); });
  }

  function decir(texto, tipo) {
    if (!aviso) return;
    aviso.className = 'renta-aviso renta-aviso--' + (tipo || 'error');
    aviso.innerHTML = texto;
    aviso.hidden = false;
    aviso.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function callar() {
    if (aviso) aviso.hidden = true;
  }

  /* --- Cuentas ---------------------------------------------------------- */

  function calcular() {
    var nombre = maquinaElegida();
    var m = nombre ? MAQUINAS[nombre] : null;
    var tarifa = tarifaElegida();
    var cantidad = parseInt(campoCantidad.value, 10);
    var regla = TARIFAS[tarifa];

    if (!m || !isFinite(cantidad) || cantidad < regla.min) return null;

    var renta = m[tarifa] * cantidad;
    var iva = renta * IVA;
    var total = renta + iva;
    var anticipo = Math.round(total * ANTICIPO);

    return {
      maquina: nombre, tarifa: tarifa, cantidad: cantidad,
      renta: renta, iva: iva, total: total,
      anticipo: anticipo, resto: total - anticipo,
      deposito: m.deposito
    };
  }

  function pintarResumen() {
    var c = calcular();
    var t = function (sel) { return resumen.querySelector(sel); };
    var regla = TARIFAS[tarifaElegida()];

    if (!c) {
      t('[data-r-maquina]').textContent = maquinaElegida() ? 'Ajusta el tiempo' : 'Escoge una impresora';
      ['[data-r-renta]', '[data-r-iva]', '[data-r-total]', '[data-r-anticipo]',
       '[data-r-resto]', '[data-r-deposito]'].forEach(function (s) { t(s).textContent = '—'; });
      return;
    }

    t('[data-r-maquina]').textContent = c.maquina + ' · ' + c.cantidad + ' ' +
      (c.cantidad === 1 ? regla.unidad.replace(/e?s$/, '') : regla.unidad);
    t('[data-r-renta]').textContent = mxn(c.renta);
    t('[data-r-iva]').textContent = mxn(c.iva);
    t('[data-r-total]').textContent = mxn(c.total);
    t('[data-r-anticipo]').textContent = mxn(c.anticipo);
    t('[data-r-resto]').textContent = mxn(c.resto);
    t('[data-r-deposito]').textContent = mxn(c.deposito);
  }

  /* --- La tarifa cambia el mínimo, el máximo y cómo se llama la unidad --- */

  function ajustarTarifa() {
    var regla = TARIFAS[tarifaElegida()];
    campoCantidad.min = regla.min;
    campoCantidad.max = regla.max;
    if (!isFinite(parseInt(campoCantidad.value, 10)) || parseInt(campoCantidad.value, 10) < regla.min) {
      campoCantidad.value = regla.min;
    }
    etiquetaUnidad.textContent = regla.unidad;
    hintCantidad.textContent = regla.hint;
    mostrarError('cantidad', '');
  }

  /* --- Enlazado --------------------------------------------------------- */

  // is-checked replica :has(input:checked) para navegadores viejos.
  function marcarPicker() {
    form.querySelectorAll('.picker__item input').forEach(function (r) {
      r.closest('.picker__item').classList.toggle('is-checked', r.checked);
    });
  }

  form.addEventListener('change', function (e) {
    marcarPicker();
    if (e.target.name === 'tarifa') ajustarTarifa();
    if (e.target.name === 'maquina') mostrarError('maquina', '');
    pintarResumen();
  });
  campoCantidad.addEventListener('input', pintarResumen);

  // "Rentar esta" en las tarjetas de la flota: escoge la máquina y baja al form.
  document.querySelectorAll('[data-rentar]').forEach(function (b) {
    b.addEventListener('click', function () {
      var r = form.querySelector('input[name="maquina"][value="' + b.dataset.rentar + '"]');
      if (!r) return;
      r.checked = true;
      marcarPicker();
      pintarResumen();
      document.getElementById('rentar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // No se puede apartar para hoy ni para el pasado: el equipo se prepara antes.
  campoInicio.min = sumarDias(hoyMX(), 1);
  campoInicio.max = sumarDias(hoyMX(), 60);

  ajustarTarifa();
  marcarPicker();
  pintarResumen();

  /* --- Validar y mandar -------------------------------------------------- */

  function validar() {
    limpiarErrores();
    var ok = true;

    if (!maquinaElegida()) { mostrarError('maquina', 'Escoge una impresora.'); ok = false; }

    var regla = TARIFAS[tarifaElegida()];
    var cantidad = parseInt(campoCantidad.value, 10);
    if (!isFinite(cantidad) || cantidad < regla.min || cantidad > regla.max) {
      mostrarError('cantidad', 'Entre ' + regla.min + ' y ' + regla.max + ' ' + regla.unidad + '.');
      ok = false;
    }

    var inicio = campoInicio.value;
    if (!inicio) {
      mostrarError('inicio', 'Escoge desde qué día.');
      ok = false;
    } else if (inicio < campoInicio.min) {
      mostrarError('inicio', 'El equipo se recoge a partir de mañana.');
      ok = false;
    } else if (diaSemana(inicio) === 0 || diaSemana(inicio) === 6) {
      mostrarError('inicio', 'Solo se entrega de lunes a viernes.');
      ok = false;
    }

    if (!form.nombre.value.trim()) { mostrarError('nombre', 'Escribe tu nombre.'); ok = false; }

    var tel = form.telefono.value.replace(/\D/g, '');
    if (tel.length < 10) { mostrarError('telefono', 'Escribe un teléfono de 10 dígitos.'); ok = false; }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.correo.value.trim())) {
      mostrarError('correo', 'Escribe un correo válido.'); ok = false;
    }

    if (!form.acepto.checked) { mostrarError('acepto', 'Hay que aceptar para poder apartar.'); ok = false; }

    return ok;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    callar();
    if (!validar()) {
      var primero = form.querySelector('.renta-error:not([hidden])');
      if (primero) primero.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    var c = calcular();
    botonEnviar.disabled = true;
    botonEnviar.textContent = 'Apartando…';

    fetch(API + '/api/renta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maquina: c.maquina,
        tarifa: c.tarifa,
        cantidad: c.cantidad,
        inicio: campoInicio.value,
        para: form.para.value.trim(),
        nombre: form.nombre.value.trim(),
        telefono: form.telefono.value.trim(),
        correo: form.correo.value.trim()
      })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, cuerpo: j }; });
    }).then(function (r) {
      if (!r.ok) throw new Error(r.cuerpo && r.cuerpo.error || 'No se pudo apartar');
      // El worker regresa a dónde ir a pagar el anticipo.
      if (r.cuerpo.pago) { location.href = r.cuerpo.pago; return; }
      decir('Listo, tu equipo quedó apartado. Te mandamos la confirmación a <b>' +
            form.correo.value.trim() + '</b>.', 'ok');
      form.reset();
      ajustarTarifa();
      marcarPicker();
      pintarResumen();
    }).catch(function () {
      decir('No se pudo apartar en línea ahora mismo. Escríbenos por ' +
            '<a href="' + WA + '" target="_blank" rel="noopener">WhatsApp</a> ' +
            'y lo apartamos nosotros.');
    }).then(function () {
      botonEnviar.disabled = false;
      botonEnviar.textContent = 'Apartar mi equipo';
    });
  });

})();
