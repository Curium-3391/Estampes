import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../documents/validation.js";
import { integrity, fail } from "./errors.js";

export class ReaderPins {
 constructor(files,{maxSessions=64,maxBytes=1024**3}={}){this.files=files;this.maxSessions=maxSessions;this.maxBytes=maxBytes;this.sessions=new Map();this.epoch=0;}
 get paths(){return new Set([...this.sessions.values()].flatMap(s=>[...s.files.keys()]));}
 get bytes(){const hashes=new Map();for(const s of this.sessions.values())for(const f of s.files.values())hashes.set(f.hash,f.bytes);return [...hashes.values()].reduce((a,b)=>a+b,0);}
 async acquire(snapshot,paths,now,{ttlMs=10*60*1000,kind="reader"}={}){
  if(this.sessions.size>=this.maxSessions)fail("LIMIT","Reader session budget exceeded");
  const files=new Map();for(const path of paths)files.set(path,await this.files.digest(path));
  const union=new Map();for(const s of this.sessions.values())for(const v of s.files.values())union.set(v.hash,v.bytes);for(const v of files.values())union.set(v.hash,v.bytes);
  if([...union.values()].reduce((a,b)=>a+b,0)>this.maxBytes)fail("LIMIT","Pinned physical hash union exceeds reader budget");
  const handles=new Map();try{for(const path of files.keys())handles.set(path,await open(this.files.path(path),"r"));}catch(e){for(const h of handles.values())await h.close();throw e;}
  const id=randomUUID(),session={id,snapshot:structuredClone(snapshot),files,handles,kind,expiresAt:now+ttlMs,active:0,closing:false,waiters:[]};this.sessions.set(id,session);this.epoch++;return {id,expiresAt:session.expiresAt,bytes:this.bytes};
 }
 renew(id,now,ttlMs=10*60*1000){const s=this.sessions.get(id);if(!s||s.closing)fail("STALE_CURSOR","Reader session is absent");s.expiresAt=now+ttlMs;return {id,expiresAt:s.expiresAt};}
 async read(id,now,fn){
  const s=this.sessions.get(id);if(!s||s.closing||now>s.expiresAt)fail("STALE_CURSOR","Reader lease expired; an active server read is never evicted");s.active++;
  const io={
   bytes:async(path,max=64*1024**2)=>{const h=s.handles.get(path),meta=s.files.get(path);integrity(Boolean(h)&&meta.bytes<=max,"Read escapes pinned physical closure");const buffer=Buffer.alloc(meta.bytes);let offset=0;while(offset<buffer.length){const {bytesRead}=await h.read(buffer,offset,buffer.length-offset,offset);integrity(bytesRead>0,"Truncated pinned file");offset+=bytesRead;}return buffer;},
   json:async(path,max)=>{const bytes=await io.bytes(path,max),value=JSON.parse(bytes);integrity(Buffer.from(canonicalJson(value)).equals(bytes),"Pinned JSON changed");return value;},
  };
  try{return await fn(s.snapshot,io);}finally{s.active--;if(!s.active)for(const wake of s.waiters.splice(0))wake();}
 }
 async release(id){const s=this.sessions.get(id);if(!s)return {released:false};s.closing=true;if(s.active)await new Promise(resolve=>s.waiters.push(resolve));for(const h of s.handles.values())await h.close();this.sessions.delete(id);this.epoch++;return {released:true};}
 async expire(now){for(const s of [...this.sessions.values()])if(now>s.expiresAt&&!s.active)await this.release(s.id);}
 status(){return {sessions:this.sessions.size,physicalBytes:this.bytes,epoch:this.epoch,active:[...this.sessions.values()].reduce((a,s)=>a+s.active,0)};}
}
