/* Emisha — solicitud de factura (/factura/). El cliente deja sus datos
   fiscales o su constancia; el worker de reparaciones los guarda, avisa al
   taller con la constancia adjunta y le manda acuse al cliente. Aquí no se
   timbra nada.

   ?folio=R-261017-AB3D&monto=1000&concepto=reparacion en la URL prellenan el
   paso 1 (para mandarle al cliente el enlace ya armado). */
(function () {
  'use strict';

  // El mismo worker que recibe las citas de /reparacion/.
  var API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
    ? 'http://localhost:8787'
    : 'https://citas.emisha.com.mx';
  var MAX_MB = 8;
  var RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/;

  var form = document.querySelector('[data-factura-form]');
  var aviso = document.querySelector('[data-aviso]');
  var conf = document.querySelector('[data-confirmacion]');
  var bloque = document.querySelector('[data-formulario]');
  if (!form || !conf) return;

  var csf = form.querySelector('#f-csf');
  var caja = form.querySelector('[data-csf-caja]');
  var notaCsf = form.querySelector('[data-csf-nota]');
  var separa = form.querySelector('[data-separa]');
  var notaOriginal = notaCsf.textContent;
  // Los cuatro datos que ya trae la constancia.
  var deLaConstancia = ['#f-rfc', '#f-nombre', '#f-regimen', '#f-cp'].map(function (s) { return form.querySelector(s); });
  var enviar = form.querySelector('[data-enviar]');

  function decir(texto, tipo) {
    if (!texto) { aviso.hidden = true; return; }
    aviso.className = 'cita-aviso' + (tipo ? ' cita-aviso--' + tipo : '');
    aviso.textContent = texto;
    aviso.hidden = false;
    aviso.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function hoy() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Prellenado desde la URL.
  var q = new URLSearchParams(location.search);
  var fecha = form.querySelector('#f-fecha');
  fecha.max = hoy();
  if (q.get('folio')) form.querySelector('#f-folio').value = q.get('folio').slice(0, 60);
  if (q.get('monto') && parseFloat(q.get('monto')) > 0) form.querySelector('#f-monto').value = parseFloat(q.get('monto'));
  var concepto = form.querySelector('#f-concepto');
  if (q.get('concepto') && concepto.querySelector('option[value="' + q.get('concepto').replace(/[^a-z]/g, '') + '"]')) {
    concepto.value = q.get('concepto');
  }

  // Con constancia, los cuatro datos pasan a opcionales (si los escribe, se
  // revisan igual).
  function alCambiarCsf() {
    var f = csf.files && csf.files[0];
    var con = !!f;
    deLaConstancia.forEach(function (el) { el.required = !con; });
    caja.classList.toggle('csf--lista', con);
    notaCsf.textContent = con
      ? 'Lista: ' + f.name + '. Lo de abajo ya es opcional.'
      : notaOriginal;
    separa.textContent = con ? 'opcional' : 'o escríbelos';
  }
  csf.addEventListener('change', function () {
    var f = csf.files && csf.files[0];
    if (f && f.size > MAX_MB * 1048576) {
      decir('Tu constancia pesa ' + (f.size / 1048576).toFixed(1) + ' MB; el tope son ' + MAX_MB + ' MB. Sube el PDF del SAT o una foto más ligera.', 'error');
      csf.value = '';
    } else {
      decir('');
    }
    alCambiarCsf();
  });

  var rfc = form.querySelector('#f-rfc');
  rfc.addEventListener('input', function () {
    var p = rfc.selectionStart;
    rfc.value = rfc.value.toUpperCase().replace(/[\s-]/g, '');
    try { rfc.setSelectionRange(p, p); } catch (e) {}
  });
  var cp = form.querySelector('#f-cp');
  cp.addEventListener('input', function () { cp.value = cp.value.replace(/\D/g, '').slice(0, 5); });

  // Lo mismo que revisa el worker, para no esperar la vuelta.
  function revisar() {
    var conCsf = !!(csf.files && csf.files[0]);
    var v = function (s) { return (form.querySelector(s).value || '').trim(); };
    if (!v('#f-concepto')) return ['Elige qué pagaste.', '#f-concepto'];
    if (!(parseFloat(v('#f-monto')) > 0)) return ['Escribe cuánto pagaste.', '#f-monto'];
    if (!v('#f-fecha') || v('#f-fecha') > hoy()) return ['Escribe la fecha en que pagaste.', '#f-fecha'];
    if (!v('#f-forma')) return ['Elige cómo pagaste.', '#f-forma'];
    if (v('#f-rfc') && !RFC_RE.test(v('#f-rfc'))) return ['El RFC no se ve bien: son 12 caracteres (empresa) o 13 (persona), sin espacios.', '#f-rfc'];
    if (v('#f-cp') && !/^\d{5}$/.test(v('#f-cp'))) return ['El código postal son 5 números.', '#f-cp'];
    if (!conCsf) {
      if (!v('#f-rfc')) return ['Escribe tu RFC o sube tu constancia de situación fiscal.', '#f-rfc'];
      if (v('#f-nombre').length < 3) return ['Escribe tu nombre o razón social tal como viene en tu constancia.', '#f-nombre'];
      if (!v('#f-regimen')) return ['Elige tu régimen fiscal.', '#f-regimen'];
      if (!v('#f-cp')) return ['Escribe el código postal de tu domicilio fiscal.', '#f-cp'];
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('#f-correo'))) return ['Escribe el correo a donde te mandamos la factura.', '#f-correo'];
    return null;
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var problema = revisar();
    if (problema) {
      decir(problema[0], 'error');
      var campo = form.querySelector(problema[1]);
      if (campo) setTimeout(function () { campo.focus({ preventScroll: true }); }, 300);
      return;
    }
    decir('');
    enviar.disabled = true;
    var antes = enviar.textContent;
    enviar.textContent = 'Enviando…';

    fetch(API + '/factura', { method: 'POST', body: new FormData(form) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
      })
      .then(function (res) {
        if (!res.ok || !res.d.folio) throw new Error(res.d.error || 'No pudimos guardar tus datos.');
        conf.querySelector('[data-c-folio]').textContent = 'Folio ' + res.d.folio;
        conf.querySelector('[data-c-correo]').textContent = form.querySelector('#f-correo').value.trim();
        conf.querySelector('[data-c-acuse]').hidden = !res.d.correo;
        bloque.hidden = true;
        conf.hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function (e) {
        enviar.disabled = false;
        enviar.textContent = antes;
        var red = e instanceof TypeError;
        decir(red
          ? 'No pudimos enviar tus datos (¿sin conexión?). Inténtalo otra vez o mándanos tu constancia por WhatsApp al +52 55 7563 9255.'
          : e.message, 'error');
      });
  });
})();
