// Long-running module work. A capability marked `async` returns at once with
// a job; the work runs in the background and its result is applied to the
// canvas when it finishes. Jobs are remembered in <storage>/modules/jobs.json
// (without results beyond a short summary); a job that was still running when
// the server stopped is shown as interrupted after the restart, never as
// running forever.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const KEEP = 100;
export const JOB_ID = /^job_[a-f0-9]{12}$/;

export function createJobs({ dir = "" } = {}) {
  const jobs = new Map();
  const file = dir ? join(dir, "jobs.json") : "";
  let saving = Promise.resolve();
  const save = () => {
    if (!file) return Promise.resolve();
    const body = JSON.stringify({ schema: "estampes.module-jobs/1", jobs: [...jobs.values()] }, null, 2);
    saving = saving.then(async () => { await mkdir(dir, { recursive: true }); const tmp = file + "." + process.pid + ".tmp"; await writeFile(tmp, body); await rename(tmp, file); }).catch(() => {});
    return saving;
  };
  const prune = () => { while (jobs.size > KEEP) jobs.delete(jobs.keys().next().value); };
  const waiters = new Map();
  return {
    async load() {
      if (!file) return;
      try {
        const data = JSON.parse(await readFile(file, "utf8"));
        for (const j of data.jobs ?? []) {
          if (j.status === "running") Object.assign(j, { status: "interrupted", error: "the server restarted while this was running; start it again", finishedAt: new Date().toISOString() });
          jobs.set(j.id, j);
        }
      } catch { /* none yet */ }
    },
    create({ module, capability, canvas, summary }) {
      const job = { id: "job_" + randomBytes(6).toString("hex"), module, capability, ...(canvas ? { canvas } : {}), status: "running", startedAt: new Date().toISOString(), ...(summary ? { summary } : {}) };
      jobs.set(job.id, job); prune(); save();
      return job;
    },
    // Records the outcome and wakes anyone waiting for it.
    finish(id, patch) {
      const job = jobs.get(id);
      if (!job || job.status !== "running") return job ?? null;
      Object.assign(job, patch, { finishedAt: new Date().toISOString() });
      save();
      for (const w of waiters.get(id) ?? []) w(job);
      waiters.delete(id);
      return job;
    },
    progress(id, note) { const job = jobs.get(id); if (job?.status === "running") { job.progress = String(note).slice(0, 200); } },
    get: (id) => jobs.get(id) ?? null,
    list: (limit = 20) => [...jobs.values()].slice(-limit).reverse(),
    // Resolves when the job is no longer running, or after waitMs.
    wait(id, waitMs) {
      const job = jobs.get(id);
      if (!job || job.status !== "running" || waitMs <= 0) return Promise.resolve(job ?? null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { resolve(jobs.get(id)); }, waitMs);
        const list = waiters.get(id) ?? [];
        list.push((j) => { clearTimeout(timer); resolve(j); });
        waiters.set(id, list);
      });
    },
    flush: () => saving,
  };
}
