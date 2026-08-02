/* ==========================================================================
   Emisha — calculadora de costos de impresión 3D
   Herramienta libre para makers: calcula cuánto cuesta imprimir una pieza y
   sugiere precios de venta. Todo el cálculo ocurre en el navegador.
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  if (!$('calc-gramos')) return;

  /* Multiplicadores sugeridos sobre el costo real. */
  var MARGENES = { amigo: 1.3, regular: 2.2, taller: 3.2 };

  var campos = ['calc-precio-kg', 'calc-gramos', 'calc-horas',
                'calc-watts', 'calc-kwh', 'calc-desgaste', 'calc-fallo'];

  function num(id, fallback) {
    var v = parseFloat($(id).value.replace(',', '.'));
    return isFinite(v) && v >= 0 ? v : fallback;
  }

  var money = function (n) {
    return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  function calcular() {
    var precioKg  = num('calc-precio-kg', 300);
    var gramos    = num('calc-gramos', 0);
    var horas     = num('calc-horas', 0);
    var watts     = num('calc-watts', 120);
    var precioKwh = num('calc-kwh', 2.5);
    var desgaste  = num('calc-desgaste', 2);
    var fallo     = num('calc-fallo', 8);

    var material = (gramos / 1000) * precioKg;
    var kwh      = (watts / 1000) * horas;
    var luz      = kwh * precioKwh;
    var uso      = horas * desgaste;
    var subtotal = material + luz + uso;
    var reserva  = subtotal * (fallo / 100);
    var total    = subtotal + reserva;

    $('out-material').textContent = money(material);
    $('out-luz').textContent      = money(luz);
    $('out-kwh').textContent      = kwh.toFixed(2) + ' kWh';
    $('out-desgaste').textContent = money(uso);
    $('out-fallo').textContent    = money(reserva);
    $('out-total').textContent    = money(total);

    $('out-amigo').textContent   = money(total * MARGENES.amigo);
    $('out-regular').textContent = money(total * MARGENES.regular);
    $('out-taller').textContent  = money(total * MARGENES.taller);

    $('out-hora').textContent = horas > 0
      ? money((total * MARGENES.regular) / horas) + ' / hora'
      : '—';
    $('out-gramo').textContent = gramos > 0
      ? money(total / gramos) + ' / gramo'
      : '—';
  }

  campos.forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('input', calcular);
  });

  var reset = $('calc-reset');
  if (reset) {
    reset.addEventListener('click', function () {
      var d = { 'calc-precio-kg': 300, 'calc-gramos': 20, 'calc-horas': 2,
                'calc-watts': 120, 'calc-kwh': 2.5, 'calc-desgaste': 2, 'calc-fallo': 8 };
      Object.keys(d).forEach(function (k) { if ($(k)) $(k).value = d[k]; });
      calcular();
    });
  }

  calcular();
})();
