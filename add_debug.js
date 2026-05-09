const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Add debug logging before the matching in fetchAndCacheBudget
// Find the line with "const entry = ruddrProjectsCache?.find"
const findPos = content.indexOf('const entry = ruddrProjectsCache?.find');
if (findPos === -1) {
  console.error('Could not find entry line');
  process.exit(1);
}

// Insert debug log before it
const debugLog = `console.log(\`[Groups] Looking for project in cache: \${trimmed}. Cache has: \${ruddrProjectsCache?.map((e) => e.name).join(', ')}\]\`);
`;

content = content.slice(0, findPos) + debugLog + content.slice(findPos);
fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
console.log('Debug logging added');
