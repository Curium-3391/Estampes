// The crash-state model shared by the power-loss simulators: what a power cut
// right after record k leaves on disk, under the POSIX contract, is each
// directory's entries as of its last fsync (none if never fsynced) and each
// file's bytes as of its last fsync (empty if never fsynced).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function durableState(events, k) {
  const dirs = new Map(), files = new Map(), acks = new Map();
  for (let i = 0; i < k; i++) {
    const e = events[i];
    if (e.t === "d") dirs.set(e.path, e.entries);
    else if (e.t === "f") files.set(e.id, e.data);
    else if (e.t === "ack") acks.set(e.key, e);
  }
  return { dirs, files, acks };
}

export async function materialize(state, from, to) {
  await mkdir(to, { mode: 0o700 });
  for (const [name, id, isDir] of state.dirs.get(from) ?? []) {
    if (isDir) await materialize(state, join(from, name), join(to, name));
    else await writeFile(join(to, name), Buffer.from(state.files.get(id) ?? "", "base64"), { mode: 0o600 });
  }
}

// A rebuilt crash state is a copy: its files get new inode numbers, which a
// real power cut keeps. One store check compares inode identity, the GC
// candidate ownership check in src/persistence/gc.js, so on a copy it would
// always fail. The checker therefore runs from a copy of the source with only
// that comparison relaxed (its content-hash check stays). The patch must apply
// exactly once, so a change to that code stops the simulator instead of
// silently testing something else. Returns the checker's root folder.
import { cp, readFile as readText, writeFile as writeText, symlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
const IDENTITY_CHECK = 'integrity(objectKey(digest)===objectKey(c.physical),"GC candidate object differs from selected ownership")';
export async function identityTolerantChecker(repo) {
  const dir = await mkdtemp(join(tmpdir(), "estampes-pl-checker-"));
  await cp(repo, dir, { recursive: true, filter: (src) => !/\/(node_modules|\.git)(\/|$)/.test(src.slice(repo.length)) });
  await symlink(join(repo, "node_modules"), join(dir, "node_modules"));
  const gc = join(dir, "src", "persistence", "gc.js"), text = await readText(gc, "utf8");
  if (text.split(IDENTITY_CHECK).length !== 2) throw new Error("The GC identity check changed; update scripts/powerloss/model.mjs");
  await writeText(gc, text.replace(IDENTITY_CHECK, "void 0"));
  return dir;
}
