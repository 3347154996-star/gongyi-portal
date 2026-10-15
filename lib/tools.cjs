'use strict';

const VERSION = '1.0.0';
const copy = value => JSON.parse(JSON.stringify(value));
const tools = [
  { id: 'weld-export', title: '焊接参数导出', description: '从机器人备份提取焊接程序、主程序调用与 welddata 参数，按任务筛选后导出。', entry: '/tools/weld-export/index.html', inputs: ['ABB RAPID 备份文件夹', '.mod / .sys / .txt'], outputs: ['Excel 多工作表', 'CSV', '剪贴板'], processing: 'browser', version: VERSION, remote: { enabled: false, reason: '远端处理尚未接入。' } },
  { id: 'measurement-compare', title: '检具与三坐标对比', description: '按工件编号、点号及方向配对两份报告，查看现场值、三坐标值与差值。', entry: '/tools/measurement-compare/index.html', inputs: ['现场检具报告', '三坐标报告 · .xlsx / .xlsm'], outputs: ['点位 / 工件对比', '可离线查看的结果 HTML'], processing: 'browser', version: VERSION, remote: { enabled: false, reason: '远端处理尚未接入。' } }
];
const fileSchema = { type: 'object', required: ['name', 'size', 'format'], additionalProperties: false, properties: {
  name: { type: 'string', minLength: 1, maxLength: 255, description: '文件名；不包含本机绝对路径。' },
  size: { type: 'integer', minimum: 0, maximum: 67108864 },
  format: { type: 'string' },
  relativePath: { type: 'string', maxLength: 2048, description: '焊接任务分组所需的备份相对路径。' }
} };
const contracts = {
  'weld-export': {
    inputSchema: { type: 'object', required: ['files'], additionalProperties: false, properties: { files: { type: 'array', minItems: 1, items: { ...fileSchema, properties: { ...fileSchema.properties, size: { type: 'integer', minimum: 0, maximum: 16777216 }, format: { enum: ['mod', 'sys', 'txt'] } } } } } },
    outputSchema: { type: 'object', required: ['version', 'headers', 'rows', 'rowCount'], additionalProperties: false, properties: { version: { const: VERSION }, headers: { type: 'array', minItems: 15, maxItems: 15, items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', minItems: 15, maxItems: 15, items: { type: ['string', 'number', 'null'] } } }, rowCount: { type: 'integer', minimum: 0 } } },
    limits: { maxFileBytes: 16777216, maxTotalBytes: 67108864 },
    assumptions: ['仅解析 ABB RAPID 中原工具支持的 PROC / ArcLStart / TASK PERS welddata 格式。', '沿用原工具的焊接速度、电流换算系数；须结合设备配置核对。', '默认只列 MainModule.mod 中启用调用的程序；可切换查看全部。']
  },
  'measurement-compare': {
    inputSchema: { type: 'object', required: ['files'], additionalProperties: false, properties: { files: { type: 'array', minItems: 1, maxItems: 2, items: { ...fileSchema, properties: { ...fileSchema.properties, format: { enum: ['xlsx', 'xlsm'] } } } } } },
    outputSchema: { type: 'object', required: ['version', 'items', 'pairs', 'diagnostics', 'unit', 'formula'], additionalProperties: true, properties: {
      version: { const: VERSION }, unit: { const: 'mm' }, formula: { type: 'string' }, diagnostics: { type: 'object' },
      pairs: { type: 'array', items: { type: 'object', required: ['pair_id', 'sn'], properties: { pair_id: { type: 'string' }, sn: { type: 'string' }, vision_time: { type: 'string' }, cmm_date: { type: 'string' } } } },
      items: {
        type: 'array',
        items: {
          type: 'object', required: ['key', 'point', 'axis', 'pairs'],
          properties: {
            key: { type: 'string' }, point: { type: 'string' }, axis: { enum: ['X', 'Y', 'Z'] }, nominal_offset: { type: 'number' },
            pairs: {
              type: 'array',
              items: { type: 'object', required: ['pair_id', 'vision', 'cmm', 'diff'], properties: { pair_id: { type: 'string' }, vision: { type: 'number' }, cmm: { type: 'number' }, diff: { type: 'number' } } }
            }
          }
        }
      }
    } },
    limits: { maxFileBytes: 67108864, maxFilesPerImport: 2, maxZipEntryBytes: 104857600, maxZipTotalBytes: 209715200 },
    assumptions: ['适用于原工具支持的横向现场检具和三坐标报表。', '使用 Excel 已保存的数值，不执行宏、不重算公式。', '只比较可唯一匹配的工件与坐标方向，理论值差超过 0.1 mm 的项目不自动比较。']
  }
};
function error(status, code, message) { return Object.assign(new Error(message), { status, statusCode: status, code }); }
function lookup(id) { const tool = tools.find(item => item.id === id); if (!tool) throw error(404, 'tool_not_found', '未找到此工具。'); return tool; }
function createToolsService() {
  return Object.freeze({
    manifest() { return copy({ version: VERSION, processing: 'browser', uploadsEnabled: false, tools }); },
    contract(id) {
      const tool = lookup(id);
      return copy({ version: VERSION, toolId: id, title: tool.title, processing: 'browser',
        inputBinding: 'Metadata only. Browser adapters accept File[]; file bytes stay in the current page.',
        displayPrivacy: { version: 'local-alias-v1', mapping: 'Local deterministic aliases, independent of the server product catalog.', policy: 'Names and mixed text identifiers are replaced before display and export. Numeric SNs, leading zeros, point numbers, axes and known welding mode descriptions are retained. Raw identifiers remain in browser memory only for parsing and matching; exported results omit the reverse mapping.' },
        localAdapter: { global: 'PortalToolBridge', methods: ['importFiles', 'getResult', 'reset'], event: 'portal-tool:result', eventPayload: 'Counts only; no file names, paths or records.' },
        remoteAdapter: { enabled: false, reservedRoute: `/local/tools/v1/${id}/run`, disabledCode: 'tool_adapter_disabled' },
        ...contracts[id] });
    },
    runRemote(id) { lookup(id); throw error(501, 'tool_adapter_disabled', '此工具的远端处理接口尚未启用。请在浏览器工具页面导入文件；文件不会上传。'); }
  });
}
module.exports = { createToolsService };
