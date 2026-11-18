const toggle=document.querySelector('.menu-toggle');
const nav=document.querySelector('#main-nav');
toggle.addEventListener('click',()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));nav.classList.toggle('open',open)});
nav.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{nav.classList.remove('open');toggle.setAttribute('aria-expanded','false')}));
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelectorAll('.nav-group').forEach(d=>d.open=false);nav.classList.remove('open');toggle.setAttribute('aria-expanded','false')}});
document.addEventListener('click',e=>{document.querySelectorAll('.nav-group').forEach(d=>{if(!d.contains(e.target))d.open=false})});
const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
document.querySelectorAll('[data-gallery]').forEach(g=>{
 const track=g.querySelector('.slides'),prev=g.querySelector('.prev'),next=g.querySelector('.next'),caption=g.querySelector('.gallery-caption');
 const total=track.children.length;let index=0;
 const update=()=>{if(!track.clientWidth)return;index=Math.max(0,Math.min(total-1,Math.round(track.scrollLeft/track.clientWidth)));prev.disabled=index===0;next.disabled=index===total-1;const description=track.children[index].dataset.description;if(caption.textContent!==description)caption.textContent=description};
 const go=step=>{index=Math.max(0,Math.min(total-1,Math.round(track.scrollLeft/track.clientWidth)+step));track.scrollTo({left:index*track.clientWidth,behavior:'instant'});update()};
 prev.addEventListener('click',()=>go(-1));next.addEventListener('click',()=>go(1));track.addEventListener('scroll',update,{passive:true});track.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();go(e.key==='ArrowRight'?1:-1)}});new ResizeObserver(update).observe(track);update();
});
document.querySelectorAll('[data-interest]').forEach(a=>a.addEventListener('click',()=>{document.querySelector('#interest').value=a.dataset.interest}));
document.querySelectorAll('[data-award-style]').forEach(a=>a.addEventListener('click',()=>{document.querySelector('#award-style').value=a.dataset.awardStyle}));
document.querySelector('#brief-form').addEventListener('submit',e=>{
 e.preventDefault();const d=new FormData(e.currentTarget);const greeting=e.currentTarget.dataset.kind==='awards'?'Hola Adolfo, me gustaría cotizar reconocimientos personalizados.':'Hola Adolfo, me gustaría platicar sobre un proyecto de diseño.';const message=[greeting,'',`Nombre: ${d.get('nombre')}`,d.get('empresa')?`Marca / empresa: ${d.get('empresa')}`:'',`Proyecto: ${d.get('categoria')}`,d.get('estilo')?`Estilo: ${d.get('estilo')}`:'',`Idea: ${d.get('idea')}`,`Cantidad: ${d.get('cantidad')||'Por definir'}`,`Fecha: ${d.get('fecha')||'Por definir'}`,d.get('presupuesto')?`Presupuesto total (MXN): ${d.get('presupuesto')}`:''].filter((x,i)=>x||i===1).join('\n');window.open('https://wa.me/525552176071?text='+encodeURIComponent(message),'_blank','noopener,noreferrer');
});
