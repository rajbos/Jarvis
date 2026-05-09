const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Find and update the groups:find-ruddr-projects handler
// We need to change the map to include path
const oldMap = `const matches: RuddrProjectMatch[] = cache\n      .map(({ name }) => ({ name, score: scoreMatch(groupName.trim(), name) }))\n      .filter((m) => m.score > 0)\n      .sort((a, b) => b.score - a.score);`;

const newMap = `const matches: RuddrProjectMatch[] = cache\n      .map(({ name, path }) => ({ name, path, score: scoreMatch(groupName.trim(), name) }))\n      .filter((m) => m.score > 0)\n      .sort((a, b) => b.score - a.score);`;

if (content.includes(oldMap)) {
  content = content.replace(oldMap, newMap);
  fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
  console.log('groups:find-ruddr-projects handler updated to return path');
} else {
  console.error('Could not find the map expression');
  // Try to find it
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('map(({ name }))')) {
      console.log('Found at line', i + 1);
      console.log(lines.slice(i, i + 4).join('\n'));
    }
  }
}
