'use strict';
const fs = require('node:fs');
const mode = process.argv[2] || 'busy';
if (mode === 'busy') {
	fs.writeSync(1, 'untrusted-early-output');
	for (;;) {}
} else if (mode === 'overflow' || mode === 'stderr') {
	fs.writeSync(mode === 'stderr' ? 2 : 1, Buffer.alloc(4096, 65));
	for (;;) {}
} else if (mode === 'escaped') {
	const { spawn } = require('node:child_process');
	const descendant = spawn(process.execPath, [__filename, 'escape-safety'], {
		detached: true, stdio: ['ignore', 1, 'ignore'],
	});
	fs.writeFileSync(process.argv[3], String(descendant.pid), { flag: 'wx', mode: 0o600 });
	process.exit(0);
} else if (mode === 'escape-safety') {
	setTimeout(() => process.exit(0), 5000);
} else if (mode === 'descendant') {
	const { spawn } = require('node:child_process');
	const descendant = spawn(process.execPath, [__filename, 'busy'], { stdio: ['ignore', 'pipe', 'ignore'] });
	descendant.stdout.once('data', () => {
		fs.writeSync(1, JSON.stringify({ descendant: descendant.pid }));
		process.exit(0);
	});
} else {
	const { createHash } = require('node:crypto');
	const hash = createHash('sha256');
	let bytes = 0;
	process.stdin.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
	process.stdin.on('end', () => {
		if (mode === 'fail') { process.exitCode = 1; return; }
		if (mode === 'empty') return;
		fs.writeSync(1, JSON.stringify({ bytes, sha256: hash.digest('hex'), environment: Object.keys(process.env).sort() }));
	});
}