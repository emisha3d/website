/* Emisha — existencia en vivo para páginas que se generan estáticas.
   Las fichas de /filamentos/ y la reja de colores de /filamentos/ salen de un
   generador y dicen «En existencia» siempre. Este script le pregunta al worker
   de checkout (GET /stock, sin caché, proxy tal cual de CanalPulse) y marca
   «Agotado» lo que tenga 0.

   Las páginas de /refacciones/ (herramientas/gen-refacciones.py) son lo mismo
   pero con el catálogo de AG: se generan en cada build y se quedan con la
   existencia y el precio de ese día. Sus productos llevan
   data-existencia-fuente="ag" y se cotejan contra GET /productos del worker
   de AG (catalogo.emisha.com.mx): una sola petición por página, con 10 min de
   caché en el borde y en el navegador, que sirve para la ficha y para todas
   sus tarjetas. Solo se leen sku, precio_centavos, stock y disponible.

   Marcado que lee:
     [data-existencia-sku="E-…"]  un producto: la ficha entera (<main>) o una
                                  tarjeta. Agotado → recibe la clase .agotado.
     [data-existencia-fuente="ag"] en el mismo elemento: el SKU es de AG.
     [data-agotado-texto]         dentro del producto: su texto cambia a este.
     [data-agotado-href]          dentro del producto: su enlace cambia a este.
     [data-agotado-mostrar]       dentro del producto: deja de estar hidden.
     [data-existencia-cantidad]   (AG) dentro del producto: «N piezas en
                                  existencia» con el número vivo.
     [data-precio-vivo]           (AG) dentro del producto: «$1,234 MXN» con el
                                  precio vivo, si cambió.

   Un producto anidado (las tarjetas de «otros colores» dentro de la ficha) es
   dueño de su propio marcado: el de afuera no lo toca.

   Si el worker no contesta, la página se queda como vino: mejor enseñar
   «En existencia» de más que esconder un color que sí hay. */
(function () {
  'use strict';

  var API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
    ? 'http://localhost:8787'
    : 'https://emisha-checkout.matosic-hrvoje.workers.dev';
  var AG_API = 'https://catalogo.emisha.com.mx';

  var productos = document.querySelectorAll('[data-existencia-sku]');
  if (!productos.length) return;

  var propios = [], deAG = [], skus = {};
  productos.forEach(function (el) {
    if (el.getAttribute('data-existencia-fuente') === 'ag') { deAG.push(el); return; }
    propios.push(el);
    skus[el.getAttribute('data-existencia-sku')] = true;
  });

  function propio(nodo, producto) {
    return nodo.closest('[data-existencia-sku]') === producto;
  }

  function cadaUno(producto, sel, fn) {
    producto.querySelectorAll(sel).forEach(function (n) {
      if (propio(n, producto)) fn(n);
    });
  }

  function agotar(producto) {
    producto.classList.add('agotado');
    cadaUno(producto, '[data-agotado-texto]', function (n) {
      n.textContent = n.getAttribute('data-agotado-texto');
    });
    cadaUno(producto, '[data-agotado-href]', function (n) {
      n.setAttribute('href', n.getAttribute('data-agotado-href'));
    });
    cadaUno(producto, '[data-agotado-mostrar]', function (n) { n.hidden = false; });
  }

  // La ficha agotada tampoco debe declararle a Google InStock.
  function jsonldAgotado() {
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      if (s.textContent.indexOf('schema.org/InStock') === -1) return;
      s.textContent = s.textContent.replace('https://schema.org/InStock',
                                            'https://schema.org/OutOfStock');
    });
  }

  // Precio vivo en el JSON-LD de la ficha (Product → offers.price).
  function jsonldPrecio(sku, pesosNum) {
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      var d;
      try { d = JSON.parse(s.textContent); } catch (e) { return; }
      var nodos = (d && d['@graph']) || [d], cambio = false;
      nodos.forEach(function (n) {
        if (n && n['@type'] === 'Product' && n.sku === sku && n.offers && n.offers.price &&
            n.offers.price !== pesosNum.toFixed(2)) {
          n.offers.price = pesosNum.toFixed(2);
          cambio = true;
        }
      });
      if (cambio) s.textContent = JSON.stringify(d, null, 2);
    });
  }

  // Igual que pesos() del generador: sin centavos si son cero.
  function pesos(centavos) {
    var v = centavos / 100, entero = Math.abs(v - Math.round(v)) < 0.005;
    return '$' + v.toLocaleString('en-US', {
      minimumFractionDigits: entero ? 0 : 2, maximumFractionDigits: entero ? 0 : 2
    });
  }

  if (propios.length) {
    fetch(API + '/stock?skus=' + encodeURIComponent(Object.keys(skus).join(',')))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (datos) {
        var stock = datos && datos.stock;
        if (!stock) return;
        propios.forEach(function (el) {
          var n = stock[el.getAttribute('data-existencia-sku')];
          // Solo un 0 explícito cuenta: un SKU que no vino no es un agotado.
          if (typeof n !== 'number' || n > 0) return;
          agotar(el);
          if (el.tagName === 'MAIN') jsonldAgotado();
        });
      })
      .catch(function () {});
  }

  if (deAG.length) {
    fetch(AG_API + '/productos')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (datos) {
        var lista = datos && datos.productos;
        // Una lista vacía o rara es un worker con problemas, no un catálogo
        // agotado: la página se queda como vino.
        if (!lista || !lista.length) return;
        var vivos = {};
        lista.forEach(function (p) { if (p && p.sku) vivos[p.sku] = p; });
        deAG.forEach(function (el) {
          var sku = el.getAttribute('data-existencia-sku');
          var p = vivos[sku];
          var ficha = el.tagName === 'MAIN';
          // /productos solo trae lo publicable y con precio: si el SKU ya no
          // viene, AG lo dio de baja y tampoco se puede vender.
          if (!p || !(typeof p.stock === 'number' ? p.stock > 0 : p.disponible)) {
            agotar(el);
            if (ficha) jsonldAgotado();
            return;
          }
          if (typeof p.stock === 'number') {
            cadaUno(el, '[data-existencia-cantidad]', function (n) {
              n.textContent = p.stock <= 3 ? 'Últimas ' + p.stock + ' piezas'
                                           : p.stock + ' piezas en existencia';
            });
          }
          if (typeof p.precio_centavos === 'number' && p.precio_centavos > 0) {
            var texto = pesos(p.precio_centavos) + ' MXN';
            cadaUno(el, '[data-precio-vivo]', function (n) {
              if (n.textContent !== texto) n.textContent = texto;
            });
            if (ficha) jsonldPrecio(sku, p.precio_centavos / 100);
          }
        });
      })
      .catch(function () {});
  }
})();
