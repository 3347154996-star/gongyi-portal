'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProductPrivacy } = require('../lib/product-privacy.cjs');
const { createPortal } = require('../server.cjs');
const { makeAdminConfig } = require('../lib/admin.cjs');
const MODEL = 'SYNTHETIC_MODEL_ALPHA';
const OTHER = 'SYNTHETIC_MODEL_BETA';
function workspace(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'portal-privacy-test-'));
  t.after(() => { const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('portal-privacy-test-')); fs.rmSync(resolved, { recursive: true, force: true }); });
  return root;
}
function noNames(value, names = [MODEL, OTHER]) {
  const text = JSON.stringify(value);
  for (const name of names) assert.ok(!text.includes(name), 'A synthetic private name escaped the output boundary');
}

test('product aliases persist across restart, remain stable and never mutate source objects', t => {
  const root = workspace(t), source = { rows: [{ item_name: MODEL, partName: OTHER, count: 17 }], materialNames: [MODEL, OTHER], dates: ['2026-10-15'] }, before = structuredClone(source);
  const first = createProductPrivacy({ root }), protectedFirst = first.protect(source);
  noNames(protectedFirst); assert.deepEqual(source, before);
  assert.match(protectedFirst.rows[0].item_name, /^P-[A-F0-9]{16}$/);
  assert.notEqual(protectedFirst.rows[0].item_name, protectedFirst.rows[0].partName);
  assert.equal(protectedFirst.materialNames[0], protectedFirst.rows[0].item_name);
  const restarted = createProductPrivacy({ root });
  assert.deepEqual(restarted.protect(source), protectedFirst);
  assert.deepEqual(restarted.restore(protectedFirst), source);
  assert.deepEqual(first.protect(protectedFirst), protectedFirst);
  assert.ok(fs.existsSync(path.join(root, 'runtime/product-aliases.json')));
});

test('original-name mode retains exact source text and existing alias mappings without rewriting the registry', t => {
  const root=workspace(t), source={partName:'  合成产品 <A&B>  ',sourceFile:'Synthetic/name.csv',notes:'合成产品 <A&B>',count:7};
  const old=createProductPrivacy({root,config:{privacy:{terms:[MODEL]}}}), coded=old.protect(source);
  const file=path.join(root,'runtime/product-aliases.json'), before=fs.readFileSync(file);
  const original=createProductPrivacy({root,config:{privacy:{productNames:'original',terms:[MODEL]}}});
  assert.equal(original.productNamesMode,'original');
  assert.equal(original.alias(source.partName),source.partName);
  const result=original.protect(source);assert.deepEqual(result,source);assert.notEqual(result,source);
  assert.equal(original.replaceText(source.partName),source.partName);
  assert.equal(original.restore(coded.sourceFile),source.sourceFile);
  assert.equal(original.restore(old.alias(MODEL)),MODEL);
  original.protect({partName:OTHER});original.save();
  assert.deepEqual(fs.readFileSync(file),before);
  assert.throws(()=>createProductPrivacy({root,config:{privacy:{productNames:'invalid'}}}),{status:503});
});

test('original names observed in source responses take precedence over colliding legacy product and file codes', t => {
  const root=workspace(t), old=createProductPrivacy({root});
  const coded=old.protect({partName:MODEL,sourceFile:'synthetic-report.csv',materialName:OTHER});
  const file=path.join(root,'runtime/product-aliases.json'), before=fs.readFileSync(file);
  const original=createProductPrivacy({root,config:{privacy:{productNames:'original'}}});
  assert.equal(original.restore(coded.partName),MODEL,'An unseen direct request remains compatible with legacy codes');
  const source={partName:coded.partName,sourceFile:'folder/'+coded.sourceFile+'.csv',counts:{['line-'+coded.partName]:3}}, snapshot=structuredClone(source);
  assert.deepEqual(original.protect(source),snapshot);assert.deepEqual(source,snapshot);
  assert.equal(original.restore(coded.partName),coded.partName);
  assert.equal(original.restore(coded.sourceFile),coded.sourceFile);
  assert.deepEqual(original.restore({materialName:coded.partName,line:'line-'+coded.partName,filename:'folder/'+coded.sourceFile+'.csv'}),{materialName:coded.partName,line:'line-'+coded.partName,filename:'folder/'+coded.sourceFile+'.csv'});
  assert.equal(original.restore(coded.materialName),OTHER,'Unrelated legacy codes are still restored');
  original.save();assert.deepEqual(fs.readFileSync(file),before);
});

test('explicit original-source learning preserves literal codes in values and object keys without changing the registry', t => {
  const root=workspace(t), old=createProductPrivacy({root}), coded=old.protect({partName:MODEL,sourceFile:'synthetic-report.csv'});
  const file=path.join(root,'runtime/product-aliases.json'), before=fs.readFileSync(file);
  const original=createProductPrivacy({root,config:{privacy:{productNames:'original'}}});
  const source={products:[{value:coded.partName,label:'literal '+coded.partName}],byFilename:{[coded.sourceFile]:4}}, snapshot=structuredClone(source);
  original.learn(source);assert.deepEqual(source,snapshot);
  assert.deepEqual(original.restore(source),source);
  assert.equal(original.restore(coded.sourceFile),coded.sourceFile);
  original.save();assert.deepEqual(fs.readFileSync(file),before);
});

test('original-name mode initializes literal collisions from configured names and persisted raw names after restart', t => {
  const root=workspace(t), old=createProductPrivacy({root});
  const code=old.alias(MODEL), fileCode=old.alias('synthetic-report.csv','F');
  const literalName='SYNTHETIC_LINE_'+code, literalCode=old.alias(literalName);old.save();
  const file=path.join(root,'runtime/product-aliases.json'), before=fs.readFileSync(file);
  for(let restart=0;restart<2;restart++){
    const original=createProductPrivacy({root,config:{weldMaterialNames:[fileCode],privacy:{productNames:'original'}}});
    assert.equal(original.restore(code),code,'Persisted raw names establish literal tokens before any response');
    assert.equal(original.restore(literalCode),literalName,'The separate legacy alias still resolves to its exact raw name');
    assert.equal(original.restore(fileCode),fileCode,'Configured original names take precedence at startup');
    assert.equal(original.restore('line-'+code+'-'+fileCode),'line-'+code+'-'+fileCode);
    original.protect({notes:'ordinary source text',partName:'P-0000000000000000'});original.save();
    assert.deepEqual(fs.readFileSync(file),before);
  }
});

test('product dropdown value and label both use stable aliases while the all option is preserved', t => {
  const privacy = createProductPrivacy({ root: workspace(t) });
  const source = { filters: { materialNames: [{ value: 'all', label: '全部物料', count: 3 }, { value: MODEL, label: MODEL, count: 2 }, { value: OTHER, label: OTHER, count: 1 }], parts: ['all', MODEL, OTHER] } };
  const result = privacy.protect(source); noNames(result);
  assert.deepEqual(result.filters.materialNames[0], source.filters.materialNames[0]); assert.equal(result.filters.parts[0], 'all');
  const choice = result.filters.materialNames[1]; assert.equal(choice.value, choice.label); assert.equal(choice.value, result.filters.parts[1]);
  const query = { materialName: choice.value, part: result.filters.parts[2], keyword: '检查 ' + choice.label, line: '线1 · ' + choice.value, status: 'all' };
  const before = structuredClone(query), restored = privacy.restore(query);
  assert.deepEqual(restored, { materialName: MODEL, part: OTHER, keyword: '检查 ' + MODEL, line: '线1 · ' + MODEL, status: 'all' });
  assert.deepEqual(query, before);
});

test('known names are removed from device, production-line, description and filename fields', t => {
  const privacy = createProductPrivacy({ root: workspace(t), config: { privacy: { terms: [MODEL, OTHER] } } });
  const source = { devices: [{ id: 'dev-01', name: MODEL + ' 检具', lineName: 'L1 · ' + OTHER, description: '检查 ' + MODEL + ' / ' + OTHER, sourcePath: '\\\\synthetic-host\\results\\' + MODEL + '\\report.json' }], records: [{ sourceFile: MODEL + '_report.csv', filename: OTHER + '.xlsx' }], nested: [{ note: MODEL + ' 测量记录' }] };
  const before = structuredClone(source), result = privacy.protect(source); noNames(result);
  assert.match(result.devices[0].sourcePath, /^F-[A-F0-9]{16}$/); assert.match(result.records[0].sourceFile, /^F-[A-F0-9]{16}$/);
  assert.equal(result.devices[0].id, 'dev-01'); assert.deepEqual(source, before); assert.deepEqual(privacy.restore(result), source);
});

test('known product names embedded in name-keyed dictionaries are also removed', t => {
  const privacy = createProductPrivacy({ root: workspace(t), config: { privacy: { terms: [MODEL] } } });
  const source = { countsByProduct: { [MODEL]: 4 }, descriptionByProduct: { ['线1 · ' + MODEL]: { count: 2 } } };
  const result = privacy.protect(source); noNames(result); assert.deepEqual(privacy.restore(result), source);
});

test('embedded aliases restore original line and equipment identifiers without requiring word boundaries', t => {
  const privacy = createProductPrivacy({ root: workspace(t), config: { privacy: { terms: [MODEL] } } });
  const source = { line: 'CELL' + MODEL + 'Zone1', equipmentCode: 'ST' + MODEL + '042' };
  const result = privacy.protect(source); noNames(result, [MODEL]); assert.deepEqual(privacy.restore(result), source);
});

test('numeric product names do not corrupt date or engineering identifier substrings', t => {
  const privacy = createProductPrivacy({ root: workspace(t), config: { privacy: { terms: ['11', '2'] } } });
  const source = { partName: '11', description: '2026-11-02 11:02:11', start: '2026-11-01', end: '2026-11-30', point: 'W11', serialNumber: '000112', count: 11 };
  const result = privacy.protect(source); assert.match(result.partName, /^P-[A-F0-9]{16}$/);
  for (const key of ['description', 'start', 'end', 'point', 'serialNumber', 'count']) assert.equal(result[key], source[key], key);
  assert.deepEqual(privacy.restore(result), source);
});

test('existing opaque aliases are not rewritten when a known short name appears inside their hex text', t => {
  const privacy = createProductPrivacy({ root: workspace(t), config: { privacy: { terms: ['AD'] } } });
  const product = 'P-00000000000000AD', file = 'F-AD00000000000000';
  const source = { partName: product, sourceFile: file, description: 'line-' + product + '-file-' + file };
  assert.deepEqual(privacy.protect(source),source);
  const mixed = privacy.protect({ partName: 'AD', description: 'AD / ' + product });
  assert.match(mixed.partName,/^P-[A-F0-9]{16}$/); assert.equal(mixed.description,mixed.partName+' / '+product);
});

test('decomposed Unicode product fields are hidden and restore the exact original filter value', t => {
  const root = workspace(t), raw = 'SYNTH_E\u0301TIC_ALPHA', privacy = createProductPrivacy({ root });
  const source = { partName: raw, materialNames: [{ value: raw, label: raw }] }, result = privacy.protect(source);
  noNames(result, [raw, raw.normalize('NFC')]); assert.match(result.partName, /^P-[A-F0-9]{16}$/);
  assert.equal(privacy.restore(result.partName), raw);
  assert.deepEqual(createProductPrivacy({ root }).protect(source), result);
});

test('unknown free text requires declared terms while identified product fields teach the mapping', t => {
  const privacy = createProductPrivacy({ root: workspace(t) });
  assert.equal(privacy.protect({ notes: MODEL }).notes, MODEL, 'The mapper does not claim semantic recognition of arbitrary prose');
  const first = privacy.protect({ notes: MODEL + ' 待核对', record: { partName: MODEL } }); noNames(first, [MODEL]);
  const later = privacy.protect({ description: '后续 ' + MODEL }); noNames(later, [MODEL]);
});

test('invalid persisted alias state fails closed instead of returning business names', t => {
  const root = workspace(t); fs.mkdirSync(path.join(root, 'runtime')); fs.writeFileSync(path.join(root, 'runtime/product-aliases.json'), '{invalid');
  assert.throws(() => createProductPrivacy({ root }), error => error.status === 503 && !error.message.includes(MODEL));
});

test('portal JSON boundary aliases catalog and report data and restores business filters after restart', async t => {
  const root = workspace(t), queries = [], config = { admin: makeAdminConfig('synthetic-privacy-admin', 'synthetic-privacy-password'), privacy: { terms: [MODEL] } };
  const sourceData = { rows: [{ item_name: MODEL, count: 3 }], filters: { materialNames: [{ value: 'all', label: '全部物料' }, { value: MODEL, label: MODEL }] }, description: '检查 ' + MODEL }, original = structuredClone(sourceData);
  const fleet = { lines: [{ id: 'line-1', name: MODEL + ' 线' }], devices: [{ id: 'device-1', name: MODEL + ' 检具', lineName: MODEL + ' 线', partNames: [MODEL], sourcePath: '/synthetic/' + MODEL + '/input.json' }] };
  const start = async () => {
    const server = createPortal({ root, config, source: {}, autoSource: { start() {}, stop() {}, status: () => ({ state: 'ready' }), async read(module, query) { queries.push({ module, query: structuredClone(query) }); if(module==='visionMesReport')return query.action==='catalog'?fleet:{records:[{partName:MODEL}],filters:{partCode:query.partCode}}; return sourceData; } },
      inventoryService: { async capabilities() { return {}; }, async catalog(query) { queries.push({ module: 'inventory', query }); return { items: [{ id: MODEL + '-item', name: MODEL }] }; }, async transact(input) { queries.push({ module: 'transact', input }); return { status: 'applied' }; }, async count(input) { queries.push({ module: 'count', input }); return { status: 'pending' }; }, async review(input) { queries.push({ module: 'review', input }); return { status: 'applied' }; } },
      visionService: { async catalog() { return fleet; }, async report(query) { queries.push({ module: 'vision', query }); return { records: [{ partName: MODEL }], filters: { parts: [MODEL] } }; } } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
    t.after(close);
    const login = await fetch(base + '/local/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'synthetic-privacy-admin', password: 'synthetic-privacy-password' }) });
    assert.equal(login.status, 200); const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const get = async route => { const response = await fetch(base + route, { headers }); assert.equal(response.status, 200); return response.json(); };
    const post = async (route, payload) => { const response = await fetch(base + route, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); assert.equal(response.status,200); return response.json(); };
    return { get, post, close };
  };
  const first = await start(), report = await first.get('/local/data/weld?start=2026-10-02&end=2026-10-08'); noNames(report, [MODEL]);
  const code = report.filters.materialNames[1].value; assert.match(code, /^P-[A-F0-9]{16}$/);
  noNames(await first.get('/local/vision/mes/catalog'), [MODEL]);
  await first.get('/local/data/weld?start=2026-10-02&end=2026-10-08&materialName=' + code + '&keyword=' + code);
  assert.equal(queries.at(-1).query.materialName, MODEL); assert.equal(queries.at(-1).query.keyword, MODEL);
  await first.get('/local/vision/mes/report?partCode=' + code); assert.equal(queries.at(-1).query.partCode, MODEL);
  const stock = await first.get('/local/inventory/catalog?search=' + code); assert.equal(queries.at(-1).query.search, MODEL);
  await first.post('/local/inventory/transactions',{itemId:stock.items[0].id,kind:'inbound'}); assert.equal(queries.at(-1).input.itemId,MODEL+'-item');
  await first.post('/local/inventory/counts',{itemId:stock.items[0].id}); assert.equal(queries.at(-1).input.itemId,MODEL+'-item');
  await first.post('/local/inventory/review',{id:stock.items[0].id,action:'approve'}); assert.equal(queries.at(-1).input.id,MODEL+'-item');
  assert.deepEqual(sourceData, original);
  await first.close(); const second = await start();
  const afterRestart = await second.get('/local/data/weld?start=2026-10-02&end=2026-10-08&materialName=' + code);
  assert.equal(afterRestart.filters.materialNames[1].value, code); assert.equal(queries.at(-1).query.materialName, MODEL);
  await second.close();config.privacy.productNames='original';const originalMode=await start();
  const named=await originalMode.get('/local/data/weld?start=2026-10-02&end=2026-10-08&materialName='+code);
  assert.deepEqual(named.rows,sourceData.rows);assert.equal(named.filters.materialNames[1].value,MODEL);
  assert.equal(named.resolvedQuery.materialName,MODEL);assert.equal(queries.at(-1).query.materialName,MODEL);
  assert.deepEqual(await originalMode.get('/local/vision/mes/catalog'),fleet);
  const namedVision=await originalMode.get('/local/vision/mes/report?partCode='+code);
  assert.equal(namedVision.records[0].partName,MODEL);assert.equal(namedVision.filters.partCode,MODEL);
  const namedStock=await originalMode.get('/local/inventory/catalog?search='+code);
  assert.equal(namedStock.items[0].name,MODEL);assert.equal(queries.at(-1).query.search,MODEL);
});
