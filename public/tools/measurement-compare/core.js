(function (global) {
  'use strict';
  const EPS = 1e-12;
  const MAX_INPUT_BYTES = 64 * 1024 * 1024;
  const MAX_XML_CHARS = 100 * 1024 * 1024;
  const MAX_ZIP_ENTRY_BYTES = 100 * 1024 * 1024;
  const MAX_ZIP_TOTAL_BYTES = 200 * 1024 * 1024;

  function clean(value) { return value == null ? '' : String(value).trim(); }
  function number(value) {
    if (value == null || typeof value === 'boolean') return null;
    const text = clean(value).replace(/\u2212/g, '-');
    if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
    const out = Number(text);
    return Number.isFinite(out) ? out : null;
  }
  function columnName(index) {
    let result = '';
    while (index > 0) { index--; result = String.fromCharCode(65 + index % 26) + result; index = Math.floor(index / 26); }
    return result;
  }
  function addressParts(address) {
    const m = /^([A-Z]+)([1-9]\d*)$/i.exec(address || '');
    if (!m) return null;
    let col = 0;
    for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
    return { row: Number(m[2]), col };
  }
  function elements(node, name) { return Array.from(node.getElementsByTagNameNS('*', name)); }
  function first(node, name) { return node.getElementsByTagNameNS('*', name)[0] || null; }
  function parseXML(text, filename) {
    if (text.length > MAX_XML_CHARS) throw new Error('工作表内容过大，请分批导出后导入。');
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('此文件包含不支持的 XML 定义，请重新另存为 .xlsx。');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || doc.getElementsByTagNameNS('*', 'parsererror').length) {
      throw new Error('无法读取 Excel 内部文件：' + filename + '。请在 Excel 中重新另存为 .xlsx。');
    }
    return doc;
  }
  function createZipTextReader(zip) {
    // JSZip 3.10.1 retains the central-directory size on loaded entries.
    // Validate every entry before any decompression, including unused ZIP parts.
    let declaredTotal = 0, actualTotal = 0;
    const declaredSizes = new Map();
    for (const file of Object.values(zip.files)) {
      if (file.dir) continue;
      // Loaded zero-length entries are normalized to a Promise by this JSZip version.
      // Treat them as declared empty and still reject any nonempty streamed output.
      const bytes = file._data?.uncompressedSize ?? (typeof file._data?.then === 'function' ? 0 : undefined);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Excel 压缩目录大小无效，请重新另存为 .xlsx。');
      if (bytes > MAX_ZIP_ENTRY_BYTES) throw new Error('Excel 解压后单个文件超过 100 MB，请缩小报告范围。');
      declaredTotal += bytes;
      if (!Number.isSafeInteger(declaredTotal) || declaredTotal > MAX_ZIP_TOTAL_BYTES) throw new Error('Excel 解压后文件合计超过 200 MB，请分批导入。');
      declaredSizes.set(file.name, bytes);
    }
    return file => new Promise((resolve, reject) => {
      const declared = declaredSizes.get(file.name), chunks = [];
      let size = 0, settled = false;
      const stream = file.internalStream('uint8array');
      function fail(error) { if (settled) return; settled = true; stream.pause(); chunks.length = 0; reject(error); }
      stream.on('data', chunk => {
        if (settled) return;
        size += chunk.byteLength; actualTotal += chunk.byteLength;
        // Check actual chunks too: an attacker can lie in the ZIP directory.
        if (size > MAX_ZIP_ENTRY_BYTES || actualTotal > MAX_ZIP_TOTAL_BYTES) {
          fail(new Error('Excel 实际展开内容超过大小限制，请缩小报告范围。')); return;
        }
        if (size > declared) { fail(new Error('Excel 压缩目录与实际展开大小不一致，请重新另存为 .xlsx。')); return; }
        chunks.push(chunk);
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (settled) return;
        if (size !== declared) { fail(new Error('Excel 压缩目录与实际展开大小不一致，请重新另存为 .xlsx。')); return; }
        try {
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          chunks.length = 0; const text = new TextDecoder('utf-8').decode(bytes);
          if (text.length > MAX_XML_CHARS) { fail(new Error('工作表内容过大，请分批导出后导入。')); return; }
          settled = true; resolve(text);
        } catch (error) { fail(error); }
      });
      stream.resume();
    });
  }
  function zipPath(base, target) {
    if (/^[a-z]+:/i.test(target)) return null;
    const combined = target.startsWith('/') ? target.slice(1) : base + '/' + target;
    const out = [];
    for (const part of combined.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!out.length) return null; out.pop(); } else out.push(part);
    }
    return out.join('/');
  }
  function normalizeSn(value, stripDateSuffix) {
    let sn = clean(value).replace(/[\s\u200B-\u200D\uFEFF]/g, '');
    let date = '';
    if (stripDateSuffix !== false) {
      const m = /^(.+)-(\d{1,2}[./]\d{1,2}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$/.exec(sn);
      if (m) {
        const bits = m[2].split(/[-/.]/).map(Number);
        const month = bits.length === 3 ? bits[1] : bits[0];
        const day = bits.length === 3 ? bits[2] : bits[1];
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) { sn = m[1]; date = m[2]; }
      }
    }
    return { sn, date };
  }
  function cellAt(sheet, row, col) { return sheet.rows.get(row)?.get(col) || null; }
  function valueAt(sheet, row, col) { return cellAt(sheet, row, col)?.value ?? ''; }
  function numericCell(sheet, row, col) {
    const cell = cellAt(sheet, row, col);
    return !cell || cell.type === 'e' || cell.type === 'b' ? null : number(cell.value);
  }
  function cellIdentity(cell) {
    if (!cell) return null;
    const numeric = cell.type !== 'e' && cell.type !== 'b' ? number(cell.value) : null;
    return numeric === null ? [cell.type, cell.value] : numeric;
  }
  function pad(number, digits) { return String(number).padStart(digits || 2, '0'); }
  function excelDate(serial, date1904) {
    const n = number(serial);
    if (n === null || n < 1 || n > 2958465) return clean(serial);
    const date = new Date((date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) + Math.round(n * 86400000));
    if (!Number.isFinite(date.getTime())) return clean(serial);
    return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) + ' ' +
      pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ':' + pad(date.getUTCSeconds());
  }
  function timeAt(sheet, row, col, date1904) {
    const cell = cellAt(sheet, row, col);
    if (!cell) return '';
    if (cell.type === 'n' && number(cell.value) !== null) return excelDate(cell.value, date1904);
    return clean(cell.value).replace('T', ' ').replace(/\.000Z$/, '');
  }
  function snValue(cell) {
    if (!cell) return '';
    // Text is deliberately never converted to a number; a zero-only Excel format is also retained.
    if (cell.type === 'n' && /^0+$/.test(cell.format || '') && /^\d+$/.test(cell.value)) return cell.value.padStart(cell.format.length, '0');
    return cell.value;
  }
  function pointID(value) {
    const m = /^(?:P)?(?:位置|点位|点)?\s*(\d+)(?:\.0)?(?=\D|$)/i.exec(clean(value));
    return m ? String(Number(m[1])) : null;
  }
  function visionPoint(value) {
    const m = /^(?:P)?(?:位置|点位|点)?\s*(\d+)\s*[_\- ]\s*([XYZ])$/i.exec(clean(value));
    return m ? { point: String(Number(m[1])), axis: m[2].toUpperCase(), key: String(Number(m[1])) + '_' + m[2].toUpperCase() } : null;
  }
  function headerToken(value) { return clean(value).toLowerCase().replace(/[\s_：:]/g, ''); }
  function findHeader(sheet, tokens) {
    for (const [row, cols] of sheet.rows) {
      for (const [col, cell] of cols) if (tokens.includes(headerToken(cell.value))) return { row, col };
    }
    return null;
  }
  function describeVision(sheet) {
    const snHeader = findHeader(sheet, ['sn', 'serialnumber', '工件编号', '工件号', '条码']);
    const nameHeader = findHeader(sheet, ['name', '测量名称', '测量项', '点位']);
    if (!snHeader || !nameHeader) return null;
    const nominalHeader = [...(sheet.rows.get(nameHeader.row) || [])].find(([, c]) => ['nominal', '理论值', '名义值'].includes(headerToken(c.value)));
    if (!nominalHeader) return null;
    const nominalCol = nominalHeader[0];
    const timeHeader = findHeader(sheet, ['timestamp', 'time', '测量时间', '时间']);
    const resultHeader = findHeader(sheet, ['result', '结果', '判定']);
    const metrics = [], excluded = [], allMetricRows = [];
    for (const [row, cols] of sheet.rows) {
      if (row <= nameHeader.row) continue;
      const label = clean(cols.get(nameHeader.col)?.value);
      if (!label) continue;
      const parsed = visionPoint(label);
      if (parsed) {
        allMetricRows.push(row);
        metrics.push({ ...parsed, label, row, nominal: numericCell(sheet, row, nominalCol) });
      } else if (pointID(label) !== null) {
        allMetricRows.push(row);
        excluded.push({ key: label, row, reason: '当前工具比较 X、Y、Z；此项目未纳入。' });
      }
    }
    if (!metrics.length) return null;
    const dataCols = [];
    for (const [col, cell] of sheet.rows.get(snHeader.row) || []) {
      if (col <= nominalCol || col === snHeader.col || !clean(cell.value)) continue;
      const header = clean(valueAt(sheet, nameHeader.row, col));
      const hasMetric = allMetricRows.some(row => cellAt(sheet, row, col) !== null);
      if (/^dev\d*$/i.test(header) || hasMetric) dataCols.push(col);
    }
    dataCols.sort((a, b) => a - b);
    if (!dataCols.length) return null;
    return { kind: 'vision', metrics, excluded, allMetricRows, dataCols, snRow: snHeader.row, timeRow: timeHeader?.row || null,
      resultRow: resultHeader?.row || null, nominalCol, record_count: dataCols.length, item_count: metrics.length };
  }
  function possibleSN(value) {
    const x = normalizeSn(value, true).sn;
    return x.length >= 4 && /\d/.test(x) && !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(x) &&
      !/^\d{1,2}[-/.]\d{1,2}$/.test(x) && !/^(?:dev|nominal|standard|item)/i.test(x);
  }
  function describeCmm(sheet) {
    let header = null;
    for (const [row, cols] of sheet.rows) {
      const entries = [...cols];
      const item = entries.find(([, c]) => ['item', '点位', '测量点', '项目'].includes(headerToken(c.value)));
      const axis = entries.find(([, c]) => ['checkitem', '方向', '测量方向', '检查项'].includes(headerToken(c.value)));
      const nominal = entries.find(([, c]) => ['nominal', '理论值', '名义值'].includes(headerToken(c.value)));
      if (item && axis && nominal) { header = { row, pointCol: item[0], axisCol: axis[0], nominalCol: nominal[0] }; break; }
    }
    if (!header) return null;
    const metrics = [], invalidNominals = [], allMetricRows = [];
    let firstMetricRow = Infinity;
    for (const [row, cols] of sheet.rows) {
      if (row <= header.row) continue;
      const label = clean(cols.get(header.pointCol)?.value);
      const point = pointID(label);
      if (point === null) continue;
      const axis = clean(cols.get(header.axisCol)?.value).toUpperCase();
      if (!axis) continue;
      allMetricRows.push(row);
      firstMetricRow = Math.min(row, firstMetricRow);
      if (!/^[XYZ]$/.test(axis)) continue;
      const metric = { key: point + '_' + axis, point, axis, row, label, nominal: numericCell(sheet, row, header.nominalCol) };
      if (metric.nominal === null) invalidNominals.push(metric); else metrics.push(metric);
    }
    if (!metrics.length) return null;
    let snRow = null, dataCols = [];
    for (const [row, cols] of sheet.rows) {
      if (row < header.row || row >= firstMetricRow) continue;
      const candidates = [...cols].filter(([col, cell]) => col > header.nominalCol && possibleSN(snValue(cell))).map(([col]) => col);
      if (candidates.length > dataCols.length) { snRow = row; dataCols = candidates; }
    }
    if (!dataCols.length) return null;
    dataCols.sort((a, b) => a - b);
    return { kind: 'cmm', metrics, invalidNominals, allMetricRows, dataCols, snRow, ...header,
      record_count: dataCols.length, item_count: metrics.length };
  }
  function classify(sheet) {
    const vision = describeVision(sheet);
    const cmm = describeCmm(sheet);
    sheet._vision = vision;
    sheet._cmm = cmm;
    sheet.detectedKind = vision && cmm ? 'ambiguous' : vision ? 'vision' : cmm ? 'cmm' : 'unknown';
  }
  async function readWorkbook(arrayBuffer, filename) {
    const size = arrayBuffer?.byteLength;
    if (!size) throw new Error('文件为空，无法读取。');
    if (size > MAX_INPUT_BYTES) throw new Error('单个 Excel 超过 64 MB，请按时间范围分批导出。');
    if (!global.JSZip) throw new Error('Excel 读取组件未加载，请重新打开完整 HTML 文件。');
    let zip;
    try { zip = await global.JSZip.loadAsync(arrayBuffer); }
    catch (_) { throw new Error('无法读取“' + clean(filename) + '”。请导入未加密的 .xlsx 或 .xlsm 文件；旧版 .xls 请先另存为 .xlsx。'); }
    const readText = createZipTextReader(zip);
    const workbookFile = zip.file('xl/workbook.xml');
    const relationFile = zip.file('xl/_rels/workbook.xml.rels');
    if (!workbookFile || !relationFile) throw new Error('此文件不是受支持的 Excel 工作簿，请重新另存为 .xlsx。');
    const workbookDoc = parseXML(await readText(workbookFile), 'workbook.xml');
    const relationDoc = parseXML(await readText(relationFile), 'workbook.xml.rels');
    const relationMap = new Map();
    for (const rel of elements(relationDoc, 'Relationship')) {
      if (rel.getAttribute('TargetMode') === 'External') continue;
      relationMap.set(rel.getAttribute('Id'), { target: zipPath('xl', rel.getAttribute('Target') || ''), type: rel.getAttribute('Type') || '' });
    }
    const getRelation = suffix => [...relationMap.values()].find(r => r.type.endsWith('/' + suffix))?.target;
    const sharedPath = getRelation('sharedStrings') || 'xl/sharedStrings.xml';
    const stylePath = getRelation('styles') || 'xl/styles.xml';
    const strings = [];
    if (zip.file(sharedPath)) {
      const doc = parseXML(await readText(zip.file(sharedPath)), sharedPath);
      for (const si of elements(doc, 'si')) strings.push(elements(si, 't').map(t => t.textContent || '').join(''));
    }
    const formats = [], formatMap = new Map();
    if (zip.file(stylePath)) {
      const doc = parseXML(await readText(zip.file(stylePath)), stylePath);
      for (const format of elements(doc, 'numFmt')) formatMap.set(Number(format.getAttribute('numFmtId')), format.getAttribute('formatCode') || '');
      const xfs = first(doc, 'cellXfs');
      if (xfs) for (const xf of elements(xfs, 'xf')) formats.push(formatMap.get(Number(xf.getAttribute('numFmtId'))) || '');
    }
    const date1904 = ['1', 'true'].includes(first(workbookDoc, 'workbookPr')?.getAttribute('date1904'));
    const workbook = { name: clean(filename) || 'Excel.xlsx', sheets: [], date1904, warnings: [] };
    for (const element of elements(workbookDoc, 'sheet')) {
      const id = element.getAttribute('r:id') || element.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      const relation = relationMap.get(id);
      if (!relation?.target || !relation.type.endsWith('/worksheet')) continue;
      const file = zip.file(relation.target);
      if (!file) { workbook.warnings.push('未能读取工作表：' + element.getAttribute('name')); continue; }
      const doc = parseXML(await readText(file), relation.target);
      const sheet = { name: element.getAttribute('name') || 'Sheet', cells: new Map(), rows: new Map(), detectedKind: 'unknown' };
      for (const c of elements(doc, 'c')) {
        const address = c.getAttribute('r');
        const pos = addressParts(address);
        if (!pos) continue;
        const type = c.getAttribute('t') || 'n';
        const v = first(c, 'v');
        let value = '';
        if (type === 's') value = v ? strings[Number(v.textContent)] ?? '' : '';
        else if (type === 'inlineStr') value = elements(c, 't').map(t => t.textContent || '').join('');
        else if (v) value = v.textContent || '';
        // Ignore all styled empty cells: worksheet dimensions are intentionally never used.
        if (!clean(value)) continue;
        const cell = { address, ...pos, value, type, format: formats[Number(c.getAttribute('s') || 0)] || '', hasFormula: Boolean(first(c, 'f')) };
        sheet.cells.set(address, cell);
        if (!sheet.rows.has(pos.row)) sheet.rows.set(pos.row, new Map());
        sheet.rows.get(pos.row).set(pos.col, cell);
      }
      sheet.rows = new Map([...sheet.rows].sort((a, b) => a[0] - b[0]));
      classify(sheet);
      workbook.sheets.push(sheet);
    }
    if (!workbook.sheets.length) throw new Error('此工作簿没有可读取的工作表。');
    return workbook;
  }
  function inspectWorkbook(workbook) {
    const sheets = workbook.sheets.map(sheet => ({ name: sheet.name, kind: sheet.detectedKind,
      detectedKind: sheet.detectedKind, record_count: (sheet._vision || sheet._cmm)?.record_count || 0,
      item_count: (sheet._vision || sheet._cmm)?.item_count || 0, nonempty_cells: sheet.cells.size }));
    return { name: workbook.name, sheets,
      visionSheets: sheets.filter(s => s.kind === 'vision'), cmmSheets: sheets.filter(s => s.kind === 'cmm'), warnings: workbook.warnings || [] };
  }
  function groupBy(array, fn) {
    const out = new Map();
    for (const entry of array) { const key = fn(entry); if (!out.has(key)) out.set(key, []); out.get(key).push(entry); }
    return out;
  }
  function stats(pairs) {
    const values = pairs.map(p => p.diff), n = values.length;
    const mean = n ? values.reduce((a, b) => a + b, 0) / n : null;
    const min = n ? Math.min(...values) : null, max = n ? Math.max(...values) : null;
    return { n, mean, min, max, range: n ? max - min : null, max_abs: n ? Math.max(Math.abs(min), Math.abs(max)) : null,
      exceed_count: values.filter(d => Math.abs(d) > 0.2 + EPS).length,
      sd: n > 1 ? Math.sqrt(values.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (n - 1)) : null };
  }
  function compare(visionWorkbook, visionSheetName, cmmWorkbook, cmmSheetName) {
    const vs = visionWorkbook.sheets.find(s => s.name === visionSheetName);
    const cs = cmmWorkbook.sheets.find(s => s.name === cmmSheetName);
    if (!vs?._vision) throw new Error('所选工作表未识别为现场检具格式。请选含 SN、TimeStamp、Name、Nominal 的横向数据表。');
    if (!cs?._cmm) throw new Error('所选工作表未识别为三坐标格式。请选含 Item、Check Item、Nominal 及工件编号的结果表。');
    const vd = vs._vision, cd = cs._cmm;
    const diagnostics = { messages: [], warnings: [], excluded_items: [...vd.excluded], nominal_adjustments: [],
      missing_values: [], missing_value_count: 0, unmatched_cmm: [], unmatched_vision: [],
      duplicate_vision_records: 0, duplicate_cmm_records: 0, repeated_vision: [], ambiguous_cmm_sns: [],
      cmm_rows_without_nominal: cd.invalidNominals.map(m => ({ key: m.key, row: m.row, label: m.label })),
      unsafe_numeric_sns: [], empty_sn_columns: [] };
    const warn = (code, message, context) => diagnostics.warnings.push({ code, message, ...(context || {}) });
    const snFor = (sheet, row, col, stripDate) => {
      const cell = cellAt(sheet, row, col);
      const value = snValue(cell);
      // Excel stores at most 15 significant decimal digits. Check numeric magnitude,
      // including scientific notation; converting a rounded long barcode cannot recover it.
      const numericSN = cell?.type === 'n' ? number(cell.value) : null;
      if (cell?.type === 'n' && (numericSN === null || Math.abs(numericSN) >= 1e15)) {
        diagnostics.unsafe_numeric_sns.push({ sheet: sheet.name, cell: columnName(col) + row, value });
        return { sn: '', date: '' };
      }
      return normalizeSn(value, stripDate);
    };
    const visionRecords = [], seenVision = new Set();
    for (const col of vd.dataCols) {
      const id = snFor(vs, vd.snRow, col, false);
      if (!id.sn) { diagnostics.empty_sn_columns.push({ sheet: vs.name, col: columnName(col) }); continue; }
      const time = vd.timeRow ? timeAt(vs, vd.timeRow, col, visionWorkbook.date1904) : '';
      const result = vd.resultRow ? clean(valueAt(vs, vd.resultRow, col)) : '';
      const fingerprint = JSON.stringify([id.sn, time, result, vd.allMetricRows.map(row => cellIdentity(cellAt(vs, row, col)))]);
      if (seenVision.has(fingerprint)) { diagnostics.duplicate_vision_records++; continue; }
      seenVision.add(fingerprint);
      visionRecords.push({ sn: id.sn, short_sn: id.sn.slice(-9), vision_time: time, vision_result: result, col, vision_col: columnName(col) });
    }
    const cmmRecords = [], seenCmm = new Set();
    for (const col of cd.dataCols) {
      const id = snFor(cs, cd.snRow, col, true);
      if (!id.sn) continue;
      const fingerprint = JSON.stringify([id.sn, id.date, cd.allMetricRows.map(row => cellIdentity(cellAt(cs, row, col)))]);
      if (seenCmm.has(fingerprint)) { diagnostics.duplicate_cmm_records++; continue; }
      seenCmm.add(fingerprint);
      cmmRecords.push({ sn: id.sn, cmm_date: id.date, col, cmm_col: columnName(col) });
    }
    const visionsBySN = groupBy(visionRecords, x => x.sn), cmmsBySN = groupBy(cmmRecords, x => x.sn);
    for (const [sn, records] of visionsBySN) if (records.length > 1) diagnostics.repeated_vision.push({ sn, count: records.length, times: records.map(r => r.vision_time) });
    const pairs = [];
    for (const [sn, cmmEntries] of cmmsBySN) {
      if (cmmEntries.length > 1) {
        diagnostics.ambiguous_cmm_sns.push({ sn, count: cmmEntries.length, columns: cmmEntries.map(r => r.cmm_col), dates: cmmEntries.map(r => r.cmm_date) });
        continue;
      }
      const visionEntries = visionsBySN.get(sn);
      if (!visionEntries) { diagnostics.unmatched_cmm.push({ sn, cmm_col: cmmEntries[0].cmm_col, cmm_date: cmmEntries[0].cmm_date }); continue; }
      const cmm = cmmEntries[0];
      visionEntries.sort((a, b) => a.vision_time.localeCompare(b.vision_time) || a.col - b.col);
      visionEntries.forEach((vision, index) => {
        pairs.push({ sn, short_sn: vision.short_sn, vision_time: vision.vision_time, vision_result: vision.vision_result,
          cmm_date: cmm.cmm_date, date: cmm.cmm_date, vision_col: vision.vision_col, cmm_col: cmm.cmm_col,
          vision_col_index: vision.col, cmm_col_index: cmm.col, repeat_index: index + 1, repeat_count: visionEntries.length,
          repeat_label: visionEntries.length > 1 ? '现场第 ' + (index + 1) + '/' + visionEntries.length + ' 次测量' : '',
          pair_id: sn + '|' + vision.vision_col + '|' + cmm.cmm_col });
      });
    }
    pairs.sort((a, b) => a.vision_time.localeCompare(b.vision_time) || a.vision_col_index - b.vision_col_index);
    for (const [sn, records] of visionsBySN) if (!cmmsBySN.has(sn)) diagnostics.unmatched_vision.push({ sn, count: records.length });
    const visionMetrics = groupBy(vd.metrics, x => x.key), cmmMetrics = groupBy(cd.metrics, x => x.key);
    const items = [];
    for (const [key, metrics] of visionMetrics) {
      if (metrics.length > 1) { diagnostics.excluded_items.push({ key, reason: '现场有多个同名点位方向，未自动选择。', rows: metrics.map(m => m.row) }); continue; }
      const vm = metrics[0], candidates = cmmMetrics.get(key) || [];
      if (vm.nominal === null) { diagnostics.excluded_items.push({ key, reason: '现场理论值缺失或不是数值。', row: vm.row }); continue; }
      if (!candidates.length) { diagnostics.excluded_items.push({ key, reason: '三坐标未找到点号、方向相同且有理论值的项目。' }); continue; }
      if (candidates.length > 1) { diagnostics.excluded_items.push({ key, reason: '三坐标有多个同名点位方向，未自动选择。', rows: candidates.map(m => m.row) }); continue; }
      const cm = candidates[0], offset = vm.nominal - cm.nominal;
      if (Math.abs(offset) > 0.1 + EPS) {
        diagnostics.excluded_items.push({ key, reason: '两表理论值相差超过 0.1，需确认是否为同一测量项。', vision_nominal: vm.nominal, cmm_nominal: cm.nominal }); continue;
      }
      if (Math.abs(offset) > EPS) diagnostics.nominal_adjustments.push({ key, vision_nominal: vm.nominal, cmm_nominal: cm.nominal, offset });
      const itemPairs = [];
      for (const pair of pairs) {
        const vision = numericCell(vs, vm.row, pair.vision_col_index), cmm = numericCell(cs, cm.row, pair.cmm_col_index);
        const visionCell = pair.vision_col + vm.row, cmmCell = pair.cmm_col + cm.row;
        if (vision === null || cmm === null) {
          diagnostics.missing_value_count++;
          if (diagnostics.missing_values.length < 300) diagnostics.missing_values.push({ key, sn: pair.sn, pair_id: pair.pair_id,
            vision_cell: visionCell, cmm_cell: cmmCell, reason: vision === null && cmm === null ? '两表数值均缺失或无效' : vision === null ? '现场值缺失或无效' : '三坐标值缺失或无效' });
          continue;
        }
        itemPairs.push({ ...pair, vision, cmm, vision_normalized: vision + offset, diff: vision - cmm + offset,
          raw_diff: vision - cmm, nominal_offset: offset, vision_cell: visionCell, cmm_cell: cmmCell });
      }
      if (!itemPairs.length) { diagnostics.excluded_items.push({ key, reason: pairs.length ? '已匹配工件在此项目没有有效的两表数值。' : '没有匹配工件，暂不能比较。' }); continue; }
      items.push({ key, point: vm.point, axis: vm.axis, vision_label: vm.label, cmm_label: cm.label,
        vision_nominal: vm.nominal, cmm_nominal: cm.nominal, nominal_offset: offset,
        vision_row: vm.row, cmm_row: cm.row, pairs: itemPairs, ...stats(itemPairs) });
    }
    items.sort((a, b) => Number(a.point) - Number(b.point) || a.axis.localeCompare(b.axis));
    if (diagnostics.ambiguous_cmm_sns.length) warn('ambiguous_cmm_sn', diagnostics.ambiguous_cmm_sns.length + ' 个工件在三坐标有不同记录，已跳过，避免配错。');
    if (diagnostics.repeated_vision.length) warn('repeated_vision', diagnostics.repeated_vision.length + ' 个现场工件有多次测量；各次均保留并单独标记。');
    if (diagnostics.duplicate_vision_records || diagnostics.duplicate_cmm_records) warn('exact_duplicates', '完全相同的重复导出已合并：现场 ' + diagnostics.duplicate_vision_records + ' 条，三坐标 ' + diagnostics.duplicate_cmm_records + ' 条。');
    if (diagnostics.unsafe_numeric_sns.length) warn('unsafe_numeric_sn', diagnostics.unsafe_numeric_sns.length + ' 个编号以超过 15 位的 Excel 数字存储，不能保证编号准确，已跳过。');
    if (diagnostics.unmatched_cmm.length) warn('unmatched_cmm', diagnostics.unmatched_cmm.length + ' 个三坐标工件在现场表找不到相同完整编号。');
    if (diagnostics.missing_value_count) warn('missing_values', diagnostics.missing_value_count + ' 组点位数据缺失或无效，未按 0 计算。');
    if (!pairs.length) warn('no_matches', '没有找到可唯一匹配的完整工件编号，请查看未匹配原因。');
    if (pairs.length && !items.length) warn('no_items', '工件编号已匹配，但没有可比较的同名点位方向。');
    diagnostics.messages = diagnostics.warnings.map(w => w.message);
    const allDiffs = items.flatMap(item => item.pairs.map(p => p.diff));
    return { version: '1.0.0', items, pairs, diagnostics,
      vision_file: visionWorkbook.name, cmm_file: cmmWorkbook.name, vision_sheet: vs.name, cmm_sheet: cs.name,
      vision_count: vd.dataCols.length, vision_unique: visionsBySN.size, vision_unique_record_count: visionRecords.length,
      cmm_count: cd.dataCols.length, cmm_unique: cmmsBySN.size, cmm_unique_record_count: cmmRecords.length,
      matched_unique_sn_count: new Set(pairs.map(p => p.sn)).size, paired_record_count: pairs.length,
      point_count: new Set(items.map(i => i.point)).size, item_count: items.length,
      comparison_count: allDiffs.length, exceed_count: allDiffs.filter(d => Math.abs(d) > 0.2 + EPS).length,
      any_exceed_item_count: items.filter(i => i.exceed_count > 0).length,
      vision_start: visionRecords.map(r => r.vision_time).filter(Boolean).sort()[0] || '',
      vision_end: visionRecords.map(r => r.vision_time).filter(Boolean).sort().at(-1) || '',
      threshold: 0.2, unit: 'mm', formula: 'diff = vision - cmm + vision_nominal - cmm_nominal' };
  }
  global.MeasureCompareEngine = Object.freeze({ version: '1.0.0', readWorkbook, inspectWorkbook, compare, normalizeSn, columnName });
})(typeof window !== 'undefined' ? window : globalThis);
