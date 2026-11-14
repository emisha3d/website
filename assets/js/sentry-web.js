/* Sentry en las páginas con formulario (reparación, cotizador, tienda, envío,
   mantenimiento, factura): avisa si un error de JavaScript rompe el formulario
   en algún navegador. Sin cookies, sin grabación de pantalla, sin datos de
   quien llena el formulario (sendDefaultPii: false, sin cuerpos ni IP). */
(function () {
  if (!window.Sentry || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  window.Sentry.init({
    dsn: 'https://76b8383a59547d658ee8d18eccc4e427@o4512428352077824.ingest.us.sentry.io/4512428616318976',
    environment: 'production',
    sendDefaultPii: false,
    // Por citas: los bloqueadores de anuncios tumban *.sentry.io.
    tunnel: 'https://citas.emisha.com.mx/sentry-tunnel',
    tracesSampleRate: 0,
    // Solo errores de nuestro propio código, no de extensiones del navegador.
    allowUrls: [/https?:\/\/(www\.)?emisha\.com\.mx/],
    ignoreErrors: ['ResizeObserver loop', 'Non-Error promise rejection captured'],
    initialScope: { tags: { pagina: location.pathname } }
  });
})();
