const fs = require('node:fs');
const path = require('node:path');

const dist = path.resolve(__dirname, '../../client/dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Build the production client before checking the E2E boundary.');
let checked = 0;
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) inspect(filename);
    else if (/\.(?:html|[cm]?js|json)$/i.test(entry.name)) {
      if (/demo-hr-flow-e2e|demo-e2e-not-a-production-key|isolated-e2e-firebase/.test(fs.readFileSync(filename, 'utf8'))) {
        throw new Error('An isolated E2E bootstrap was included in the production output.');
      }
      checked += 1;
    }
  }
}
inspect(dist);
console.log(`Production E2E boundary passed (${checked} files).`);
