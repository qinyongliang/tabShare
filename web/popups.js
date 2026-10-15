export class PopupWindows {
  constructor(doc,open=url=>doc.defaultView.open(url,'_blank')){this.doc=doc;this.open=open;this.seen=new Set();}
  receive(popup){
    if(!popup||!/^[A-Za-z0-9_-]{8,80}$/.test(popup.id)||this.seen.has(popup.id))return;
    let url;try{url=new URL(popup.shareUrl,this.doc.location.href);}catch{return;}
    if(url.origin!==this.doc.location.origin||url.pathname!=='/s/'+popup.id||!/^#[A-Za-z0-9_-]{32,80}$/.test(url.hash))return;
    this.seen.add(popup.id);url.searchParams.set('popup','1');
    const link=this.doc.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener';link.textContent=popup.title||'新页面';
    const row=this.doc.createElement('p');row.append(link);const list=this.doc.querySelector('#shared-pages');list.append(row);while(list.childElementCount>32)list.firstElementChild.remove();
    // Remote notifications are asynchronous. A browser may require the user to
    // allow popups; keep a native link available when it blocks the new window.
    try{if(!this.open(url.href)){row.prepend('浏览器阻止了新标签页：');this.doc.querySelector('#share-settings').hidden=false;}}catch{row.prepend('打开新标签页：');this.doc.querySelector('#share-settings').hidden=false;}
  }
}
