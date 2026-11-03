import { open, lstat, mkdir, rename, readFile, readdir, statfs, unlink } from "node:fs/promises";
import { join, dirname, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../documents/validation.js";
import { fail, integrity } from "./errors.js";
import { registerTemporary, temporaryClaimPath } from "./temporary-attribution.js";
import { constants } from "node:fs";

export const physicalFingerprint=info=>[info.dev,info.ino,info.bytes,info.mtimeNs,info.ctimeNs].join(":");
const physicalInfo=st=>({bytes:Number(st.size),allocatedBytes:Number(st.blocks*512n),dev:String(st.dev),ino:String(st.ino),mtimeNs:String(st.mtimeNs),ctimeNs:String(st.ctimeNs)});

export class ManagedFiles {
  constructor(root, observer = async () => {}) { this.root=root;this.observer=observer;this.fault=null;this.trace=[]; }
  // A verification operation owns its observations. They are never recovered
  // from disk or inferred from a later stat of bytes read earlier.
  observation(){const io=Object.create(this);io.observations=new Map();return io;}
  observed(name,info){
    if(!this.observations)return;
    const value=physicalFingerprint(info),prior=this.observations.get(name);
    integrity(!prior||prior===value,"Managed file changed within verification");this.observations.set(name,value);
  }
  async proofFingerprint(name){
    if(!this.observations){const io=this.observation();await io.bytes(name);return io.proofFingerprint(name);}
    const expected=this.observations.get(name);
    integrity(Boolean(expected)&&physicalFingerprint(await this.info(name))===expected,"Verified bytes no longer match managed file identity");return expected;
  }
  async verifyObservations(){for(const path of this.observations?.keys()??[])await this.proofFingerprint(path);}
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
    const before=await this.info(name),fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const opened=await fd.stat({bigint:true});
      integrity(opened.isFile()&&physicalFingerprint(physicalInfo(opened))===physicalFingerprint(before),"Managed path changed before open");
      const bytes=await fd.readFile();
      const after=physicalInfo(await fd.stat({bigint:true})),selected=await this.info(name);
      integrity(bytes.length<=maxBytes&&bytes.length===before.bytes&&physicalFingerprint(before)===physicalFingerprint(after)&&physicalFingerprint(after)===physicalFingerprint(selected),"Managed file changed during read");
      this.observed(name,after);return bytes;
    }finally{await fd.close();}
  }
  async json(name,maxBytes) {
    const bytes=await this.bytes(name,maxBytes);let value;
    try{value=JSON.parse(bytes);}catch{fail("INTEGRITY_ERROR","Malformed managed JSON");}
    integrity(Buffer.from(canonicalJson(value)).equals(bytes),"Non-canonical managed JSON");return value;
  }
  async exists(name){try{await lstat(this.path(name));return true;}catch(e){if(e.code==="ENOENT")return false;throw e;}}
  async durableCreate(name,bytes,label){
    await this.ensureDirectory(dirname(name));await this.point(label+".before-write",{path:name});const fd=await open(this.path(name),"wx",0o600);
    try{await fd.writeFile(bytes);await this.point(label+".before-file-fsync",{path:name});try{await fd.sync();}catch(e){e.barrier=true;throw e;}await this.point(label+".after-file-fsync",{path:name});}
    finally{await fd.close();}await this.syncDirectory(dirname(this.path(name)),label);
  }
  async atomic(name,bytes,label,{immutable=false,owner}={}) {
    await this.ensureDirectory(dirname(name));
    if(immutable&&await this.exists(name)){
      if(!(await this.bytes(name)).equals(bytes))fail("INTEGRITY_ERROR","Immutable file collision or corruption",{storageIntegrity:true});
      // A matching file may be an orphan whose rename was never flushed.
      // Reusing its bytes never substitutes for the file + directory barriers.
      await this.resync(name,label);return;
    }
    const claim=await registerTemporary(this,name,bytes,label,owner),temporary=claim.temporaryPath,target=this.path(name);
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
    await this.remove(temporaryClaimPath(claim.claimId),"temporary-claim");
  }
  async resync(name,label="recovery") {
    const fd=await open(this.path(name),"r");try{await this.point(label+".before-file-fsync",{path:name});try{await fd.sync();}catch(e){e.barrier=true;throw e;}await this.point(label+".after-file-fsync",{path:name});}finally{await fd.close();}
    await this.syncDirectory(dirname(this.path(name)),label);
  }
  async info(name){
    const path=this.path(name),st=await lstat(path,{bigint:true});if(st.dev!==(await lstat(this.root,{bigint:true})).dev)fail("UNSUPPORTED_STORAGE","Physical entry crosses managed device");integrity(st.isFile()&&!st.isSymbolicLink(),"Managed physical entry is not a regular file");
    let dir=dirname(path);while(dir!==this.root){const p=await lstat(dir);integrity(p.isDirectory()&&!p.isSymbolicLink(),"Unsafe physical parent");dir=dirname(dir);}
    return physicalInfo(st);
  }
  async digest(name){
    const info=await this.info(name),fd=await open(this.path(name),constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash("sha256"),buffer=Buffer.alloc(4*1024*1024);let offset=0;
    try{
      integrity(physicalFingerprint(physicalInfo(await fd.stat({bigint:true})))===physicalFingerprint(info),"Physical file replaced before hash verification");
      for(;;){const {bytesRead}=await fd.read(buffer,0,buffer.length,offset);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
      integrity(offset===info.bytes&&physicalFingerprint(physicalInfo(await fd.stat({bigint:true})))===physicalFingerprint(info)&&physicalFingerprint(await this.info(name))===physicalFingerprint(info),"Physical file changed during hash verification");
      return {...info,hash:hash.digest("hex")};
    }finally{await fd.close();}
  }
  async usage(){
    const inodes=new Set();let logicalBytes=0,allocatedBytes=0,files=0;
    const walk=async dir=>{const entries=await readdir(dir,{withFileTypes:true});for(const e of entries){
      const p=join(dir,e.name),st=await lstat(p);integrity(!st.isSymbolicLink()&&(st.isFile()||st.isDirectory()),"Unsafe managed usage entry");
      const key=st.dev+":"+st.ino;if(!inodes.has(key)){allocatedBytes+=st.blocks*512;inodes.add(key);}
      if(st.isDirectory())await walk(p);else{logicalBytes+=st.size;files++;}
    }};await walk(this.root);return {logicalBytes,allocatedBytes,files};
  }
  async usedBytes(){return (await this.usage()).allocatedBytes;}
  async move(from,to,label="gc"){
    await this.info(from);await this.ensureDirectory(dirname(to));await this.point(label+".before-rename",{from,to});
    try{await rename(this.path(from),this.path(to));}catch(e){e.barrier=true;throw e;}
    await this.point(label+".after-rename",{from,to});await this.syncDirectory(dirname(this.path(from)),label);await this.syncDirectory(dirname(this.path(to)),label);
  }
  async remove(name,label="gc"){
    await this.point(label+".before-unlink",{path:name});try{await unlink(this.path(name));}catch(e){if(e.code!=="ENOENT")throw e;}
    await this.point(label+".after-unlink",{path:name});await this.syncDirectory(dirname(this.path(name)),label);
  }
  async preflight(bytes,quota,reserve) {
    const used=await this.usedBytes(), fs=await statfs(this.root,{bigint:true}), available=fs.bavail*fs.bsize;
    if(used+bytes+reserve>quota || available<BigInt(bytes+reserve))fail("STORAGE_UNAVAILABLE","Insufficient isolated store quota or free space",{used,required:bytes,reserve,quota});
  }
}
export class StagingPlan {
  constructor(files){this.files=files;this.records=new Map();this.bytes=0;}
  addBytes(name,bytes,label="staged"){
    if(this.records.has(name))integrity(this.records.get(name).bytes.equals(bytes),"Conflicting staged bytes");
    else{this.records.set(name,{bytes:Buffer.from(bytes),label});this.bytes+=bytes.length;}return name;
  }
  add(name,value,limit=4*1024*1024,label="staged") {
    const bytes=Buffer.from(canonicalJson(value));if(bytes.length>limit)fail("LIMIT","Immutable record exceeds byte limit");
    if(this.records.has(name))integrity(this.records.get(name).bytes.equals(bytes),"Conflicting staged immutable path");
    else{this.records.set(name,{bytes,label});this.bytes+=bytes.length;}return name;
  }
  blob(value,{folder="visual-registry/pages",limit=4*1024*1024,label="staged"}={}) {
    const hash=createHash("sha256").update(canonicalJson(value)).digest("hex");this.add(folder+"/"+hash+".json",value,limit,label);return hash;
  }
  async json(name,maxBytes){return this.records.has(name)?JSON.parse(this.records.get(name).bytes):this.files.json(name,maxBytes);}
  allocationEstimate(){const dirs=new Set();let bytes=0;for(const [path,record]of this.records){bytes+=Math.ceil(record.bytes.length/4096)*4096;let dir=dirname(path);while(dir!=="."){dirs.add(dir);dir=dirname(dir);}}return bytes+dirs.size*4096;}
  async flush(include=()=>true,owner){for(const [path,record]of this.records)if(include(record))await this.files.atomic(path,record.bytes,record.label,{immutable:true,owner});}
}
