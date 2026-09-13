import { join, resolve } from 'node:path';

/** Paths owned by the Partner runtime inside its selected workspace. */
export type PartnerPaths = Readonly<{
  workspaceRoot: string;
  managedRoot: string;
  database: string;
  attachments: string;
}>;

/** Resolve the one managed subtree without changing the ordinary workspace. */
export function partnerPaths(workspace: string): PartnerPaths {
  const workspaceRoot = resolve(workspace);
  const managedRoot = join(workspaceRoot, '.lamplit');
  return {
    workspaceRoot,
    managedRoot,
    database: join(managedRoot, 'session.sqlite'),
    attachments: join(managedRoot, 'attachments'),
  };
}
