const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BUNDLE = path.join(
  __dirname, '..', '..', '..', 'src', 'main', 'apigee', 'apiproxies', 'sar-mot-kpis-v1', 'apiproxy'
);
const JSC_DIR = path.join(BUNDLE, 'resources', 'jsc');

function jscSource(name) {
  return fs.readFileSync(path.join(JSC_DIR, name), 'utf8');
}

// Pure functions, exported for mocha (module.exports branch of each resource).
// Evaluated in a vm sandbox that has `module` but no `context`: mocha defines a global
// `context` (alias of describe), which would make the resources' `typeof context` Apigee
// guard true when they are require()d directly.
function load(name) {
  const mod = { exports: {} };
  const sandbox = vm.createContext({ module: mod, exports: mod.exports, Date, Math, JSON, Object, String, Number, parseInt, isFinite });
  vm.runInContext(jscSource(name), sandbox, { filename: name });
  return mod.exports;
}

// Runs a resource the way Apigee does: no `module`, a global `context` with
// getVariable/setVariable. Returns the variables the script set.
// Pass `now` (epoch ms) to pin new Date() (the scripts read the gateway clock there).
function runInApigee(name, vars, now) {
  const set = {};
  const context = {
    getVariable: (k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : null),
    setVariable: (k, v) => {
      set[k] = v;
    }
  };
  let FakeDate = Date;
  if (now !== undefined) {
    FakeDate = class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
    };
  }
  const sandbox = vm.createContext({ context, Date: FakeDate, Math, JSON, Object, String, Number, parseInt, isFinite });
  vm.runInContext(jscSource(name), sandbox, { filename: name });
  return set;
}

module.exports = { BUNDLE, JSC_DIR, jscSource, load, runInApigee };
