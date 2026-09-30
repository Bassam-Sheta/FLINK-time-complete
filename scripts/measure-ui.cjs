'use strict';
// Byte sizes are a local transfer-size comparison, not a live Google latency benchmark.
const fs = require('node:fs'), zlib = require('node:zlib'), cp = require('node:child_process');
const baseline = '59e7467cdfcd673e4ad24e75b7a982a194442448';
const rows = ['User', 'Admin', 'SuperAdmin'].map(portal => {
  const path = 'apps-script/' + portal + '.html';
  const prior = cp.execFileSync('git', ['show', baseline + ':' + path]);
  const current = fs.readFileSync(path);
  const jsBytes = html => Buffer.byteLength((html.toString().match(/<script>[\s\S]*?<\/script>/g) || []).join('\n'));
  return { portal, baselineBytes: prior.length, currentBytes: current.length,
    baselineGzipBytes: zlib.gzipSync(prior).length, currentGzipBytes: zlib.gzipSync(current).length,
    baselineInlineJsBytes: jsBytes(prior), currentInlineJsBytes: jsBytes(current),
    externalFontLinks: (current.toString().match(/https:\/\/fonts\.(?:googleapis|gstatic)\.com/g) || []).length };
});
fs.writeFileSync('docs/UI_SIZE_EVIDENCE.json', JSON.stringify({ baseline, measuredAt: new Date().toISOString(), environment: process.version, rows }, null, 2) + '\n');
console.log(JSON.stringify(rows));
