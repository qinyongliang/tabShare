export function shareKey(hash){return hash.replace(/^#/,'').split('&')[0];}
export function routeHash(key,url){return '#'+key+'&url='+encodeURIComponent(url);}

// Only the fragment contains the capability and source URL; neither reaches HTTP logs.
export class SharedNavigation {
  constructor(win,key,send){
    this.win=win;this.key=key;this.send=send;this.entries=new Map();this.slot=0;
    const saved=win.history.state?.tabshare;
    if(saved?.key===key){this.slot=saved.slot;this.entries.set(saved.entry,saved.slot);}
    win.addEventListener('popstate',()=>{
      const state=win.history.state?.tabshare;
      if(state?.key!==key)return;
      this.slot=state.slot;
      if(this.moving===state.entry){this.moving=null;return;}
      this.pending=state.entry;send({action:'history',entryId:state.entry});
    });
    win.addEventListener('hashchange',()=>{
      if(win.history.state?.tabshare?.key===key)return;
      if(shareKey(win.location.hash)!==key)return;
      const url=new URLSearchParams(win.location.hash.slice(1).split('&').slice(1).join('&')).get('url');
      try{const u=new URL(url);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)send({action:'navigate',url:u.href});}catch{}
    });
  }
  update(meta){
    const entry=meta.navigation?.entryId,url=meta.url;
    if(!Number.isInteger(entry)||!url)return;
    if(this.pending!=null){if(this.pending!==entry){if(!Array.isArray(meta.navigation.entries)||meta.navigation.entries.includes(this.pending))return;this.entries.delete(this.pending);this.entries.set(entry,this.slot);this.win.history.replaceState({tabshare:{key:this.key,entry,slot:this.slot}},'',routeHash(this.key,url));this.pending=null;return;}this.pending=null;}
    if(this.moving===entry)return;
    const current=this.win.history.state?.tabshare;
    const state=slot=>({tabshare:{key:this.key,entry,slot}}),hash=routeHash(this.key,url);
    if(!this.ready){this.ready=true;this.win.history.replaceState(state(this.slot),'',hash);this.entries.set(entry,this.slot);return;}
    if(current?.entry===entry){if(this.win.location.hash!==hash)this.win.history.replaceState(state(this.slot),'',hash);return;}
    const slot=this.entries.get(entry);
    if(slot!=null&&slot!==this.slot){this.moving=entry;this.win.history.go(slot-this.slot);return;}
    for(const [id,index] of this.entries)if(index>this.slot)this.entries.delete(id);
    this.slot++;this.entries.set(entry,this.slot);this.win.history.pushState(state(this.slot),'',hash);
  }
}
