import { open, lstat, mkdir, rename, readFile, readdir, statfs, unlink, link } from "node:fs/promises";
import { join, dirname, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../documents/validation.js";
import { fail, integrity } from "./errors.js";
import { registerTemporary, temporaryClaimPath } from "./temporary-attribution.js";
import { constants } from "node:fs";
import { privateDirectory, privateFile, privateAncestry } from "./ownership.js";

export const physicalFingerprint=info=>[info.dev,info.ino,info.bytes,info.mtimeNs,info.ctimeNs].join(":");
const physicalInfo=st=>({bytes:Number(st.size),allocatedBytes:Number(st.blocks*512n),dev:String(st.dev),ino:String(st.ino),mtimeNs:String(st.mtimeNs),ctimeNs:String(st.ctimeNs)});

// A transaction folder whose outcome is written never changes again (its three
// records are immutable); only compaction removes them, through remove().
const SETTLED_FOLDER=/^visual-transactions\/[0-9a-f-]{36}$/, SETTLED_RECORD=/^(?:intent|prepared|outcome)\.json$/;
const IMMUTABLE_RECORD=/^(?:visual-registry\/(?:pages|roots)\/[0-9a-f]{64}\.json|visual-history\/(?:chunks\/[0-9a-f]{64}\.bin|deltas\/[0-9a-f]{64}\.json)|visual-documents\/[0-9a-f-]{36}\/generations\/[1-9][0-9]*-[0-9a-f]{64}\.json|visual-transactions\/[0-9a-f-]{36}\/(?:intent|prepared|outcome)\.json)$/;
export class ManagedFiles {
  // pageProofs outlives single verifications (observations inherit it): a
  // content-addressed page that was verified once and whose physical fingerprint
  // is unchanged is reused instead of being read and hashed again.
  constructor(root, observer = async () => {}) { this.root=root;this.observer=observer;this.fault=null;this.trace=[];this.pageProofs={entries:new Map(),bytes:0}; }
  // A verification operation owns its observations. They are never recovered
  // from disk or inferred from a later stat of bytes read earlier.
  observation(){const io=Object.create(this);io.observations=new Map();io.contentProofs=new Map();io.checkedFingerprints=new Set();io.jsonIdentities=new WeakMap();io.metadataCache={records:new Map(),bytes:0};io.fingerprintChecks=0;io.contentHashChecks=0;return io;}
  async auditBoundary(){this.trust=await privateAncestry(this.root);return this.trust;}
  validateEntry(st){if(st.isDirectory())privateDirectory(st);else privateFile(st);}
  async checkFingerprint(name,expected){
    if(!expected?.hash)return false;
    let value=this.contentProofs?.get(name),fingerprint=this.observations?.get(name);
    // Not yet observed in this verification: under the trust model an unchanged
    // physical fingerprint proves the content hashed when the proof was made, so
    // a cached proof costs one stat instead of re-reading and hashing the file.
    if(!value){const info=await this.info(name);fingerprint=physicalFingerprint(info);
      if(fingerprint===expected.fingerprint&&info.bytes===expected.contentBytes){this.observed(name,info,expected.hash);return true;}
      const digest=await this.digest(name);value={hash:digest.hash,contentBytes:digest.bytes};fingerprint=physicalFingerprint(digest);}
    return fingerprint===expected.fingerprint&&value.hash===expected.hash&&value.contentBytes===expected.contentBytes;
  }
  observed(name,info,hash){
    if(!this.observations)return;
    const value=physicalFingerprint(info),prior=this.observations.get(name);
    const content=this.contentProofs.get(name);
    if((prior&&prior!==value)||(content&&hash&&(content.hash!==hash||content.contentBytes!==info.bytes)))fail("INTEGRITY_ERROR","Managed file changed within verification",{storageIntegrity:true});this.observations.set(name,value);
    if(hash)this.contentProofs.set(name,{hash,contentBytes:info.bytes});
  }
  async proofIdentity(name){
    if(!this.observations){const io=this.observation();await io.bytes(name);return io.proofIdentity(name);}
    const expected=this.observations.get(name);
    if(!this.checkedFingerprints.has(name)){
      this.fingerprintChecks++;const content=this.contentProofs.get(name),actual=await this.info(name);
      if(!content||physicalFingerprint(actual)!==expected||actual.bytes!==content.contentBytes)fail("INTEGRITY_ERROR","Verified content proof changed",{storageIntegrity:true});this.checkedFingerprints.add(name);
    }
    const content=this.contentProofs.get(name);
    if(!expected||!content)fail("INTEGRITY_ERROR","Missing verified content observation",{storageIntegrity:true});return {fingerprint:expected,...content};
  }
  async proofFingerprint(name){return (await this.proofIdentity(name)).fingerprint;}
  // Content was hashed when it was first observed. Under the filesystem trust
  // model (private tree, trusted UID, PR-1D-FILESYSTEM-TRUST-MODEL.md) any later
  // write changes the inode's mtime and ctime, which an unprivileged process
  // cannot set back, so an unchanged physical fingerprint (device, inode, size,
  // mtime, ctime) proves unchanged content. Re-hashing every dependency, three
  // times per commit, made each commit cost O(all index and history files).
  async verifyObservations(){for(const [path,fingerprint]of this.observations??[]){
    this.fingerprintChecks++;const expected=this.contentProofs.get(path),actual=await this.info(path);
    if(!expected||physicalFingerprint(actual)!==fingerprint||actual.bytes!==expected.contentBytes)fail("INTEGRITY_ERROR","Verified dependency changed before publication or ACK",{storageIntegrity:true});
  }}
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
    privateDirectory(await lstat(this.root));
    if(name===".")return;
    const path=this.path(name), parts=relative(this.root,path).split("/");let current=this.root;
    for(const part of parts){const parent=current;current=join(current,part);let made=false;
      try{await mkdir(current,{mode:0o700});made=true;}catch(e){if(e.code!=="EEXIST")throw e;}
      const st=await lstat(current);privateDirectory(st);
      if(st.dev!==(await lstat(this.root)).dev)fail("UNSUPPORTED_STORAGE","Managed tree crosses filesystem devices");
      if(made)await this.syncDirectory(parent,"mkdir");
    }
  }
  async bytes(name,maxBytes=64*1024*1024) {
    const path=this.path(name), st=await lstat(path);privateFile(st);integrity(st.size<=maxBytes,"Invalid managed file or byte limit");
    if(st.dev!==(await lstat(this.root)).dev)fail("UNSUPPORTED_STORAGE","Managed file crosses filesystem devices");
    // All path components were created under the private store; recheck against symlink substitution.
    let dir=dirname(path);while(dir!==this.root){privateDirectory(await lstat(dir));dir=dirname(dir);}
    const before=await this.info(name),fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const opened=await fd.stat({bigint:true});
      privateFile(opened);integrity(Number(opened.size)<=maxBytes,"Opened managed file exceeds byte limit");
      integrity(opened.isFile()&&physicalFingerprint(physicalInfo(opened))===physicalFingerprint(before),"Managed path changed before open");
      const bytes=await fd.readFile();
      const after=physicalInfo(await fd.stat({bigint:true})),selected=await this.info(name);
      integrity(bytes.length<=maxBytes&&bytes.length===before.bytes&&physicalFingerprint(before)===physicalFingerprint(after)&&physicalFingerprint(after)===physicalFingerprint(selected),"Managed file changed during read");
      this.observed(name,after,createHash("sha256").update(bytes).digest("hex"));return bytes;
    }finally{await fd.close();}
  }
  async json(name,maxBytes) {
    const bytes=await this.bytes(name,maxBytes);let value;
    try{value=JSON.parse(bytes);}catch{fail("INTEGRITY_ERROR","Malformed managed JSON");}
    integrity(Buffer.from(canonicalJson(value)).equals(bytes),"Non-canonical managed JSON");
    if(value&&typeof value==="object")this.jsonIdentities?.set(value,{hash:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length});return value;
  }
  async exists(name){try{await lstat(this.path(name));return true;}catch(e){if(e.code==="ENOENT")return false;throw e;}}
  // Create a file that is either absent or complete: write and fsync a .partial
  // name, then link it into place (link, unlike rename, refuses to replace) and
  // drop the partial name. Recovery removes partials it finds.
  async durableCreate(name,bytes,label){
    await this.ensureDirectory(dirname(name));await this.point(label+".before-write",{path:name});
    const partial=name+".partial",fd=await open(this.path(partial),"wx",0o600);
    try{await fd.writeFile(bytes);await this.point(label+".before-file-fsync",{path:name});try{await fd.sync();}catch(e){e.barrier=true;throw e;}await this.point(label+".after-file-fsync",{path:name});}
    finally{await fd.close();}
    try{await link(this.path(partial),this.path(name));}catch(e){e.barrier=true;throw e;}
    await unlink(this.path(partial));await this.syncDirectory(dirname(this.path(name)),label);
  }
  async atomic(name,bytes,label,{immutable=false,owner,beforeRename}={}) {
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
    if(beforeRename)await beforeRename();
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
    const path=this.path(name),st=await lstat(path,{bigint:true}),root=await lstat(this.root,{bigint:true});privateDirectory(root);privateFile(st);if(st.dev!==root.dev)fail("UNSUPPORTED_STORAGE","Physical entry crosses managed device");
    let dir=dirname(path);while(dir!==this.root){privateDirectory(await lstat(dir));dir=dirname(dir);}
    return physicalInfo(st);
  }
  async digest(name){
    const info=await this.info(name),fd=await open(this.path(name),constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash("sha256"),buffer=Buffer.alloc(Math.max(1,Math.min(info.bytes,4*1024*1024)));let offset=0;
    try{
      integrity(physicalFingerprint(physicalInfo(await fd.stat({bigint:true})))===physicalFingerprint(info),"Physical file replaced before hash verification");
      while(offset<info.bytes){const {bytesRead}=await fd.read(buffer,0,Math.min(buffer.length,info.bytes-offset),offset);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
      const tail=await fd.read(buffer,0,1,offset);integrity(tail.bytesRead===0,"Physical file grew during hash verification");
      integrity(offset===info.bytes&&physicalFingerprint(physicalInfo(await fd.stat({bigint:true})))===physicalFingerprint(info)&&physicalFingerprint(await this.info(name))===physicalFingerprint(info),"Physical file changed during hash verification");
      const value={...info,hash:hash.digest("hex")};this.contentHashChecks=(this.contentHashChecks??0)+1;this.observed(name,info,value.hash);return value;
    }finally{await fd.close();}
  }
  // Every entry is listed on each call, so new, removed and mutable files are
  // always measured. Content-addressed records are written once by atomic
  // rename and never modified in place, so their lstat is reused while the
  // name stays listed: admission no longer costs one lstat per history file.
  async usage(){
    const inodes=new Set(),seen=new Set(),cache=this.usageCache??=new Map(),settled=this.usageSettled??=new Map();let logicalBytes=0,allocatedBytes=0,files=0;
    const count=st=>{if(!inodes.has(st.key)){allocatedBytes+=st.blocks;inodes.add(st.key);}};
    const measure=async path=>{const s=await lstat(path);integrity(!s.isSymbolicLink()&&(s.isFile()||s.isDirectory()),"Unsafe managed usage entry");return {directory:s.isDirectory(),key:s.dev+":"+s.ino,blocks:s.blocks*512,size:s.size};};
    const walk=async(dir,rel)=>{const entries=await readdir(dir,{withFileTypes:true});for(const e of entries){
      integrity(!e.isSymbolicLink()&&(e.isFile()||e.isDirectory()),"Unsafe managed usage entry");
      const name=rel?rel+"/"+e.name:e.name,p=join(dir,e.name);
      if(e.isDirectory()&&SETTLED_FOLDER.test(name)){
        // A transaction folder with an outcome is listed once; later calls reuse
        // its totals while its name stays listed (remove() forgets it).
        seen.add(name);let known=settled.get(name);
        if(!known){
          const folder=await measure(p),members=[];
          for(const member of await readdir(p)){const st=await measure(join(p,member));integrity(!st.directory,"Unsafe managed usage entry");members.push({name:member,...st});}
          known={folder,files:members,final:members.some(m=>m.name==="outcome.json")&&members.every(m=>SETTLED_RECORD.test(m.name))};
          if(known.final)settled.set(name,known);
        }
        count(known.folder);for(const m of known.files){count(m);logicalBytes+=m.size;files++;}
        continue;
      }
      const immutable=e.isFile()&&IMMUTABLE_RECORD.test(name);let st=immutable?cache.get(name):null;
      if(!st){st=await measure(p);if(immutable&&!st.directory)cache.set(name,st);}
      seen.add(name);count(st);
      if(st.directory)await walk(p,name);else{logicalBytes+=st.size;files++;}
    }};await walk(this.root,"");
    for(const name of cache.keys())if(!seen.has(name))cache.delete(name);
    for(const name of settled.keys())if(!seen.has(name))settled.delete(name);
    return {logicalBytes,allocatedBytes,files};
  }
  async usedBytes(){return (await this.usage()).allocatedBytes;}
  async move(from,to,label="gc"){
    await this.info(from);await this.ensureDirectory(dirname(to));await this.point(label+".before-rename",{from,to});
    try{await rename(this.path(from),this.path(to));}catch(e){e.barrier=true;throw e;}
    await this.point(label+".after-rename",{from,to});await this.syncDirectory(dirname(this.path(from)),label);await this.syncDirectory(dirname(this.path(to)),label);
  }
  async remove(name,label="gc",{allowMissing=true,expected}={}){
    await this.point(label+".before-unlink",{path:name});
    if(expected){const actual=await this.digest(name);if(physicalFingerprint(actual)!==physicalFingerprint(expected)||actual.hash!==expected.hash)fail("INTEGRITY_ERROR","Authorized unlink object was replaced or modified",{storageIntegrity:true});}
    this.usageSettled?.delete(dirname(name));
    try{await unlink(this.path(name));}catch(e){if(e.code!=="ENOENT"||!allowMissing)throw e;}
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
