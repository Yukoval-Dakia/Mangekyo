export type ToolErrorCode = 'invalid_args' | 'not_found' | 'ambiguous_ref' | 'access_revoked' | 'basis_stale' |
  'version_conflict' | 'evidence_not_opened' | 'budget_or_limit' | 'partial_success' |
  'tool_unavailable' | 'image_unavailable' | 'invalid_memory' | 'execution_failed';

export type ToolNext = { tool: string; args: Record<string, unknown>; why: string };

export function learningToolError(code: ToolErrorCode, field: string | undefined, message: string, next?: ToolNext) {
  return {ok:false as const, code, ...(field && {field}), message: message.slice(0,80).toWellFormed(), ...(next && {next})};
}

export type ToolError = ReturnType<typeof learningToolError>;
