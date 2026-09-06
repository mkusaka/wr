import { Client } from "../cli/client.js";
import type { Connection } from "../cli/files.js";
export type ResumeBinding = Connection & {
    work: string;
    key: string;
    scopeRevision: number;
};
/** Same bounded current-state view for static hooks and native context rollover. */
export async function resumeGuidance(ctx: ResumeBinding): Promise<string> {
    let guidance = `You are working on ${ctx.key}. Use wr-next status to read current requirements and state. Use wr-next report for decisions/blockers; wr-next done --summary to submit. Submission is not unconditional acceptance. Do not repeat external actions based only on old handoff prose. Context-window rollover continues the same Execution. Native child work needs a dedicated harness binding; project hooks alone do not provide it.`;
    try {
        const view = await new Client(ctx).request<{
            work: {
                title: string;
                description: string;
                scopeRevision: number;
            };
        }>(`/v1/work?work=${encodeURIComponent(ctx.work)}`);
        guidance += `\nTitle: ${view.work.title}\nRequirements: ${view.work.description.slice(0, 4000)}\nScope revision at start: ${ctx.scopeRevision}; current: ${view.work.scopeRevision}.`;
        if (view.work.scopeRevision !== ctx.scopeRevision)
            guidance += " Requirements changed. Do not adopt the new scope implicitly; replan/rebind before further stateful actions.";
        if (view.work.description.length > 4000)
            guidance += " Requirements truncated: retrieve current state before acting.";
    }
    catch {
        guidance += " Current authority unavailable: read live state before external actions; completion cannot be assumed.";
    }
    return guidance;
}
