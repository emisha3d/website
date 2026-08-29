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
  var envioCfg = null;        // {centavos, gratis_desde_centavos} — lo manda el worker

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
    pintarCarrito();
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

  // Informativo: el cobro real del envío siempre lo calcula el worker.
  function costoEnvio(subtotalCentavos) {
    if (!envioCfg || !envioCfg.centavos) return 0;
    if (envioCfg.gratis_desde_centavos && subtotalCentavos >= envioCfg.gratis_desde_centavos) return 0;
    return envioCfg.centavos;
  }

  /* --- Pintado ---------------------------------------------------------- */

  var grid = document.querySelector('[data-tienda-grid]');
  var aviso = document.querySelector('[data-tienda-aviso]');
  var cartBtn = document.querySelector('[data-cart-abrir]');
  var cartN = document.querySelector('[data-cart-n]');
  var cartTotal = document.querySelector('[data-cart-total]');
  var drawer = document.querySelector('[data-cart-drawer]');
  var fondo = document.querySelector('[data-cart-fondo]');
  var lineasEl = document.querySelector('[data-cart-lineas]');
  var cuentaEl = document.querySelector('[data-cart-cuenta]');

  function avisar(texto, esError) {
    if (!aviso) return;
    aviso.textContent = texto || '';
    aviso.hidden = !texto;
    aviso.classList.toggle('tienda-aviso--error', !!esError);
    // El aviso vive arriba del catálogo y el botón de pagar abajo: sin esto
    // el error queda fuera de pantalla y parece que el clic no hizo nada.
    if (texto && esError && aviso.scrollIntoView) {
      aviso.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
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

  function pintarCarrito() {
    var t = totalCarrito();
    if (cartN) { cartN.hidden = t.piezas === 0; cartN.textContent = t.piezas; }
    if (cartTotal) cartTotal.textContent = t.piezas ? precio(t.centavos) : 'Carrito';
    pintarCajon(t);
  }

  // El cajón se repinta siempre, esté abierto o no: así abrirlo es instantáneo.
  function pintarCajon(t) {
    if (!lineasEl || !cuentaEl) return;
    lineasEl.textContent = '';

    if (!t.piezas) {
      var vacio = document.createElement('p');
      vacio.className = 'drawer__vacio';
      vacio.textContent = 'Todavía no agregas nada.';
      lineasEl.appendChild(vacio);
      cuentaEl.textContent = '';
      var pagar = drawer && drawer.querySelector('[data-pagar]');
      if (pagar) pagar.disabled = true;
      return;
    }

    Object.keys(carrito.lineas).forEach(function (sku) {
      var p = porSku[sku];
      if (p) lineasEl.appendChild(lineaCarrito(p, carrito.lineas[sku]));
    });

    var envio = costoEnvio(t.centavos);
    var falta = envioCfg && envioCfg.gratis_desde_centavos - t.centavos;
    cuentaEl.innerHTML =
      '<div><span>' + t.piezas + (t.piezas === 1 ? ' pieza' : ' piezas') + '</span><span>' + precio(t.centavos) + '</span></div>' +
      '<div><span>Envío</span><span>' + (envio === 0 ? 'Gratis' : precio(envio)) + '</span></div>' +
      (envio > 0 && falta > 0
        ? '<div class="drawer__falta"><span>Te faltan ' + precio(falta) + ' para el envío gratis</span></div>' : '') +
      '<div class="drawer__total"><span>Total</span><span>' + precio(t.centavos + envio) + '</span></div>';

    var boton = drawer && drawer.querySelector('[data-pagar]');
    if (boton) boton.disabled = false;
  }

  function lineaCarrito(p, n) {
    var el = document.createElement('div');
    el.className = 'linea';
    el.innerHTML =
      (p.imagen ? '<img class="linea__img" alt="" loading="lazy">' : '<div class="linea__img"></div>') +
      '<div class="linea__txt">' +
        '<div class="linea__nombre"></div>' +
        '<div class="linea__fila">' +
          '<div class="prod__stepper">' +
            '<button type="button" aria-label="Quitar una pieza" data-menos>−</button>' +
            '<span data-cantidad>' + n + '</span>' +
            '<button type="button" aria-label="Agregar una pieza" data-mas>+</button>' +
          '</div>' +
          '<span class="linea__precio">' + precio(p.precio_centavos * n) + '</span>' +
        '</div>' +
      '</div>';
    el.querySelector('.linea__nombre').textContent = p.nombre;
    if (p.imagen) el.querySelector('.linea__img').src = p.imagen;
    el.querySelector('[data-menos]').addEventListener('click', function () {
      fijarCantidad(p.sku, (carrito.lineas[p.sku] || 0) - 1);
    });
    var mas = el.querySelector('[data-mas]');
    mas.disabled = n >= p.stock;
    mas.addEventListener('click', function () {
      fijarCantidad(p.sku, (carrito.lineas[p.sku] || 0) + 1);
    });
    return el;
  }

  /* --- Abrir y cerrar el cajón ------------------------------------------ */

  function abrirCajon() {
    if (!drawer) return;
    drawer.hidden = false;
    if (fondo) fondo.hidden = false;
    if (cartBtn) cartBtn.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    var cerrar = drawer.querySelector('[data-cart-cerrar]');
    if (cerrar) cerrar.focus();
  }

  function cerrarCajon() {
    if (!drawer) return;
    drawer.hidden = true;
    if (fondo) fondo.hidden = true;
    if (cartBtn) { cartBtn.setAttribute('aria-expanded', 'false'); cartBtn.focus(); }
    document.body.style.overflow = '';
  }

  if (cartBtn) cartBtn.addEventListener('click', abrirCajon);
  if (fondo) fondo.addEventListener('click', cerrarCajon);
  if (drawer) {
    drawer.querySelector('[data-cart-cerrar]').addEventListener('click', cerrarCajon);
  }
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && drawer && !drawer.hidden) cerrarCajon();
  });

  /* --- Catálogo --------------------------------------------------------- */

  function cargarCatalogo() {
    if (!grid) return;
    fetch(API + '/productos')
      .then(function (r) { return r.json(); })
      .then(function (datos) {
        envioCfg = datos.envio || null;
        catalogo = (datos.productos || []).filter(function (p) { return p.stock > 0; });
        porSku = {};
        catalogo.forEach(function (p) { porSku[p.sku] = p; });

        // Piezas del carrito que ya no existen o no tienen stock: fuera.
        var huboCambio = false;
        Object.keys(carrito.lineas).forEach(function (sku) {
          if (!porSku[sku]) { delete carrito.lineas[sku]; huboCambio = true; }
        });
        if (huboCambio) { carrito.carrito_id = nuevoId(); guardar(); }

        if (!catalogo.length) {
          grid.innerHTML = '<p class="muted">Por ahora no hay piezas disponibles en línea. ' +
            'Encuéntranos en la <a href="https://www.mercadolibre.com.mx/tienda/emisha" ' +
            'target="_blank" rel="noopener">tienda oficial de MercadoLibre</a>.</p>';
          return;
        }
        // El nombre normalizado se calcula UNA vez: el buscador corre en cada
        // tecla sobre 1500 productos y no puede estar quitando acentos ahí.
        catalogo.forEach(function (p) { p._busca = normaliza(p.nombre); });
        pintarGrid();
        pintarCarrito();
        // Ambas necesitan porSku ya armado para contar solo lo que hay.
        cargarCategorias();
        cargarDestacados();
      })
      .catch(function () {
        grid.innerHTML = '<p class="muted">No pudimos cargar el catálogo. Recarga la página ' +
          'o inténtalo más tarde.</p>';
      });
  }

  /* --- Categorías -------------------------------------------------------- */
  /* El inventario no manda categorías, así que el árbol se deriva de los
     nombres (herramientas/categorizar.py) y se publica como JSON estático.
     Si el archivo no carga, la tienda sigue funcionando sin barra lateral. */

  var catsLista = document.querySelector('[data-cats-lista]');
  var catsToggle = document.querySelector('[data-cats-toggle]');
  var cuentaEl2 = document.querySelector('[data-cuenta]');
  var arbol = [];
  var catActiva = null;    // {nombre, skus:{sku:true}}

  if (catsToggle && catsLista) {
    // En móvil la lista arranca cerrada; en escritorio siempre se ve.
    if (window.matchMedia('(max-width: 900px)').matches) catsLista.hidden = true;
    catsToggle.addEventListener('click', function () {
      catsLista.hidden = !catsLista.hidden;
      catsToggle.setAttribute('aria-expanded', String(!catsLista.hidden));
    });
  }

  function cargarCategorias() {
    if (!catsLista) return Promise.resolve();
    return fetch('/assets/data/categorias.json')
      .then(function (r) { return r.json(); })
      .then(function (d) { arbol = d.categorias || []; pintarCategorias(); })
      .catch(function () { /* sin categorías: la tienda sigue siendo usable */ });
  }

  function conjunto(skus) {
    var m = {};
    for (var i = 0; i < skus.length; i++) m[skus[i]] = true;
    return m;
  }

  // Solo se cuentan las piezas con stock: una categoría que dice 70 y enseña 3
  // se siente rota.
  function cuantasHay(skus) {
    var n = 0;
    for (var i = 0; i < skus.length; i++) if (porSku[skus[i]]) n++;
    return n;
  }

  function pintarCategorias() {
    catsLista.textContent = '';

    var todo = document.createElement('button');
    todo.type = 'button';
    todo.className = 'cats__btn cats__todo';
    todo.innerHTML = 'Todo el catálogo <b>' + catalogo.length + '</b>';
    todo.addEventListener('click', function () { elegirCategoria(null); });
    catsLista.appendChild(todo);

    // El JSON viene en el orden en que las reglas las fueron creando: para
    // buscar con la vista, alfabético es lo predecible.
    var ordenadas = arbol.slice().sort(function (a, b) {
      return a.nombre.localeCompare(b.nombre, 'es');
    });
    ordenadas.forEach(function (cat) {
      var skusCat = [];
      cat.subcategorias.forEach(function (s) { skusCat = skusCat.concat(s.skus); });
      var nCat = cuantasHay(skusCat);
      if (!nCat) return;                       // categoría sin stock: no se pinta

      var grupo = document.createElement('div');
      grupo.className = 'cats__grupo';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cats__btn';
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>' +
        '<span></span><b>' + nCat + '</b>';
      btn.querySelector('span').textContent = cat.nombre;

      var sub = document.createElement('ul');
      sub.className = 'cats__sub';
      sub.hidden = true;

      cat.subcategorias.slice().sort(function (a, b) {
        return a.nombre.localeCompare(b.nombre, 'es');
      }).forEach(function (s) {
        var n = cuantasHay(s.skus);
        if (!n) return;
        var li = document.createElement('li');
        var b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = '<span></span><b>' + n + '</b>';
        b.querySelector('span').textContent = s.nombre;
        b.addEventListener('click', function () {
          elegirCategoria({ nombre: cat.nombre + ' · ' + s.nombre, skus: conjunto(s.skus), boton: b });
        });
        li.appendChild(b);
        sub.appendChild(li);
      });

      btn.addEventListener('click', function () {
        var abierto = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!abierto));
        sub.hidden = abierto;
        elegirCategoria({ nombre: cat.nombre, skus: conjunto(skusCat), boton: btn });
      });

      grupo.appendChild(btn);
      grupo.appendChild(sub);
      catsLista.appendChild(grupo);
    });
  }

  function elegirCategoria(cat) {
    catActiva = cat;
    catsLista.querySelectorAll('.es-activa').forEach(function (e) { e.classList.remove('es-activa'); });
    if (cat && cat.boton) cat.boton.classList.add('es-activa');
    // Elegir categoría con una búsqueda puesta confunde: se limpia.
    if (buscarEl && buscarEl.value) { buscarEl.value = ''; filtro = ''; if (limpiarEl) limpiarEl.hidden = true; }
    pintarGrid();
    if (catsLista && window.matchMedia('(max-width: 900px)').matches) {
      catsLista.hidden = true;
      if (catsToggle) catsToggle.setAttribute('aria-expanded', 'false');
      var main = document.querySelector('[data-tienda-grid]');
      if (main && main.scrollIntoView) main.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  var limpiarCuenta = document.querySelector('[data-cuenta-limpiar]');
  if (limpiarCuenta) {
    limpiarCuenta.addEventListener('click', function () {
      if (buscarEl) { buscarEl.value = ''; filtro = ''; }
      if (limpiarEl) limpiarEl.hidden = true;
      elegirCategoria(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* --- Selección de portada ---------------------------------------------- */

  function cargarDestacados() {
    var panel = document.querySelector('[data-destacados]');
    if (!panel) return Promise.resolve();
    return fetch('/assets/data/destacados.json')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // Precio, stock e imagen SIEMPRE del catálogo vivo: el archivo solo
        // dice qué SKUs enseñar, nunca cuánto cuestan.
        var piezas = (d.skus || []).map(function (s) { return porSku[s]; })
          .filter(function (p) { return p && p.stock > 0; });
        if (!piezas.length) return;
        panel.querySelector('[data-destacados-titulo]').textContent = d.titulo || 'Selección Emisha';
        panel.querySelector('[data-destacados-sub]').textContent = d.subtitulo || '';
        var fila = panel.querySelector('[data-destacados-fila]');
        fila.textContent = '';
        piezas.forEach(function (p) { fila.appendChild(tarjeta(p)); });
        piezas.forEach(function (p) { pintarCantidad(p.sku); });
        panel.dataset.listo = '1';
        actualizarPortada();
      })
      .catch(function () { /* sin destacados: no se pinta el panel */ });
  }

  // La portada solo tiene sentido sin filtro: si el cliente ya buscó o eligió
  // categoría, estorba.
  function actualizarPortada() {
    var panel = document.querySelector('[data-destacados]');
    if (!panel || !panel.dataset.listo) return;
    panel.hidden = !!(catActiva || filtro);
  }

  /* --- Buscador y pintado del catálogo ---------------------------------- */
  /* Son 1500+ piezas: pintarlas todas de golpe cuesta segundos en un celular.
     Se pintan por tandas y el buscador filtra sobre el arreglo, no sobre el DOM. */

  var TANDA = 48;
  var buscarEl = document.querySelector('[data-buscar]');
  var sugEl = document.querySelector('[data-sugerencias]');
  var limpiarEl = document.querySelector('[data-buscar-limpiar]');
  var filtro = '';
  var mostrados = 0;
  var resultado = [];
  var marcada = -1;

  function normaliza(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // Todas las palabras tienen que aparecer: "caja tornillo" no es lo mismo
  // que "caja" ni que "tornillo".
  function coincide(p, palabras) {
    for (var i = 0; i < palabras.length; i++) {
      if (p._busca.indexOf(palabras[i]) === -1) return false;
    }
    return true;
  }

  function filtrar() {
    var base = catActiva
      ? catalogo.filter(function (p) { return catActiva.skus[p.sku]; })
      : catalogo;
    if (!filtro) return base;
    var palabras = filtro.split(/\s+/).filter(Boolean);
    return base.filter(function (p) { return coincide(p, palabras); });
  }

  function pintarGrid() {
    if (!grid) return;
    resultado = filtrar();
    mostrados = 0;
    actualizarPortada();
    actualizarCuenta();
    grid.textContent = '';
    if (!resultado.length) {
      grid.innerHTML = '<p class="muted">Ninguna pieza coincide con esa búsqueda. ' +
        'Prueba con menos palabras.</p>';
      return;
    }
    pintarTanda();
  }

  function actualizarCuenta() {
    if (!cuentaEl2) return;
    var hay = !!(catActiva || filtro);
    cuentaEl2.hidden = !hay;
    if (!hay) return;
    cuentaEl2.querySelector('[data-cuenta-titulo]').textContent =
      catActiva ? catActiva.nombre : 'Resultados';
    cuentaEl2.querySelector('[data-cuenta-n]').textContent =
      resultado.length + (resultado.length === 1 ? ' pieza' : ' piezas');
    cuentaEl2.querySelector('[data-cuenta-limpiar]').hidden = false;
  }

  function pintarTanda() {
    var hasta = Math.min(mostrados + TANDA, resultado.length);
    var trozo = document.createDocumentFragment();
    for (var i = mostrados; i < hasta; i++) trozo.appendChild(tarjeta(resultado[i]));
    var boton = grid.querySelector('[data-ver-mas]');
    if (boton) boton.remove();
    grid.appendChild(trozo);
    for (var j = mostrados; j < hasta; j++) pintarCantidad(resultado[j].sku);
    mostrados = hasta;
    if (mostrados < resultado.length) grid.appendChild(botonVerMas());
  }

  function botonVerMas() {
    var envoltura = document.createElement('div');
    envoltura.dataset.verMas = '';
    envoltura.style.gridColumn = '1/-1';
    envoltura.style.textAlign = 'center';
    envoltura.style.padding = '10px 0 4px';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--ghost';
    b.textContent = 'Ver más (' + (resultado.length - mostrados) + ' piezas)';
    b.addEventListener('click', pintarTanda);
    envoltura.appendChild(b);
    return envoltura;
  }

  /* --- Autocompletado ---------------------------------------------------- */

  function sugerir() {
    if (!sugEl) return;
    var q = normaliza(buscarEl.value.trim());
    if (q.length < 2) return ocultarSugerencias();
    var palabras = q.split(/\s+/).filter(Boolean);
    var top = [];
    for (var i = 0; i < catalogo.length && top.length < 8; i++) {
      if (coincide(catalogo[i], palabras)) top.push(catalogo[i]);
    }
    sugEl.textContent = '';
    marcada = -1;
    if (!top.length) {
      sugEl.innerHTML = '<li class="buscador__vacio">Sin coincidencias</li>';
    } else {
      top.forEach(function (p) {
        var li = document.createElement('li');
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'buscador__op';
        b.setAttribute('role', 'option');
        b.innerHTML = (p.imagen ? '<img alt="" loading="lazy">' : '') +
          '<span></span><b>' + precio(p.precio_centavos) + '</b>';
        b.querySelector('span').textContent = p.nombre;
        if (p.imagen) b.querySelector('img').src = p.imagen;
        b.addEventListener('click', function () {
          buscarEl.value = p.nombre;
          aplicarFiltro(p.nombre);
          ocultarSugerencias();
        });
        li.appendChild(b);
        sugEl.appendChild(li);
      });
    }
    sugEl.hidden = false;
    buscarEl.setAttribute('aria-expanded', 'true');
  }

  function ocultarSugerencias() {
    if (!sugEl) return;
    sugEl.hidden = true;
    marcada = -1;
    if (buscarEl) buscarEl.setAttribute('aria-expanded', 'false');
  }

  function mover(paso) {
    var ops = sugEl.querySelectorAll('.buscador__op');
    if (!ops.length) return;
    if (marcada >= 0) ops[marcada].removeAttribute('aria-selected');
    marcada = (marcada + paso + ops.length) % ops.length;
    ops[marcada].setAttribute('aria-selected', 'true');
    ops[marcada].scrollIntoView({ block: 'nearest' });
  }

  function aplicarFiltro(texto) {
    filtro = normaliza(texto.trim());
    if (limpiarEl) limpiarEl.hidden = !texto;
    pintarGrid();
  }

  if (buscarEl) {
    var espera;
    buscarEl.addEventListener('input', function () {
      clearTimeout(espera);
      var v = buscarEl.value;
      espera = setTimeout(function () { aplicarFiltro(v); sugerir(); }, 140);
    });
    buscarEl.addEventListener('keydown', function (ev) {
      if (sugEl.hidden) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); mover(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); mover(-1); }
      else if (ev.key === 'Enter' && marcada >= 0) {
        ev.preventDefault();
        sugEl.querySelectorAll('.buscador__op')[marcada].click();
      } else if (ev.key === 'Escape') { ocultarSugerencias(); }
    });
    buscarEl.addEventListener('blur', function () { setTimeout(ocultarSugerencias, 140); });
  }
  if (limpiarEl) {
    limpiarEl.addEventListener('click', function () {
      buscarEl.value = '';
      aplicarFiltro('');
      ocultarSugerencias();
      buscarEl.focus();
    });
  }

  /* --- Checkout --------------------------------------------------------- */
  /* "Pagar" abre el diálogo de datos de envío; el POST al worker sale del
     submit del formulario. Los datos se recuerdan en localStorage para que
     un reintento (o la próxima compra) no obligue a teclear todo otra vez. */

  var DATOS = 'emisha-datos-envio-v1';
  var CAMPOS = ['nombre', 'email', 'telefono', 'calle', 'colonia', 'cp', 'ciudad', 'estado', 'referencias'];

  var botonPagar = document.querySelector('[data-pagar]');
  var dialogo = document.querySelector('[data-checkout]');
  var formulario = dialogo && dialogo.querySelector('[data-checkout-form]');

  if (botonPagar && dialogo && formulario) {
    botonPagar.addEventListener('click', abrirCheckout);
    formulario.addEventListener('submit', function (ev) {
      ev.preventDefault();
      pagar(leerFormulario());
    });
    dialogo.querySelector('[data-cerrar]').addEventListener('click', cerrarCheckout);
  }

  function abrirCheckout() {
    var t = totalCarrito();
    if (!t.piezas) return;
    cerrarCajon();          // el cajón estorba detrás del diálogo
    avisar('');
    prellenar();
    cpUltimo = '';
    buscarCp();             // datos recordados: resolver el CP sin que teclee
    var e = costoEnvio(t.centavos);
    dialogo.querySelector('[data-checkout-resumen]').innerHTML =
      '<div><span>' + t.piezas + (t.piezas === 1 ? ' pieza' : ' piezas') + '</span><span>' + precio(t.centavos) + '</span></div>' +
      '<div><span>Envío</span><span>' + (e === 0 ? 'Gratis' : precio(e)) + '</span></div>' +
      '<div class="checkout__total"><span>Total</span><span>' + precio(t.centavos + e) + '</span></div>';
    if (dialogo.showModal) dialogo.showModal();
    else dialogo.setAttribute('open', '');
  }

  function cerrarCheckout() {
    if (dialogo.close) dialogo.close();
    else dialogo.removeAttribute('open');
  }

  function prellenar() {
    try {
      var d = JSON.parse(localStorage.getItem(DATOS));
      if (!d) return;
      CAMPOS.forEach(function (k) {
        var campo = formulario.elements[k];
        if (campo && !campo.value && d[k]) campo.value = d[k];
      });
    } catch (e) { /* datos corruptos: el formulario queda vacío */ }
  }

  function leerFormulario() {
    var d = {};
    CAMPOS.forEach(function (k) {
      d[k] = (formulario.elements[k] ? formulario.elements[k].value : '').trim();
    });
    try { localStorage.setItem(DATOS, JSON.stringify(d)); } catch (e) {}
    return d;
  }

  function pagar(datos) {
    var lineas = Object.keys(carrito.lineas).map(function (sku) {
      return { sku: sku, cantidad: carrito.lineas[sku] };
    });
    if (!lineas.length) return;

    var confirmar = dialogo.querySelector('[data-confirmar]');
    confirmar.disabled = true;
    confirmar.textContent = 'Preparando el pago…';

    fetch(API + '/pedido', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        carrito_id: carrito.carrito_id,
        lineas: lineas,
        comprador: { nombre: datos.nombre, email: datos.email, telefono: datos.telefono },
        envio: {
          calle: datos.calle, colonia: datos.colonia, cp: datos.cp,
          ciudad: datos.ciudad, estado: datos.estado, referencias: datos.referencias
        }
      })
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
          restaurarBoton();
          cerrarCheckout();
          r.datos.faltantes.forEach(function (f) {
            if (porSku[f.sku]) porSku[f.sku].stock = f.available;
            fijarCantidad(f.sku, Math.min(carrito.lineas[f.sku] || 0, f.available));
          });
          avisar('El inventario cambió mientras armabas tu carrito: lo ajustamos a las ' +
            'piezas que sí hay. Revisa las cantidades y vuelve a intentar.', true);
          return;
        }
        restaurarBoton();
        cerrarCheckout();
        if (r.status === 503) {
          // Pago en línea aún no habilitado (falta el token de MP en el worker).
          avisar('El pago en línea se activa muy pronto. Mientras tanto escríbenos por ' +
            'WhatsApp al +52 55 7563 9255 con lo que traes en el carrito y te lo apartamos.', true);
        } else {
          avisar((r.datos && r.datos.error) || 'No se pudo iniciar el pago. Inténtalo de nuevo.', true);
        }
      })
      .catch(function () {
        restaurarBoton();
        cerrarCheckout();
        avisar('No se pudo iniciar el pago. Revisa tu conexión e inténtalo de nuevo.', true);
      });
  }

  /* --- Autocompletado por código postal ---------------------------------- */
  /* SEPOMEX: un CP cae en UN municipio y UN estado, pero en varias colonias
     (una sola en un tercio de los casos, seis o más en la cuarta parte). Por
     eso la colonia es un input cuando hay una y un select cuando hay varias,
     siempre con salida a "Otra" por si la colonia no está en el catálogo. */

  var cpEl = formulario && formulario.elements.cp;
  var coloniaEl = formulario && formulario.elements.colonia;
  var coloniaSel = dialogo && dialogo.querySelector('[data-colonia-sel]');
  var cpAviso = dialogo && dialogo.querySelector('[data-cp-aviso]');
  var cpUltimo = '';
  var autollenado = false;   // ¿ciudad/estado los pusimos nosotros?

  function decirCp(texto) {
    if (!cpAviso) return;
    cpAviso.textContent = texto || '';
    cpAviso.hidden = !texto;
  }

  // El "required" viaja con el control visible: un campo obligatorio oculto
  // no se puede enfocar y Chrome se niega a enviar el formulario sin decir nada.
  function mostrarInputColonia(valor) {
    if (coloniaSel) { coloniaSel.hidden = true; coloniaSel.required = false; }
    coloniaEl.hidden = false;
    coloniaEl.required = true;
    if (valor !== undefined) coloniaEl.value = valor;
  }

  function mostrarSelectColonia(colonias) {
    if (!coloniaSel) return mostrarInputColonia();
    coloniaSel.textContent = '';
    var vacia = document.createElement('option');
    vacia.value = '';
    vacia.textContent = 'Elige tu colonia…';
    coloniaSel.appendChild(vacia);
    colonias.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      coloniaSel.appendChild(o);
    });
    var otra = document.createElement('option');
    otra.value = '__otra__';
    otra.textContent = 'Otra (escribirla)';
    coloniaSel.appendChild(otra);

    // Si ya traía una colonia (datos guardados) y está en la lista, se respeta.
    if (coloniaEl.value && colonias.indexOf(coloniaEl.value) !== -1) {
      coloniaSel.value = coloniaEl.value;
    } else {
      coloniaSel.value = '';
      coloniaEl.value = '';
    }
    coloniaSel.hidden = false;
    coloniaSel.required = true;
    coloniaEl.hidden = true;
    coloniaEl.required = false;
  }

  if (coloniaSel) {
    coloniaSel.addEventListener('change', function () {
      if (coloniaSel.value === '__otra__') {
        mostrarInputColonia('');
        coloniaEl.focus();
        return;
      }
      coloniaEl.value = coloniaSel.value;   // el input sigue siendo el que se envía
    });
  }

  function buscarCp() {
    if (!cpEl) return;
    var codigo = (cpEl.value || '').trim();
    if (!/^[0-9]{5}$/.test(codigo)) { decirCp(''); return; }
    if (codigo === cpUltimo) return;        // no repetir la consulta al salir del campo
    cpUltimo = codigo;
    decirCp('Buscando…');

    fetch(API + '/cp?codigo=' + codigo)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, datos: d }; }); })
      .then(function (r) {
        if (!r.ok) {
          // 404: el CP no está en el catálogo. Se borra lo que habíamos puesto
          // nosotros — si no, queda la ciudad del CP anterior y el paquete se
          // va a otro lado sin que nadie lo note. Lo que escribió el cliente
          // a mano no se toca.
          if (autollenado) {
            formulario.elements.ciudad.value = '';
            formulario.elements.estado.value = '';
            autollenado = false;
          }
          mostrarInputColonia();
          decirCp('No encontramos ese código postal. Escribe los datos a mano.');
          return;
        }
        formulario.elements.ciudad.value = r.datos.municipio;
        formulario.elements.estado.value = r.datos.estado;
        autollenado = true;
        var colonias = r.datos.colonias || [];
        if (colonias.length === 1) {
          mostrarInputColonia(colonias[0]);
          decirCp(r.datos.municipio + ', ' + r.datos.estado);
        } else if (colonias.length > 1) {
          mostrarSelectColonia(colonias);
          decirCp(r.datos.municipio + ', ' + r.datos.estado + ' · elige tu colonia');
        } else {
          mostrarInputColonia();
          decirCp(r.datos.municipio + ', ' + r.datos.estado);
        }
      })
      .catch(function () {
        cpUltimo = '';                      // que se pueda reintentar
        mostrarInputColonia();
        decirCp('No pudimos consultar el código postal. Escribe los datos a mano.');
      });
  }

  if (cpEl) {
    cpEl.addEventListener('input', function () {
      if (/^[0-9]{5}$/.test(cpEl.value.trim())) buscarCp();
    });
    cpEl.addEventListener('blur', buscarCp);
  }

  function restaurarBoton() {
    var confirmar = dialogo.querySelector('[data-confirmar]');
    confirmar.disabled = false;
    confirmar.textContent = 'Continuar al pago';
  }

  cargarCatalogo();
})();
