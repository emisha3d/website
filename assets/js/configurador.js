/* Emisha — formulario «tipo Apple» para /reparacion/ y
   /reparacion/mantenimiento-preventivo/agendar/.

   Se va armando de arriba abajo: primero la marca (Bambu Lab, Creality u otra),
   luego el modelo de esa marca, luego la falla, luego los detalles; cada
   elección abre el paso siguiente y baja la página hasta él. Los pasos grandes
   («Tus datos», «Día y hora») se abren con «Continuar».

   Es una capa encima del formulario: no cambia ningún campo ni lo que se manda
   (reparacion.js / mantenimiento.js siguen igual). Sin JS se ve todo, como
   antes. Lo que ya se abrió no se vuelve a cerrar, así nada brinca al
   corregir. Los bloques de «Agregar otra impresora» arrancan desde la marca. */
(function () {
  'use strict';

  var form = document.querySelector('[data-cita-form], [data-mant-form]');
  if (!form) return;
  var esRep = form.hasAttribute('data-cita-form');
  var suave = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  var MARCAS = [
    { id: 'bambu', nombre: 'Bambu Lab', sub: 'A1, P1, P2, X1, X2, H2, H3 y AMS' },
    { id: 'creality', nombre: 'Creality', sub: 'K1, K2, Hi, Ender-3 V3 y CFS' },
    { id: 'otra', nombre: 'Otra marca', sub: 'Dinos cuál', soloRep: true }
  ];
  function marcaDe(valor) {
    if (valor === 'Otro') return 'otra';
    return /^Creality /.test(valor) ? 'creality' : 'bambu';
  }

  var css = document.createElement('style');
  css.textContent =
    '[data-cfg-oculto]{display:none!important}' +
    '[data-cfg-entra]{animation:cfgEntra .4s ease both}' +
    '@keyframes cfgEntra{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' +
    '@media (prefers-reduced-motion:reduce){[data-cfg-entra]{animation:none}}' +
    '.cfg-paso{scroll-margin-top:calc(var(--h-header,67px) + 14px)}' +
    '.picker__grid--marcas{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}' +
    '[data-cfg-marcas]{margin-bottom:16px}' +
    '.picker__item--marca{align-items:flex-start;text-align:left;padding:16px 16px 14px;gap:4px}' +
    '.picker__item--marca .cfg-marca__nombre{font-size:1.05rem;font-weight:700;color:var(--text)}' +
    '.picker__item--marca .cfg-marca__sub{font-size:.78rem;color:var(--muted);line-height:1.3}' +
    '.picker__item--modelo-oculto{display:none!important}' +
    '[data-picker-modelo]{margin-bottom:16px}' +
    '.cfg-seguir{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:18px}' +
    '.cfg-falta{color:#b42318;font-size:.88rem;margin:0}' +
    '[data-cfg-listo] .picker__marca{display:none}' +
    '@media (max-width:520px){.picker__grid--marcas{grid-template-columns:1fr}}';
  document.head.appendChild(css);

  function abrir(el) {
    if (!el || !el.hasAttribute('data-cfg-oculto')) return false;
    el.removeAttribute('data-cfg-oculto');
    el.setAttribute('data-cfg-entra', '');
    return true;
  }
  // Lo que tapa el encabezado fijo (en escritorio es sticky; en celular no).
  function altoEncabezado() {
    var h = document.querySelector('.site-header');
    if (!h) return 0;
    var pos = getComputedStyle(h).position;
    return pos === 'sticky' || pos === 'fixed' ? h.getBoundingClientRect().height : 0;
  }
  // La tarjeta que se acaba de escoger: al bajar, queda justo debajo del
  // encabezado (completa, sin cortarse) y el paso nuevo se ve debajo de ella.
  var ancla = null;
  function bajarA(el) {
    if (!el) return;
    var a = ancla;
    ancla = null;
    requestAnimationFrame(function () {
      var ref = a || el;
      var arriba = ref.getBoundingClientRect().top + window.scrollY - altoEncabezado() - 12;
      // Solo lo necesario: si el final de lo abierto (los pasos cerrados no
      // ocupan lugar, así que es el final del formulario) ya cabe en pantalla,
      // se baja hasta ahí y no más, para no dejar la página en blanco.
      var finForm = form.getBoundingClientRect().bottom + window.scrollY + 24 - window.innerHeight;
      var y = Math.min(arriba, finForm);
      if (y <= window.scrollY + 4) return;   // ya se ve todo: no se mueve (nunca sube)
      window.scrollTo({ top: y, behavior: suave ? 'smooth' : 'auto' });
    });
  }
  function radioMarcado(raiz, sel) { return raiz.querySelector(sel + ':checked'); }

  /* --- Dentro de cada impresora: marca → modelo → falla → detalles -------- */

  function pasosDe(bloque) { return bloque.__cfgPasos; }

  function preparar(bloque) {
    var picker = bloque.querySelector('[data-picker-modelo]');
    if (!picker) return;
    var marcasFs = bloque.querySelector('[data-cfg-marcas]');
    var nuevo = !marcasFs;
    if (nuevo) {
      var hayOtro = !!picker.querySelector('input[data-campo="modelo"][value="Otro"]');
      marcasFs = document.createElement('fieldset');
      marcasFs.className = 'picker cfg-paso';
      marcasFs.setAttribute('data-cfg-marcas', '');
      var html = '<legend>Marca</legend><div class="picker__grid picker__grid--marcas">';
      MARCAS.forEach(function (m) {
        if (m.soloRep && !hayOtro) return;
        html += '<label class="picker__item picker__item--marca"><input type="radio" name="cfg_marca" value="' + m.id + '">' +
          '<span class="cfg-marca__nombre">' + m.nombre + '</span><span class="cfg-marca__sub">' + m.sub + '</span></label>';
      });
      marcasFs.innerHTML = html + '</div>';
      picker.parentNode.insertBefore(marcasFs, picker);
      bloque.setAttribute('data-cfg-listo', '');
    }
    // Los pasos: marca, modelo, falla (solo reparación) y lo que sigue, junto.
    var falla = bloque.querySelector('[data-picker-falla]');
    var resto = [];
    var el = picker.nextElementSibling;
    while (el) {
      if (el !== falla && !el.hasAttribute('data-modelo-otro')) resto.push(el);
      el = el.nextElementSibling;
    }
    var pasos = [[marcasFs], [picker]];
    if (falla) pasos.push([falla]);
    pasos.push(resto);
    bloque.__cfgPasos = pasos;
    pasos.forEach(function (p) { p.forEach(function (x) { x.classList.add('cfg-paso'); }); });

    // Un bloque nuevo (o el clon de «Agregar otra impresora») arranca en la marca.
    var marcada = radioMarcado(picker, 'input[data-campo="modelo"]');
    if (nuevo && marcada) {
      // Ya traía modelo (raro: autollenado del navegador): se respeta.
      var r = marcasFs.querySelector('input[value="' + marcaDe(marcada.value) + '"]');
      if (r) r.checked = true;
    }
    pasos.slice(1).forEach(function (p) { p.forEach(function (x) { x.setAttribute('data-cfg-oculto', ''); }); });
    filtrar(bloque);
    avanzar(bloque, false);
  }

  function marcaElegida(bloque) {
    var r = radioMarcado(bloque.querySelector('[data-cfg-marcas]'), 'input');
    return r ? r.value : '';
  }

  // Solo los modelos de la marca; «Otra marca» no muestra modelos.
  function filtrar(bloque) {
    var marca = marcaElegida(bloque);
    var picker = bloque.querySelector('[data-picker-modelo]');
    picker.querySelectorAll('input[data-campo="modelo"]').forEach(function (r) {
      r.closest('.picker__item').classList.toggle('picker__item--modelo-oculto', marcaDe(r.value) !== marca);
    });
    picker.classList.toggle('picker__item--modelo-oculto', marca === 'otra');
  }

  // Cuántos pasos seguidos ya están completos.
  function completos(bloque) {
    var n = 0;
    if (!marcaElegida(bloque)) return n;
    n++;
    if (!radioMarcado(bloque, 'input[data-campo="modelo"]')) return n;
    n++;
    if (bloque.querySelector('[data-picker-falla]')) {
      if (!radioMarcado(bloque, 'input[data-campo="tipo_falla"]')) return n;
      n++;
    }
    return n;
  }

  // Abre hasta el primer paso pendiente; si abrió algo y `mover`, baja hasta él.
  // Regresa lo primero que abrió (o null).
  function avanzar(bloque, mover) {
    var pasos = pasosDe(bloque), hasta = Math.min(completos(bloque), pasos.length - 1), nuevo = null;
    for (var i = 0; i <= hasta; i++) {
      pasos[i].forEach(function (x) { if (abrir(x) && !nuevo) nuevo = x; });
    }
    if (mover && nuevo) bajarA(nuevo);
    // Con la primera impresora completa aparecen «Agregar otra» y «Continuar».
    if (!pasos[pasos.length - 1][0] || !pasos[pasos.length - 1][0].hasAttribute('data-cfg-oculto')) extrasPaso1.forEach(abrir);
    return nuevo;
  }
  var extrasPaso1 = [];

  form.addEventListener('change', function (e) {
    var t = e.target, bloque = t.closest && t.closest('[data-equipo]');
    // Solo lo que hace la persona: los change que lanzamos aquí (desmarcar el
    // modelo, marcar «Otro») son para reparacion.js, no para mover la página.
    if (!e.isTrusted || !bloque || !bloque.__cfgPasos) return;
    var pasos = pasosDe(bloque);
    if (/^cfg_marca/.test(t.name)) {
      var modelo = radioMarcado(bloque, 'input[data-campo="modelo"]');
      var otro = bloque.querySelector('input[data-campo="modelo"][value="Otro"]');
      if (t.value === 'otra' && otro && !otro.checked) {
        otro.checked = true;
        otro.dispatchEvent(new Event('change', { bubbles: true }));   // reparacion.js abre «¿Cuál?»
      } else if (modelo && marcaDe(modelo.value) !== t.value) {
        modelo.checked = false;
        modelo.dispatchEvent(new Event('change', { bubbles: true }));
      }
      filtrar(bloque);
      if (t.value === 'otra') {
        // Abre lo que sigue, pero baja a «¿Cuál?», que es lo que hay que llenar.
        avanzar(bloque, false);
        ancla = null;
        bajarA(bloque.querySelector('[data-modelo-otro]'));
        return;
      }
    }
    var nuevo = avanzar(bloque, false);
    if (t.type !== 'radio') return;
    if (nuevo) {
      // Primera vez: la tarjeta elegida arriba, completa, y el paso nuevo debajo.
      ancla = t.closest('.picker__item');
      bajarA(nuevo);
      return;
    }
    // Corrigiendo un paso de arriba: lleva al paso que sigue, que ya estaba abierto.
    var i = -1;
    pasos.forEach(function (p, k) { if (p.some(function (x) { return x.contains(t); })) i = k; });
    var sig = pasos[i + 1] && pasos[i + 1][0];
    if (sig && !sig.hasAttribute('data-cfg-oculto')) { ancla = null; bajarA(sig); }
  });

  /* --- Precios: solo los de la marca escogida -------------------------- */
  // Sin marca escogida se ven las dos listas; con impresoras de las dos
  // marcas, también. «Otra marca» paga la lista general (la de Bambu Lab).
  var listasPrecios = document.querySelectorAll('[data-precios-marca]');
  function pintarPrecios() {
    if (!listasPrecios.length) return;
    var hay = {};
    form.querySelectorAll('[data-cfg-marcas] input:checked').forEach(function (r) {
      hay[r.value === 'otra' ? 'bambu' : r.value] = true;
    });
    var ninguna = !hay.bambu && !hay.creality;
    listasPrecios.forEach(function (l) {
      var ver = ninguna || hay[l.getAttribute('data-precios-marca')];
      l.hidden = !ver;
      // El título de la marca sobra cuando solo hay una lista; el margen de arriba también.
      var t = l.querySelector('p');
      if (t) t.style.marginTop = (ninguna || (hay.bambu && hay.creality)) && l.getAttribute('data-precios-marca') !== 'bambu' ? '14px' : '0';
    });
  }
  form.addEventListener('change', pintarPrecios);

  /* --- Los pasos grandes: «Tus datos», «Día y hora» y el botón final ------- */

  var pasosForm = Array.prototype.filter.call(form.children, function (x) { return x.classList.contains('cita-paso'); });
  var enviar = form.querySelector('.cita-enviar');

  // Lo que le falta al paso 1: [mensaje, elemento al que bajar].
  function faltaEnImpresoras() {
    var bloques = form.querySelectorAll('[data-equipo]');
    for (var i = 0; i < bloques.length; i++) {
      var b = bloques[i], cual = bloques.length > 1 ? ' de la impresora ' + (i + 1) : '';
      var modelo = radioMarcado(b, 'input[data-campo="modelo"]');
      if (!marcaElegida(b)) return ['Elige la marca' + cual + '.', b.querySelector('[data-cfg-marcas]')];
      if (!modelo) return ['Elige el modelo' + cual + '.', b.querySelector('[data-picker-modelo]')];
      var otro = b.querySelector('[data-campo="modelo_otro"]');
      if (modelo.value === 'Otro' && otro && !otro.value.trim()) return ['Dinos qué marca y modelo es' + cual + '.', otro];
      if (b.querySelector('[data-picker-falla]') && !radioMarcado(b, 'input[data-campo="tipo_falla"]')) {
        return ['Elige el tipo de falla' + cual + '.', b.querySelector('[data-picker-falla]')];
      }
      var desc = b.querySelector('[data-campo="descripcion"]');
      if (desc && desc.value.trim().length < 10) return ['Cuéntanos qué le pasa' + cual + ' (al menos una frase).', desc];
    }
    return null;
  }
  function faltaEnCampos(paso) {
    var campos = paso.querySelectorAll('input[required], select[required], textarea[required]');
    for (var i = 0; i < campos.length; i++) {
      if (!campos[i].checkValidity()) return campos[i];
    }
    return null;
  }

  function botonSeguir(paso, siguiente, revisar) {
    var caja = document.createElement('div');
    caja.className = 'cfg-seguir';
    caja.innerHTML = '<button type="button" class="btn btn--accent">Continuar</button><p class="cfg-falta" aria-live="polite"></p>';
    var cont = paso.querySelector('.cita-campos') || paso;
    cont.appendChild(caja);
    caja.querySelector('button').addEventListener('click', function () {
      var aviso = caja.querySelector('.cfg-falta');
      var falta = revisar();
      if (falta) {
        aviso.textContent = falta[0];
        if (falta[1]) {
          falta[1].scrollIntoView({ behavior: suave ? 'smooth' : 'auto', block: 'center' });
          if (falta[1].focus && /^(INPUT|TEXTAREA|SELECT)$/.test(falta[1].tagName)) falta[1].focus({ preventScroll: true });
        }
        return;
      }
      aviso.textContent = '';
      caja.setAttribute('data-cfg-oculto', '');
      siguiente.forEach(abrir);
      bajarA(siguiente[0]);
    });
  }

  if (pasosForm.length >= 3 && enviar) {
    pasosForm.slice(1).concat([enviar]).forEach(function (x) {
      x.classList.add('cfg-paso');
      x.setAttribute('data-cfg-oculto', '');
    });
    botonSeguir(pasosForm[0], [pasosForm[1]], faltaEnImpresoras);
    var campos1 = pasosForm[0].querySelector('.cita-campos');
    if (campos1) Array.prototype.forEach.call(campos1.children, function (x) {
      if (!x.hasAttribute('data-equipos')) { x.setAttribute('data-cfg-oculto', ''); extrasPaso1.push(x); }
    });
    botonSeguir(pasosForm[1], [pasosForm[2], enviar], function () {
      var f = faltaEnCampos(pasosForm[1]);
      if (!f) return null;
      var etiqueta = f.id && form.querySelector('label[for="' + f.id + '"]');
      return ['Falta: ' + (etiqueta ? etiqueta.textContent.trim() : 'un dato') + '.', f];
    });
  }

  /* --- Arranque y bloques que se agregan después ------------------------- */

  form.querySelectorAll('[data-equipo]').forEach(preparar);
  new MutationObserver(function (cambios) {
    pintarPrecios();   // «Quitar» una impresora también cambia las marcas
    cambios.forEach(function (c) {
      c.addedNodes.forEach(function (n) {
        if (n.nodeType === 1 && n.matches('[data-equipo]')) preparar(n);   // el clon ya baja solo
      });
    });
  }).observe(form, { childList: true, subtree: true });
})();
