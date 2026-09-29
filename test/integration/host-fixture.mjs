// Loaded only by dsh-cli.test.mjs in its disposable DSH_HOME.
export const inject = ['workspaceRegistry', 'agentPresets'];

export async function apply(ctx) {
  await ctx.workspaceRegistry.create(process.cwd(), 'Bridge contract workspace');
  const unregister = await ctx.agentPresets.register({ id: 'bridge-contract', plugins: [] });
  ctx.effect(() => unregister);
}
