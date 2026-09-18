// ── GitHub Copilot coding agent handoff ──────────────────────────────────────
// Assigns the Copilot coding agent to an issue via the GraphQL API so it opens
// a fix PR. See docs: "Using Copilot cloud agent via the API".
//
// IMPORTANT: this only works with a token tied to a real, Copilot-enabled user
// (a classic PAT, a fine-grained PAT, or — as Jarvis uses — a device-flow OAuth
// app token). A GitHub App installation token does NOT work: suggestedActors
// will not return copilot-swe-agent for it, because Copilot assignment requires
// the request to carry a Copilot-entitled user identity, not a bot/app identity.

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const COPILOT_BOT_LOGIN = 'copilot-swe-agent';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; type?: string }>;
}

async function githubGraphQL<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub GraphQL API error ${response.status}: ${text.slice(0, 300)}`);
  }

  return (await response.json()) as GraphQLResponse<T>;
}

const SUGGESTED_ACTORS_QUERY = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
        nodes {
          login
          __typename
          ... on Bot { id }
          ... on User { id }
        }
      }
    }
  }
`;

interface SuggestedActorsResult {
  repository: {
    suggestedActors: {
      nodes: Array<{ login: string; __typename: string; id?: string }>;
    };
  } | null;
}

/**
 * Result of checking whether the Copilot coding agent can be assigned to
 * issues in a given repository, for a given (already-authenticated) user.
 */
export interface CopilotAvailability {
  available: boolean;
  /** The Copilot bot's GraphQL node ID, present only when available. */
  botId?: string;
  /**
   * Machine-readable reason code when unavailable, so callers can show a
   * targeted, actionable message instead of a generic failure.
   */
  reason?: 'repo_not_found_or_no_access' | 'not_enabled_or_no_seat' | 'api_error';
  /** Human-readable detail, e.g. the underlying HTTP/GraphQL error text. */
  detail?: string;
}

/**
 * Check whether the Copilot coding agent is assignable in `repoFullName` for
 * the user behind `accessToken`. Absence of `copilot-swe-agent` from
 * `suggestedActors` is the documented signal that either the coding agent is
 * not enabled for the repo/org, or the user does not hold a Copilot seat —
 * the API does not distinguish the two cases, so callers should tell users to
 * check both.
 */
export async function checkCopilotAssignable(
  accessToken: string,
  repoFullName: string,
): Promise<CopilotAvailability> {
  const [owner, name] = repoFullName.split('/');
  if (!owner || !name) {
    return { available: false, reason: 'api_error', detail: `Invalid repo full name: ${repoFullName}` };
  }

  let result: GraphQLResponse<SuggestedActorsResult>;
  try {
    result = await githubGraphQL<SuggestedActorsResult>(accessToken, SUGGESTED_ACTORS_QUERY, { owner, name });
  } catch (err) {
    return { available: false, reason: 'api_error', detail: err instanceof Error ? err.message : String(err) };
  }

  if (result.errors && result.errors.length > 0) {
    const message = result.errors.map((e) => e.message).join('; ');
    // A NOT_FOUND type error here usually means the token can't see the repo at all.
    const notFound = result.errors.some((e) => e.type === 'NOT_FOUND');
    return {
      available: false,
      reason: notFound ? 'repo_not_found_or_no_access' : 'api_error',
      detail: message,
    };
  }

  const nodes = result.data?.repository?.suggestedActors.nodes ?? [];
  const bot = nodes.find((n) => n.login === COPILOT_BOT_LOGIN);
  if (!bot || !bot.id) {
    return { available: false, reason: 'not_enabled_or_no_seat' };
  }

  return { available: true, botId: bot.id };
}

const REPLACE_ACTORS_MUTATION = `
  mutation($assignableId: ID!, $actorIds: [ID!]!) {
    replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: $actorIds }) {
      clientMutationId
    }
  }
`;

/**
 * Assign the Copilot coding agent to an already-created issue, given the
 * issue's GraphQL node ID. Callers should run `checkCopilotAssignable` first
 * (and avoid creating the issue at all if it reports unavailable) — this
 * function still re-resolves the bot ID itself so it stays correct even if
 * called on its own.
 */
export async function assignCopilotToIssue(
  accessToken: string,
  repoFullName: string,
  issueNodeId: string,
): Promise<void> {
  const availability = await checkCopilotAssignable(accessToken, repoFullName);
  if (!availability.available || !availability.botId) {
    const detail = availability.detail ? ` (${availability.detail})` : '';
    throw new Error(
      `Copilot coding agent is not assignable for ${repoFullName}${detail}. ` +
      'Enable the coding agent for this repository/organization in GitHub Copilot settings, ' +
      'and make sure the authenticated GitHub account holds a Copilot Pro, Pro+, Business, or Enterprise seat.',
    );
  }

  const result = await githubGraphQL<{ replaceActorsForAssignable: { clientMutationId: string | null } }>(
    accessToken,
    REPLACE_ACTORS_MUTATION,
    { assignableId: issueNodeId, actorIds: [availability.botId] },
  );

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Failed to assign Copilot coding agent: ${result.errors.map((e) => e.message).join('; ')}`);
  }
}
