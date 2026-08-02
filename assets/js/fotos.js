/* ==========================================================================
   Emisha — huecos de foto que se ocultan solos
   --------------------------------------------------------------------------
   Deja preparados los espacios para las fotos del taller sin romper el sitio
   mientras no existan. Cada elemento con data-foto que no logre cargar su imagen
   se quita del DOM, así que la página se ve igual de bien con foto y sin
   foto, y basta con dejar el archivo en su ruta para que aparezca.

   No hace falta tocar el HTML cuando lleguen las fotos: solo subirlas con
   el nombre que ya está escrito en el src.
   ========================================================================== */
(function () {
  'use strict';

  function quitar(fig) {
    if (fig && fig.parentNode) fig.parentNode.removeChild(fig);
  }

  function revisar() {
    var figuras = document.querySelectorAll('[data-foto]');
    Array.prototype.forEach.call(figuras, function (fig) {
      var img = fig.querySelector('img');
      if (!img) { quitar(fig); return; }

      // Ya falló antes de que corriera este script.
      if (img.complete && img.naturalWidth === 0) { quitar(fig); return; }

      img.addEventListener('error', function () { quitar(fig); });

      // Si ya cargó bien, la dejamos visible.
      if (img.complete && img.naturalWidth > 0) fig.removeAttribute('data-esperando');
      else img.addEventListener('load', function () { fig.removeAttribute('data-esperando'); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', revisar);
  } else {
    revisar();
  }
})();
