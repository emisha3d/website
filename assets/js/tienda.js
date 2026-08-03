/* Emisha — tienda: catálogo vivo + carrito + checkout.
   El catálogo y el stock vienen del worker de checkout (que a su vez habla
   con el inventario central). Aquí no hay precios propios: lo que pinta la
   página es informativo y el cobro real siempre se calcula en el servidor.

   El carrito vive en localStorage. El carrito_id identifica UN intento de
   compra: si el contenido cambia, se genera uno nuevo; si solo se reintenta
   el pago (doble clic, recarga), se conserva y el servidor responde con el
   mismo pedido (replay seguro). */
(function () {
  'use strict';

  var API = 'https://emisha-checkout.matosic-hrvoje.workers.dev';
  var LLAVE = 'emisha-carrito-v1';

  var catalogo = [];          // [{sku, nombre, precio_centavos, stock}]
  var porSku = {};

  /* --- Estado del carrito ---------------------------------------------- */

  function cargarCarrito() {
    try {
      var c = JSON.parse(localStorage.getItem(LLAVE));
      if (c && c.carrito_id && c.lineas) return c;
    } catch (e) { /* carrito corrupto: se empieza de cero */ }
    return { carrito_id: nuevoId(), lineas: {} };  // lineas: {sku: cantidad}
  }

  function nuevoId() {
    return (crypto.randomUUID) ? crypto.randomUUID()
      : 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  var carrito = cargarCarrito();

  function guardar() { localStorage.setItem(LLAVE, JSON.stringify(carrito)); }

  // Cambió el contenido => es OTRO intento de compra: nuevo carrito_id.
  function fijarCantidad(sku, n) {
    n = Math.max(0, Math.min(n, (porSku[sku] && porSku[sku].stock) || 0));
    if (n === 0) delete carrito.lineas[sku];
    else carrito.lineas[sku] = n;
    carrito.carrito_id = nuevoId();
    guardar();
    pintarCantidad(sku);
    pintarBarra();
  }

  /* --- Utilidades ------------------------------------------------------- */

  var mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  function precio(centavos) { return mxn.format(centavos / 100); }

  function totalCarrito() {
    var t = 0, piezas = 0;
    Object.keys(carrito.lineas).forEach(function (sku) {
      var p = porSku[sku];
      if (!p) return;
      t += p.precio_centavos * carrito.lineas[sku];
      piezas += carrito.lineas[sku];
    });
    return { centavos: t, piezas: piezas };
  }

  /* --- Pintado ---------------------------------------------------------- */

  var grid = document.querySelector('[data-tienda-grid]');
  var barra = document.querySelector('[data-cart-bar]');
  var aviso = document.querySelector('[data-tienda-aviso]');

  function avisar(texto, esError) {
    if (!aviso) return;
    aviso.textContent = texto || '';
    aviso.hidden = !texto;
    aviso.classList.toggle('tienda-aviso--error', !!esError);
  }

  function tarjeta(p) {
    var el = document.createElement('div');
    el.className = 'prod';
    el.dataset.sku = p.sku;
    var pocas = p.stock <= 3 ? '<span class="prod__pocas">Últimas ' + p.stock + '</span>' : '';
    el.innerHTML =
      '<div class="prod__media" aria-hidden="true"><span>' + inicial(p.nombre) + '</span></div>' +
      '<div class="prod__body">' +
        '<div class="prod__nombre"></div>' +
        '<div class="prod__precio">' + precio(p.precio_centavos) + ' ' + pocas + '</div>' +
        '<div class="prod__acciones">' +
          '<button type="button" class="btn btn--primary btn--sm" data-agregar>Agregar</button>' +
          '<div class="prod__stepper" data-stepper hidden>' +
            '<button type="button" aria-label="Quitar una pieza" data-menos>−</button>' +
            '<span data-cantidad aria-live="polite">0</span>' +
            '<button type="button" aria-label="Agregar una pieza" data-mas>+</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    el.querySelector('.prod__nombre').textContent = p.nombre;  // sin inyectar HTML
    if (p.imagen) {
      var media = el.querySelector('.prod__media');
      media.textContent = '';
      var img = document.createElement('img');
      img.src = p.imagen;
      img.alt = p.nombre;
      img.loading = 'lazy';
      media.appendChild(img);
    }
    el.querySelector('[data-agregar]').addEventListener('click', function () {
      fijarCantidad(p.sku, 1);
    });
    el.querySelector('[data-menos]').addEventListener('click', function () {
      fijarCantidad(p.sku, (carrito.lineas[p.sku] || 0) - 1);
    });
    el.querySelector('[data-mas]').addEventListener('click', function () {
      fijarCantidad(p.sku, (carrito.lineas[p.sku] || 0) + 1);
    });
    return el;
  }

  function inicial(nombre) {
    return (nombre || '?').trim().charAt(0).toUpperCase();
  }

  function pintarCantidad(sku) {
    var el = grid && grid.querySelector('[data-sku="' + sku + '"]');
    if (!el) return;
    var n = carrito.lineas[sku] || 0;
    el.querySelector('[data-agregar]').hidden = n > 0;
    el.querySelector('[data-stepper]').hidden = n === 0;
    el.querySelector('[data-cantidad]').textContent = n;
    var p = porSku[sku];
    el.querySelector('[data-mas]').disabled = p && n >= p.stock;
  }

  function pintarBarra() {
    if (!barra) return;
    var t = totalCarrito();
    barra.hidden = t.piezas === 0;
    barra.querySelector('[data-cart-resumen]').textContent =
      t.piezas + (t.piezas === 1 ? ' pieza' : ' piezas') + ' · ' + precio(t.centavos);
  }

  /* --- Catálogo --------------------------------------------------------- */

  function cargarCatalogo() {
    if (!grid) return;
    fetch(API + '/productos')
      .then(function (r) { return r.json(); })
      .then(function (datos) {
        catalogo = (datos.productos || []).filter(function (p) { return p.stock > 0; });
        porSku = {};
        catalogo.forEach(function (p) { porSku[p.sku] = p; });

        // Piezas del carrito que ya no existen o no tienen stock: fuera.
        var huboCambio = false;
        Object.keys(carrito.lineas).forEach(function (sku) {
          if (!porSku[sku]) { delete carrito.lineas[sku]; huboCambio = true; }
        });
        if (huboCambio) { carrito.carrito_id = nuevoId(); guardar(); }

        grid.textContent = '';
        if (!catalogo.length) {
          grid.innerHTML = '<p class="muted">Por ahora no hay piezas disponibles en línea. ' +
            'Encuéntranos en la <a href="https://www.mercadolibre.com.mx/tienda/emisha" ' +
            'target="_blank" rel="noopener">tienda oficial de MercadoLibre</a>.</p>';
          return;
        }
        catalogo.forEach(function (p) {
          grid.appendChild(tarjeta(p));
          pintarCantidad(p.sku);
        });
        pintarBarra();
      })
      .catch(function () {
        grid.innerHTML = '<p class="muted">No pudimos cargar el catálogo. Recarga la página ' +
          'o inténtalo más tarde.</p>';
      });
  }

  /* --- Checkout --------------------------------------------------------- */

  var botonPagar = document.querySelector('[data-pagar]');
  if (botonPagar) botonPagar.addEventListener('click', pagar);

  function pagar() {
    var lineas = Object.keys(carrito.lineas).map(function (sku) {
      return { sku: sku, cantidad: carrito.lineas[sku] };
    });
    if (!lineas.length) return;

    botonPagar.disabled = true;
    botonPagar.textContent = 'Preparando el pago…';
    avisar('');

    fetch(API + '/pedido', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carrito_id: carrito.carrito_id, lineas: lineas })
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, datos: d }; }); })
      .then(function (r) {
        if ((r.status === 201 || r.status === 200) && r.datos.url_pago) {
          // Recordar el folio para la página de gracias (MP a veces regresa
          // sin query params si el cliente cierra a medias).
          try { localStorage.setItem('emisha-ultimo-pedido', r.datos.pedido_id); } catch (e) {}
          window.location.href = r.datos.url_pago;
          return;
        }
        if (r.status === 409 && r.datos.faltantes) {
          // No alcanzó el stock: ajustar el carrito a lo que sí hay.
          r.datos.faltantes.forEach(function (f) {
            if (porSku[f.sku]) porSku[f.sku].stock = f.available;
            fijarCantidad(f.sku, Math.min(carrito.lineas[f.sku] || 0, f.available));
          });
          avisar('El inventario cambió mientras armabas tu carrito: lo ajustamos a las ' +
            'piezas que sí hay. Revisa las cantidades y vuelve a intentar.', true);
          restaurarBoton();
          return;
        }
        if (r.status === 503) {
          // Pago en línea aún no habilitado (falta el token de MP en el worker).
          avisar('El pago en línea se activa muy pronto. Mientras tanto escríbenos por ' +
            'WhatsApp al +52 55 7563 9255 con lo que traes en el carrito y te lo apartamos.', true);
        } else {
          avisar((r.datos && r.datos.error) || 'No se pudo iniciar el pago. Inténtalo de nuevo.', true);
        }
        restaurarBoton();
      })
      .catch(function () {
        avisar('No se pudo iniciar el pago. Revisa tu conexión e inténtalo de nuevo.', true);
        restaurarBoton();
      });
  }

  function restaurarBoton() {
    botonPagar.disabled = false;
    botonPagar.textContent = 'Pagar con Mercado Pago';
  }

  cargarCatalogo();
})();
