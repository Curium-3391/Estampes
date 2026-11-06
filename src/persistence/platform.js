// Deployment configuration, never a request-supplied durability upgrade.
import { statfs, lstat, realpath, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fail } from "./errors.js";
export async function inspectPlatform(directory, profile, purpose) {
  if (process.platform !== "linux" || purpose !== "isolated-pr1c-testing") fail("UNSUPPORTED_STORAGE", "Only an explicit isolated Linux test store is enabled in PR-1C");
  if (!["linux-local-durable", "linux-process-crash-test"].includes(profile)) fail("UNSUPPORTED_STORAGE", "Unknown storage profile");
  const path = resolve(directory), st = await lstat(path), actual = await realpath(path);
  if (actual !== path || !st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid() || !basename(path).startsWith("estampes-pr1c-")) {
    fail("UNSUPPORTED_STORAGE", "An owned 0700 disposable estampes-pr1c-* directory without symlinks is required");
  }
  const fs = await statfs(path, { bigint: true });
  const type = Number(BigInt.asUintN(32, fs.type));
  const supported = [0xef53, 0x58465342].includes(type); // ext4-family magic or XFS; exact mount evidence is still required.
  if (profile === "linux-local-durable" && !supported) fail("UNSUPPORTED_STORAGE", "Durable profile requires an approved local ext4/XFS mount", { fsType: "0x" + type.toString(16) });
  if (profile === "linux-local-durable") {
    // Magic alone cannot distinguish ext2/3 or a Docker/Desktop backing driver.
    // No caller can substitute an attestation for this exact mount check.
    const { readFile } = await import("node:fs/promises");
    const mounts = (await readFile("/proc/self/mountinfo", "utf8")).trim().split("\n").map(line => {
      const [left,right] = line.split(" - ");
      return { mount: left.split(" ")[4].replace(/\\([0-7]{3})/g,(_,n)=>String.fromCharCode(parseInt(n,8))), type: right.split(" ")[0] };
    }).filter(m => path === m.mount || path.startsWith(m.mount === "/" ? "/" : m.mount + "/")).sort((a,b)=>b.mount.length-a.mount.length);
    if (!["ext4","xfs"].includes(mounts[0]?.type)) fail("UNSUPPORTED_STORAGE", "Mount type is not allowlisted");
  }
  const names=await readdir(path);
  if (names.length && !names.includes("storage-format.json") && names.some(n=>n!=="WRITER.lock")) fail("UNSUPPORTED_STORAGE", "Refusing an unrecognized or interrupted uninitialized directory");
  return { platform:"linux", profile, fsType:"0x"+type.toString(16), device:st.dev,
    durability: profile === "linux-local-durable" ? "durable" : "process-crash-test", purpose };
}

export async function assertOwnedWriterLease(directory) {
  const { readFile }=await import("node:fs/promises");
  const st=await lstat(resolve(directory,"WRITER.lock"));
  if(!st.isFile()||st.isSymbolicLink())fail("UNSUPPORTED_STORAGE","Invalid writer lease inode");
  for(const fd of await readdir("/proc/self/fdinfo")){
    let info;try{info=await readFile("/proc/self/fdinfo/"+fd,"utf8");}catch(e){if(e.code==="ENOENT")continue;throw e;}
    const lock=info.match(/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+\S+:(\d+)\s+/m);
    if(lock&&Number(lock[1])===process.pid&&BigInt(lock[2])===BigInt(st.ino))return;
  }
  fail("UNSUPPORTED_STORAGE","Writer does not own an inherited exclusive OS flock lease");
}
