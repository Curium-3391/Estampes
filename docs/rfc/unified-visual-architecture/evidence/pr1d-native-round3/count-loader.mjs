// Profiling only: prepend counters to the real canonical/hash functions.
// Input files stay unchanged; no parser, filesystem or durability result is substituted.
export async function load(url,context,next){
 const result=await next(url,context);
 const root=process.env.PR1D_CODE_ROOT??process.cwd();
 if(url!==new URL('file://'+root+'/src/documents/validation.js').href)return result;
 const inc=k=>`globalThis.__pr1dEncodingCounts??={canonical:0,hash:0};globalThis.__pr1dEncodingCounts.${k}++;`;
 let source=String(result.source);
 source=source.replace('export function canonicalJson(value, limits) {','export function canonicalJson(value, limits) {'+inc('canonical'));
 source=source.replace('export const hashJson = value => createHash("sha256").update(canonicalJson(value)).digest("hex");','export const hashJson = value => {'+inc('hash')+'return createHash("sha256").update(canonicalJson(value)).digest("hex");};');
 return {...result,source};
}
