import { open, lstat, mkdir, rename, readFile, readdir, statfs } from "node:fs/promises";
import { join, dirname, resolve, relative } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { canonicalJson } from "../documents/validation.js";
import { fail, integrity } from "./errors.js";

export class ManagedFiles {
  constructor(root, observer = async () => {}) { this.root=root;this.observer=observer;this.fault=null;this.trace=[]; }
  path(name) {
    const p=resolve(this.root,name);
    if (!name || p===this.root || relative(this.root,p).startsWith("..") || name.includes("\\")) fail("INTEGRITY_ERROR","Unsafe managed path");
    return p;
  }
  async point(name, details={}) {
    this.trace.push(name);if(this.trace.length>4096)this.trace.shift();
    if(this.fault?.point!==name)return;
    if(--this.fault.nth>0)return;
    const fault=this.fault;this.fault=null;
    await this.observer(name,details);
    if(fault.mode==="pause")await new Promise(()=>{});
    const e=new Error("Injected filesystem failure at "+name);e.code=fault.code??"EIO";e.barrier=/fsync|rename/.test(name);throw e;
  }
  arm(fault) { this.fault=fault ? { ...fault,nth:fault.nth??1 } : null; }
  async syncDirectory(path,label) {
    await this.point(label+".before-dir-fsync");
    const fd=await open(path,"r");
    try { await fd.sync(); } catch(e) {e.barrier=true;throw e;} finally {await fd.close();}
    await this.point(label+".after-dir-fsync");
  }
  async ensureDirectory(name) {
    if(name===".")return;
    const path=this.path(name), parts=relative(this.root,path).split("/");let current=this.root;
    for(const part of parts){const parent=current;current=join(current,part);let made=false;
      try{await mkdir(current,{mode:0o700});made=true;}catch(e){if(e.code!=="EEXIST")throw e;}
      const st=await lstat(current);integrity(st.isDirectory()&&!st.isSymbolicLink(),"Managed directory is not a regular directory");
      if(st.dev!==(await lstat(this.root)).dev)fail("UNSUPPORTED_STORAGE","Managed tree crosses filesystem devices");
      if(made)await this.syncDirectory(parent,"mkdir");
    }
  }
  async bytes(name,maxBytes=64*1024*1024) {
    const path=this.path(name), st=await lstat(path);integrity(st.isFile()&&!st.isSymbolicLink()&&st.size<=maxBytes,"Invalid managed file or byte limit");
    if(st.dev!==(await lstat(this.root)).dev)fail("UNSUPPORTED_STORAGE","Managed file crosses filesystem devices");
    // All path components were created under the private store; recheck against symlink substitution.
    let dir=dirname(path);while(dir!==this.root){const s=await lstat(dir);integrity(s.isDirectory()&&!s.isSymbolicLink(),"Symlink in managed path");dir=dirname(dir);}
    return readFile(path);
  }
  async json(name,maxBytes) {
    const bytes=await this.bytes(name,maxBytes);let value;
    try{value=JSON.parse(bytes);}catch{fail("INTEGRITY_ERROR","Malformed managed JSON");}
    integrity(Buffer.from(canonicalJson(value)).equals(bytes),"Non-canonical managed JSON");return value;
  }
  async exists(name){try{await lstat(this.path(name));return true;}catch(e){if(e.code==="ENOENT")return false;throw e;}}
  async atomic(name,bytes,label,{immutable=false}={}) {
    await this.ensureDirectory(dirname(name));
    if(immutable&&await this.exists(name)){
      if(!(await this.bytes(name)).equals(bytes))fail("INTEGRITY_ERROR","Immutable file collision or corruption",{storageIntegrity:true});
      // A matching file may be an orphan whose rename was never flushed.
      // Reusing its bytes never substitutes for the file + directory barriers.
      await this.resync(name,label);return;
    }
    const temporary=name+".tmp-"+randomUUID(), target=this.path(name);
    await this.point(label+".before-write",{path:name});
    const fd=await open(this.path(temporary),"wx",0o600);
    try{await fd.writeFile(bytes);await this.point(label+".before-file-fsync",{path:name});
      try{await fd.sync();}catch(e){e.barrier=true;throw e;}
      await this.point(label+".after-file-fsync",{path:name});
    }finally{await fd.close();}
    await this.point(label+".before-rename",{path:name});
    try{await rename(this.path(temporary),target);}catch(e){e.barrier=true;throw e;}
    await this.point(label+".after-rename",{path:name});
    await this.syncDirectory(dirname(target),label);
  }
  async resync(name,label="recovery") {
    const fd=await open(this.path(name),"r");try{await this.point(label+".before-file-fsync",{path:name});try{await fd.sync();}catch(e){e.barrier=true;throw e;}await this.point(label+".after-file-fsync",{path:name});}finally{await fd.close();}
    await this.syncDirectory(dirname(this.path(name)),label);
  }
  async usedBytes() {
    const walk=async dir=>{let bytes=0;for(const e of await readdir(dir,{withFileTypes:true})){
      const p=join(dir,e.name);if(e.isDirectory())bytes+=await walk(p);else{const st=await lstat(p);integrity(st.isFile()&&!st.isSymbolicLink(),"Unexpected managed entry");bytes+=st.size;}
    }return bytes;};return walk(this.root);
  }
  async preflight(bytes,quota,reserve) {
    const used=await this.usedBytes(), fs=await statfs(this.root,{bigint:true}), available=fs.bavail*fs.bsize;
    if(used+bytes+reserve>quota || available<BigInt(bytes+reserve))fail("STORAGE_UNAVAILABLE","Insufficient isolated store quota or free space",{used,required:bytes,reserve,quota});
  }
}
export class StagingPlan {
  constructor(files){this.files=files;this.records=new Map();this.bytes=0;}
  add(name,value,limit=4*1024*1024,label="staged") {
    const bytes=Buffer.from(canonicalJson(value));if(bytes.length>limit)fail("LIMIT","Immutable record exceeds byte limit");
    if(this.records.has(name))integrity(this.records.get(name).bytes.equals(bytes),"Conflicting staged immutable path");
    else{this.records.set(name,{bytes,label});this.bytes+=bytes.length;}return name;
  }
  blob(value,{folder="visual-registry/pages",limit=4*1024*1024,label="staged"}={}) {
    const hash=createHash("sha256").update(canonicalJson(value)).digest("hex");this.add(folder+"/"+hash+".json",value,limit,label);return hash;
  }
  async json(name,maxBytes){return this.records.has(name)?JSON.parse(this.records.get(name).bytes):this.files.json(name,maxBytes);}
  async flush(include=()=>true){for(const [path,record]of this.records)if(include(record))await this.files.atomic(path,record.bytes,record.label,{immutable:true});}
}
