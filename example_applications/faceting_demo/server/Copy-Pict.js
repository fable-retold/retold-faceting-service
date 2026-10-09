/**
 * Copy-Pict -- the last step of `npm run build`: copy pict.min.js into dist/ (root, per the example
 * conventions).  `quack copy` cannot do it with the canonical `./node_modules/pict/dist/*` glob because this
 * example has no node_modules of its own (dependencies resolve from the retold umbrella), so resolve it the
 * way node does.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFS = require('node:fs');
const libPath = require('node:path');

const DIST_ROOT = libPath.resolve(__dirname, '..', 'dist');

let tmpSource = null;
try
{
	tmpSource = require.resolve('pict/dist/pict.min.js');
}
catch (pError)
{
	console.error(`Copy-Pict: cannot resolve pict/dist/pict.min.js (${pError.message}). Run npm install at the retold repo root.`);
	process.exit(1);
}

libFS.mkdirSync(DIST_ROOT, { recursive: true });
libFS.copyFileSync(tmpSource, libPath.join(DIST_ROOT, 'pict.min.js'));
let tmpMap = `${tmpSource}.map`;
if (libFS.existsSync(tmpMap))
{
	libFS.copyFileSync(tmpMap, libPath.join(DIST_ROOT, 'pict.min.js.map'));
}
console.log(`Copy-Pict: ${tmpSource} -> ${libPath.join(DIST_ROOT, 'pict.min.js')}`);
