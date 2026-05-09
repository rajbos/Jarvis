const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Split by lines
const lines = content.split('\n');

// Find the line with parseRuddrNames,
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('parseRuddrNames,')) {
    // Insert parseRuddrPaths, after this line
    lines[i] = lines[i].replace(/\r$/, ''); // Remove trailing \r
    lines.splice(i + 1, 0, '  parseRuddrPaths,');
    content = lines.join('\n');
    fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
    console.log('parseRuddrPaths added to import at line', i + 2);
    process.exit(0);
  }
}

console.error('Could not find parseRuddrNames in import');
