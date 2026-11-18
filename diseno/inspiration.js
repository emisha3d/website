(() => {
  const items = window.EMISHA_INSPIRATION;
  const grid = document.querySelector('#inspiration-grid');
  if (!items || !grid) return;
  // A piece can belong to a broad family and several concrete product types.
  const productTypes = {
    'Pines y símbolos de marca': ['Pines'],
    'Charms personalizados': ['Charms'],
    'Llaveros personalizados': ['Llaveros'],
    'Organizadores de escritorio': ['Organizadores'],
    'Estuches a medida': ['Estuches'],
    'Soportes con NFC': ['Soportes', 'NFC'],
    'Ajedrez Steelcase · Presentación': ['Juegos', 'Miniaturas'],
    'Producto en miniatura': ['Miniaturas'],
    'Kits para armar': ['Kits para armar', 'Juegos'],
    'Figura de marca · Adidas': ['Figuras y personajes'],
    'Personajes personalizados': ['Figuras y personajes'],
    'Figura con empaque': ['Figuras y personajes', 'Estuches', 'Empaques'],
    'Contenedores con forma propia': ['Contenedores', 'Empaques'],
    'Estuches con interiores a medida': ['Estuches', 'Empaques'],
    'Cajas de presentación': ['Cajas', 'Empaques'],
    'Placas y relieves': ['Placas', 'Relieves'],
    'Texto y logo en volumen': ['Logos 3D'],
    'Geometrías de marca': ['Logos 3D'],
    'Figura escultórica · Pantera': ['Esculturas', 'Figuras y personajes'],
    'Símbolo en relieve · UP': ['Relieves', 'Trofeos'],
    'Trofeo personalizado · Nike': ['Trofeos'],
    'Soportes de producto': ['Soportes', 'Exhibidores'],
    'Display para punto de venta · Nike': ['Exhibidores'],
    'Réplicas de producto': ['Réplicas de producto'],
    'Máscaras y personajes': ['Máscaras', 'Props'],
    'Utilería temática': ['Máscaras', 'Props'],
    'Elementos para eventos': ['Decoración', 'Props'],
    'Ajedrez Steelcase': ['Juegos', 'Miniaturas'],
    'Busto Nike · Gran formato': ['Esculturas', 'Bustos'],
    'Logo luminoso Oppa Mart': ['Logos luminosos'],
    'Personajes · TikTok': ['Figuras y personajes', 'Trofeos'],
    'Rayos · TikTok': ['Trofeos'],
    'Números en volumen': ['Números 3D'],
    'Placas · FUSA': ['Placas'],
    'Figuras de gallos': ['Esculturas', 'Figuras y personajes']
  };
  const typesFor = item => [...new Set([item.kind, ...(productTypes[item.title] || [])])];
  const type = document.querySelector('#product-type');
  const filters = [...document.querySelectorAll('[data-family]')];
  const dialog = document.querySelector('#inspiration-dialog');
  let family = 'Todas', selected = null, opener = null;
  const familyItems = () => items.filter(item => family === 'Todas' || item.category === family);
  function refreshTypes() {
    type.replaceChildren(new Option('Todos los tipos', 'Todos'));
    [...new Set(familyItems().flatMap(typesFor))]
      .sort((a, b) => a.localeCompare(b, 'es'))
      .forEach(kind => type.add(new Option(kind, kind)));
  }
  function show(item, button) {
    selected = item; opener = button;
    document.querySelector('#inspiration-detail-image').src = item.image;
    document.querySelector('#inspiration-detail-image').alt = item.title;
    document.querySelector('#inspiration-detail-kind').textContent = item.category + ' / ' + item.kind;
    document.querySelector('#inspiration-detail-title').textContent = item.title;
    document.querySelector('#inspiration-detail-description').textContent = item.description;
    dialog.showModal();
  }
  function render() {
    const matches = familyItems().filter(item => type.value === 'Todos' || typesFor(item).includes(type.value));
    grid.replaceChildren();
    matches.forEach(item => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'inspiration-card';
      const image = document.createElement('img');
      image.src = item.image; image.alt = item.title; image.loading = 'lazy'; image.decoding = 'async';
      const text = document.createElement('span'); text.className = 'inspiration-card-copy';
      const kind = document.createElement('span'); kind.className = 'inspiration-kind'; kind.textContent = item.kind;
      const title = document.createElement('strong'); title.textContent = item.title;
      const more = document.createElement('span'); more.className = 'inspiration-more'; more.textContent = 'Ver idea ↗';
      text.append(kind, title, more); button.append(image, text);
      button.addEventListener('click', () => show(item, button)); grid.append(button);
    });
    document.querySelector('#inspiration-count').textContent = `${matches.length} ideas para explorar`;
  }
  filters.forEach(button => button.addEventListener('click', () => {
    family = button.dataset.family;
    filters.forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    refreshTypes(); render();
  }));
  type.addEventListener('change', render);
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r=dialog.getBoundingClientRect(); if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => opener?.focus());
  document.querySelector('#inspiration-enquire').addEventListener('click', () => {
    if (!selected) return;
    document.querySelector('#interest').value = selected.category;
    const idea = document.querySelector('textarea[name="idea"]');
    const reference = `Me interesa desarrollar algo inspirado en: ${selected.title}.`;
    if (!idea.value.includes(reference)) idea.value = [idea.value, reference].filter(Boolean).join('\n');
    dialog.close(); document.querySelector('#contacto').scrollIntoView({behavior:'instant'});
    idea.focus({preventScroll:true});
  });
  refreshTypes(); render();
})();
