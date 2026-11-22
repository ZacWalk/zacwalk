import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { endoskeleton, NIGHT, PALETTE } from '../web/static/game/art.js';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: node tools\\gen_favicon.mjs [--check]');
}

const head = endoskeleton().skull;
const size = Math.max(head.w, head.h) + 2;
const paths = new Map();
const colour = (index) => '#' + PALETTE[index].map((c) => c.toString(16).padStart(2, '0')).join('');
for (let y = 0; y < head.h; y++) {
  for (let x = 0; x < head.w;) {
    const index = head.get(x, y);
    let end = x + 1;
    while (end < head.w && head.get(end, y) === index) end++;
    if (index) {
      paths.set(index, (paths.get(index) ?? '') + `M${x + 1} ${y + 1}h${end - x}v1h-${end - x}z`);
    }
    x = end;
  }
}

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="ZacWalk robot head">`,
  '  <title>ZacWalk robot head</title>',
  `  <rect width="${size}" height="${size}" fill="${colour(NIGHT)}"/>`,
  ...[...paths].map(([index, d]) => `  <path fill="${colour(index)}" d="${d}"/>`),
  '</svg>',
  '',
].join('\n');
const output = fileURLToPath(new URL('../web/static/favicon-robot.svg', import.meta.url));
if (args[0] === '--check') {
  if (readFileSync(output, 'utf8') !== svg) {
    throw new Error('Robot SVG differs from the game artwork. Run node tools\\gen_favicon.mjs.');
  }
  console.log('Robot SVG matches the game robot-head pixels and palette.');
} else {
  writeFileSync(output, svg);
  console.log(`Generated ${output}`);
}
