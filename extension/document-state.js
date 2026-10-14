// Source-side state for late joins. Only changed nodes are copied; no extra page scan.
export class DocumentState {
  constructor(){this.nodes=new Map();}
  apply(d){
    if(d.reset)this.nodes.clear();
    for(const node of d.nodes||[])this.nodes.set(node.id,node);
    for(const u of d.updates||[]){const old=this.nodes.get(u.id);if(!old)continue;const node={...old};
      for(const [field,value] of Object.entries(u.changes)){if(field==='style'||field==='attrs'){const merged={...old[field]};for(const [k,v] of Object.entries(value))if(v===null)delete merged[k];else merged[k]=v;node[field]=merged;}else node[field]=value;}
      this.nodes.set(u.id,node);
    }
    for(const id of d.removes||[])this.nodes.delete(id);
    this.meta=d.meta;this.version=d.version;this.sequence=d.sequence;this.root=d.root;if(d.reset||d.css)this.css=d.css;
  }
  snapshot(){return this.version?{reset:true,version:this.version,sequence:this.sequence,root:this.root,meta:this.meta,css:this.css||'',nodes:[...this.nodes.values()],updates:[],removes:[]}:null;}
}
