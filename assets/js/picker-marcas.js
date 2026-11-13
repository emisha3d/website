/* Emisha — pestañas de marca en el selector de modelo (/reparacion/ y
   /reparacion/mantenimiento-preventivo/agendar/).

   Arriba de cada [data-picker-modelo] pone «Bambu Lab | Creality» y solo deja
   ver los modelos de esa marca. «Otro modelo o marca» sale en las dos. Es una
   capa encima: sin JS se ven todos, como antes, y los radios no cambian (el
   formulario manda lo mismo). Funciona por delegación, así que también sirve
   en los bloques que se clonan con «Agregar otra impresora». */
(function () {
  'use strict';

  var MARCAS = [['bambu', 'Bambu Lab'], ['creality', 'Creality']];
  function marcaDe(valor) {
    if (/^Creality /.test(valor)) return 'creality';
    if (valor === 'Otro') return '';   // en las dos
    return 'bambu';
  }

  var css = document.createElement('style');
  css.textContent =
    '.marcas{display:inline-flex;gap:4px;padding:4px;margin:0 0 10px;border:1px solid var(--border);border-radius:999px;background:#f6f8fb}' +
    '.marcas__tab{appearance:none;border:0;background:transparent;font:inherit;font-size:.84rem;font-weight:600;color:var(--muted);padding:7px 16px;border-radius:999px;cursor:pointer}' +
    '.marcas__tab:hover{color:var(--text)}' +
    '.marcas__tab[aria-selected="true"]{background:#fff;color:var(--text);box-shadow:0 1px 3px rgba(16,24,40,.12)}' +
    '.marcas__tab:focus-visible{outline:2px solid var(--brand);outline-offset:2px}' +
    '.marcas__punto{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--brand);margin-left:6px;vertical-align:middle}' +
    '.marcas__punto[hidden]{display:none}' +
    '[data-marcas-listo] .picker__item[data-marca-oculta]{display:none}' +
    '[data-marcas-listo] .picker__marca{display:none}';
  document.head.appendChild(css);

  function radios(picker) { return picker.querySelectorAll('input[data-campo="modelo"]'); }

  // Muestra una marca; el punto marca la pestaña donde quedó el modelo elegido.
  function mostrar(picker, marca) {
    picker.setAttribute('data-marca', marca);
    var elegida = '';
    radios(picker).forEach(function (r) {
      var m = marcaDe(r.value), item = r.closest('.picker__item');
      if (item) item.toggleAttribute('data-marca-oculta', !!m && m !== marca);
      if (r.checked) elegida = m;
    });
    picker.querySelectorAll('.marcas__tab').forEach(function (t) {
      var activa = t.getAttribute('data-tab') === marca;
      t.setAttribute('aria-selected', activa ? 'true' : 'false');
      t.tabIndex = activa ? 0 : -1;
      var punto = t.querySelector('.marcas__punto');
      if (punto) punto.hidden = !(elegida && elegida === t.getAttribute('data-tab') && !activa);
    });
  }

  function preparar(picker) {
    if (picker.querySelector('.marcas')) {   // un clon: ya trae las pestañas
      mostrar(picker, picker.getAttribute('data-marca') || 'bambu');
      return;
    }
    var hay = {};
    radios(picker).forEach(function (r) { hay[marcaDe(r.value)] = true; });
    if (!hay.bambu || !hay.creality) return;
    var barra = document.createElement('div');
    barra.className = 'marcas';
    barra.setAttribute('role', 'tablist');
    barra.setAttribute('aria-label', 'Marca de la impresora');
    MARCAS.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'marcas__tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('data-tab', m[0]);
      b.innerHTML = m[1] + '<span class="marcas__punto" hidden></span>';
      barra.appendChild(b);
    });
    var grid = picker.querySelector('.picker__grid');
    grid.parentNode.insertBefore(barra, grid);
    picker.setAttribute('data-marcas-listo', '');
    var elegido = picker.querySelector('input[data-campo="modelo"]:checked');
    mostrar(picker, (elegido && marcaDe(elegido.value)) || 'bambu');
  }

  function prepararTodo() { document.querySelectorAll('[data-picker-modelo]').forEach(preparar); }

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('.marcas__tab');
    if (!t) return;
    mostrar(t.closest('[data-picker-modelo]'), t.getAttribute('data-tab'));
  });
  // Flechas entre pestañas (patrón de tablist).
  document.addEventListener('keydown', function (e) {
    var t = e.target.closest && e.target.closest('.marcas__tab');
    if (!t || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    var otra = (e.key === 'ArrowRight' ? t.nextElementSibling : t.previousElementSibling) || t;
    otra.focus();
    otra.click();
    e.preventDefault();
  });
  document.addEventListener('change', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-campo') === 'modelo') {
      var p = e.target.closest('[data-picker-modelo]');
      if (p && p.hasAttribute('data-marcas-listo')) mostrar(p, marcaDe(e.target.value) || p.getAttribute('data-marca'));
    }
  });

  prepararTodo();
  // Los bloques que se agregan después («Agregar otra impresora»).
  new MutationObserver(function (cambios) {
    cambios.forEach(function (c) {
      c.addedNodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        if (n.matches('[data-picker-modelo]')) preparar(n);
        n.querySelectorAll && n.querySelectorAll('[data-picker-modelo]').forEach(preparar);
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
