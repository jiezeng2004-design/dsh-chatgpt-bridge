const WRITE_KEYWORDS = [
  /\b(?:edit|create|write|delete|patch|refactor)\b/i,
];

const GIT_MUTATE_KEYWORDS = [
  /\b(?:git\s+commit|git\s+push|git\s+tag|git\s+merge|git\s+reset)\b/i,
];

const NPM_PUBLISH_KEYWORDS = [
  /\b(?:npm\s+publish|publish\s+package)\b/i,
];

const GITHUB_RELEASE_KEYWORDS = [
  /\b(?:gh\s+release|github\s+release)\b/i,
];

const NETWORK_KEYWORDS = [
  /\b(?:npm\s+install|pnpm\s+install|yarn\s+add|curl|wget|download)\b/i,
];

const EXTERNAL_WRITE_KEYWORDS = [
  /\bexternal(?:_|\s+)path\b/i,
  /\boutside (?:the )?workspace\b/i,
];

function hasIntent(text, patterns) {
  return patterns.some((p) => p.test(text));
}

export function validateGoalPreflight(input) {
  const text = `${input.goal}\n${input.plan ?? ''}`;
  const constraints = input.constraints ?? {};
  const conflicts = [];
  const suggestedDeltas = [];

  const forbidden = new Set(constraints.forbidden_actions ?? []);
  const allowed = constraints.allowed_actions !== undefined ? new Set(constraints.allowed_actions) : undefined;

  const isForbidden = (action) => {
    if (forbidden.has(action)) return true;
    if (allowed !== undefined && !allowed.has(action)) return true;
    return false;
  };

  const wantsWrite = hasIntent(text, WRITE_KEYWORDS);
  if (wantsWrite) {
    if (constraints.read_only === true) {
      conflicts.push('Goal requires modifying files or workspace content, but constraints.read_only is true.');
      suggestedDeltas.push('Set constraints.read_only=false');
    }
    if (isForbidden('filesystem.write')) {
      conflicts.push('Goal requires modifying files, but action class "filesystem.write" is forbidden.');
      suggestedDeltas.push('Remove "filesystem.write" from forbidden_actions or add to allowed_actions');
    }
    if (constraints.max_changed_files === 0) {
      conflicts.push('Goal requires modifying files, but constraints.max_changed_files is 0.');
      suggestedDeltas.push('Increase constraints.max_changed_files');
    }
  }

  const wantsGitMutate = hasIntent(text, GIT_MUTATE_KEYWORDS);
  if (wantsGitMutate) {
    if (constraints.read_only === true) {
      conflicts.push('Goal requires git commit/tag/push, but constraints.read_only is true.');
      suggestedDeltas.push('Set constraints.read_only=false');
    }
    if (isForbidden('git.mutate')) {
      conflicts.push('Goal requires git commit/tag/push, but action class "git.mutate" is forbidden.');
      suggestedDeltas.push('Remove "git.mutate" from forbidden_actions or add to allowed_actions');
    }
  }

  const wantsNpmPublish = hasIntent(text, NPM_PUBLISH_KEYWORDS);
  if (wantsNpmPublish) {
    if (isForbidden('npm.publish')) {
      conflicts.push('Goal requires publishing to npm, but action class "npm.publish" is forbidden.');
      suggestedDeltas.push('Remove "npm.publish" from forbidden_actions or add to allowed_actions');
    }
  }

  const wantsGhRelease = hasIntent(text, GITHUB_RELEASE_KEYWORDS);
  if (wantsGhRelease) {
    if (isForbidden('github.release')) {
      conflicts.push('Goal requires creating a GitHub Release, but action class "github.release" is forbidden.');
      suggestedDeltas.push('Remove "github.release" from forbidden_actions or add to allowed_actions');
    }
  }

  const wantsNetwork = hasIntent(text, NETWORK_KEYWORDS);
  if (wantsNetwork) {
    if (isForbidden('network')) {
      conflicts.push('Goal requires downloading packages or network access, but action class "network" is forbidden.');
      suggestedDeltas.push('Remove "network" from forbidden_actions or add to allowed_actions');
    }
  }

  if (wantsWrite && hasIntent(text, EXTERNAL_WRITE_KEYWORDS) && isForbidden('external_path.write')) {
    conflicts.push('Goal requires writing outside the workspace, but action class "external_path.write" is forbidden.');
    suggestedDeltas.push('Remove "external_path.write" from forbidden_actions or add to allowed_actions');
  }

  return {
    valid: conflicts.length === 0,
    conflicts,
    ...(suggestedDeltas.length === 0 ? {} : { suggested_constraint_delta: suggestedDeltas }),
  };
}
