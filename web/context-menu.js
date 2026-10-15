export function contextMenu(doc,options){
  const menu=doc.createElement('div');menu.id='page-context-menu';menu.hidden=true;menu.setAttribute('role','menu');doc.body.append(menu);
  const hide=()=>{menu.hidden=true;};doc.addEventListener('pointerdown',e=>{if(!menu.contains(e.target))hide();},true);doc.addEventListener('keydown',e=>{if(e.key==='Escape')hide();});
  return {hide,show({x,y,text,href,paste}){
    menu.replaceChildren();
    const item=(label,run,disabled=false)=>{const button=doc.createElement('button');button.textContent=label;button.type='button';button.setAttribute('role','menuitem');button.disabled=disabled;button.onpointerdown=e=>e.preventDefault();button.onclick=()=>{hide();Promise.resolve().then(run).catch(options.error);};menu.append(button);};
    if(href){item('打开链接',()=>options.navigate(href));item('复制链接地址',()=>navigator.clipboard.writeText(href));}
    item('复制',()=>navigator.clipboard.writeText(text),!text);
    item('粘贴',paste);
    item('后退',()=>history.back());item('前进',()=>history.forward());item('刷新网页',options.reload);
    menu.hidden=false;const r=menu.getBoundingClientRect();menu.style.left=Math.max(4,Math.min(x,innerWidth-r.width-4))+'px';menu.style.top=Math.max(4,Math.min(y,innerHeight-r.height-4))+'px';
  }};
}
