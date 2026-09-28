/* Emisha — existencia en vivo para páginas que se generan estáticas.
   Las fichas de /filamentos/ y la reja de colores de /filamentos/ salen de un
   generador y dicen «En existencia» siempre. Este script le pregunta al worker
   de checkout (GET /stock, sin caché, proxy tal cual de CanalPulse) y marca
   «Agotado» lo que tenga 0.

   Marcado que lee:
     [data-existencia-sku="E-…"]  un producto: la ficha entera (<main>) o una
                                  tarjeta. Agotado → recibe la clase .agotado.
     [data-agotado-texto]         dentro del producto: su texto cambia a este.
     [data-agotado-href]          dentro del producto: su enlace cambia a este.
     [data-agotado-mostrar]       dentro del producto: deja de estar hidden.

   Un producto anidado (las tarjetas de «otros colores» dentro de la ficha) es
   dueño de su propio marcado: el de afuera no lo toca.

   Si el worker no contesta, la página se queda como vino: mejor enseñar
   «En existencia» de más que esconder un color que sí hay. */
(function () {
  'use strict';

  var API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
    ? 'http://localhost:8787'
    : 'https://emisha-checkout.matosic-hrvoje.workers.dev';

  var productos = document.querySelectorAll('[data-existencia-sku]');
  if (!productos.length) return;

  var skus = {};
  productos.forEach(function (el) { skus[el.getAttribute('data-existencia-sku')] = true; });

  function propio(nodo, producto) {
    return nodo.closest('[data-existencia-sku]') === producto;
  }

  function agotar(producto) {
    producto.classList.add('agotado');
    producto.querySelectorAll('[data-agotado-texto]').forEach(function (n) {
      if (propio(n, producto)) n.textContent = n.getAttribute('data-agotado-texto');
    });
    producto.querySelectorAll('[data-agotado-href]').forEach(function (n) {
      if (propio(n, producto)) n.setAttribute('href', n.getAttribute('data-agotado-href'));
    });
    producto.querySelectorAll('[data-agotado-mostrar]').forEach(function (n) {
      if (propio(n, producto)) n.hidden = false;
    });
  }

  // La ficha agotada tampoco debe declararle a Google InStock.
  function jsonldAgotado() {
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      if (s.textContent.indexOf('schema.org/InStock') === -1) return;
      s.textContent = s.textContent.replace('https://schema.org/InStock',
                                            'https://schema.org/OutOfStock');
    });
  }

  fetch(API + '/stock?skus=' + encodeURIComponent(Object.keys(skus).join(',')))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (datos) {
      var stock = datos && datos.stock;
      if (!stock) return;
      productos.forEach(function (el) {
        var n = stock[el.getAttribute('data-existencia-sku')];
        // Solo un 0 explícito cuenta: un SKU que no vino no es un agotado.
        if (typeof n !== 'number' || n > 0) return;
        agotar(el);
        if (el.tagName === 'MAIN') jsonldAgotado();
      });
    })
    .catch(function () {});
})();
