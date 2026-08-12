import { APP, VENDOR } from './paths.mjs';
import './shim.mjs';
globalThis.self = globalThis;
globalThis.console = { log:(...a)=>print(a.join(' ')), error:(...a)=>print(a.join(' ')), warn:()=>{} };
load(VENDOR + '/pdf-lib.min.js');
globalThis.pdfjsLib = { GlobalWorkerOptions:{}, getDocument: () => ({ promise: Promise.resolve({}) }) };

let bad = 0;
for (const m of ['state.js','rotmath.test.js','export.js','persist.js','view.js','annots.js','pages.js','files.js']) {
  try { const mod = await import(`${APP}/${m}`); print(`ok    ${m}  (${Object.keys(mod).length} exports)`); }
  catch (e) { bad++; print(`FAIL  ${m}: ${e.stack || e}`); }
}
print(bad ? `\n${bad} module(s) failed to load` : '\nAll modules load cleanly');
