/**
 * Ensure-Built -- `prestart`: build the browser bundle when dist/ does not have it yet, or when it is older
 * than the files it is built from (source/, html/, css/ and the service's pure contract modules the client
 * deep-requires), so `npm start` never serves a blank page or a stale bundle.  Set DEMO_SKIP_BUILD=1 to skip
 * (the server then serves a "run npm run build" page when dist/ is missing, or whatever dist/ holds).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFS = require('node:fs');
const libPath = require('node:path');
const libChildProcess = require('node:child_process');

const EXAMPLE_ROOT = libPath.resolve(__dirname, '..');
const PACKAGE = require(libPath.join(EXAMPLE_ROOT, 'package.json'));
const DIST_ROOT = libPath.join(EXAMPLE_ROOT, 'dist');
const BUNDLE = libPath.join(DIST_ROOT, `${PACKAGE.name}.compatible.min.js`);
const PICT = libPath.join(DIST_ROOT, 'pict.min.js');

// What the bundle and the copied files are made from.
const INPUTS =
	[
		libPath.join(EXAMPLE_ROOT, 'source'),
		libPath.join(EXAMPLE_ROOT, 'html'),
		libPath.join(EXAMPLE_ROOT, 'css'),
		libPath.join(EXAMPLE_ROOT, 'package.json'),
		libPath.resolve(EXAMPLE_ROOT, '..', '..', 'source', 'contract')
	];

/**
 * The newest modification time under a file or directory (0 when it does not exist).
 *
 * @param {string} pPath
 * @return {number}
 */
const newestMTime = (pPath) =>
{
	let tmpStat = null;
	try
	{
		tmpStat = libFS.statSync(pPath);
	}
	catch (pError)
	{
		return 0;
	}
	if (!tmpStat.isDirectory())
	{
		return tmpStat.mtimeMs;
	}
	let tmpNewest = 0;
	libFS.readdirSync(pPath).forEach(
		(pEntry) =>
		{
			if (pEntry.charAt(0) === '.')
			{
				return;
			}
			tmpNewest = Math.max(tmpNewest, newestMTime(libPath.join(pPath, pEntry)));
		});
	return tmpNewest;
};

/**
 * Why dist/ needs a build, or null when it is current.
 *
 * @return {string|null}
 */
const buildReason = () =>
{
	if (!libFS.existsSync(BUNDLE))
	{
		return 'the bundle is missing from dist/';
	}
	if (!libFS.existsSync(PICT) || !libFS.existsSync(libPath.join(DIST_ROOT, 'index.html')))
	{
		return 'pict.min.js or index.html is missing from dist/';
	}
	let tmpBuilt = libFS.statSync(BUNDLE).mtimeMs;
	let tmpNewest = INPUTS.reduce((pNewest, pInput) => { return Math.max(pNewest, newestMTime(pInput)); }, 0);
	if (tmpNewest > tmpBuilt)
	{
		return 'the client sources changed since the last build';
	}
	return null;
};

if (require.main === module)
{
	if (process.env.DEMO_SKIP_BUILD === '1')
	{
		process.exit(0);
	}
	let tmpReason = buildReason();
	if (!tmpReason)
	{
		process.exit(0);
	}
	let tmpHadBundle = libFS.existsSync(BUNDLE);
	console.log(`Ensure-Built: ${tmpReason}; running npm run build ...`);
	try
	{
		libChildProcess.execSync('npm run build', { cwd: EXAMPLE_ROOT, stdio: 'inherit' });
	}
	catch (pError)
	{
		if (tmpHadBundle)
		{
			// A stale bundle still demos; say so loudly and start anyway.
			console.error(`Ensure-Built: the rebuild FAILED (${pError.message}); starting with the previous bundle in dist/. Fix the build and run npm run build.`);
			process.exit(0);
		}
		console.error(`Ensure-Built: the build failed (${pError.message}). Fix it, or start with DEMO_SKIP_BUILD=1 (the API still works; the page asks for a build).`);
		process.exit(1);
	}
}

module.exports = { buildReason: buildReason, newestMTime: newestMTime, BUNDLE: BUNDLE, INPUTS: INPUTS };
