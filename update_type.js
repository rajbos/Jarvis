const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/types.ts', 'utf8');

// Update RuddrProjectMatch to include path
const oldInterface = `export interface RuddrProjectMatch {
  name: string;
  score: number;
}`;

const newInterface = `export interface RuddrProjectMatch {
  name: string;
  path: string;
  score: number;
}`;

if (content.includes(oldInterface)) {
  content = content.replace(oldInterface, newInterface);
  fs.writeFileSync('src/plugins/types.ts', content, 'utf8');
  console.log('RuddrProjectMatch type updated');
} else {
  console.error('Could not find RuddrProjectMatch interface');
  // Try to find it with different line endings
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('RuddrProjectMatch')) {
      console.log('Found at line', i + 1);
      console.log(lines.slice(i, i + 4).join('\n'));
    }
  }
}
