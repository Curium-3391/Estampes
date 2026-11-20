// Changing what is installed or enabled always takes two steps: prepare a
// plan (read-only: what changes, which permissions are added, the risk),
// then commit it with proof that a person approved it. The model can ask
// for a plan, but committing needs the plan's consent nonce, which only
// the Store widget receives, and high-risk plans also need administrator
// approval (admin.js). Committing the same plan twice does nothing more.
import { randomBytes } from "node:crypto";
import { permissionDiff, riskOf, describePermission } from "./permissions.js";
import { sameSecret } from "../security.js";

export const ACTIONS = ["enable", "disable"];
const PLAN_TTL_MS = 15 * 60 * 1000, MAX_PLANS = 100;

export class LifecycleError extends Error {
  constructor(message, code = "invalid") { super(message); this.code = code; }
}

export function createLifecycle({ registry, audit, admin = null, actions = {} }) {
  const plans = new Map();
  let lock = Promise.resolve();
  // One change at a time: a second commit waits for the first.
  const exclusive = (job) => { const run = lock.then(job, job); lock = run.catch(() => {}); return run; };

  const prune = (now = Date.now()) => {
    for (const [id, p] of plans) if (p.status === "pending" && now > p.expiresAtMs) p.status = "expired";
    while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value);
  };

  // Built-in actions; packages.js adds install, update, uninstall, purge, rollback.
  const handlers = {
    enable: {
      prepare(mod) {
        if (mod.record.state === "enabled") throw new LifecycleError(mod.manifest.id + " is already enabled", "noop");
        const requested = mod.manifest.permissions;
        return { toVersion: mod.manifest.version, requested, diff: permissionDiff(mod.record.granted ?? [], requested) };
      },
      async commit(mod, plan) {
        await registry.setRecord(mod.manifest.id, { ...mod.record, state: "enabled", version: mod.manifest.version, granted: plan.permissions.requested });
        return { state: "enabled" };
      },
    },
    disable: {
      prepare(mod) {
        if (mod.record.state !== "enabled") throw new LifecycleError(mod.manifest.id + " is not enabled", "noop");
        return { toVersion: mod.manifest.version, requested: [], diff: permissionDiff(mod.record.granted ?? [], []) };
      },
      async commit(mod) {
        // Disabled keeps the grant on record, but nothing runs until a new
        // enable plan is approved again.
        await registry.setRecord(mod.manifest.id, { ...mod.record, state: "disabled" });
        return { state: "disabled" };
      },
    },
    ...actions,
  };

  const lifecycle = {
    actions: () => Object.keys(handlers),
    async prepare(action, moduleId, options = {}, { by = "model" } = {}) {
      prune();
      const handler = handlers[action];
      if (!handler) throw new LifecycleError("unknown action " + JSON.stringify(action) + " (known: " + Object.keys(handlers).join(", ") + ")");
      const mod = registry.get(moduleId);
      if (!mod && !handler.withoutModule) throw new LifecycleError("no module " + JSON.stringify(moduleId), "not-found");
      const details = await handler.prepare(mod, { ...options, module: moduleId });
      const added = details.diff?.added ?? [];
      const risk = details.risk ?? riskOf(added);
      const requiresAdmin = details.requiresAdmin ?? risk === "high";
      const now = Date.now();
      // The same change asked for again while a plan for it is still pending
      // (the Store widget reloaded and lost its copy, or the model asked
      // twice) gets that plan back, so an approval the administrator already
      // gave to it still applies. Only a byte-for-byte identical, unexpired,
      // uncommitted plan is reused: a different version, permission set or
      // package digest always makes a new plan that needs its own approval.
      const sameChange = JSON.stringify([action, moduleId, mod?.record?.version ?? null, details.toVersion ?? null, details.requested ?? [], risk, requiresAdmin, details.options ?? options]);
      for (const existing of plans.values()) {
        if (existing.status === "pending" && now <= existing.expiresAtMs && existing.fingerprint === sameChange) return existing;
      }
      const plan = {
        fingerprint: sameChange,
        planId: "plan_" + randomBytes(9).toString("base64url"), action, module: moduleId,
        name: details.name ?? mod?.manifest.name, fromVersion: mod?.record?.version ?? null, toVersion: details.toVersion ?? null,
        permissions: { requested: details.requested ?? [], added: added.map(describePermission), removed: details.diff?.removed ?? [] },
        risk, requiresAdmin, notes: details.notes ?? [], dataFlow: details.dataFlow ?? null, ...(details.abi && details.abi.kind !== "none" ? { abi: details.abi } : {}),
        status: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
        expiresAtMs: now + PLAN_TTL_MS, consent: randomBytes(18).toString("base64url"), requestedBy: by,
        options: details.options ?? options,
      };
      plans.set(plan.planId, plan);
      audit.record({ kind: "plan.created", module: moduleId, action, planId: plan.planId, risk, requiresAdmin, by,
        added: added, toVersion: plan.toVersion });
      return plan;
    },
    get(planId) { prune(); return plans.get(planId) ?? null; },
    // proof: { consent, adminCode?, adminToken?, by }
    commit(planId, proof = {}) {
      return exclusive(async () => {
        prune();
        const plan = plans.get(planId);
        if (!plan) throw new LifecycleError("no such plan (it may have expired); prepare it again", "not-found");
        if (plan.status === "committed") return { plan, result: plan.result, repeated: true };
        if (plan.status !== "pending") throw new LifecycleError("this plan is " + plan.status + "; prepare a new one", plan.status);
        if (!proof.consent || !sameSecret(proof.consent, plan.consent)) {
          audit.record({ kind: "plan.refused", module: plan.module, planId, reason: "consent" });
          throw new LifecycleError("this change must be approved in the Estampes Store by a person", "consent");
        }
        let approvedBy = "store";
        if (plan.requiresAdmin) {
          if (!admin) throw new LifecycleError("this change needs administrator approval, and no administrator key is set up on this server (see docs/MODULES.md)", "admin");
          const ok = await admin.verify(proof, planId);
          if (!ok) {
            audit.record({ kind: "plan.refused", module: plan.module, planId, reason: "admin" });
            throw new LifecycleError("administrator approval is missing or wrong", "admin");
          }
          approvedBy = ok.via ?? "admin";
        }
        const mod = registry.get(plan.module);
        try {
          const result = await handlers[plan.action].commit(mod, plan);
          plan.status = "committed"; plan.result = result; plan.committedAt = new Date().toISOString();
          audit.record({ kind: "plan.committed", module: plan.module, action: plan.action, planId, approvedBy, toVersion: plan.toVersion,
            granted: plan.permissions.requested, result });
          return { plan, result };
        } catch (error) {
          plan.status = "failed"; plan.error = String(error?.message || error);
          audit.record({ kind: "plan.failed", module: plan.module, action: plan.action, planId, error: plan.error });
          throw error instanceof LifecycleError ? error : new LifecycleError(plan.error, "failed");
        }
      });
    },
    // What the Store or model may see of a plan: never the consent nonce.
    publicPlan(plan) {
      const { consent, expiresAtMs, options, fingerprint, ...rest } = plan;
      return rest;
    },
  };
  return lifecycle;
}
