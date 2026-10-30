// Built-in modules are code that ships with Estampes and was reviewed with
// it, so they run in the server process. They still go through the same
// manifest, permission, input and output checks as any other module.
export const builtinRuntime = {
  kind: "builtin",
  async run(mod, capability, params, ctx) {
    const { entry, ...context } = ctx;
    return mod.runtime.run(capability, params, { ...context, ...(entry ? { image: entry } : {}) });
  },
};
