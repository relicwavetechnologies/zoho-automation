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

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_WEB_BASE = 'https://github.com';
const MAX_REPO_CANDIDATES = 8;
const MAX_CODE_SEARCH_RESULTS = 12;

const buildGitHubHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cursorr-vercel-runtime',
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

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url, { headers: buildGitHubHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}) for ${url}`);
  }
  return await response.text();
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

const resolveRepositoryCandidates = async (repoQuery: string, targetFileName?: string): Promise<RepoIdentity[]> => {
  const fromUrl = extractRepoFromUrl(repoQuery);
  if (fromUrl) {
    const direct = await fetchRepoByIdentity(fromUrl);
    return direct ? [direct] : [];
  }

  const fromToken = extractOwnerRepoToken(repoQuery);
  if (fromToken) {
    const direct = await fetchRepoByIdentity(fromToken);
    return direct ? [direct] : [];
  }

  const directSearch = await searchRepositories(repoQuery);
  if (directSearch.length > 0) {
    return directSearch;
  }

  if (targetFileName) {
    return searchCodeRepositories(repoQuery, targetFileName);
  }

  return [];
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

const resolveTargetMatches = (input: {
  tree: RepoTreeEntry[];
  targetFilePath?: string;
  targetFileName?: string;
  requireRoot?: boolean;
}): RepoTreeEntry[] => {
  const blobs = input.tree.filter((entry) => entry.type === 'blob');
  const targetPath = normalizePath(input.targetFilePath);
  if (targetPath) {
    return blobs.filter((entry) => entry.path === targetPath);
  }

  const targetName = input.targetFileName?.trim();
  if (!targetName) {
    return [];
  }

  return blobs.filter((entry) => {
    if (basenameOf(entry.path) !== targetName) return false;
    if (!input.requireRoot) return true;
    return !entry.path.includes('/');
  });
};

export const discoverRepositories = async (input: {
  repoQuery: string;
  targetFileName?: string;
}) => {
  const repositories = await resolveRepositoryCandidates(input.repoQuery, input.targetFileName);
  return repositories;
};

export const inspectRepository = async (input: {
  repoRef: string;
  targetFilePath?: string;
  targetFileName?: string;
  requireRoot?: boolean;
}) => {
  const repo = (await resolveRepositoryCandidates(input.repoRef, input.targetFileName))[0] ?? null;
  if (!repo) {
    throw new Error(`I could not resolve the repository "${input.repoRef}".`);
  }
  const tree = await fetchRepoTree(repo);
  const matches = resolveTargetMatches({
    tree,
    targetFilePath: input.targetFilePath,
    targetFileName: input.targetFileName,
    requireRoot: input.requireRoot,
  });
  return { repo, tree, matches };
};

export const retrieveRepositoryFile = async (input: {
  repoRef: string;
  filePath?: string;
  targetFilePath?: string;
  targetFileName?: string;
  requireRoot?: boolean;
}): Promise<RepoFileArtifact> => {
  const { repo, matches } = await inspectRepository({
    repoRef: input.repoRef,
    targetFilePath: input.filePath ?? input.targetFilePath,
    targetFileName: input.targetFileName,
    requireRoot: input.requireRoot,
  });

  const match = matches[0];
  if (!match) {
    throw new Error('No matching repository file was found.');
  }

  const htmlUrl = `${GITHUB_WEB_BASE}/${repo.fullName}/blob/${repo.defaultBranch}/${match.path}`;
  const rawUrl = `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/${match.path}`;
  const content = await fetchText(rawUrl);
  return {
    repo,
    path: match.path,
    content,
    sha: match.sha,
    htmlUrl,
    rawUrl,
  };
};
