const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/services/groups.ts', 'utf8');

// The issue is that ruddr_project_paths column doesn't exist in old databases
// We need to make the query backward compatible

// Replace the listGroups function to not select ruddr_project_paths
// Instead, we'll query it separately when needed
const oldQuery = `    SELECT
      g.id,
      g.name,
      g.created_at,
      g.updated_at,
      g.ruddr_project_name,
      g.ruddr_project_paths,
      (SELECT COUNT(*) FROM group_local_repos  glr WHERE glr.group_id = g.id) AS local_repo_count,
      (SELECT COUNT(*) FROM group_github_repos ggr WHERE ggr.group_id = g.id) AS github_repo_count,
      (SELECT COUNT(*) FROM onedrive_files f
         INNER JOIN onedrive_customer_folders cf ON f.folder_id = cf.id
         WHERE cf.group_id = g.id) AS file_count
    FROM groups g`;

const newQuery = `    SELECT
      g.id,
      g.name,
      g.created_at,
      g.updated_at,
      g.ruddr_project_name,
      (SELECT COUNT(*) FROM group_local_repos  glr WHERE glr.group_id = g.id) AS local_repo_count,
      (SELECT COUNT(*) FROM group_github_repos ggr WHERE ggr.group_id = g.id) AS github_repo_count,
      (SELECT COUNT(*) FROM onedrive_files f
         INNER JOIN onedrive_customer_folders cf ON f.folder_id = cf.id
         WHERE cf.group_id = g.id) AS file_count
    FROM groups g`;

if (content.includes(oldQuery)) {
  content = content.replace(oldQuery, newQuery);
  
  // Also update the row type and the push to not use ruddr_project_paths
  // Old: ruddr_project_name: string | null; ruddr_project_paths: string | null;
  // New: ruddr_project_name: string | null;
  content = content.replace(
    'ruddr_project_name: string | null;\n        ruddr_project_paths: string | null;',
    'ruddr_project_name: string | null;'
  );
  
  // Old: ruddrProjectPaths: parseRuddrPaths(row.ruddr_project_paths),
  // New: ruddrProjectPaths: [],  // Will be fetched separately when needed
  content = content.replace(
    'ruddrProjectNames: parseRuddrNames(row.ruddr_project_name),\n        ruddrProjectPaths: parseRuddrPaths(row.ruddr_project_paths),',
    'ruddrProjectNames: parseRuddrNames(row.ruddr_project_name),\n        ruddrProjectPaths: [], // Compatibility: paths fetched separately'
  );
  
  fs.writeFileSync('src/services/groups.ts', content, 'utf8');
  console.log('listGroups fixed for backward compatibility');
} else {
  console.error('Could not find the query to replace');
}
