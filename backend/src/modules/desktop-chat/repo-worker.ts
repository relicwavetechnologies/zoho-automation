type RepoIdentity = {
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  description?: string;
};

type RepoTreeEntry = {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha?: string;
};

export type RepoFileArtifact = {
  repo: RepoIdentity;
  path: string;
  content: string;
  sha?: string;
  htmlUrl: string;
  rawUrl: string;
};

export type RepoWorkerInput =
  | {
    actionKind?: 'RETRIEVE_ARTIFACT';
    repoQuery?: string;
    repoRef?: string;
    targetFilePath?: string;
    targetFileName?: string;
    requireRoot?: boolean;
  }
  | {
    actionKind: 'DISCOVER_CANDIDATES';
    query: string;
    targetFileName?: string;
  }
  | {
    actionKind: 'INSPECT_CANDIDATE';
    repoRef: string;
    targetFilePath?: string;
    targetFileName?: string;
    requireRoot?: boolean;
  }
  | {
    actionKind: 'RETRIEVE_ARTIFACT';
    repoRef: string;
    filePath?: string;
    targetFilePath?: string;
    targetFileName?: string;
    requireRoot?: boolean;
  };

export type RepoWorkerSuccess =
  | {
    ok: true;
    actionKind: 'DISCOVER_CANDIDATES';
    summary: string;
    facts: string[];
    entities: Array<{ type: string; id?: string; title?: string; metadata?: Record<string, unknown> }>;
    artifacts: Array<{ type: string; id?: string; title?: string; url?: string; metadata?: Record<string, unknown> }>;
  }
  | {
    ok: true;
    actionKind: 'INSPECT_CANDIDATE';
    summary: string;
    facts: string[];
    entities: Array<{ type: string; id?: string; title?: string; metadata?: Record<string, unknown> }>;
    artifacts: Array<{ type: string; id?: string; title?: string; url?: string; metadata?: Record<string, unknown> }>;
  }
  | {
    ok: true;
    actionKind: 'RETRIEVE_ARTIFACT';
    summary: string;
    artifact: RepoFileArtifact;
    facts: string[];
    entities: Array<{ type: string; id?: string; title?: string; metadata?: Record<string, unknown> }>;
    artifacts: Array<{ type: string; id?: string; title?: string; url?: string; metadata?: Record<string, unknown> }>;
  };

export type RepoWorkerBlocked = {
  ok: false;
  actionKind: 'DISCOVER_CANDIDATES' | 'INSPECT_CANDIDATE' | 'RETRIEVE_ARTIFACT';
  summary: string;
  blockingQuestion: string;
};

export type RepoWorkerFailure = {
  ok: false;
  actionKind: 'DISCOVER_CANDIDATES' | 'INSPECT_CANDIDATE' | 'RETRIEVE_ARTIFACT';
  summary: string;
  retryHint?: string;
};

export type RepoWorkerResult = RepoWorkerSuccess | RepoWorkerBlocked | RepoWorkerFailure;

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_WEB_BASE = 'https://github.com';
const MAX_REPO_CANDIDATES = 8;
const MAX_CODE_SEARCH_RESULTS = 12;

const buildGitHubHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cursorr-desktop-controller',
  };
  const token = (process.env.GITHUB_TOKEN ?? '').trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

const extractRepoFromUrl = (value: string): { owner: string; repo: string } | null => {
  const match = value.match(/github\.com\/([^/\s]+)\/([^/\s?#]+)(?:[/?#]|$)/i);
  if (!match) return null;
  return {
    owner: match[1].trim(),
    repo: match[2].replace(/\.git$/i, '').trim(),
  };
};

const extractOwnerRepoToken = (value: string): { owner: string; repo: string } | null => {
  const match = value.match(/\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/);
  if (!match) return null;
  return {
    owner: match[1].trim(),
    repo: match[2].replace(/\.git$/i, '').trim(),
  };
};

const normalizeRepoIdentity = (value: Record<string, unknown>): RepoIdentity | null => {
  const owner = value.owner && typeof value.owner === 'object' ? value.owner as Record<string, unknown> : null;
  const ownerLogin = typeof owner?.login === 'string' ? owner.login.trim() : '';
  const repoName = typeof value.name === 'string' ? value.name.trim() : '';
  const defaultBranch = typeof value.default_branch === 'string' ? value.default_branch.trim() : 'main';
  const htmlUrl = typeof value.html_url === 'string' ? value.html_url.trim() : `${GITHUB_WEB_BASE}/${ownerLogin}/${repoName}`;
  if (!ownerLogin || !repoName) return null;
  return {
    owner: ownerLogin,
    repo: repoName,
    fullName: `${ownerLogin}/${repoName}`,
    htmlUrl,
    defaultBranch,
    description: typeof value.description === 'string' ? value.description : undefined,
  };
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { headers: buildGitHubHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}) for ${url}`);
  }
  return await response.json() as T;
};

const fetchRepoByIdentity = async (identity: { owner: string; repo: string }): Promise<RepoIdentity | null> => {
  try {
    const payload = await fetchJson<Record<string, unknown>>(`${GITHUB_API_BASE}/repos/${identity.owner}/${identity.repo}`);
    return normalizeRepoIdentity(payload);
  } catch {
    return null;
  }
};

const searchRepositories = async (repoQuery: string): Promise<RepoIdentity[]> => {
  const query = `${repoQuery} in:name,description archived:false fork:false`;
  const payload = await fetchJson<{ items?: Array<Record<string, unknown>> }>(
    `${GITHUB_API_BASE}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${MAX_REPO_CANDIDATES}`,
  );
  return (payload.items ?? [])
    .map((item) => normalizeRepoIdentity(item))
    .filter((item): item is RepoIdentity => Boolean(item));
};

const searchCodeRepositories = async (query: string, targetFileName: string): Promise<RepoIdentity[]> => {
  try {
    const payload = await fetchJson<{ items?: Array<Record<string, unknown>> }>(
      `${GITHUB_API_BASE}/search/code?q=${encodeURIComponent(`${query} filename:${targetFileName}`)}&per_page=${MAX_CODE_SEARCH_RESULTS}`,
    );
    const repositories = (payload.items ?? [])
      .map((item) => item.repository && typeof item.repository === 'object' ? item.repository as Record<string, unknown> : null)
      .map((item) => item ? normalizeRepoIdentity(item) : null)
      .filter((item): item is RepoIdentity => Boolean(item));
    const unique = new Map(repositories.map((repo) => [repo.fullName.toLowerCase(), repo]));
    return Array.from(unique.values()).slice(0, MAX_REPO_CANDIDATES);
  } catch {
    return [];
  }
};

const resolveRepository = async (repoQuery: string): Promise<RepoIdentity[] | RepoWorkerFailure> => {
  const fromUrl = extractRepoFromUrl(repoQuery);
  if (fromUrl) {
    const direct = await fetchRepoByIdentity(fromUrl);
    if (direct) return [direct];
  }

  const fromToken = extractOwnerRepoToken(repoQuery);
  if (fromToken) {
    const direct = await fetchRepoByIdentity(fromToken);
    if (direct) return [direct];
  }

  const candidates = await searchRepositories(repoQuery);
  if (candidates.length === 0) {
    return {
      ok: false,
      actionKind: 'DISCOVER_CANDIDATES',
      summary: `I could not find a public GitHub repository matching "${repoQuery}".`,
      retryHint: 'Provide the repository URL or exact owner/repo name.',
    };
  }
  return candidates;
};

const resolveRepoRef = async (repoRef: string): Promise<RepoIdentity | null> => {
  const fromUrl = extractRepoFromUrl(repoRef);
  if (fromUrl) return fetchRepoByIdentity(fromUrl);
  const fromToken = extractOwnerRepoToken(repoRef);
  if (fromToken) return fetchRepoByIdentity(fromToken);
  const candidates = await resolveRepository(repoRef);
  if (!Array.isArray(candidates)) return null;
  return candidates[0] ?? null;
};

const fetchRepoTree = async (repo: RepoIdentity): Promise<RepoTreeEntry[]> => {
  const payload = await fetchJson<{ tree?: Array<Record<string, unknown>> }>(
    `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(repo.defaultBranch)}?recursive=1`,
  );
  return (payload.tree ?? [])
    .map((item) => ({
      path: typeof item.path === 'string' ? item.path : '',
      type: item.type === 'tree' ? ('tree' as const) : ('blob' as const),
      size: typeof item.size === 'number' ? item.size : undefined,
      sha: typeof item.sha === 'string' ? item.sha : undefined,
    }))
    .filter((item) => item.path.length > 0);
};

const normalizePath = (value?: string): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^\/+/, '');
};

const basenameOf = (value: string): string => {
  const parts = value.split('/');
  return parts[parts.length - 1] ?? value;
};

const resolveTargetFiles = (input: {
  tree: RepoTreeEntry[];
  targetFilePath?: string;
  targetFileName?: string;
  requireRoot?: boolean;
}): { matches: RepoTreeEntry[] } | RepoWorkerBlocked | RepoWorkerFailure => {
  const blobs = input.tree.filter((entry) => entry.type === 'blob');
  const explicitPath = normalizePath(input.targetFilePath);
  if (explicitPath) {
    const exact = blobs.find((entry) => entry.path.toLowerCase() === explicitPath.toLowerCase());
    if (!exact) {
      return {
        ok: false,
        actionKind: 'INSPECT_CANDIDATE',
        summary: `The repository does not contain "${explicitPath}".`,
        retryHint: 'Provide a different file path or ask me to inspect the repository tree first.',
      };
    }
    return { matches: [exact] };
  }

  const targetName = normalizePath(input.targetFileName);
  if (targetName) {
    const matches = blobs.filter((entry) => basenameOf(entry.path).toLowerCase() === targetName.toLowerCase());
    if (matches.length === 0) {
      return {
        ok: false,
        actionKind: 'INSPECT_CANDIDATE',
        summary: `I could not find a file named "${targetName}" in the repository.`,
        retryHint: 'Ask me to inspect another repository or provide the exact file path.',
      };
    }

    if (input.requireRoot) {
      const rootMatch = matches.find((entry) => !entry.path.includes('/'));
      if (rootMatch) return { matches: [rootMatch] };
      return {
        ok: false,
        actionKind: 'INSPECT_CANDIDATE',
        summary: `I found "${targetName}" only in nested folders, not at the repository root.`,
        blockingQuestion: `I found "${targetName}" only in nested folders. Do you want one of these instead: ${matches.slice(0, 3).map((entry) => entry.path).join(', ')}?`,
      };
    }

    return { matches };
  }

  const rootReadme = blobs.find((entry) => entry.path.toLowerCase() === 'readme.md');
  if (rootReadme) {
    return { matches: [rootReadme] };
  }

  return {
    ok: false,
    actionKind: 'INSPECT_CANDIDATE',
    summary: 'I could not determine which repository file to inspect.',
    retryHint: 'Provide the exact file path or file name.',
  };
};

const fetchFileArtifact = async (repo: RepoIdentity, path: string): Promise<RepoFileArtifact> => {
  const payload = await fetchJson<Record<string, unknown>>(
    `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(repo.defaultBranch)}`,
  );
  const encoded = typeof payload.content === 'string' ? payload.content.replace(/\n/g, '') : '';
  const content = Buffer.from(encoded, 'base64').toString('utf8');
  return {
    repo,
    path,
    content,
    sha: typeof payload.sha === 'string' ? payload.sha : undefined,
    htmlUrl: typeof payload.html_url === 'string'
      ? payload.html_url
      : `${repo.htmlUrl}/blob/${repo.defaultBranch}/${path}`,
    rawUrl: `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.defaultBranch}/${path}`,
  };
};

const buildRepoArtifacts = (repos: RepoIdentity[]) =>
  repos.map((repo) => ({
    type: 'repository_candidate',
    id: repo.fullName,
    title: repo.fullName,
    url: repo.htmlUrl,
    metadata: {
      repoFullName: repo.fullName,
      repoUrl: repo.htmlUrl,
      defaultBranch: repo.defaultBranch,
      description: repo.description,
    },
  }));

const buildRepoEntities = (repos: RepoIdentity[]) =>
  repos.map((repo) => ({
    type: 'repository',
    id: repo.fullName,
    title: repo.fullName,
    metadata: {
      repoUrl: repo.htmlUrl,
      defaultBranch: repo.defaultBranch,
    },
  }));

const discoverCandidates = async (query: string, targetFileName?: string): Promise<RepoWorkerResult> => {
  const discovered = new Map<string, RepoIdentity>();
  if (targetFileName) {
    const codeSearchRepos = await searchCodeRepositories(query, targetFileName);
    for (const repo of codeSearchRepos) {
      discovered.set(repo.fullName.toLowerCase(), repo);
    }
  }

  const repoSearch = await searchRepositories(query);
  for (const repo of repoSearch) {
    discovered.set(repo.fullName.toLowerCase(), repo);
  }

  const candidates = Array.from(discovered.values()).slice(0, MAX_REPO_CANDIDATES);
  if (candidates.length === 0) {
    return {
      ok: false,
      actionKind: 'DISCOVER_CANDIDATES',
      summary: `I could not find public GitHub repositories relevant to "${query}".`,
      retryHint: 'Provide a more specific repository hint or exact owner/repo name.',
    };
  }

  return {
    ok: true,
    actionKind: 'DISCOVER_CANDIDATES',
    summary: `Discovered ${candidates.length} candidate repositories for "${query}".`,
    facts: candidates.map((repo) => `Candidate repository: ${repo.fullName}`),
    entities: buildRepoEntities(candidates),
    artifacts: buildRepoArtifacts(candidates),
  };
};

const inspectCandidate = async (input: Extract<RepoWorkerInput, { actionKind: 'INSPECT_CANDIDATE' }>): Promise<RepoWorkerResult> => {
  const repo = await resolveRepoRef(input.repoRef);
  if (!repo) {
    return {
      ok: false,
      actionKind: 'INSPECT_CANDIDATE',
      summary: `I could not resolve the repository "${input.repoRef}".`,
      retryHint: 'Provide the exact repository URL or owner/repo name.',
    };
  }

  const tree = await fetchRepoTree(repo);
  const target = resolveTargetFiles({
    tree,
    targetFilePath: input.targetFilePath,
    targetFileName: input.targetFileName,
    requireRoot: input.requireRoot,
  });
  if ('matches' in target) {
    return {
      ok: true,
      actionKind: 'INSPECT_CANDIDATE',
      summary: `Inspected ${repo.fullName} and found ${target.matches.length} matching file candidate${target.matches.length === 1 ? '' : 's'}.`,
      facts: [
        `Repository: ${repo.fullName}`,
        ...target.matches.slice(0, 5).map((match) => `Matched file: ${match.path}`),
      ],
      entities: [
        { type: 'repository', id: repo.fullName, title: repo.fullName, metadata: { repoUrl: repo.htmlUrl } },
        ...target.matches.slice(0, 5).map((match) => ({ type: 'file', id: `${repo.fullName}:${match.path}`, title: match.path })),
      ],
      artifacts: target.matches.slice(0, 5).map((match) => ({
        type: 'repository_file_candidate',
        id: `${repo.fullName}:${match.path}`,
        title: match.path,
        url: `${repo.htmlUrl}/blob/${repo.defaultBranch}/${match.path}`,
        metadata: {
          repoFullName: repo.fullName,
          repoUrl: repo.htmlUrl,
          filePath: match.path,
          defaultBranch: repo.defaultBranch,
        },
      })),
    };
  }
  return target;
};

const retrieveArtifact = async (input: {
  repoRef: string;
  filePath?: string;
  targetFilePath?: string;
  targetFileName?: string;
  requireRoot?: boolean;
}): Promise<RepoWorkerResult> => {
  const repo = await resolveRepoRef(input.repoRef);
  if (!repo) {
    return {
      ok: false,
      actionKind: 'RETRIEVE_ARTIFACT',
      summary: `I could not resolve the repository "${input.repoRef}".`,
      retryHint: 'Provide the exact repository URL or owner/repo name.',
    };
  }

  let path = normalizePath(input.filePath) ?? normalizePath(input.targetFilePath);
  if (!path) {
    const tree = await fetchRepoTree(repo);
    const target = resolveTargetFiles({
      tree,
      targetFilePath: input.targetFilePath,
      targetFileName: input.targetFileName,
      requireRoot: input.requireRoot,
    });
    if ('matches' in target) {
      path = target.matches[0]?.path ?? null;
    } else {
      return {
        ...target,
        actionKind: 'RETRIEVE_ARTIFACT',
      };
    }
  }

  if (!path) {
    return {
      ok: false,
      actionKind: 'RETRIEVE_ARTIFACT',
      summary: 'I could not determine which repository file to retrieve.',
      retryHint: 'Provide the exact file path or inspect the repository first.',
    };
  }

  const artifact = await fetchFileArtifact(repo, path);
  return {
    ok: true,
    actionKind: 'RETRIEVE_ARTIFACT',
    summary: `Fetched ${artifact.path} from ${repo.fullName}.`,
    artifact,
    facts: [
      `Repository: ${repo.fullName}`,
      `Default branch: ${repo.defaultBranch}`,
      `Fetched file: ${artifact.path}`,
    ],
    entities: [
      { type: 'repository', id: repo.fullName, title: repo.fullName, metadata: { repoUrl: repo.htmlUrl } },
      { type: 'file', id: `${repo.fullName}:${artifact.path}`, title: artifact.path },
    ],
    artifacts: [
      { type: 'repository', id: repo.fullName, title: repo.fullName, url: repo.htmlUrl, metadata: { repoFullName: repo.fullName } },
      {
        type: 'repository_file',
        id: `${repo.fullName}:${artifact.path}`,
        title: artifact.path,
        url: artifact.htmlUrl,
        metadata: {
          repoFullName: repo.fullName,
          filePath: artifact.path,
          rawUrl: artifact.rawUrl,
        },
      },
    ],
  };
};

export const runRepoWorker = async (input: RepoWorkerInput): Promise<RepoWorkerResult> => {
  if (input.actionKind === 'DISCOVER_CANDIDATES') {
    return discoverCandidates(input.query, input.targetFileName);
  }

  if (input.actionKind === 'INSPECT_CANDIDATE') {
    return inspectCandidate(input);
  }

  if (input.actionKind === 'RETRIEVE_ARTIFACT') {
    const repoRef = 'repoRef' in input
      ? input.repoRef
      : 'repoQuery' in input
        ? input.repoQuery
        : '';
    const filePath = 'filePath' in input ? input.filePath : undefined;
    return retrieveArtifact({
      repoRef: repoRef ?? '',
      filePath,
      targetFilePath: input.targetFilePath,
      targetFileName: input.targetFileName,
      requireRoot: input.requireRoot,
    });
  }

  const repoQuery = input.repoRef ?? input.repoQuery ?? '';
  const candidates = await resolveRepository(repoQuery);
  if (!Array.isArray(candidates)) {
    return {
      ...candidates,
      actionKind: 'RETRIEVE_ARTIFACT',
    };
  }
  const repo = candidates[0];
  return retrieveArtifact({
    repoRef: repo.fullName,
    targetFilePath: input.targetFilePath,
    targetFileName: input.targetFileName,
    requireRoot: input.requireRoot,
  });
};
