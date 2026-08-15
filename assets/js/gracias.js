/* Emisha — página de gracias: estado del pedido tras volver de Mercado Pago.
   El folio viene en ?pedido= (o del localStorage como respaldo). El estado
   real lo dicta el worker; mientras el webhook de MP no llegue, el pedido
   sigue "pending" y aquí se reintenta unos segundos antes de rendirse. */
(function () {
  'use strict';

  var API = 'https://emisha-checkout.matosic-hrvoje.workers.dev';

  var caja = document.querySelector('[data-pedido]');
  if (!caja) return;

  var params = new URLSearchParams(window.location.search);
  var folio = params.get('pedido');
  if (!folio) {
    try { folio = localStorage.getItem('emisha-ultimo-pedido'); } catch (e) {}
  }

  var mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  var intentos = 0;

  function pintar(titulo, cuerpo) {
    caja.querySelector('[data-pedido-titulo]').textContent = titulo;
    caja.querySelector('[data-pedido-cuerpo]').innerHTML = cuerpo;
  }

  function lineasHtml(pedido) {
    var filas = (pedido.lineas || []).map(function (l) {
      var fila = '<tr><td>' + escapar(l.sku) + '</td><td>' + l.quantity + '</td><td>' +
        mxn.format(l.unit_price_cents * l.quantity / 100) + '</td></tr>';
      return fila;
    }).join('');
    // Pedidos previos al envío con tarifa no traen desglose: sin fila.
    var envio = pedido.envio;
    var filaEnvio = (envio && typeof envio.centavos === 'number')
      ? '<tr><th scope="row" colspan="2">Envío</th><td>' +
        (envio.centavos === 0 ? 'Gratis' : mxn.format(envio.centavos / 100)) + '</td></tr>'
      : '';
    var direccion = '';
    if (envio && envio.direccion) {
      var d = envio.direccion;
      direccion = '<p class="muted" style="margin-top:14px">Enviaremos tu paquete a: ' +
        escapar([d.calle, d.colonia, 'CP ' + d.cp, d.ciudad, d.estado].filter(Boolean).join(', ')) + '.</p>';
    }
    return '<div class="table-scroll"><table class="specs">' +
      '<thead><tr><th scope="col">Pieza</th><th scope="col">Cantidad</th><th scope="col">Importe</th></tr></thead>' +
      '<tbody>' + filas + filaEnvio +
      '<tr><th scope="row" colspan="2">Total</th><td><strong>' +
      mxn.format(pedido.total_centavos / 100) + '</strong></td></tr></tbody></table></div>' + direccion +
      '<p class="muted" style="font-size:.86rem;margin-top:14px">Folio: ' + escapar(pedido.pedido_id) + '</p>';
  }

  function escapar(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function consultar() {
    fetch(API + '/pedido/' + encodeURIComponent(folio))
      .then(function (r) {
        if (r.status === 404) throw new Error('404');
        return r.json();
      })
      .then(function (p) {
        if (p.estado === 'paid') {
          pintar('¡Gracias por tu compra' + (p.nombre ? ', ' + escapar(p.nombre) : '') + '!',
            '<p>Tu pago quedó confirmado y tus piezas ya están apartadas. Te escribimos por ' +
            'correo con la guía de envío en cuanto salga tu paquete.</p>' + lineasHtml(p));
          return;
        }
        if (p.estado === 'pending') {
          // MP a veces tarda unos segundos en avisar. Reintentar con calma.
          if (intentos++ < 12) {
            pintar('Confirmando tu pago…',
              '<p>Estamos esperando la confirmación de Mercado Pago. Esta página se ' +
              'actualiza sola; no hace falta recargar.</p>');
            setTimeout(consultar, 5000);
          } else {
            pintar('Tu pago sigue en proceso',
              '<p>Mercado Pago aún no nos confirma el resultado. Si ya pagaste, no te ' +
              'preocupes: en cuanto llegue la confirmación apartamos tus piezas y te ' +
              'avisamos por correo. Si algo sale mal, escríbenos por WhatsApp al ' +
              '<a href="https://wa.me/525575639255" target="_blank" rel="noopener">+52 55 7563 9255</a> con tu folio.</p>' +
              '<p class="muted" style="font-size:.86rem">Folio: ' + escapar(folio) + '</p>');
          }
          return;
        }
        // released / failed
        pintar('El pago no se completó',
          '<p>No se hizo ningún cargo y las piezas volvieron al inventario. Puedes ' +
          'intentarlo de nuevo cuando gustes.</p>' +
          '<p><a class="btn btn--primary" href="/tienda/">Volver a la tienda</a></p>');
      })
      .catch(function () {
        pintar('No encontramos ese pedido',
          '<p>Revisa que el enlace esté completo. Si pagaste y ves este mensaje, ' +
          'escríbenos por <a href="https://wa.me/525575639255" target="_blank" rel="noopener">WhatsApp</a> ' +
          'y lo resolvemos.</p>');
      });
  }

  if (folio) {
    consultar();
  } else {
    pintar('No hay pedido que mostrar',
      '<p>Parece que llegaste aquí sin un pedido en curso. La tienda está en ' +
      '<a href="/tienda/">emisha.com.mx/tienda</a>.</p>');
  }
})();
