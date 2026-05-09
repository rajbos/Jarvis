const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/services/groups.ts', 'utf8');

// Fix 1: Remove g.ruddr_project_paths from the SELECT query
content = content.replace(
  /g\.ruddr_project_paths,\s*/g,
  ''
);

// Fix 2: Remove ruddr_project_paths from the row type
content = content.replace(
  /\s*ruddr_project_paths: string \| null;/g,
  ''
);

// Fix 3: Remove ruddrProjectPaths from the groups.push
content = content.replace(
  /,\s*ruddrProjectPaths: parseRuddrPaths\(row\.ruddr_project_paths\),/g,
  ''
);

// Fix 4: We also need to remove the parseRuddrPaths import if it's not used elsewhere
// But it's used in groups handler, so we keep it in services/groups.ts

fs.writeFileSync('src/services/groups.ts', content, 'utf8');
console.log('Fixed listGroups to work with old databases');
