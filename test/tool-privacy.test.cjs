'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require('../public/tools/vendor/jszip.min.js');
const root = path.join(__dirname, '../public/tools');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const secret = 'SYNTHETIC_PRIVATE_MODEL';
const absent = value => assert.ok(!String(value).includes(secret), 'Synthetic private model must not appear in output');
function environment(anonymizeNames = false) {
  const nodes = new Map(), blobs = [], downloads = [], clipboard = [];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', checked: false, innerHTML: '', textContent: id === 'saved-result' ? 'null' : '', style: {}, hidden: false, disabled: false, events: {}, classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(type, callback) { this.events[type] = callback; }, setAttribute() {}, removeAttribute() {}, scrollIntoView() {}, focus() {}, click() {},
      get options() { return [...this.innerHTML.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(m => ({ value: m[1], textContent: m[2], hidden: false })); }
    });
    return nodes.get(id);
  };
  const document = { getElementById: get, addEventListener() {}, createElement(tag) { return { click() { downloads.push(this.download); }, tagName: tag }; } };
  const context = vm.createContext({ window: { ToolPrivacyOptions: { anonymizeNames } }, document, navigator: { clipboard: { writeText: async value => clipboard.push(value) } }, JSZip, Blob,
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:fixture'; }, revokeObjectURL() {} }, setTimeout: callback => { callback(); }, console, alert: message => { throw new Error(message); } });
  vm.runInContext(read('privacy.js'), context);
  return { context, get, nodes, blobs, downloads, clipboard, surface: () => [...nodes.values()].map(n => n.innerHTML + n.textContent + n.value).join('\n') };
}
function workbook(context, rows, name) {
  const sheet = { name, cells: new Map(), rows: new Map() };
  rows.forEach((row, ri) => { const cols = new Map(); row.forEach((v, ci) => { if (v == null) return; const cell = { value: String(v), type: typeof v === 'number' ? 'n' : 's' }; cols.set(ci + 1, cell); sheet.cells.set((ci + 1) + ':' + (ri + 1), cell); }); sheet.rows.set(ri + 1, cols); });
  context.window.classifyForTest(sheet); return { name, sheets: [sheet], date1904: false };
}
function fixtures(context) {
  vm.runInContext(read('measurement-compare/core.js').replace('global.MeasureCompareEngine =', 'global.classifyForTest = classify; global.MeasureCompareEngine ='), context);
  const vision = workbook(context, [['SN', '', '', '00001234', secret + '0002'], ['TimeStamp', '', '', '2026-10-15 08:00:00', '2026-10-15 08:01:00'], ['Name', '', 'Nominal', 'Dev1', 'Dev2'], ['42_X', '', 10.05, .25, .4], ['42_' + secret, '', 1, .2, .3]], secret + '_VISION');
  const cmm = workbook(context, [['Item', 'Check Item', 'Nominal', '00001234-10/15', secret + '0002-10/15'], ['42 ' + secret, 'X', 10, .1, .2]], secret + '_CMM');
  return { vision, cmm };
}

test('local aliases are stable, idempotent and retain numeric identifiers and engineering syntax', () => {
  const { context } = environment(true), p = context.window.ToolPrivacy;
  assert.equal(p.alias('文件', secret), p.alias('文件', secret));
  assert.notEqual(p.alias('文件', secret), p.alias('文件', secret + '2'));
  assert.equal(p.alias('文件', p.alias('文件', secret)), p.alias('文件', secret));
  for (const value of ['W42','42_X','P12','seam12','weld23','焊点42']) assert.equal(p.engineering('标签',value), value);
  assert.equal(p.sn('00001234'), '00001234'); absent(p.sn(secret + '0002'));
  const mixed = p.engineering('标签',secret + ' W42'); absent(mixed); assert.match(mixed,/W42$/); assert.equal(p.engineering('标签',mixed),mixed);
  assert.equal(p.mode('CV ArMix'),'CV ArMix'); assert.equal(p.mode('PULSE Steel'),'PULSE Steel'); absent(p.mode('CV ' + secret));
  assert.equal(p.rawWeld('[10,0,[11,0,24,100]]'),'[10,0,[11,0,24,100]]'); absent(p.rawWeld('[10,"' + secret + '"]')); absent(p.safeError(Error(secret)));
});

for (const anonymizeNames of [false, true]) test(`weld display, filtering, CSV, TSV and XLSX use ${anonymizeNames ? 'opt-in aliases' : 'original names by default'} without changing numeric parameters`, async () => {
  const env = environment(anonymizeNames), { context, get, blobs, clipboard, downloads } = env;
  const checkName = value => anonymizeNames ? absent(value) : assert.ok(String(value).includes(secret));
  context.window.JSZip = JSZip;
  vm.runInContext(read('xlsx-export.js'), context);
  const exports = [];
  context.XLSX = {...context.window.XLSX, writeFile: async (book, name) => { exports.push(await context.window.XLSX.toBytes(book)); downloads.push(name); }};
  vm.runInContext(read('weld-export/app.js'), context);
  const proc = 'WL_' + secret, text = `MODULE Test\nTASK PERS welddata weld1:=[10,0,[11,0,24,100]];\nCONST LincWeldModeData weld_Mode_11:=[11,"CV ArMix"];\nPROC ${proc}()\n! =${secret} W42\nArcLStart p1,v100,seam1,weld1,fine,tool0;\nArcLEnd p2,v100,seam1,weld1,fine,tool0;\nENDPROC\nENDMODULE`;
  const file = (name, content) => ({ name, webkitRelativePath: secret + '/TASK1/' + name, size: content.length, text: async () => content });
  await context.window.WeldExportTool.importFiles([file('MainModule.mod', `IF ${secret}_START=1 THEN\n${proc};\nENDIF`), file(secret + '.mod', text)]);
  const result = context.window.WeldExportTool.getResult(); assert.equal(result.rowCount,1); checkName(JSON.stringify(result)); checkName(env.surface());
  assert.deepEqual(Array.from(result.rows[0].slice(9,14)),[10,23.62,'11 CV ArMix',24,236.22]); assert.match(result.rows[0][6],/W42$/);
  context.pick(0); assert.equal(context.window.WeldExportTool.getResult().rowCount,1); checkName(get('kw').value);
  get('kw').value = anonymizeNames ? get('kw').value : secret.toLowerCase(); context.applyFilter();
  assert.equal(context.window.WeldExportTool.getResult().rowCount,1);
  context.exportCSV(); context.copyTSV(); await context.exportExcel();
  assert.equal(blobs.length,1); checkName(await blobs[0].text()); checkName(clipboard[0]); absent(downloads.join('|'));
  if(!anonymizeNames){assert.equal(result.rows[0][6],'='+secret+' W42');assert.ok((await blobs[0].text()).includes("'="+secret));assert.ok(clipboard[0].includes("'="+secret));}
  const zip=await JSZip.loadAsync(exports[0]);
  checkName(await zip.file('xl/worksheets/sheet2.xml').async('string'));
  assert.doesNotMatch(await zip.file('xl/worksheets/sheet2.xml').async('string'),/<f[ >]/);
  if(anonymizeNames)for (const entry of Object.values(zip.files)) if (!entry.dir) absent(await entry.async('string'));
  assert.match(await zip.file('xl/worksheets/sheet2.xml').async('string'), /<v>236\.22<\/v>/);
  await context.window.WeldExportTool.importFiles([{name:'bad.mod',size:1,text:async()=>{throw Error(secret);}}]); absent(get('impMsg').textContent);assert.equal(context.window.WeldExportTool.getResult().rowCount,0);
});

test('comparison sanitization follows exact matching, preserves values and never exports hidden source metadata', () => {
  const {context}=environment(true), {vision,cmm}=fixtures(context), p=context.window.ToolPrivacy;
  const raw=context.window.MeasureCompareEngine.compare(vision,vision.sheets[0].name,cmm,cmm.sheets[0].name);
  assert.equal(raw.pairs.length,2); assert.ok(raw.pairs.some(v=>v.sn===secret+'0002'),'Original identities are used for matching');
  raw.extra_private_metadata={ [secret]: secret }; raw.diagnostics.excluded_items.push({key:'12_'+secret,label:secret,reason:secret,extra:secret});
  const result=p.compareResult(raw); absent(JSON.stringify(result));
  assert.equal(result.pairs[0].sn,'00001234'); assert.equal(result.items[0].point,'42'); assert.equal(result.items[0].axis,'X');
  assert.equal(result.items[0].pairs[1].diff,raw.items[0].pairs[1].diff);
  assert.deepEqual(JSON.parse(JSON.stringify(p.compareResult(result))),JSON.parse(JSON.stringify(result)));
  assert.ok(result.items[0].pairs.every(pair=>result.pairs.some(meta=>meta.pair_id===pair.pair_id)));
  assert.equal(result.diagnostics.excluded_items.length,2); assert.equal(result.extra_private_metadata,undefined);
});

test('comparison application renders aliases, uses sheet indexes and re-sanitizes older saved result data', async () => {
  const env=environment(true), {context,get}=env, {vision,cmm}=fixtures(context);
  const engine=context.window.MeasureCompareEngine;
  context.window.MeasureCompareEngine={...engine,readWorkbook:async value=>value};
  vm.runInContext(read('measurement-compare/app.js'),context);
  const file=(suffix,wb)=>({name:secret+suffix+'.xlsx',size:100,arrayBuffer:async()=>wb});
  await context.window.MeasureCompareTool.importFiles([file('_v',vision),file('_c',cmm)]);
  assert.equal(context.window.MeasureCompareTool.getResult().pairs.length,2); absent(env.surface()); absent(JSON.stringify(context.window.MeasureCompareTool.getResult()));
  assert.match(get('vision-sheet').innerHTML, /value="0"/); assert.match(get('vision-name').textContent,/^文件-/);
  get('vision-sheet').events.change({target:{value:'0'}}); assert.equal(context.window.MeasureCompareTool.getResult().items.length,1);
  const old=engine.compare(vision,vision.sheets[0].name,cmm,cmm.sheets[0].name);
  const offline=environment(true); offline.get('saved-result').textContent=JSON.stringify({data:old,threshold:.2,saved_at:'2026-10-15'});
  vm.runInContext(read('measurement-compare/app.js'),offline.context); absent(JSON.stringify(offline.context.window.MeasureCompareTool.getResult()));
  for(const node of offline.nodes.values()) absent(node.innerHTML+node.textContent+node.value);
  // The download path serializes only safe results and removes hidden selected filenames/sheets.
  const code=read('measurement-compare/app.js'); assert.match(code,/data:privacy\.compareResult\(state\.data\)/); assert.match(code,/root\.querySelector\('#'\+type\+'-sheet'\)\.innerHTML=''/);
});

test('default name policy preserves supplied names and never invents originals for old aliases', () => {
  const {context}=environment(), p=context.window.ToolPrivacy;
  assert.equal(p.anonymizeNames,false);
  for(const value of [secret,'  '+secret+'  ','00001234','文件-0000000000001']){
    assert.equal(p.alias('文件',value),value); assert.equal(p.engineering('测点',value),value); assert.equal(p.sn(value),value); assert.equal(p.mode(value),value);
  }
  assert.equal(p.rawWeld('[10,"'+secret+'",[11,0,24,100]]'),'[10,"'+secret+'",[11,0,24,100]]');
  absent(p.safeError(Error(secret)));
  const {vision,cmm}=fixtures(context), raw=context.window.MeasureCompareEngine.compare(vision,vision.sheets[0].name,cmm,cmm.sheets[0].name);
  const result=p.compareResult(raw);
  assert.equal(result.pairs[1].sn,secret+'0002'); assert.equal(result.items[0].cmm_label,raw.items[0].cmm_label);
  assert.equal(result.source_names.vision,raw.vision_file); assert.equal(result.source_sheets.vision,vision.sheets[0].name);
  assert.equal(result.items[0].pairs[1].diff,raw.items[0].pairs[1].diff);
  const oldAlias=environment(true).context.window.ToolPrivacy.compareResult(raw);
  assert.deepEqual(JSON.parse(JSON.stringify(p.compareResult(oldAlias))),JSON.parse(JSON.stringify(oldAlias)));
});

test('comparison displays original names safely and preserves them through saved HTML serialization and reopening', async () => {
  const env=environment(), {context,get}=env, {vision,cmm}=fixtures(context), engine=context.window.MeasureCompareEngine;
  const sourceName=secret+'</script><img src=x>.xlsx';
  vision.sheets[0].name=secret+'<sheet>'; cmm.sheets[0].name=secret+'_CMM';
  context.window.MeasureCompareEngine={...engine,readWorkbook:async value=>value};
  vm.runInContext(read('measurement-compare/app.js'),context);
  await context.window.MeasureCompareTool.importFiles([{name:sourceName,size:100,arrayBuffer:async()=>vision},{name:secret+'_c.xlsx',size:100,arrayBuffer:async()=>cmm}]);
  const result=context.window.MeasureCompareTool.getResult();
  assert.equal(get('vision-name').textContent,sourceName);
  assert.match(get('vision-sheet').innerHTML,/value="0"/); assert.ok(get('vision-sheet').innerHTML.includes(secret+'&lt;sheet&gt;'));
  assert.ok(get('matching-body').innerHTML.includes(secret+'&lt;/script&gt;&lt;img src=x&gt;.xlsx'));
  assert.doesNotMatch(get('matching-body').innerHTML,/<img src=x>/);
  assert.equal(result.source_names.vision,sourceName); assert.equal(result.pairs[1].sn,secret+'0002');
  get('point-search').value='42'; get('point-search').events.input(); assert.ok(get('point-content').innerHTML.includes('42'));
  get('tab-sample').events.click(); assert.ok(get('sample-select').innerHTML.includes(secret+'0002'));

  const cloned=new Map(), node=selector=>{if(!cloned.has(selector))cloned.set(selector,{textContent:'',innerHTML:'',disabled:false});return cloned.get(selector);};
  context.document.documentElement={cloneNode:()=>({querySelector:node,querySelectorAll:()=>[],get outerHTML(){return '<html><script type="application/json" id="saved-result">'+node('#saved-result').textContent+'</script></html>';}})};
  await get('download').events.click();
  const html=await env.blobs[0].text();assert.ok(html.includes(secret));assert.doesNotMatch(html,/<img src=x>/);
  const saved=JSON.parse(node('#saved-result').textContent);assert.equal(saved.data.source_names.vision,sourceName);
  const offline=environment();offline.get('saved-result').textContent=node('#saved-result').textContent;
  vm.runInContext(read('measurement-compare/app.js'),offline.context);
  assert.equal(offline.context.window.MeasureCompareTool.getResult().source_names.vision,sourceName);
  assert.equal(offline.context.window.MeasureCompareTool.getResult().pairs[1].sn,secret+'0002');

  const anonymous=environment(true).context.window.ToolPrivacy.compareResult(result), legacy=environment();
  legacy.get('saved-result').textContent=JSON.stringify({data:anonymous,threshold:.2,saved_at:'2026-10-15'});
  vm.runInContext(read('measurement-compare/app.js'),legacy.context);
  assert.deepEqual(JSON.parse(JSON.stringify(legacy.context.window.MeasureCompareTool.getResult())),JSON.parse(JSON.stringify(anonymous)));
  absent(JSON.stringify(legacy.context.window.MeasureCompareTool.getResult()));
});
