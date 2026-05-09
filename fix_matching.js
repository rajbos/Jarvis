const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Find and replace the matching logic in fetchAndCacheBudget
const oldMatchStart = 'const entry = ruddrProjectsCache?.find((e) => e.name === trimmed)';
const findPos = content.indexOf(oldMatchStart);

if (findPos === -1) {
  console.error('Could not find matching logic');
  process.exit(1);
}

// Find the end of the matching expression (the semicolon after normalize)
const matchEnd = content.indexOf(');', findPos) + 2;

// New matching logic with partial matching
const newMatch = `const entry = ruddrProjectsCache?.find((e) => {
  const cacheName = e.name;
  const cacheLower = cacheName.toLowerCase();
  const searchLower = trimmed.toLowerCase();
  // Try exact match first
  if (cacheName === trimmed || cacheLower === searchLower) return true;
  // Try normalized match
  if (normalize(cacheName) === normalize(trimmed)) return true;
  // Try substring match (either direction)
  if (cacheLower.includes(searchLower) || searchLower.includes(cacheLower)) return true;
  // Try if one starts with the other
  if (cacheLower.startsWith(searchLower) || searchLower.startsWith(cacheLower)) return true;
  return false;
})`;

content = content.slice(0, findPos) + newMatch + content.slice(matchEnd);
fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
console.log('Matching logic updated');
