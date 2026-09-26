/** A user's personal workspace (workspaces are personal today: iOS and the api use the same id). */
export const workspaceIdFor = (uid: string) => `workspace_${uid}`;
