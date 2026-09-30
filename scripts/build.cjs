'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');
const write = (file, value) => {
  if (process.argv.includes('--check')) {
    if (read(file).replace(/\r\n/g,'\n') !== value) throw new Error('Generated file is stale: '+file);
  } else fs.writeFileSync(path.join(root,file),value);
};
const order = JSON.parse(read('src/backend/order.json'));
if (crypto.createHash('sha256').update(read('vendor/tweetnacl-1.0.3/nacl-fast.min.js')).digest('hex') !== '3ec535c004aeeb225785d8e93fb33bf99f52e399bd7dfc01969b5629baea5131') {
  throw new Error('Pinned cryptographic source integrity check failed.');
}
// Unmodified, pinned upstream source. Its CommonJS export remains scoped to this wrapper.
const secretbox = 'var FlinkSecretbox = (function() { var module = { exports: {} }; var self = {};\n' +
  read('vendor/tweetnacl-1.0.3/nacl-fast.min.js') + '\nreturn module.exports.secretbox; })();\n';
const code = secretbox + order.map(file => read('src/backend/'+file)).join('');
write('apps-script/Code.gs',code);
const template = read('src/portals/template.html');
for (const role of ['User','Admin','SuperAdmin']) {
  const fragments = JSON.parse(read('src/portals/'+role+'.json'));
  const html = template.replace(/\{\{(PORTAL_SLOT_\d+)\}\}/g, (_,key) => {
    if (!Object.hasOwn(fragments,key)) throw new Error('Missing '+role+' '+key);
    return fragments[key];
  });
  write('apps-script/'+role+'.html',html);
}
console.log(process.argv.includes('--check') ? 'Generated files match shared sources.' : 'Built backend and all three portals.');
