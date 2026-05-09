const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Replace the map to include path
// The line contains: .map(({ name }) => ({ name, score:
const oldLine = `.map(({ name }) => ({ name, score: scoreMatch(groupName.trim(), name) }))`;
const newLine = `.map(({ name, path }) => ({ name, path, score: scoreMatch(groupName.trim(), name) }))`;

if (content.includes(oldLine)) {
  content = content.replace(oldLine, newLine);
  fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
  console.log('Handler updated to return path');
} else {
  console.error('Could not find the map line');
  // Try without the full context
  const simpleOld = `.map(({ name }) => ({ name,`;
  const simpleNew = `.map(({ name, path }) => ({ name, path,`;
  if (content.includes(simpleOld)) {
    content = content.replace(simpleOld, simpleNew);
    fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
    console.log('Handler updated (simple match)');
  } else {
    console.error('Still could not find it');
  }
}
