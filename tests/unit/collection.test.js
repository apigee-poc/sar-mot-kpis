// Static checks of the Newman collection, its generator and the environment files.
// Pure file reads: no network, no cloud.
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const gen = require('../tools/build-collection');

const ROOT = path.join(__dirname, '..', '..');
const OAS_FILE = path.join(ROOT, 'api', 'sar-mot-kpis-oas.yaml');
const ENV_DIR = path.join(ROOT, 'tests', 'environments');
const BASE_PATH = '/mot-kpis/business-domain/v1';
const SECRET_VARS = ['apiKey', 'apiSecret', 'otherApiKey', 'otherApiSecret'];
const ENV_HOSTS = {
  local: 'http://localhost:8998',
  dev: 'https://35.201.86.122.nip.io',
  staging: 'https://staging.35.201.86.122.nip.io',
  prod: 'https://prod.35.201.86.122.nip.io'
};

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

const collectionText = read(gen.OUTPUT_FILE);
const collection = JSON.parse(collectionText);
const catalog = gen.readCatalog();

// All requests, with their folder name.
function requests() {
  const out = [];
  collection.item.forEach((folder) => {
    folder.item.forEach((item) => out.push({ folder: folder.name, item }));
  });
  return out;
}

// The `expected` object a request's pre-request script sets.
function expectedOf(item) {
  const pre = item.event.find((e) => e.listen === 'prerequest');
  const line = pre.script.exec.join('\n');
  const m = /^pm\.variables\.set\('expected', JSON\.stringify\((.*)\)\);$/.exec(line);
  expect(m, `${item.name}: pre-request must only set 'expected'`).to.not.equal(null);
  return JSON.parse(m[1]);
}

// Minimal reader for `components.schemas` of the OAS (YAML-free, indentation based). Supports
// exactly the keywords used there: type, required (block list), properties, items, $ref,
// minimum, maximum, minItems, maxItems; format/description/example are ignored.
function oasSchemas() {
  const lines = read(OAS_FILE).split('\n');
  const start = lines.indexOf('  schemas:');
  expect(start, 'components.schemas not found').to.be.above(-1);
  const schemas = {};
  const stack = []; // [{indent, node}]
  let listKey = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    if (indent <= 2) break;
    const text = line.trim();
    if (text.startsWith('- ')) {
      listKey.push(text.slice(2).trim());
      continue;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const m = /^([$\w]+):\s*(.*)$/.exec(text);
    expect(m, `unsupported OAS line: ${line}`).to.not.equal(null);
    const [, key, raw] = m;
    const value = raw.replace(/^'(.*)'$/, '$1');
    if (indent === 4) {
      schemas[key] = {};
      stack.push({ indent, node: schemas[key] });
      continue;
    }
    const parent = stack[stack.length - 1].node;
    if (key === 'required' && raw === '') {
      parent.required = [];
      listKey = parent.required;
    } else if (raw === '') {
      parent[key] = {};
      stack.push({ indent, node: parent[key] });
    } else if (['format', 'description', 'example'].includes(key)) {
      // not part of the draft-04 conversion
    } else if (['minimum', 'maximum', 'minItems', 'maxItems'].includes(key)) {
      parent[key] = Number(value);
    } else if (key === 'type' || key === '$ref') {
      parent[key] = value;
    } else {
      throw new Error(`unsupported OAS schema keyword: ${key}`);
    }
  }
  // Inline $refs.
  const resolve = (node) => {
    if (node.$ref) {
      return resolve(schemas[node.$ref.replace('#/components/schemas/', '')]);
    }
    const out = {};
    Object.keys(node).forEach((k) => {
      if (k === 'properties') {
        out.properties = {};
        Object.keys(node.properties).forEach((p) => { out.properties[p] = resolve(node.properties[p]); });
      } else if (k === 'items') {
        out.items = resolve(node.items);
      } else {
        out[k] = node[k];
      }
    });
    return out;
  };
  const resolved = {};
  Object.keys(schemas).forEach((name) => { resolved[name] = resolve(schemas[name]); });
  return resolved;
}

describe('Newman collection (tests/sar-mot-kpis.postman_collection.json)', () => {
  it('is valid Postman v2.1 JSON', () => {
    expect(collection.info.schema).to.equal('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(collection.item.map((f) => f.name)).to.deep.equal([gen.FOLDERS.happy, gen.FOLDERS.errors, gen.FOLDERS.faults]);
  });

  it('equals the generator output (run node tests/tools/build-collection.js after a change)', () => {
    expect(collectionText).to.equal(gen.render());
  });

  it('the generator is deterministic', () => {
    expect(gen.render()).to.equal(gen.render());
  });

  it('every catalog row 1-16 has a request or is listed as fault-injection (Task F) or waived', () => {
    const titled = new Set();
    requests().forEach(({ item }) => {
      const m = /^Row (\d+): /.exec(item.name);
      if (m) titled.add(Number(m[1]));
    });
    const waived = Object.keys(gen.WAIVED_ROWS).map(Number);
    expect(Object.keys(catalog).map(Number)).to.deep.equal(Array.from({ length: 16 }, (_, i) => i + 1));
    Object.keys(catalog).map(Number).forEach((row) => {
      const covered = titled.has(row) || gen.FAULT_INJECTION_ROWS.includes(row) || waived.includes(row);
      expect(covered, `catalog row ${row} not covered`).to.equal(true);
    });
    [1, 2, 3, 4, 5, 8, 9, 10, 11, 12].forEach((row) => {
      expect(titled.has(row), `row ${row} must have a request`).to.equal(true);
    });
    expect(waived).to.deep.equal([14, 15]);
    expect(collection.info.description).to.include('Row 14 (502) WAIVED');
    expect(collection.info.description).to.include('Row 15 (504) WAIVED');
  });

  it('every request declares its expectation; error rows match the catalog status and text exactly', () => {
    requests().forEach(({ folder, item }) => {
      const expected = expectedOf(item);
      if (folder === gen.FOLDERS.happy) {
        expect(expected.status, item.name).to.equal(200);
        expect(expected.data, item.name).to.be.an('array');
        return;
      }
      const row = Number(/^Row (\d+): /.exec(item.name)[1]);
      expect(expected.row, item.name).to.equal(row);
      expect(expected.status, item.name).to.equal(catalog[row].status);
      expect(expected.message, item.name).to.equal(catalog[row].message);
      expect(item.name, item.name).to.match(new RegExp(` -> ${catalog[row].status}$`));
    });
  });

  it('happy paths expect the exact mock data', () => {
    const data = {};
    collection.item[0].item.forEach((item) => { data[item.name] = expectedOf(item).data; });
    const counts = Object.values(data).map((d) => d.length);
    expect(counts).to.deep.equal([3, 1, 0, 4]);
    expect(Object.values(data)[1]).to.deep.equal([{ quarter: 3, year: 2025, actual: 1512750, loadTime: '2025-10-05T02:00:00Z' }]);
  });

  it('omitted headers are really omitted, never sent empty', () => {
    requests().forEach(({ item }) => {
      item.request.header.forEach((h) => {
        expect(h.value, `${item.name}: ${h.key}`).to.be.a('string').and.not.equal('');
      });
    });
    const byName = (name) => requests().find(({ item }) => item.name.startsWith(name)).item;
    const keys = (item) => item.request.header.map((h) => h.key);
    expect(keys(byName('Row 2: '))).to.not.include('X-API-Key');
    expect(keys(byName('Row 4: X-API-Secret missing'))).to.not.include('X-API-Secret');
    expect(keys(byName('Row 8: X-Request-Timestamp missing'))).to.not.include('X-Request-Timestamp');
    expect(keys(byName('Row 9: X-Operator-Id missing'))).to.not.include('X-Operator-Id');
  });

  it('non-GET requests send an explicit empty body; the 405 request expects Allow: GET', () => {
    const posts = requests().filter(({ item }) => item.request.method !== 'GET');
    expect(posts).to.have.length(1);
    posts.forEach(({ item }) => {
      expect(item.request.body).to.deep.equal({ mode: 'raw', raw: '' });
      expect(expectedOf(item)).to.include({ row: 11, status: 405, allow: 'GET' });
    });
  });

  it('contains no credential-looking literals', () => {
    requests().forEach(({ item }) => {
      item.request.header.filter((h) => /^X-API-(Key|Secret)$/.test(h.key)).forEach((h) => {
        const ok = /^\{\{\w+\}\}$/.test(h.value) || [gen.FAKE_API_KEY, gen.FAKE_API_SECRET].includes(h.value);
        expect(ok, `${item.name}: ${h.key} must reference a variable`).to.equal(true);
      });
    });
    expect(collectionText).to.not.match(/[0-9a-fA-F]{32,}/);
    expect(collectionText).to.not.match(/[A-Za-z0-9+/]{32,}={0,2}/);
    expect(collection.variable || []).to.deep.equal([]);
  });

  it('collection scripts generate the request id and timestamp and check the contract', () => {
    const pre = collection.event.find((e) => e.listen === 'prerequest').script.exec.join('\n');
    const test = collection.event.find((e) => e.listen === 'test').script.exec.join('\n');
    expect(pre).to.include("pm.variables.replaceIn('{{$guid}}')");
    expect(pre).to.include("new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z')");
    ['pm.response.to.have.status(expected.status)', "to.include('application/json')", 'pm.response.to.have.jsonSchema',
      'header.isSuccess).to.equal(status < 300)', "typeof (body.error || {}).code).to.equal('number')",
      'body.error.code).to.equal(status)', 'message).to.equal(expected.message)', "headers.get('X-Request-Id')).to.equal(sentId)",
      'header.traceId).to.equal(sentId)', 'body.data).to.deep.equal(expected.data)', "headers.get('Allow')).to.equal(expected.allow)"]
      .forEach((s) => expect(test, s).to.include(s));
    expect(test).to.include(String.raw`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/`);
  });
});

describe('collection schemas vs api/sar-mot-kpis-oas.yaml', () => {
  const oas = oasSchemas();

  ['ResponseHeader', 'KpiRecord', 'KpiSuccessResponse', 'ErrorDetail', 'ErrorResponse'].forEach((name) => {
    it(`${name} equals the OAS schema (draft-04, refs inlined, format/example/description dropped)`, () => {
      expect(gen.SCHEMAS[name]).to.deep.equal(oas[name]);
    });
  });

  it('the schemas embedded in the test script are the generator schemas', () => {
    const test = collection.event.find((e) => e.listen === 'test').script.exec;
    expect(test).to.include(`const SUCCESS_SCHEMA = ${JSON.stringify(gen.SCHEMAS.KpiSuccessResponse)};`);
    expect(test).to.include(`const ERROR_SCHEMA = ${JSON.stringify(gen.SCHEMAS.ErrorResponse)};`);
    expect(JSON.stringify(gen.SCHEMAS)).to.not.match(/\$schema|\$ref|format|additionalProperties/);
  });
});

describe('Postman environments (tests/environments)', () => {
  Object.keys(ENV_HOSTS).forEach((env) => {
    it(`${env}: correct host and base path, secrets empty`, () => {
      const file = path.join(ENV_DIR, `${env}.postman_environment.json`);
      const data = JSON.parse(read(file));
      const vars = {};
      data.values.forEach((v) => { vars[v.key] = v; });
      expect(vars.baseUrl.value).to.equal(ENV_HOSTS[env]);
      expect(vars.basePath.value).to.equal(BASE_PATH);
      expect(vars.operatorId.value).to.match(/^[12]\d{9}$/);
      SECRET_VARS.forEach((k) => {
        expect(vars[k], `${env}: ${k}`).to.include({ type: 'secret', value: '' });
      });
      data.values.filter((v) => !['baseUrl', 'basePath', 'operatorId', 'folderFilter'].includes(v.key)).forEach((v) => {
        expect(v.value, `${env}: ${v.key}`).to.equal('');
      });
      expect(read(file)).to.not.match(/[0-9a-fA-F]{32,}|[A-Za-z0-9+/]{32,}={0,2}/);
    });
  });

  it('prod limits itself to the read-only smoke folder', () => {
    const data = JSON.parse(read(path.join(ENV_DIR, 'prod.postman_environment.json')));
    const filter = data.values.find((v) => v.key === 'folderFilter');
    expect(filter.value).to.equal(gen.FOLDERS.happy);
  });
});
