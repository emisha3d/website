/* ==========================================================================
   Emisha — lentes impresos en 3D: catálogo de opciones y precios
   Lo usa /lentes/ (demo sin enlazar). Script clásico, sin dependencias:
   deja todo en window.EmishaLentes para que lentes.js lo lea.

   ⚠️ TODOS LOS PRECIOS DE AQUÍ SON UN PUNTO DE PARTIDA.
   Están puestos para que la configuración más sencilla dé $5,000 y una muy
   cargada ande por los $25,000. Ajústalos cuando se mapeen los costos reales:
   cada opción tiene su `precio` en pesos (MXN) y el total es la suma. Un precio
   negativo resta (el acabado "crudo" es más barato que el lijado).

   Para agregar una opción basta con agregar una fila a su lista. Las formas,
   puentes, varillas y dijes además necesitan su geometría en lentes-geometria.js
   (se busca por `id`); si no la encuentra, usa la primera de su tipo.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------ BASE */
  var PRECIO = {
    base: 4600,          // diseño, impresión, ensamble y ajuste del armazón
    colorExtra: 300      // por cada color más en el armazón (frente, puente, varillas, ceja)
  };

  /* ---------------------------------------------- LAS 10 TALLAS DE LENTE
     El laboratorio solo corta estas 10. El número es el ancho del lente en
     milímetros (medida "caja", de lado a lado). Cada forma usa tres de ellas
     para sus tallas S, M y L; entre todas las formas se usan las 10. */
  var TALLAS_LENTE = [
    { n: 1,  ancho: 44 }, { n: 2,  ancho: 46 }, { n: 3,  ancho: 48 },
    { n: 4,  ancho: 50 }, { n: 5,  ancho: 52 }, { n: 6,  ancho: 54 },
    { n: 7,  ancho: 56 }, { n: 8,  ancho: 58 }, { n: 9,  ancho: 60 },
    { n: 10, ancho: 62 }
  ];

  /* ----------------------------------------------------------- FORMAS
     tallas: [ancho de lente, puente, varilla] en mm, como viene grabado en
     cualquier armazón: 52 □ 19 — 140. `codigo` es lo que se le pasa al
     laboratorio junto con la talla de lente: GAT-6 = ojo de gato, 54 mm.

     MODELO PROPIO: agrega `modelo: '/assets/modelos/lentes/archivo.glb'` a
     una forma para usar tu diseño de CAD en vez del generado. Las reglas del
     archivo (unidades, origen, nombres de las piezas) están en lentes.js,
     en "MODELOS PROPIOS". Se puede agregar una forma nueva con su modelo:
     solo necesita id, nombre, código, precio y tallas como las demás. */
  var FORMAS = [
    { id: 'clasico',     nombre: 'Clásico',     codigo: 'CLA', precio: 300,
      nota: 'Trapecio de ceja gruesa, el de toda la vida.',
      tallas: { S: [50, 20, 140], M: [52, 21, 145], L: [54, 22, 150] } },
    { id: 'redondo',     nombre: 'Redondo',     codigo: 'RED', precio: 0,
      nota: 'Aro fino y circular.',
      tallas: { S: [44, 20, 135], M: [46, 21, 140], L: [48, 22, 145] } },
    { id: 'cuadrado',    nombre: 'Cuadrado',    codigo: 'CUA', precio: 0,
      nota: 'Esquinas suaves, casi tan alto como ancho.',
      tallas: { S: [48, 18, 135], M: [50, 19, 140], L: [52, 20, 145] } },
    { id: 'rectangular', nombre: 'Rectangular', codigo: 'REC', precio: 0,
      nota: 'Bajo y alargado.',
      tallas: { S: [50, 17, 135], M: [52, 18, 140], L: [54, 19, 145] } },
    { id: 'gato',        nombre: 'Ojo de gato', codigo: 'GAT', precio: 500,
      nota: 'La esquina de afuera sube.',
      tallas: { S: [52, 17, 135], M: [54, 18, 140], L: [56, 19, 145] } },
    { id: 'aviador',     nombre: 'Aviador',     codigo: 'AVI', precio: 700,
      nota: 'Gota que baja hacia la nariz.',
      tallas: { S: [58, 14, 135], M: [60, 14, 140], L: [62, 15, 140] } }
  ];

  var TALLAS = [
    { id: 'S', nombre: 'Chica',   precio: 0 },
    { id: 'M', nombre: 'Mediana', precio: 0 },
    { id: 'L', nombre: 'Grande',  precio: 200 }   // más material y más horas
  ];

  /* ------------------------------------------------ LÍNEAS DE FILAMENTO
     El recargo de la línea se cobra UNA vez: el de la línea más cara que
     aparezca en el armazón. */
  var LINEAS = [
    { id: 'pla-matte',  nombre: 'PLA Matte',     precio: 0 },
    { id: 'petg-matte', nombre: 'PETG Matte HF', precio: 300 },
    { id: 'pla-cosmic', nombre: 'PLA Cosmic',    precio: 500, efecto: 'destellos' },
    { id: 'pla-wood',   nombre: 'PLA Wood',      precio: 800, efecto: 'madera' }
  ];

  /* ----------------------------------------------------------- COLORES
     Los 29 colores del catálogo de /filamentos/. El hex se midió sobre la
     foto de cada bobina (zona del filamento enrollado). */
  var COLORES = [
    { id: 'petg-deep-black',    linea: 'petg-matte', nombre: 'Deep Black',    hex: '#1b1b1b' },
    { id: 'petg-deep-white',    linea: 'petg-matte', nombre: 'Deep White',    hex: '#e3e3e4' },
    { id: 'petg-deep-grey',     linea: 'petg-matte', nombre: 'Deep Grey',     hex: '#747683' },
    { id: 'petg-deep-red',      linea: 'petg-matte', nombre: 'Deep Red',      hex: '#cf4144' },
    { id: 'petg-deep-orange',   linea: 'petg-matte', nombre: 'Deep Orange',   hex: '#f26d46' },
    { id: 'petg-deep-yellow',   linea: 'petg-matte', nombre: 'Deep Yellow',   hex: '#e4e038' },
    { id: 'petg-deep-green',    linea: 'petg-matte', nombre: 'Deep Green',    hex: '#52b847' },
    { id: 'petg-mint-green',    linea: 'petg-matte', nombre: 'Mint Green',    hex: '#3eb9a6' },
    { id: 'petg-sky-blue',      linea: 'petg-matte', nombre: 'Sky Blue',      hex: '#50b0e1' },
    { id: 'petg-deep-blue',     linea: 'petg-matte', nombre: 'Deep Blue',     hex: '#34378f' },
    { id: 'petg-deep-pink',     linea: 'petg-matte', nombre: 'Deep Pink',     hex: '#e0388f' },

    { id: 'pla-midnight-black', linea: 'pla-matte',  nombre: 'Midnight Black', hex: '#1f1f1f' },
    { id: 'pla-pearl-white',    linea: 'pla-matte',  nombre: 'Pearl White',    hex: '#e0e3e2' },
    { id: 'pla-soft-grey',      linea: 'pla-matte',  nombre: 'Soft Grey',      hex: '#74787b' },
    { id: 'pla-clay',           linea: 'pla-matte',  nombre: 'Clay',           hex: '#636358' },
    { id: 'pla-deep-red',       linea: 'pla-matte',  nombre: 'Deep Red',       hex: '#d75c5d' },
    { id: 'pla-sunbean-yellow', linea: 'pla-matte',  nombre: 'Sunbean Yellow', hex: '#d4e04c' },
    { id: 'pla-olive-green',    linea: 'pla-matte',  nombre: 'Olive Green',    hex: '#5c6e48' },
    { id: 'pla-deep-green',     linea: 'pla-matte',  nombre: 'Deep Green',     hex: '#76be73' },
    { id: 'pla-powder-blue',    linea: 'pla-matte',  nombre: 'Powder Blue',    hex: '#bce3eb' },
    { id: 'pla-soft-blue',      linea: 'pla-matte',  nombre: 'Soft Blue',      hex: '#9ed0ee' },
    { id: 'pla-deep-blue',      linea: 'pla-matte',  nombre: 'Deep Blue',      hex: '#4e55a7' },
    { id: 'pla-soft-pink',      linea: 'pla-matte',  nombre: 'Soft Pink',      hex: '#f58ebc' },

    { id: 'pla-cosmic-black',   linea: 'pla-cosmic', nombre: 'Cosmic Black',   hex: '#393b39' },
    { id: 'pla-cosmic-blue',    linea: 'pla-cosmic', nombre: 'Cosmic Blue',    hex: '#8acdee' },

    { id: 'pla-wood-honey-maple',   linea: 'pla-wood', nombre: 'Honey Maple',   hex: '#c9ac83' },
    { id: 'pla-wood-forest-wood',   linea: 'pla-wood', nombre: 'Forest Wood',   hex: '#907e6c' },
    { id: 'pla-wood-autumn-cherry', linea: 'pla-wood', nombre: 'Autumn Cherry', hex: '#916663' },
    { id: 'pla-wood-dark-walnut',   linea: 'pla-wood', nombre: 'Dark Walnut',   hex: '#41372d' }
  ];

  /* ------------------------------------------------ CÓMO SE REPARTE EL COLOR
     El segundo color de "dos tonos" y "degradado" ya va pagado aquí: no
     cuenta como color extra. */
  var ESTILOS_FRENTE = [
    { id: 'solido',    nombre: 'Un color',  precio: 0 },
    { id: 'dostonos',  nombre: 'Dos tonos', precio: 600,  nota: 'Arriba un color, abajo otro.' },
    { id: 'degradado', nombre: 'Degradado', precio: 1200, nota: 'Transición de un color a otro.' }
  ];

  /* ---------------------------------------------- SUPERFICIE Y ACABADO */
  var TEXTURAS = [
    { id: 'lisa',      nombre: 'Lisa',      precio: 0 },
    { id: 'acanalada', nombre: 'Acanalada', precio: 500,  nota: 'Estrías finas verticales.' },
    { id: 'moleteada', nombre: 'Moleteada', precio: 700,  nota: 'Rombos como de herramienta.' },
    { id: 'hexagonal', nombre: 'Hexagonal', precio: 900,  nota: 'Panal en relieve.' },
    { id: 'organica',  nombre: 'Orgánica',  precio: 1200, nota: 'Celdas irregulares, tipo coral.' }
  ];

  var ACABADOS = [
    { id: 'crudo',     nombre: 'Crudo',       precio: -400, nota: 'Tal cual sale de la impresora, se ven las capas.' },
    { id: 'lijado',    nombre: 'Lijado mate', precio: 0,    nota: 'Lijado a mano, mate parejo.' },
    { id: 'brillante', nombre: 'Brillante',   precio: 800,  nota: 'Barniz transparente de alto brillo.' },
    { id: 'suave',     nombre: 'Soft-touch',  precio: 1100, nota: 'Recubrimiento aterciopelado.' }
  ];

  /* ------------------------------------------------------------ PIEZAS */
  var PUENTES = [
    { id: 'silla',     nombre: 'Silla',              precio: 0,   nota: 'Arco bajo que se apoya en la nariz.' },
    { id: 'cerradura', nombre: 'Ojo de cerradura',   precio: 300, nota: 'Arco alto, deja libre el tabique.' },
    { id: 'doble',     nombre: 'Doble puente',       precio: 600, nota: 'Una barra más sobre los lentes.' },
    { id: 'plaquetas', nombre: 'Con plaquetas',      precio: 800, nota: 'Almohadillas de silicón ajustables.' }
  ];

  var VARILLAS = [
    { id: 'delgada',   nombre: 'Delgada',   precio: 0,   nota: 'Fina y ligera.' },
    { id: 'clasica',   nombre: 'Clásica',   precio: 200, nota: 'Ancha adelante, se afina hacia la oreja.' },
    { id: 'ancha',     nombre: 'Ancha',     precio: 400, nota: 'Plana y gruesa, con espacio para dijes.' },
    { id: 'deportiva', nombre: 'Deportiva', precio: 600, nota: 'Curva que abraza la cabeza.' }
  ];

  var BISAGRAS = [
    { id: 'oculta',  nombre: 'Oculta',  precio: 0,   nota: 'Perno metálico dentro de la pieza.' },
    { id: 'visible', nombre: 'Visible', precio: 300, nota: 'Barriles de metal a la vista.' },
    { id: 'flex',    nombre: 'Flex',    precio: 800, nota: 'Con resorte: abre de más sin romperse.' }
  ];

  /* Detalles: se pueden elegir varios a la vez. */
  var DETALLES = [
    { id: 'remaches', nombre: 'Remaches',        precio: 250, nota: 'Dos puntos metálicos en las esquinas.' },
    { id: 'ceja',     nombre: 'Ceja sobrepuesta', precio: 600, nota: 'Una pieza encima del aro superior.' },
    { id: 'placa',    nombre: 'Placa con logo',  precio: 350, nota: 'Placa metálica en cada varilla.' }
  ];

  /* ------------------------------------------------------------- DIJES
     Figuritas que se enganchan como los de Crocs. Cada una se cobra aparte. */
  var DIJES = [
    { id: 'calavera', nombre: 'Calavera',     precio: 300 },
    { id: 'nopal',    nombre: 'Nopal',        precio: 250 },
    { id: 'chile',    nombre: 'Chile',        precio: 250 },
    { id: 'flor',     nombre: 'Flor',         precio: 250 },
    { id: 'corazon',  nombre: 'Corazón',      precio: 200 },
    { id: 'estrella', nombre: 'Estrella',     precio: 200 },
    { id: 'rayo',     nombre: 'Rayo',         precio: 200 },
    { id: 'emisha',   nombre: 'Logo Emisha',  precio: 150 }
  ];

  /* Dónde se pueden enganchar. Las posiciones exactas salen de la geometría. */
  var LUGARES_DIJE = [
    { id: 'ceja-der',     nombre: 'Aro, arriba a la derecha' },
    { id: 'ceja-centro',  nombre: 'Sobre el puente' },
    { id: 'ceja-izq',     nombre: 'Aro, arriba a la izquierda' },
    { id: 'esquina-der',  nombre: 'Esquina derecha' },
    { id: 'esquina-izq',  nombre: 'Esquina izquierda' },
    { id: 'varilla-der-1', nombre: 'Varilla derecha, adelante' },
    { id: 'varilla-der-2', nombre: 'Varilla derecha, atrás' },
    { id: 'varilla-izq-1', nombre: 'Varilla izquierda, adelante' },
    { id: 'varilla-izq-2', nombre: 'Varilla izquierda, atrás' }
  ];

  /* ------------------------------------------------------------ LENTES */
  var LENTES = [
    { id: 'claro',      nombre: 'Sin graduación',    precio: 800,  nota: 'Lente claro, solo para lucir el armazón.' },
    { id: 'monofocal',  nombre: 'Graduado',          precio: 2400, nota: 'Monofocal. Te pedimos tu receta por WhatsApp.' },
    { id: 'progresivo', nombre: 'Progresivo',        precio: 4000, nota: 'Para ver de lejos y de cerca. Te pedimos tu receta.' }
  ];

  var TRATAMIENTOS = [
    { id: 'ar',   nombre: 'Antirreflejante', precio: 900 },
    { id: 'azul', nombre: 'Filtro de luz azul', precio: 1000 }
  ];

  var SOL = [
    { id: 'ninguno',       nombre: 'Sin tinte',     precio: 0 },
    { id: 'tinte',         nombre: 'Tinte',         precio: 700 },
    { id: 'degradado',     nombre: 'Degradado',     precio: 1000, nota: 'Oscuro arriba, claro abajo.' },
    { id: 'polarizado',    nombre: 'Polarizado',    precio: 2000, nota: 'Quita reflejos del agua y del asfalto.' },
    { id: 'fotocromatico', nombre: 'Fotocromático', precio: 2500, nota: 'Claro adentro, se oscurece al sol.' }
  ];

  var TINTES = [
    { id: 'gris',  nombre: 'Gris',  hex: '#2b2f33' },
    { id: 'cafe',  nombre: 'Café',  hex: '#5a3d24' },
    { id: 'verde', nombre: 'Verde', hex: '#3b4a33' },
    { id: 'rosa',  nombre: 'Rosa',  hex: '#b5657a' },
    { id: 'azul',  nombre: 'Azul',  hex: '#2f4a73' }
  ];

  /* ============================================================ CÁLCULO */

  function porId(lista, id) {
    for (var i = 0; i < lista.length; i++) if (lista[i].id === id) return lista[i];
    return lista[0];
  }

  /* Colores que de verdad lleva el armazón, zona por zona. null en una zona
     quiere decir "igual que el frente". La ceja solo cuenta si está puesta. */
  function coloresUsados(e) {
    var c = e.colores || {};
    var frente = c.frente;
    var zonas = [frente, c.puente || frente, c.varillas || frente];
    if (e.detalles && e.detalles.ceja) zonas.push(c.ceja || frente);
    var segundo = e.estiloFrente && e.estiloFrente !== 'solido' ? c.frente2 : null;
    return { zonas: zonas, segundo: segundo };
  }

  /* estado → { total, lineas: [{concepto, detalle, monto}] }
     Las líneas en cero no se listan, salvo la base. */
  function calcular(e) {
    var lineas = [];
    function sumar(concepto, detalle, monto) {
      if (monto) lineas.push({ concepto: concepto, detalle: detalle, monto: monto });
    }

    lineas.push({ concepto: 'Armazón impreso', detalle: 'Diseño, impresión y ensamble', monto: PRECIO.base });

    var forma = porId(FORMAS, e.forma);
    sumar('Forma', forma.nombre, forma.precio);
    var talla = porId(TALLAS, e.talla);
    sumar('Talla', talla.nombre, talla.precio);

    /* Material: recargo de la línea más cara que aparezca. */
    var usados = coloresUsados(e);
    var todos = usados.zonas.concat(usados.segundo ? [usados.segundo] : []);
    var lineaCara = null;
    todos.forEach(function (id) {
      var l = porId(LINEAS, porId(COLORES, id).linea);
      if (!lineaCara || l.precio > lineaCara.precio) lineaCara = l;
    });
    if (lineaCara) sumar('Material', lineaCara.nombre, lineaCara.precio);

    /* Colores extra: distintos entre las zonas, sin contar el segundo color
       del frente, que ya se cobra en el estilo. */
    var distintos = {};
    usados.zonas.forEach(function (id) { distintos[id] = true; });
    var extra = Object.keys(distintos).length - 1;
    if (extra > 0) sumar('Colores extra', extra + (extra === 1 ? ' color más' : ' colores más'), extra * PRECIO.colorExtra);

    var estilo = porId(ESTILOS_FRENTE, e.estiloFrente);
    sumar('Frente', estilo.nombre, estilo.precio);
    var tex = porId(TEXTURAS, e.textura);
    sumar('Textura', tex.nombre, tex.precio);
    var acab = porId(ACABADOS, e.acabado);
    sumar('Acabado', acab.nombre, acab.precio);

    var pu = porId(PUENTES, e.puente);
    sumar('Puente', pu.nombre, pu.precio);
    var va = porId(VARILLAS, e.varillas);
    sumar('Varillas', va.nombre, va.precio);
    var bi = porId(BISAGRAS, e.bisagra);
    sumar('Bisagras', bi.nombre, bi.precio);
    DETALLES.forEach(function (d) {
      if (e.detalles && e.detalles[d.id]) sumar('Detalle', d.nombre, d.precio);
    });

    /* Dijes: se agrupan por figura para que el desglose no sea una lista de 9. */
    var cuenta = {};
    Object.keys(e.dijes || {}).forEach(function (lugar) {
      var id = e.dijes[lugar];
      if (id) cuenta[id] = (cuenta[id] || 0) + 1;
    });
    DIJES.forEach(function (d) {
      var n = cuenta[d.id];
      if (n) sumar('Dijes', n + ' × ' + d.nombre, n * d.precio);
    });

    var le = porId(LENTES, e.lente);
    sumar('Lentes', le.nombre, le.precio);
    TRATAMIENTOS.forEach(function (t) {
      if (e.tratamientos && e.tratamientos[t.id]) sumar('Tratamiento', t.nombre, t.precio);
    });
    var sol = porId(SOL, e.sol);
    var tinte = porId(TINTES, e.tinte);
    sumar('Sol', sol.id === 'ninguno' || sol.id === 'fotocromatico' ? sol.nombre : sol.nombre + ' ' + tinte.nombre.toLowerCase(), sol.precio);

    var total = 0;
    lineas.forEach(function (l) { total += l.monto; });
    return { total: total, lineas: lineas };
  }

  /* Medidas de la talla elegida: lo que se le dice al laboratorio. */
  function medidas(e) {
    var forma = porId(FORMAS, e.forma);
    var t = forma.tallas[e.talla] || forma.tallas.M;
    var lente = null;
    for (var i = 0; i < TALLAS_LENTE.length; i++) if (TALLAS_LENTE[i].ancho === t[0]) lente = TALLAS_LENTE[i];
    return {
      anchoLente: t[0], puente: t[1], varilla: t[2],
      tallaLente: lente ? lente.n : null,
      codigoLente: forma.codigo + '-' + (lente ? lente.n : '?')
    };
  }

  var api = {
    PRECIO: PRECIO, TALLAS_LENTE: TALLAS_LENTE, FORMAS: FORMAS, TALLAS: TALLAS,
    LINEAS: LINEAS, COLORES: COLORES, ESTILOS_FRENTE: ESTILOS_FRENTE,
    TEXTURAS: TEXTURAS, ACABADOS: ACABADOS, PUENTES: PUENTES, VARILLAS: VARILLAS,
    BISAGRAS: BISAGRAS, DETALLES: DETALLES, DIJES: DIJES, LUGARES_DIJE: LUGARES_DIJE,
    LENTES: LENTES, TRATAMIENTOS: TRATAMIENTOS, SOL: SOL, TINTES: TINTES,
    porId: porId, calcular: calcular, medidas: medidas
  };

  if (typeof window !== 'undefined') window.EmishaLentes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
