import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BridgeError } from '../bridge.js';
import { redactText, redactValue } from '../redact.js';
const controlDescription = ' Control messages carry status only, never file contents/diffs/logs/secrets.';
const statusText = z.string().max(2048).trim().min(1);
const taskId = z.string().regex(/^adv_[0-9a-f]{16}$/);
const taskParameter = { type: 'string', required: true, description: 'Advisor task_id returned by advisor_init.' };
/** Same bundled provider contract as dsh-genui; no skills package is required. */
function bundledSkillProvider() {
    const path = fileURLToPath(new URL('../../skills/chatgpt-advisor/SKILL.md', import.meta.url));
    const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const end = raw.indexOf('\n---\n', 4);
    if (!raw.startsWith('---\n') || end < 0
        || !/^name:\s*chatgpt-advisor\s*$/m.test(raw.slice(4, end))) {
        throw new Error('Invalid advisor skill frontmatter.');
    }
    const metadata = {
        name: 'chatgpt-advisor',
        description: 'Work with ChatGPT as a read-only advisor: initialize, wait for a plan, execute in DSH, and report for review.',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: 'dsh-chatgpt-bridge',
        path,
        resourceBase: { kind: 'directory', path: dirname(path) },
    };
    return {
        name: metadata.provider,
        list: () => Promise.resolve([{ ...metadata, rank: 600, locator: path }]),
        get: () => Promise.resolve({ ...metadata, content: raw.slice(end + 5) }),
    };
}
/** Undefined runtime is the controller-mode guard: no imports or injections. */
export function registerAdvisorAgentTools(ctx, runtime, bridge, log) {
    if (!runtime)
        return;
    const { store } = runtime;
    const sessionTasks = new Map();
    // Keep check + creation atomic even if the optional tools service is replaced.
    let initQueue = Promise.resolve();
    ctx.inject(['tools'], async (toolCtx) => {
        let defineTool;
        try {
            ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
        }
        catch {
            log.warn('Advisor agent tools skipped: optional @deepseek-ai/dsh-tools could not be imported.');
            return;
        }
        const disposers = [];
        const owned = async (task_id, exec) => {
            const task = await store.getTask(task_id);
            if (task.session_id && exec.agent?.id && task.session_id !== exec.agent.id) {
                throw new BridgeError('TASK_NOT_OWNED', 'Advisor task belongs to another agent session.');
            }
        };
        const register = (name, description, parameters, schema, execute, timeoutMs) => {
            disposers.push(toolCtx.tools.register(defineTool({
                name, description: description + controlDescription, parameters,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
                output: {
                    schema: { type: 'json' },
                    render: (_args, value) => [{ type: 'text', text: JSON.stringify(redactValue(value)) }],
                },
                async execute(args, exec) {
                    try {
                        const parsed = schema.safeParse(args);
                        if (!parsed.success)
                            throw new BridgeError('INVALID_ARGUMENT', 'Invalid advisor control arguments (check required fields, lengths and bounds).');
                        return redactValue(await execute(parsed.data, exec));
                    }
                    catch (error) {
                        if (error instanceof BridgeError)
                            throw new Error(`${redactText(error.code)}: ${redactText(error.message)}`);
                        throw new Error('ADVISOR_AGENT_TOOL_FAILED: Advisor control operation failed.');
                    }
                },
                presentCall: () => ({ card: 'generic', title: name, kind: 'other' }),
            })));
        };
        try {
            register('advisor_init', 'Start a task for ChatGPT planning and review in a registered workspace.', {
                goal: { type: 'string', required: true, description: 'Goal, at most 2048 characters.' },
                workspace: { type: 'string', description: 'Registered workspace id, path, or title; defaults to the calling session cwd.' },
            }, z.object({ goal: statusText, workspace: z.string().min(1).max(4096).optional() }), (args, exec) => {
                const start = initQueue.then(async () => {
                    const session_id = exec.agent?.id;
                    if (session_id) {
                        const knownId = sessionTasks.get(session_id);
                        if (knownId) {
                            try {
                                const known = await store.getTask(knownId);
                                if (!['DONE', 'BLOCKED', 'ERROR'].includes(known.state)) {
                                    throw new BridgeError('TASK_ALREADY_ACTIVE', `Session already has active advisor task ${known.task_id}.`);
                                }
                            }
                            catch (error) {
                                if (!(error instanceof BridgeError) || error.code !== 'TASK_NOT_FOUND')
                                    throw error;
                            }
                            sessionTasks.delete(session_id);
                        }
                        const tasks = await store.listTasks();
                        const active = tasks.find((task) => task.session_id === session_id);
                        if (active)
                            throw new BridgeError('TASK_ALREADY_ACTIVE', `Session already has active advisor task ${active.task_id}.`);
                        // listTasks is capped at 100, with no pagination/session filter. Never
                        // assume an absent session has no task when the snapshot may be truncated.
                        if (tasks.length >= 100)
                            throw new BridgeError('TASK_LOOKUP_LIMIT', 'Active task listing is full; cannot safely start another session task.');
                    }
                    const cwd = exec.agent?.session.header.cwd;
                    if (args.workspace === undefined && !cwd) {
                        throw new BridgeError('WORKSPACE_NOT_FOUND', 'Supply a registered workspace or use an agent session with a registered cwd.');
                    }
                    // resolveWorkspace matches registered paths with the bridge's platform-aware path rules.
                    const workspace = await bridge.resolveWorkspace(args.workspace ?? cwd);
                    const task = await store.createTask({ workspace_id: workspace.id, goal: args.goal,
                        ...(session_id === undefined ? {} : { session_id }) });
                    if (session_id)
                        sessionTasks.set(session_id, task.task_id);
                    return { task_id: task.task_id, state: task.state, iteration: task.iteration, next: 'call advisor_get_plan' };
                });
                initQueue = start.catch(() => { });
                return start;
            });
            register('advisor_get_plan', 'Wait for the next ChatGPT plan or terminal verdict; repeat on waiting. While the task is executing, calling again re-delivers the same plan (redelivered: true).', {
                task_id: taskParameter,
                wait_seconds: { type: 'integer', default: 90, description: 'Wait 1..100 seconds (default 90).' },
            }, z.object({ task_id: taskId, wait_seconds: z.number().int().min(1).max(100).default(90) }), async (args, exec) => {
                await owned(args.task_id, exec);
                return store.getPlan({ task_id: args.task_id, wait_ms: args.wait_seconds * 1000 });
            }, 110_000);
            register('advisor_executed', 'Report execution status for ChatGPT review.', {
                task_id: taskParameter,
                iteration: { type: 'integer', required: true, description: 'Plan iteration, at least 1.' },
                changed_files_count: { type: 'integer', required: true, description: 'Number of changed files, at least 0.' },
                tests: { type: 'array', required: true, description: 'At most 50 test statuses.', items: {
                        type: 'object', additionalProperties: false, properties: {
                            name: { type: 'string', required: true, description: 'Test name, at most 2048 characters.' },
                            status: { type: 'string', required: true, enum: ['passed', 'failed', 'skipped', 'not_run'] },
                        },
                    } },
                summary: { type: 'string', required: true, description: 'Status summary, at most 2048 characters.' },
            }, z.object({ task_id: taskId, iteration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
                changed_files_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
                tests: z.array(z.object({ name: statusText, status: z.enum(['passed', 'failed', 'skipped', 'not_run']) })).max(50),
                summary: statusText }), async (args, exec) => {
                await owned(args.task_id, exec);
                return store.reportExecuted(args);
            });
            register('advisor_handoff', 'Hand a task back to ChatGPT when execution requires a decision.', {
                task_id: taskParameter,
                reason: { type: 'string', required: true, description: 'Handoff reason, at most 2048 characters.' },
            }, z.object({ task_id: taskId, reason: statusText }), async (args, exec) => {
                await owned(args.task_id, exec);
                return store.handoff(args);
            });
        }
        catch (error) {
            for (const dispose of disposers.reverse())
                dispose();
            throw error;
        }
        return () => { for (const dispose of disposers.reverse())
            dispose(); };
    });
    ctx.inject(['skills'], (skillCtx) => {
        try {
            const provider = bundledSkillProvider();
            const skills = skillCtx.skills;
            const dispose = skills.registerProvider(() => provider);
            if (typeof dispose === 'function')
                return dispose;
        }
        catch {
            log.warn('Advisor bundled skill skipped: SKILL.md is unavailable, has invalid frontmatter, or the provider could not be registered.');
        }
    });
}
