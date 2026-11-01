import { z } from "zod";
import { hashJson, parse, ContentHashSchema, canonicalJson } from "../documents/validation.js";
import { integrity, fail } from "./errors.js";
const kindSchema=z.enum(["registry","locator","ledger","commitIndex","retention","authority"]);
const rootSchema=z.object({schema:z.literal("estampes.index-root/1"),kind:kindSchema,
  buckets:z.record(z.string().regex(/^[0-9a-f]{2}$/),ContentHashSchema)}).strict();
const pageSchema=z.object({schema:z.literal("estampes.index-page/1"),kind:kindSchema,bucket:z.string().regex(/^[0-9a-f]{2}$/),
  entries:z.array(z.object({key:z.string().min(1).max(512),value:z.unknown()}).strict()).min(1),next:ContentHashSchema.nullable()}).strict();
export const pagePath=hash=>"visual-registry/pages/"+parse(ContentHashSchema,hash)+".json";
const bucketOf=key=>hashJson(key).slice(0,2);
export class PageStore {
  constructor(io,plan=null,track=new Set()){this.io=io;this.plan=plan;this.track=track;this.cache=new Map();}
  async hashed(hash,folder="visual-registry/pages",limit=4*1024*1024){
    parse(ContentHashSchema,hash);const path=folder+"/"+hash+".json";this.track.add(path);
    if(this.cache.has(path))return this.cache.get(path);
    try {
      const value=await (this.plan??this.io).json(path,limit);integrity(hashJson(value)===hash,"Content-addressed metadata hash mismatch");this.cache.set(path,value);return value;
    }catch(e){fail("INTEGRITY_ERROR","Content-addressed metadata cannot be verified",{storageIntegrity:true,cause:e.code??"IO_ERROR"});}
  }
  async read(hash,kind){
    if(!hash)return new Map();const root=parse(rootSchema,await this.hashed(hash));integrity(root.kind===kind,"Index kind mismatch");
    const entries=new Map();
    for(const [bucket,first]of Object.entries(root.buckets)){
      const seen=new Set();let next=first,previous="";
      while(next){integrity(!seen.has(next),"Cyclic index page chain");seen.add(next);
        const page=parse(pageSchema,await this.hashed(next));integrity(page.kind===kind&&page.bucket===bucket,"Index page belongs to another partition");
        for(const e of page.entries){integrity(e.key>previous&&bucketOf(e.key)===bucket&&!entries.has(e.key),"Unsorted, duplicate or misbucketed index key");entries.set(e.key,e.value);previous=e.key;}
        if(entries.size>100000||seen.size>4096)fail("LIMIT","Isolated index entry/page limit exceeded");next=page.next;
      }
    }return entries;
  }
  async update(hash,kind,changes){
    integrity(Boolean(this.plan),"A staging plan is required for index updates");
    const old=hash?parse(rootSchema,await this.hashed(hash)):{schema:"estampes.index-root/1",kind,buckets:{}};
    integrity(old.kind===kind,"Index update kind mismatch");const root=structuredClone(old),all=await this.read(hash,kind),touched=new Set();
    for(const [key,value]of changes){if(value===undefined)all.delete(key);else all.set(key,value);touched.add(bucketOf(key));}
    if(all.size>100000)fail("LIMIT","Isolated index entry limit exceeded before publication");
    if(!hash&&changes.size===0)return this.plan.blob(root);
    for(const bucket of touched){
      const entries=[...all].filter(([key])=>bucketOf(key)===bucket).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>({key,value}));
      const chunks=[];let chunk=[],bytes=160;
      for(const e of entries){const size=Buffer.byteLength(canonicalJson(e))+1;if(size+160>4*1024*1024)fail("LIMIT","Single index value exceeds page budget");
        if(bytes+size>4*1024*1024){chunks.push(chunk);chunk=[];bytes=160;}chunk.push(e);bytes+=size;}
      if(chunk.length)chunks.push(chunk);let next=null;
      for(const list of chunks.reverse())next=this.plan.blob({schema:"estampes.index-page/1",kind,bucket,entries:list,next});
      if(next===null)delete root.buckets[bucket];else root.buckets[bucket]=next;
    }return this.plan.blob(root);
  }
}
