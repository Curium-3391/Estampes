// #85 V1-4: a model-only export, read straight from the record store. It does not run, enable or even load any module, so the data of a
// disabled, removed or no-longer-readable module can be taken out. It is read-only and writes nothing to the store.
//
// This is not a workspace bundle: bundles do not carry models yet. The export holds each instance's type, owner, revision and value, and
// leaves out the change history (which holds earlier values) to keep it small and to export only what is current.
export const EXPORT_SCHEMA = "estampes.model-export/1";

export async function exportModels({ records, module = null, now = () => new Date().toISOString() }) {
  const instances = [];
  for (const id of (await records.list("model")).sort()) {
    const r = await records.read("model", id);
    if (!r || (module && r.owner.module !== module)) continue;
    instances.push({ id: r.id, module: r.owner.module, model: r.type.model, dataVersion: r.type.dataVersion, revision: r.revision, createdAt: r.createdAt, updatedAt: r.updatedAt, value: r.value });
  }
  return { schema: EXPORT_SCHEMA, exportedAt: now(), ...(module ? { module } : {}), count: instances.length, instances };
}
