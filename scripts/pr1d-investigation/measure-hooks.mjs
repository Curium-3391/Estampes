// Loaded only by the explicit investigation preload; production bytes stay intact.
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/src/documents/validation.js')) return result;
    let source = String(result.source);
    for (const name of ['assertJson', 'canonicalJson', 'parse']) {
      const signature = `export function ${name}(`;
      if (!source.includes(signature)) throw Error('Instrumentation source signature drift: '+name);
      source = source.replace(signature, `function measured_${name}(`);
      source += `\nexport function ${name}(...args) { return globalThis.__pr1dMeasure(${JSON.stringify(name)}, measured_${name}, args); }\n`;
    }
    return {...result, source};
  }
});
