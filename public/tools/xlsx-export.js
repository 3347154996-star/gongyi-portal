'use strict';
// Small XLSX writer for the tool's existing array-of-arrays export contract.
// All strings are inline strings (never formulas), and ZIP comes from the bundled JSZip.
((global) => {
  const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]));
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  function column(index) { let out = ''; while (index > 0) { index--; out = String.fromCharCode(65 + index % 26) + out; index = Math.floor(index / 26); } return out; }
  function sheetXML(sheet) {
    const cols = (sheet['!cols'] || []).map((v, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(1, Math.min(255, Number(v.wch) || 12))}" customWidth="1"/>`).join('');
    const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
      if (v == null || v === '') return '';
      const address = column(c + 1) + (r + 1), style = r === 0 ? ' s="1"' : '';
      return typeof v === 'number' && Number.isFinite(v) ? `<c r="${address}"${style}><v>${v}</v></c>` : `<c r="${address}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols ? '<cols>' + cols + '</cols>' : ''}<sheetData>${rows}</sheetData></worksheet>`;
  }
  async function toBytes(book) {
    if (!global.JSZip) throw new Error('本地 Excel 导出组件未加载，请刷新页面后重试。');
    if (!book.sheets?.length) throw new Error('工作簿没有可导出的工作表。');
    const zip = new global.JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${book.sheets.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
    zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file('xl/workbook.xml', `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>${book.sheets.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`);
    zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${book.sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="${rel}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="styles" Type="${rel}/styles" Target="styles.xml"/></Relationships>`);
    zip.file('xl/styles.xml', `<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
    book.sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXML(s.sheet)));
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }
  global.XLSX = Object.freeze({
    utils: Object.freeze({
      aoa_to_sheet: rows => ({ rows: rows.map(row => [...row]) }),
      book_new: () => ({ sheets: [] }),
      book_append_sheet(book, sheet, name) { if (!name || name.length > 31 || /[\\/?*\[\]:]/.test(name) || book.sheets.some(s=>s.name===name)) throw new Error('工作表名称无效或重复。'); book.sheets.push({ name, sheet }); }
    }),
    toBytes,
    async writeFile(book, filename) {
      const bytes = await toBytes(book), url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
