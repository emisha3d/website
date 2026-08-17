/* Emisha — interacciones del sitio. Vanilla JS, sin dependencias. */
(function () {
  'use strict';

  /* --- Menú móvil ------------------------------------------------------ */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* --- Submenús del menú superior -------------------------------------- */
  /* En escritorio abren al pasar el cursor o al hacer clic (y cierran con
     Esc o clic afuera). En móvil el CSS los deja siempre abiertos, así que
     aquí no hay nada que hacer. */
  var escritorio = window.matchMedia('(min-width: 1041px)');
  var conCursor = window.matchMedia('(hover: hover)');
  document.querySelectorAll('[data-nav-group]').forEach(function (grupo) {
    var boton = grupo.querySelector('.nav__group-btn');
    var espera;
    function fijar(abierto) {
      grupo.classList.toggle('is-open', abierto);
      boton.setAttribute('aria-expanded', String(abierto));
    }
    boton.addEventListener('click', function (e) {
      e.stopPropagation();
      var abrir = !grupo.classList.contains('is-open');
      document.querySelectorAll('[data-nav-group].is-open').forEach(function (g) {
        if (g !== grupo) { g.classList.remove('is-open'); g.querySelector('.nav__group-btn').setAttribute('aria-expanded', 'false'); }
      });
      fijar(abrir);
    });
    grupo.addEventListener('mouseenter', function () {
      if (!escritorio.matches || !conCursor.matches) return;
      clearTimeout(espera);
      fijar(true);
    });
    grupo.addEventListener('mouseleave', function () {
      if (!escritorio.matches || !conCursor.matches) return;
      espera = setTimeout(function () { fijar(false); }, 160);
    });
    grupo.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { fijar(false); boton.focus(); }
    });
    grupo.addEventListener('focusout', function (e) {
      if (!grupo.contains(e.relatedTarget)) fijar(false);
    });
    document.addEventListener('click', function (e) {
      if (!grupo.contains(e.target)) fijar(false);
    });
  });

  /* --- Galería de producto --------------------------------------------- */
  document.querySelectorAll('[data-gallery]').forEach(function (gallery) {
    var main = gallery.querySelector('[data-gallery-main]');
    var thumbs = gallery.querySelectorAll('[data-gallery-thumb]');
    if (!main || !thumbs.length) return;

    thumbs.forEach(function (thumb) {
      thumb.addEventListener('click', function () {
        thumbs.forEach(function (t) { t.setAttribute('aria-selected', 'false'); });
        thumb.setAttribute('aria-selected', 'true');
        main.src = thumb.dataset.full;
        main.alt = thumb.dataset.alt || main.alt;
      });
    });
  });

  /* --- Filtro del catálogo de filamentos -------------------------------- */
  var filterBar = document.querySelector('[data-filters]');
  if (filterBar) {
    var buttons = filterBar.querySelectorAll('button');
    var groups = document.querySelectorAll('[data-material-group]');

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var want = btn.dataset.filter;
        buttons.forEach(function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        groups.forEach(function (group) {
          group.hidden = !(want === 'all' || group.dataset.materialGroup === want);
        });
        var count = document.querySelector('[data-filter-count]');
        if (count) {
          var visible = 0;
          groups.forEach(function (g) {
            if (!g.hidden) visible += g.querySelectorAll('.swatch').length;
          });
          count.textContent = visible;
        }
      });
    });
  }

  /* --- Año en el pie ---------------------------------------------------- */
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });
})();
