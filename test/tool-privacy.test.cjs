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
function environment() {
  const nodes = new Map(), blobs = [], downloads = [], clipboard = [];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', checked: false, innerHTML: '', textContent: id === 'saved-result' ? 'null' : '', style: {}, hidden: false, disabled: false, events: {}, classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(type, callback) { this.events[type] = callback; }, setAttribute() {}, removeAttribute() {}, scrollIntoView() {}, focus() {}, click() {},
      get options() { return [...this.innerHTML.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(m => ({ value: m[1], textContent: m[2], hidden: false })); }
    });
    return nodes.get(id);
  };
  const document = { getElementById: get, addEventListener() {}, createElement(tag) { return { click() { downloads.push(this.download); }, tagName: tag }; } };
  const context = vm.createContext({ window: {}, document, navigator: { clipboard: { writeText: async value => clipboard.push(value) } }, JSZip, Blob,
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
  const { context } = environment(), p = context.window.ToolPrivacy;
  assert.equal(p.alias('文件', secret), p.alias('文件', secret));
  assert.notEqual(p.alias('文件', secret), p.alias('文件', secret + '2'));
  assert.equal(p.alias('文件', p.alias('文件', secret)), p.alias('文件', secret));
  for (const value of ['W42','42_X','P12','seam12','weld23','焊点42']) assert.equal(p.engineering('标签',value), value);
  assert.equal(p.sn('00001234'), '00001234'); absent(p.sn(secret + '0002'));
  const mixed = p.engineering('标签',secret + ' W42'); absent(mixed); assert.match(mixed,/W42$/); assert.equal(p.engineering('标签',mixed),mixed);
  assert.equal(p.mode('CV ArMix'),'CV ArMix'); assert.equal(p.mode('PULSE Steel'),'PULSE Steel'); absent(p.mode('CV ' + secret));
  assert.equal(p.rawWeld('[10,0,[11,0,24,100]]'),'[10,0,[11,0,24,100]]'); absent(p.rawWeld('[10,"' + secret + '"]')); absent(p.safeError(Error(secret)));
});

test('weld display, alias filtering, CSV, TSV and XLSX all omit names without changing numeric parameters', async () => {
  const env = environment(), { context, get, blobs, clipboard, downloads } = env;
  context.window.JSZip = JSZip;
  vm.runInContext(read('xlsx-export.js'), context);
  const exports = [];
  context.XLSX = {...context.window.XLSX, writeFile: async (book, name) => { exports.push(await context.window.XLSX.toBytes(book)); downloads.push(name); }};
  vm.runInContext(read('weld-export/app.js'), context);
  const proc = 'WL_' + secret, text = `MODULE Test\nTASK PERS welddata weld1:=[10,0,[11,0,24,100]];\nCONST LincWeldModeData weld_Mode_11:=[11,"CV ArMix"];\nPROC ${proc}()\n! ${secret} W42\nArcLStart p1,v100,seam1,weld1,fine,tool0;\nArcLEnd p2,v100,seam1,weld1,fine,tool0;\nENDPROC\nENDMODULE`;
  const file = (name, content) => ({ name, webkitRelativePath: secret + '/TASK1/' + name, size: content.length, text: async () => content });
  await context.window.WeldExportTool.importFiles([file('MainModule.mod', `IF ${secret}_START=1 THEN\n${proc};\nENDIF`), file(secret + '.mod', text)]);
  const result = context.window.WeldExportTool.getResult(); assert.equal(result.rowCount,1); absent(JSON.stringify(result)); absent(env.surface());
  assert.deepEqual(Array.from(result.rows[0].slice(9,14)),[10,23.62,'11 CV ArMix',24,236.22]); assert.match(result.rows[0][6],/W42$/);
  context.pick(0); assert.equal(context.window.WeldExportTool.getResult().rowCount,1); absent(get('kw').value);
  context.exportCSV(); context.copyTSV(); await context.exportExcel();
  assert.equal(blobs.length,1); absent(await blobs[0].text()); absent(clipboard[0]); absent(downloads.join('|'));
  const zip=await JSZip.loadAsync(exports[0]); for (const entry of Object.values(zip.files)) if (!entry.dir) absent(await entry.async('string'));
  assert.match(await zip.file('xl/worksheets/sheet2.xml').async('string'), /<v>236\.22<\/v>/);
  await context.window.WeldExportTool.importFiles([{name:'bad.mod',size:1,text:async()=>{throw Error(secret);}}]); absent(env.surface());
});

test('comparison sanitization follows exact matching, preserves values and never exports hidden source metadata', () => {
  const {context}=environment(), {vision,cmm}=fixtures(context), p=context.window.ToolPrivacy;
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
  const env=environment(), {context,get}=env, {vision,cmm}=fixtures(context);
  const engine=context.window.MeasureCompareEngine;
  context.window.MeasureCompareEngine={...engine,readWorkbook:async value=>value};
  vm.runInContext(read('measurement-compare/app.js'),context);
  const file=(suffix,wb)=>({name:secret+suffix+'.xlsx',size:100,arrayBuffer:async()=>wb});
  await context.window.MeasureCompareTool.importFiles([file('_v',vision),file('_c',cmm)]);
  assert.equal(context.window.MeasureCompareTool.getResult().pairs.length,2); absent(env.surface()); absent(JSON.stringify(context.window.MeasureCompareTool.getResult()));
  assert.match(get('vision-sheet').innerHTML, /value="0"/); assert.match(get('vision-name').textContent,/^文件-/);
  get('vision-sheet').events.change({target:{value:'0'}}); assert.equal(context.window.MeasureCompareTool.getResult().items.length,1);
  const old=engine.compare(vision,vision.sheets[0].name,cmm,cmm.sheets[0].name);
  const offline=environment(); offline.get('saved-result').textContent=JSON.stringify({data:old,threshold:.2,saved_at:'2026-10-15'});
  vm.runInContext(read('measurement-compare/app.js'),offline.context); absent(JSON.stringify(offline.context.window.MeasureCompareTool.getResult()));
  for(const node of offline.nodes.values()) absent(node.innerHTML+node.textContent+node.value);
  // The download path serializes only safe results and removes hidden selected filenames/sheets.
  const code=read('measurement-compare/app.js'); assert.match(code,/data:privacy\.compareResult\(state\.data\)/); assert.match(code,/root\.querySelector\('#'\+type\+'-sheet'\)\.innerHTML=''/);
});
