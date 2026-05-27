---
name: project-budget-actuals
description: Query customer project information and budget/actuals data. Retrieve linked projects, budgets, costs, and financial status for any customer group. Use this when analyzing project economics, budget tracking, or cost performance for customer engagements.
argument-hint: "[required: customer group name (e.g. Royal London, Colruyt, UCB)]"
---

# Customer Project Budget & Actuals Lookup

This skill enables you to quickly retrieve project and budget information for any customer group in your Jarvis database, combining project metadata with financial context.

## Quick Start

To get budget and project information for a customer:

1. In chat, ask: "What are the budgets for [customer name]?" or "Show me project costs for [customer]"
2. Jarvis will automatically call `search_project_budget` with the customer name
3. Returns: linked projects, project paths, and financial tracking information

## Architecture Overview

### Data Sources

The skill queries two primary sources:

#### 1. **Groups Table** (Customer Mapping)
- Stores customer group names and their linked projects
- Example: "Royal London" group is linked to:
  - "Royal London | GitHub Migration (part II)"
  - "Royal London | GitHub Migration"
- Each group has a JSON array of `ruddr_project_name` values

#### 2. **Ruddr Projects Table** (Project Metadata)
- Contains all projects discovered from your Rudder system
- Fields: `name`, `path`, `note`, `cached_at`, `cloud_folder_url`, `discovered_at`
- Example path: `/app/xebia-xms-benelux/portfolio/projects/royal-london/github-migration-part-ii`

#### 3. **External Finance System** (Actual Budget/Actuals)
- Not yet stored locally in Jarvis (future enhancement)
- Currently accessible via project paths pointing to Rudder, Jira, or finance dashboards
- Can be integrated via API connectors

### How It Works

When you ask about a customer's budget:

```
User: "what are the budgets for royal london?"
        ↓
Chat calls search_project_budget(group_name="royal london")
        ↓
1. Find group "Royal London" in database
        ↓
2. Extract linked project names from ruddr_project_name JSON array
        ↓
3. Query ruddr_projects table for matching project details
        ↓
4. Return: project names, paths, notes, links to finance systems
```

## When to Use This Skill

| Situation | What to ask | Expected Result |
|-----------|-----------|-----------------|
| Check projects for a customer | "What projects does Royal London have?" | List of all linked projects with paths |
| Review budget status | "What's the budget for Colruyt?" | Project information + link to budget details |
| Understand project costs | "Tell me about cost tracking for UCB" | Projects + guidance to finance system |
| Combine notes with budgets | "Full update on Liantis" | OneNote notes + projects + financial links |

## Combining with OneNote

The most powerful use is **combining this with the OneNote caching skill**:

```
User: "Full customer report for Royal London"
        ↓
Chat calls BOTH:
  1. search_onenote(query="royal london")  → Gets meeting notes, decisions, strategy
  2. search_project_budget(group_name="royal london")  → Gets projects, budget links
        ↓
Returns comprehensive customer profile:
  - Latest notes from OneNote
  - Linked projects
  - Budget tracking info
  - Links to detailed finance data
```

## Return Format

The skill returns:

```
**Project Information for Royal London:**

**Linked Projects (2):**
- **Royal London | GitHub Migration (part II)**
- **Royal London | GitHub Migration**

**Budget & Actuals:** These are tracked in your project management system 
(Rudder, Jira, finance tools, etc.). For detailed financial breakdowns, check the 
project pages in your Rudder or finance dashboard.
```

## Integration with Chat System

The `search_project_budget` tool is automatically available in chat. The LLM knows to call it when:

- User asks about project budgets, costs, or financial status
- User asks "what projects does [customer] have?"
- User asks for comprehensive customer status (combined with OneNote results)

The tool automatically:
- Filters by customer group name (partial matching)
- Returns all linked projects
- Points to cloud folder URLs where detailed budget data lives
- Suggests next steps for detailed financial review

## Schema Details

### Groups Table Columns
| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER | Primary key |
| `name` | TEXT | Customer group name (e.g., "Royal London") |
| `ruddr_project_name` | TEXT | JSON array of project names linked to this group |
| `ruddr_project_paths` | TEXT | JSON array of project paths (not yet populated) |
| `created_at` | DATETIME | When group was created |
| `updated_at` | DATETIME | Last update timestamp |

### Ruddr Projects Table Columns
| Column | Type | Purpose |
|--------|------|---------|
| `name` | TEXT | Full project name (e.g., "Royal London \| GitHub Migration (part II)") |
| `path` | TEXT | Internal project path in Rudder system |
| `note` | TEXT | Optional notes about the project |
| `cached_at` | DATETIME | When project was last cached |
| `cloud_folder_url` | TEXT | URL to cloud folder (future: direct finance data link) |
| `discovered_at` | DATETIME | When project was discovered |

## Troubleshooting

### Error: "No group found matching '[name]'"
**Cause:** Customer group doesn't exist or name doesn't match exactly.

**Fix:**
1. Check spelling of customer name
2. Try partial match: "london" instead of "Royal London"
3. Verify group exists in Groups panel of Jarvis UI

### Error: "No projects linked to this group yet"
**Cause:** Group exists but has no linked projects.

**Fix:**
1. Open Groups panel in Jarvis
2. Select the group
3. Manually link projects or import from Rudder

### Error: "No projects found in the database"
**Cause:** Projects exist in group but haven't been discovered/cached yet.

**Fix:**
1. Run project discovery in the Dashboard
2. Wait for Rudder sync to complete
3. Try again

### Empty budget/actuals section
**Expected:** Actual detailed budget numbers require access to your finance system.

**Next Steps:**
1. Click project path to open in browser
2. Log into Rudder, Jira, or finance dashboard
3. Review detailed budget breakdowns there
4. (Future) Configure API integration to display budgets in Jarvis directly

## Future Enhancements

- **Direct Budget API Integration**: Load actual budget/actuals numbers from Rudder API or finance tools
- **Budget Variance Tracking**: Show actuals vs. budget with variance % and trend
- **Historical Trends**: Track budget changes over time
- **Cost Breakdown**: Show cost by category (resources, tools, infrastructure, etc.)
- **Budget Alerts**: Notify on budget overruns or critical milestones
- **Multi-Period Reporting**: Compare budgets across quarters or fiscal years

## Code Locations (Quick Reference)

| Module | Purpose | Key Function |
|--------|---------|--------------|
| `src/plugins/chat/db-helpers.ts` | Search logic | `searchProjectBudgetForChat()` |
| `src/plugins/chat/handler.ts` | Tool registration | `search_project_budget` in `CHAT_TOOLS` |
| `src/storage/schema.ts` | Database schema | `groups`, `ruddr_projects` table definitions |
| `src/renderer/chat.tsx` | Chat UI | Displays search results |

## Lessons Learned

### 1. **Partial Matching for Group Names**
Customer names may have variations (e.g., "Royal London" vs "Royal_London" vs "Royal London Group"). The tool uses case-insensitive `LIKE %...%` matching to be forgiving.

### 2. **JSON Storage for Relationships**
Project relationships are stored as JSON arrays in a single TEXT column rather than junction tables. This simplifies queries but requires parsing in code.

### 3. **Budget Data Lives Elsewhere**
The local Jarvis database stores **project metadata only** (names, paths). Actual budget/actuals numbers are in external finance systems. Future integrations should use APIs (Rudder, Jira, SAP, etc.) to fetch live budget data.

### 4. **Combine with Qualitative Data**
Budget/actuals alone don't tell the full story. Combining with OneNote (decisions, meetings, risks) gives comprehensive customer understanding.

---

**Last Updated**: 2026-05-26  
**Status**: Fully Implemented  
**Linked Tool**: `search_project_budget` in chat system
