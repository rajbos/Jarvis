const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/types.ts', 'utf8');

// Remove ruddrProjectPaths from Group interface
content = content.replace(
  /,\s*ruddrProjectPaths: string\[\];/g,
  ''
);

// Also need to make it optional in the interface since we might not always have it
// Actually, better to just remove it completely for now

fs.writeFileSync('src/plugins/types.ts', content, 'utf8');
console.log('Group type fixed');
