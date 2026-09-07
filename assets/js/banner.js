/* Emisha — tira giratoria de avisos (reparación, novedades, lanzamientos).

   El contenido vive en /assets/data/banners.json para que cambiarlo no sea
   tocar código. Aquí solo está el comportamiento.

   Decisiones que valen la pena saber:
   · Si el visitante tiene "reducir movimiento" prendido en su sistema, NO
     gira sola: se queda en la primera y él pasa las que quiera.
   · Se detiene al pasar el mouse, al enfocar con teclado y cuando la pestaña
     está en segundo plano (girar sin que nadie mire solo gasta batería).
   · Una sola tira activa = sin flechas, sin puntos, sin giro.
   · Las tiras con fecha caducan solas; nadie tiene que acordarse de quitarlas. */
(function () {
  'use strict';

  var caja = document.querySelector('[data-banner]');
  if (!caja) return;

  var LAPSO = 5000;
  var quieto = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var tiras = [];
  var actual = 0;
  var reloj = null;

  function hoy() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function vigente(t) {
    var h = hoy();
    if (t.desde && h < t.desde) return false;
    if (t.hasta && h > t.hasta) return false;
    return true;
  }

  function pintar() {
    var t = tiras[actual];
    caja.textContent = '';

    var art = document.createElement('article');
    var arte = t.arte || (t.imagen ? 'lado' : 'trama');
    art.className = 'banner__tira banner--' + (t.tono || 'marca') + ' banner-arte--' + arte;

    // Arte de fondo: la foto ocupa toda la tira y encima va un velo oscuro,
    // porque texto blanco sobre una foto clara no se lee.
    if (arte === 'fondo' && t.imagen) {
      var fondo = document.createElement('div');
      fondo.className = 'banner__fondo';
      fondo.style.backgroundImage = 'url("' + t.imagen + '")';
      if (t.foco) fondo.style.backgroundPosition = t.foco;
      art.appendChild(fondo);
    }
    // Sin foto, una trama geométrica: mejor que un rectángulo de color solo.
    if (arte === 'trama') art.appendChild(trama());

    // Ilustración: un SVG de línea que se trae y se inserta en el documento,
    // no en un <img>. Así hereda el color de la tira con currentColor y no
    // hay que mantener una versión por tono.
    if (arte === 'ilustracion' && t.imagen) {
      var cont = document.createElement('div');
      cont.className = 'banner__ilustracion';
      cont.setAttribute('aria-hidden', 'true');
      art.appendChild(cont);
      fetch(t.imagen)
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (svg) {
          // Solo se acepta lo que de verdad es un SVG: nada de inyectar
          // cualquier cosa que devuelva el servidor.
          if (svg.slice(0, 400).indexOf('<svg') !== -1) cont.innerHTML = svg;
          else cont.remove();
        })
        .catch(function () { cont.remove(); });
    }

    var cuerpo = document.createElement('div');
    cuerpo.className = 'banner__cuerpo';

    if (t.eyebrow) {
      var e = document.createElement('p');
      e.className = 'banner__eyebrow';
      e.textContent = t.eyebrow;
      cuerpo.appendChild(e);
    }

    var h = document.createElement('p');
    h.className = 'banner__titulo';
    h.textContent = t.titulo;
    cuerpo.appendChild(h);

    if (t.texto) {
      var p = document.createElement('p');
      p.className = 'banner__texto';
      p.textContent = t.texto;
      cuerpo.appendChild(p);
    }

    if (t.cta && t.url) {
      var a = document.createElement('a');
      a.className = 'btn btn--sm banner__cta';
      a.href = t.url;
      a.textContent = t.cta;
      if (/^https?:/.test(t.url)) { a.target = '_blank'; a.rel = 'noopener'; }
      cuerpo.appendChild(a);
    }
    art.appendChild(cuerpo);

    if (t.imagen && arte === 'lado') {
      var fig = document.createElement('div');
      fig.className = 'banner__media';
      var img = document.createElement('img');
      img.src = t.imagen;
      img.alt = '';                      // decorativa: el texto ya lo dice todo
      img.loading = 'lazy';
      img.onerror = function () { fig.remove(); };
      fig.appendChild(img);
      art.appendChild(fig);
    }

    caja.appendChild(art);
    pintarPuntos();
  }

  // Trama decorativa: círculos concéntricos y una retícula, en SVG para que
  // pese nada y se vea nítida en cualquier pantalla. Es adorno: aria-hidden.
  function trama() {
    var cont = document.createElement('div');
    cont.className = 'banner__trama';
    cont.setAttribute('aria-hidden', 'true');
    cont.innerHTML =
      '<svg viewBox="0 0 420 220" preserveAspectRatio="xMaxYMid slice" focusable="false">' +
        '<defs><pattern id="bnr-malla" width="26" height="26" patternUnits="userSpaceOnUse">' +
          '<path d="M26 0H0v26" fill="none" stroke="currentColor" stroke-width="1"/>' +
        '</pattern></defs>' +
        '<rect width="420" height="220" fill="url(#bnr-malla)" opacity=".22"/>' +
        '<circle cx="330" cy="110" r="94" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".38"/>' +
        '<circle cx="330" cy="110" r="66" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".28"/>' +
        '<circle cx="330" cy="110" r="38" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".2"/>' +
        '<circle cx="330" cy="110" r="11" fill="currentColor" opacity=".16"/>' +
      '</svg>';
    return cont;
  }

  function pintarPuntos() {
    if (tiras.length < 2) return;
    var nav = document.createElement('div');
    nav.className = 'banner__nav';

    var prev = boton('‹', 'Aviso anterior', function () { ir(actual - 1); });
    var puntos = document.createElement('div');
    puntos.className = 'banner__puntos';
    tiras.forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'banner__punto' + (i === actual ? ' es-activo' : '');
      b.setAttribute('aria-label', 'Ver aviso ' + (i + 1) + ' de ' + tiras.length);
      b.setAttribute('aria-current', i === actual ? 'true' : 'false');
      b.addEventListener('click', function () { ir(i); });
      puntos.appendChild(b);
    });
    var sig = boton('›', 'Aviso siguiente', function () { ir(actual + 1); });

    nav.appendChild(prev);
    nav.appendChild(puntos);
    nav.appendChild(sig);
    caja.appendChild(nav);
  }

  function boton(txt, etiqueta, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'banner__flecha';
    b.textContent = txt;
    b.setAttribute('aria-label', etiqueta);
    b.addEventListener('click', fn);
    return b;
  }

  function ir(i) {
    actual = (i + tiras.length) % tiras.length;
    pintar();
    reiniciar();
  }

  function reiniciar() {
    detener();
    if (quieto || tiras.length < 2) return;
    reloj = setInterval(function () { ir(actual + 1); }, LAPSO);
  }

  function detener() {
    if (reloj) { clearInterval(reloj); reloj = null; }
  }

  fetch('/assets/data/banners.json')
    .then(function (r) { return r.ok ? r.json() : { tiras: [] }; })
    .then(function (d) {
      tiras = (d.tiras || []).filter(vigente);
      if (!tiras.length) { caja.remove(); return; }   // sin avisos, sin hueco
      caja.hidden = false;
      pintar();
      reiniciar();

      caja.addEventListener('mouseenter', detener);
      caja.addEventListener('mouseleave', reiniciar);
      caja.addEventListener('focusin', detener);
      caja.addEventListener('focusout', reiniciar);
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) detener(); else reiniciar();
      });
      caja.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowLeft') { ir(actual - 1); }
        if (ev.key === 'ArrowRight') { ir(actual + 1); }
      });
    })
    .catch(function () { caja.remove(); });          // que falle callado
})();
