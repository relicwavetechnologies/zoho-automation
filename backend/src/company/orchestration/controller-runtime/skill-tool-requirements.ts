export type SkillToolRequirements = {
  required: string[];
  optional: string[];
  action: string[];
  all: string[];
};

const LEGACY_NON_REQUIRED = new Set(['larkDoc', 'workspace', 'terminal', 'search']);

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const extractFrontmatter = (content: string | null | undefined): string => {
  if (!content) return '';
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match?.[1] ?? '';
};

const parseFlatAllowedTools = (frontmatter: string): string[] => {
  const match = frontmatter.match(/(?:^|\n)allowed_tools:\s*\n((?:\s*-\s*[^\n]+\n?)+)/);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
};

export const parseSkillToolRequirements = (content: string | null | undefined): SkillToolRequirements => {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    return { required: [], optional: [], action: [], all: [] };
  }

  const requiredMatch = frontmatter.match(/(?:^|\n)allowed_tools:\s*\n\s{2}required:\s*\n((?:\s{4}-\s*[^\n]+\n?)+)/);
  const optionalMatch = frontmatter.match(/(?:^|\n)\s{2}optional:\s*\n((?:\s{4}-\s*[^\n]+\n?)+)/);
  const actionMatch = frontmatter.match(/(?:^|\n)\s{2}action:\s*\n((?:\s{4}-\s*[^\n]+\n?)+)/);

  const parseNestedList = (block: string | undefined): string[] =>
    (block ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);

  if (requiredMatch || optionalMatch || actionMatch) {
    const required = parseNestedList(requiredMatch?.[1]);
    const optional = parseNestedList(optionalMatch?.[1]);
    const action = parseNestedList(actionMatch?.[1]);
    return {
      required,
      optional,
      action,
      all: unique([...required, ...optional, ...action]),
    };
  }

  const flat = parseFlatAllowedTools(frontmatter);
  return {
    required: flat.filter((tool) => !LEGACY_NON_REQUIRED.has(tool)),
    optional: flat.filter((tool) => tool === 'search'),
    action: flat.filter((tool) => tool === 'larkDoc' || tool === 'workspace' || tool === 'terminal'),
    all: flat,
  };
};

export const getRequiredSkillTools = (content: string | null | undefined): string[] =>
  parseSkillToolRequirements(content).required;
