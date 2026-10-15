'use strict';
require('./lib/portable-launcher.cjs').main({ root: __dirname }).then(code => { process.exitCode = code; }).catch(error => {
  console.error(/^(?:PORTAL_|EADDRINUSE$)/.test(error?.code || '') ? error.message : '门户启动器未能完成操作，请检查解压目录权限并查看 runtime/portable-launcher/portal.log。');
  process.exitCode = 1;
});
