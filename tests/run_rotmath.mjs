/* The guide §3 self-test, run headlessly. */
import { APP } from './paths.mjs';
import './shim.mjs';
globalThis.console = { log: (...a) => print(a.join(' ')), error: (...a) => print(a.join(' ')), warn: () => {} };

const { runRotMathTests } = await import(APP + '/rotmath.test.js');
const r = runRotMathTests();
print(`\n${r.failed ? r.failed + ' FAILURE(S)' : 'All ' + r.total + ' rotation-math checks passed'}`);
