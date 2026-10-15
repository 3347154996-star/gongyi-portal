(function (global) {
  'use strict';
  // Local aliases are independent of the portal's server-side product catalog.
  // They are display identifiers, not encryption or a promise of irreversible anonymization.
  const kinds = new Set(['文件','工作表','程序','信号','标签','焊接数据','焊缝数据','模式说明','工件','配对','测点','字段']);
  function alias(kind, value) {
    const text = String(value ?? '').trim(); if (!text) return '';
    if (/^(?:文件|工作表|程序|信号|标签|焊接数据|焊缝数据|模式说明|工件|配对|测点|字段)-[0-9A-Z]{13}(?: \/ [WP]\d+(?:_[XYZ])?)*$/.test(text)) return text;
    const prefix = kinds.has(kind) ? kind : '字段';
    let hash = 14695981039346656037n;
    for (const ch of prefix + '\0' + text) { hash ^= BigInt(ch.codePointAt(0)); hash = BigInt.asUintN(64, hash * 1099511628211n); }
    return prefix + '-' + hash.toString(36).toUpperCase().padStart(13, '0');
  }
  function engineering(kind, value) {
    const text = String(value ?? '').trim();
    // Preserve unambiguous point/data syntax, never a free-text suffix.
    if (/^(?:\d+(?:[_.\/-]\d+)*|[WP]?\d+(?:[_ -][XYZ])?|[XYZ]|(?:weld|seam)\d+|(?:焊点|焊缝|点位|点)\s*\d+)$/i.test(text)) return text;
    if (/^(?:标签|焊接数据|焊缝数据|测点)-[0-9A-Z]{13}(?: \/ [WP]\d+(?:_[XYZ])?)*$/.test(text)) return text;
    const points = [...text.matchAll(/(?:^|[\s_:/-])(?:W|WP|P|焊点|焊缝|点位|点)\s*(\d+)(?:[_-]([XYZ]))?(?=$|[\s_:/-])/gi)].map(m => 'W' + m[1] + (m[2] ? '_' + m[2].toUpperCase() : ''));
    return alias(kind, text) + [...new Set(points)].map(p => ' / ' + p).join('');
  }
  const sn = value => /^\d+$/.test(String(value ?? '')) ? String(value) : alias('工件', value);
  function mode(value) {
    const text = String(value ?? '').trim();
    return /^(?:CV|CC|PULSE|STT|GMAW|FCAW|MIG|MAG|TIG)(?:[ _-](?:ArMix|CO2|Ar|Steel|Stainless|Aluminum|Aluminium|Pulse|Spray|Short|Arc|AC|DC|\d+(?:\.\d+)?))*$/i.test(text) ? text : alias('模式说明', text);
  }
  function rawWeld(value) {
    try {
      const scrub = v => Array.isArray(v) ? v.map(scrub) : typeof v === 'number' || v === null || typeof v === 'boolean' ? v : typeof v === 'string' ? alias('字段', v) : null;
      const parsed = JSON.parse(value); return Array.isArray(parsed) ? JSON.stringify(scrub(parsed)) : '声明格式待核对';
    } catch (_) { return '声明格式待核对'; }
  }
  const reasons = new Set(['当前工具比较 X、Y、Z；此项目未纳入。','现场有多个同名点位方向，未自动选择。','现场理论值缺失或不是数值。','三坐标未找到点号、方向相同且有理论值的项目。','三坐标有多个同名点位方向，未自动选择。','两表理论值相差超过 0.1，需确认是否为同一测量项。','两表数值均缺失或无效','现场值缺失或无效','三坐标值缺失或无效','已匹配工件在此项目没有有效的两表数值。','没有匹配工件，暂不能比较。']);
  const numericKeys = new Set('vision cmm vision_normalized diff raw_diff nominal_offset vision_nominal cmm_nominal vision_row cmm_row vision_col_index cmm_col_index repeat_count repeat_index n min max mean max_abs spread exceed_count count row col offset vision_count vision_unique vision_unique_record_count cmm_count cmm_unique cmm_unique_record_count matched_unique_sn_count paired_record_count point_count item_count comparison_count any_exceed_item_count threshold missing_value_count duplicate_vision_records duplicate_cmm_records'.split(' '));
  const dateKeys = new Set(['vision_time','cmm_date','date','vision_start','vision_end']);
  function field(key, value) {
    if (key === 'col' && typeof value === 'string') return /^[A-Z]{1,4}$/.test(value) ? value : '';
    if (numericKeys.has(key)) return typeof value === 'number' && Number.isFinite(value) ? value : null;
    if (dateKeys.has(key)) return /^[\d\sT:./+-]+$/.test(String(value ?? '')) ? String(value) : '';
    if (key === 'sn' || key === 'short_sn') return sn(value);
    if (key === 'pair_id') return alias('配对', value);
    if (['key','point','axis'].includes(key)) return engineering('测点', value);
    if (['vision_label','cmm_label','label'].includes(key)) return engineering('测点', value);
    if (['vision_col','cmm_col','vision_cell','cmm_cell','cell'].includes(key)) return /^[A-Z]{1,4}\d*$/.test(String(value)) ? String(value) : '';
    if (key === 'vision_result') return /^(?:OK|NG|PASS|FAIL)$/i.test(String(value)) ? String(value) : '';
    if (key === 'sheet') return alias('工作表', value);
    if (key === 'value') return sn(value);
    if (key === 'reason') return reasons.has(value) ? value : '请核对原始报告。';
    if (key === 'times' || key === 'dates') return Array.isArray(value) ? value.map(v => field('date', v)) : [];
    if (key === 'columns') return Array.isArray(value) ? value.map(v => field('vision_col', v)) : [];
    if (key === 'rows') return Array.isArray(value) ? value.filter(Number.isFinite) : [];
    return undefined;
  }
  function record(value) {
    const out = {}; for (const [key,v] of Object.entries(value || {})) { const safe = field(key,v); if (safe !== undefined) out[key] = safe; }
    if ('sn' in out) out.short_sn = /^\d+$/.test(out.sn) ? out.sn.slice(-9) : out.sn;
    return out;
  }
  const diagnosticKeys = new Set('unmatched_cmm unmatched_vision ambiguous_cmm_sns repeated_vision missing_values missing_value_count excluded_items nominal_adjustments cmm_rows_without_nominal unsafe_numeric_sns empty_sn_columns duplicate_vision_records duplicate_cmm_records'.split(' '));
  function compareResult(raw) {
    const out = record(raw);
    out.version = '1.0.0'; out.unit = 'mm'; out.formula = 'diff = vision - cmm + vision_nominal - cmm_nominal';
    out.pairs = (raw.pairs || []).map(record);
    out.items = (raw.items || []).map(item => ({ ...record(item), pairs: (item.pairs || []).map(record) }));
    out.source_names = { vision: alias('文件', raw.source_names?.vision || raw.vision_file), cmm: alias('文件', raw.source_names?.cmm || raw.cmm_file) };
    out.source_sheets = { vision: alias('工作表', raw.source_sheets?.vision || raw.vision_sheet), cmm: alias('工作表', raw.source_sheets?.cmm || raw.cmm_sheet) };
    out.vision_file = out.source_names.vision; out.cmm_file = out.source_names.cmm; out.vision_sheet = out.source_sheets.vision; out.cmm_sheet = out.source_sheets.cmm;
    out.diagnostics = {};
    for (const [key,value] of Object.entries(raw.diagnostics || {})) if (diagnosticKeys.has(key)) out.diagnostics[key] = Array.isArray(value) ? value.map(v => typeof v === 'object' ? record(v) : { value: sn(v) }) : field(key,value);
    return out;
  }
  const errors = new Set(['请使用 .xlsx 或 .xlsm 文件；其他格式请先另存为 .xlsx。','文件超过 64 MB，请导出所需日期范围后再导入。','文件同时包含两种报表，请分别放入对应的导入框。','未识别为当前现场检具或三坐标模板，请检查表头与工作表。','文件为空，无法读取。','单个 Excel 超过 64 MB，请按时间范围分批导出。','工作表内容过大，请分批导出后导入。','此文件包含不支持的 XML 定义，请重新另存为 .xlsx。','Excel 解压后单个文件超过 100 MB，请缩小报告范围。','Excel 解压后文件合计超过 200 MB，请分批导入。','Excel 实际展开内容超过大小限制，请缩小报告范围。','Excel 压缩目录大小无效，请重新另存为 .xlsx。','Excel 压缩目录与实际展开大小不一致，请重新另存为 .xlsx。','所选工作表未识别为现场检具格式。请选含 SN、TimeStamp、Name、Nominal 的横向数据表。','所选工作表未识别为三坐标格式。请选含 Item、Check Item、Nominal 及工件编号的结果表。','这两个文件都识别为现场检具报告，请各导入一份。','这两个文件都识别为三坐标报告，请各导入一份。','无法读取本地样式，请刷新工具页面后重试。','无法读取本地组件，请刷新工具页面后重试。']);
  function safeError(error) { const message = error?.message; return errors.has(message) ? message : '文件或组件无法读取，请检查格式、完整性和访问权限后重试。'; }
  global.ToolPrivacy = Object.freeze({ alias, engineering, sn, mode, rawWeld, compareResult, safeError });
})(typeof window !== 'undefined' ? window : globalThis);
