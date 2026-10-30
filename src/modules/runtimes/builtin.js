// Built-in modules are code that ships with Estampes and was reviewed with
// it, so they run in the server process. They still go through the same
// manifest, permission, input and output checks as any other module.
export const builtinRuntime = {
  kind: "builtin",
  async run(mod, capability, params, ctx) {
    const { entry, ...context } = ctx;
    return mod.runtime.run(capability, params, { ...context, ...(entry ? { image: entry } : {}) });
  },
  // Optional: a built-in may record what the Core did with its output.
  async after(mod, capability, params, ctx, outcome) {
    return mod.runtime.after?.(capability, params, ctx, outcome);
  },
};
