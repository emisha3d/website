/* Emisha — catálogo de refacciones y consumibles Bambu Lab.

   El catálogo lo sirve el worker de AG, que cada 6 horas relee las fichas
   públicas de AG Electrónica y guarda precio y existencia en D1. Aquí no hay
   precios escritos a mano: si el worker no contesta, la página lo dice en vez
   de inventar números.

   El filtro reusa el patrón de /filamentos/ (.filters con aria-pressed), pero
   con los botones armados desde los datos: solo salen las categorías que hoy
   tienen piezas con existencia. */
(function () {
  'use strict';

  var API = 'https://catalogo.emisha.com.mx';

  var GRUPOS = [
    ['boquilla',      'Boquillas'],
    ['hotend',        'Hotends'],
    ['placa',         'Placas'],
    ['ams',           'AMS'],
    ['refaccion',     'Refacciones'],
    ['mantenimiento', 'Mantenimiento'],
    ['filamento',     'Filamento'],
    ['impresora',     'Impresoras']
  ];

  var rejilla = document.querySelector('[data-ag-grid]');
  var estado = document.querySelector('[data-ag-estado]');
  var barra = document.querySelector('[data-ag-filtros]');
  if (!rejilla) return;

  var mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  var productos = [];
  var filtro = 'todo';
  var slugs = {};   // sku -> slug de su ficha en /refacciones/

  function texto(el, s) { el.textContent = s; }

  function tarjeta(p) {
    var art = document.createElement('article');
    art.className = 'swatch';
    art.setAttribute('data-perfil', p.perfil || 'otros');

    // Si la pieza tiene ficha propia, la foto y el nombre llevan a ella. El
    // mapa lo escribe herramientas/gen-refacciones.py; si todavía no cargó, o
    // si la pieza no tiene ficha (agotadas y las que AG publica sin nombre),
    // la tarjeta se queda como estaba y solo se puede pedir por WhatsApp.
    var slug = slugs[p.sku];
    var ficha = slug ? '/refacciones/' + slug + '/' : null;

    function enlazar(el) {
      if (!ficha) return el;
      var a = document.createElement('a');
      a.href = ficha;
      a.style.color = 'inherit';
      a.style.display = 'block';
      a.appendChild(el);
      return a;
    }

    var media = document.createElement('div');
    media.className = 'swatch__media';
    if (p.imagen) {
      var img = document.createElement('img');
      img.src = p.imagen;
      img.alt = p.nombre || p.sku;
      img.loading = 'lazy';
      img.width = 400;
      img.height = 400;
      // Si AG mueve o borra la foto, mejor una tarjeta sin imagen que un roto.
      img.onerror = function () { media.remove(); };
      media.appendChild(img);
    }
    art.appendChild(enlazar(media));

    var cuerpo = document.createElement('div');
    cuerpo.className = 'swatch__body';

    var nom = document.createElement('p');
    nom.className = 'swatch__name';
    texto(nom, p.nombre || p.sku);
    cuerpo.appendChild(enlazar(nom));

    var precio = document.createElement('p');
    precio.className = 'swatch__line';
    precio.style.fontWeight = '600';
    precio.style.color = 'var(--text)';
    texto(precio, mxn.format(p.precio_centavos / 100));
    cuerpo.appendChild(precio);

    // Las agotadas se publican a propósito: el cliente puede encontrarlas,
    // ver el precio y pedirlas sobre pedido. Van al final de la lista.
    var disp = document.createElement('p');
    disp.className = 'swatch__line';
    if (!p.disponible) {
      texto(disp, 'Sobre pedido');
      disp.style.color = 'var(--muted)';
      art.style.opacity = '.72';
    } else if (p.stock <= 3) {
      texto(disp, 'Últimas ' + p.stock);
      disp.style.color = 'var(--accent)';
    } else {
      texto(disp, 'En existencia');
    }
    cuerpo.appendChild(disp);

    // Botón explícito a la ficha: que la tarjeta sea clicable no se ve, y sin
    // esto la única acción visible era pedir por WhatsApp sin saber qué es la
    // pieza ni con qué impresora va.
    if (ficha) {
      var vf = document.createElement('a');
      vf.className = 'btn btn--ghost btn--sm btn--block';
      vf.href = ficha;
      vf.style.marginTop = '10px';
      texto(vf, 'Ver ficha');
      cuerpo.appendChild(vf);
    }

    var a = document.createElement('a');
    a.className = ficha ? 'btn btn--accent btn--sm btn--block' : 'btn btn--ghost btn--sm btn--block';
    a.href = 'https://wa.me/525575639255?text=' + encodeURIComponent(
      p.disponible
        ? 'Hola, me interesa: ' + (p.nombre || p.sku) + ' (' + p.sku + ')'
        : 'Hola, ¿pueden conseguir esta pieza sobre pedido? ' +
          (p.nombre || p.sku) + ' (' + p.sku + ')');
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.marginTop = '10px';
    texto(a, p.disponible ? 'Pedir por WhatsApp' : 'Preguntar sobre pedido');
    cuerpo.appendChild(a);

    art.appendChild(cuerpo);
    return art;
  }

  function pintar() {
    rejilla.innerHTML = '';
    var visibles = productos.filter(function (p) {
      return filtro === 'todo' || p.perfil === filtro;
    });

    if (!visibles.length) {
      texto(estado, 'No hay piezas de esa categoría con existencia en este momento.');
      estado.hidden = false;
      return;
    }
    estado.hidden = true;
    visibles.forEach(function (p) { rejilla.appendChild(tarjeta(p)); });

    var cuenta = document.querySelector('[data-ag-cuenta]');
    if (cuenta) {
      var hay = visibles.filter(function (p) { return p.disponible; }).length;
      var pedido = visibles.length - hay;
      texto(cuenta, hay + (hay === 1 ? ' pieza en existencia' : ' piezas en existencia') +
        (pedido ? ' · ' + pedido + ' más sobre pedido' : ''));
    }
  }

  function pintarFiltros() {
    if (!barra) return;
    var presentes = {};
    productos.forEach(function (p) { if (p.perfil) presentes[p.perfil] = true; });

    var lista = [['todo', 'Todo']].concat(GRUPOS.filter(function (g) { return presentes[g[0]]; }));
    barra.innerHTML = '';
    lista.forEach(function (g) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-filter', g[0]);
      b.setAttribute('aria-pressed', g[0] === filtro ? 'true' : 'false');
      texto(b, g[1]);
      b.addEventListener('click', function () {
        filtro = g[0];
        barra.querySelectorAll('button').forEach(function (o) {
          o.setAttribute('aria-pressed', o.getAttribute('data-filter') === filtro ? 'true' : 'false');
        });
        pintar();
      });
      barra.appendChild(b);
    });
    barra.hidden = false;
  }

  texto(estado, 'Cargando el catálogo…');

  // El mapa de fichas es opcional: si no carga, el catálogo se pinta igual,
  // solo que sin enlace a la ficha. Por eso va en un Promise aparte que
  // nunca rechaza, y no encadenado al del catálogo.
  var mapaListo = fetch('/assets/data/refacciones-slugs.json')
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (d) { slugs = d || {}; });

  Promise.all([mapaListo, fetch(API + '/productos')
    .then(function (r) {
      if (!r.ok) throw new Error('el catálogo respondió ' + r.status);
      return r.json();
    })])
    .then(function (res) {
      var d = res[1];
      productos = (d && d.productos) || [];
      if (!productos.length) {
        texto(estado, 'Ahora mismo no hay piezas con existencia. Escríbenos por WhatsApp ' +
                      'y te decimos cuándo llegan.');
        return;
      }
      pintarFiltros();
      pintar();
    })
    .catch(function () {
      // Nunca dejar la página diciendo "cargando" para siempre.
      texto(estado, 'No pudimos cargar el catálogo en este momento. ' +
                    'Escríbenos por WhatsApp y te confirmamos precio y existencia.');
      estado.hidden = false;
    });
})();
