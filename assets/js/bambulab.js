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

  var API = 'https://emisha-ag.matosic-hrvoje.workers.dev';

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
  var sello = document.querySelector('[data-ag-actualizado]');
  if (!rejilla) return;

  var mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  var productos = [];
  var filtro = 'todo';

  function texto(el, s) { el.textContent = s; }

  function tarjeta(p) {
    var art = document.createElement('article');
    art.className = 'swatch';
    art.setAttribute('data-perfil', p.perfil || 'otros');

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
    art.appendChild(media);

    var cuerpo = document.createElement('div');
    cuerpo.className = 'swatch__body';

    var nom = document.createElement('p');
    nom.className = 'swatch__name';
    texto(nom, p.nombre || p.sku);
    cuerpo.appendChild(nom);

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

    var a = document.createElement('a');
    a.className = 'btn btn--ghost btn--sm btn--block';
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

  fetch(API + '/productos')
    .then(function (r) {
      if (!r.ok) throw new Error('el catálogo respondió ' + r.status);
      return r.json();
    })
    .then(function (d) {
      productos = (d && d.productos) || [];
      if (!productos.length) {
        texto(estado, 'Ahora mismo no hay piezas con existencia. Escríbenos por WhatsApp ' +
                      'y te decimos cuándo llegan.');
        return;
      }
      if (sello && d.actualizado) {
        var f = new Date(d.actualizado);
        texto(sello, 'Precios y existencias al ' +
          f.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' }) + ', ' +
          f.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) + ' h.');
        sello.hidden = false;
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
