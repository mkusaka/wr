export type Policy = {
    name: "declaration-v1" | "children-v1" | "evidence-v1";
    checks: string[];
};
export type Resource = {
    key: string;
    mode: "read" | "write" | "exclusive";
};
export type ArtifactRef = {
    repo: string;
    sha: string;
};
export type Principal = {
    id: string;
    device: string;
    role: "operator" | "worker" | "launcher" | "collector" | "adapter" | "bootstrap" | "coordinator" | "coordination-runtime" | "effect";
    grant?: string;
    coordinator?: string;
    dispatch?: string;
    execution?: string;
    checks?: string[];
    generation?: number;
    runtimeRoot?: string;
    runtimeAgent?: string;
};
export type Work = {
    collection?: boolean;
    policyTemplate?: string;
    id: string;
    key: string;
    parent: string | null;
    title: string;
    description: string;
    state: "open" | "done" | "cancelled";
    revision: number;
    scopeRevision: number;
    policy: Policy;
    acceptance: string | null;
    links: string[];
    phase: string;
    priority: number;
    lane: string | null;
    resources: Resource[];
    candidate: ArtifactRef[] | null;
    createdAt: string;
    updatedAt: string;
    legacy?: {
        source: string;
        key: string;
        state: string;
        stage: string;
        run: string;
        pass1: boolean;
        gate: string;
        writesKnown: boolean;
    };
};
export type Dependency = {
    id: string;
    prerequisite: string;
    dependent: string;
    predicate: "accepted" | "legacy-pass1" | "legacy-after";
};
export type Session = {
    id: string;
    runtime: string;
    externalId: string;
    device: string;
    parentSession?: string | null;
};
export type Run = {
    id: string;
    session: string | null;
    parentRun?: string | null;
    runtimeAgent?: string | null;
    device: string;
    runtime: string;
    state: "active" | "ended" | "unknown";
    startedAt: string;
    endedAt: string | null;
    windows: string[];
    metadata: Record<string, string>;
};
export type Execution = {
    coordinator?: string;
    id: string;
    work: string;
    run: string;
    role: string;
    mode: "read" | "write";
    state: "active" | "finished" | "failed" | "interrupted";
    scopeRevision: number;
    generation: number;
    basis: Record<string, string>;
    environment: string;
    continuedFrom: string | null;
    parent: string | null;
    delegation?: string | null;
    startedAt: string;
    endedAt: string | null;
};
export type Reservation = {
    coordinator?: string;
    id: string;
    execution: string;
    key: string;
    mode: Resource["mode"];
    state: "active" | "released";
    generation: number;
};
export type Hold = {
    id: string;
    work: string;
    kind: string;
    reason: string;
    authority: "operator" | "worker";
    execution: string | null;
    resolvedAt: string | null;
};
export type Result = {
    id: string;
    work: string;
    execution: string | null;
    scopeRevision: number;
    basis: Record<string, string>;
    summary: string;
    manifest: ArtifactRef[];
    subject: string;
    submittedAt: string;
};
export type Check = {
    id: string;
    result: string;
    name: string;
    subject: string;
    status: "passed" | "failed" | "pending";
    collector: string;
    evidence: string | null;
    observedAt: string;
};
export type Acceptance = {
    id: string;
    work: string;
    result: string | null;
    scopeRevision: number;
    fingerprint: string;
    policy: Policy;
    basis: Record<string, string>;
    evidence: string[];
    source: "declared" | "observed" | "derived";
    acceptedAt: string;
};
export type Event = {
    id: string;
    seq: number;
    type: string;
    work: string | null;
    execution: string | null;
    source: "declared" | "observed" | "derived";
    actor: string;
    payload: unknown;
    occurredAt: string;
    receivedAt: string;
};
export type CommitSnapshot = {
    id: string;
    work: string;
    execution: string;
    scopeRevision: number;
    generation: number;
    repo: string;
    tree: string;
    base: string | null;
    branch: string | null;
    capturedAt: string;
    contributors: string[];
    originCommit?: string;
};
export type ContextRecord = {
    id: string;
    snapshot: CommitSnapshot;
    digest: string;
};
export type Artifact = {
    id: string;
    repo: string;
    sha: string;
    tree: string;
    parents: string[];
    subject: string;
    author: string;
    committer: string;
    context: string | null;
    gaps: string[];
    observedAt: string;
};
export type Contribution = {
    id: string;
    artifact: string;
    execution: string | null;
    relation: "committed_by" | "implemented_by" | "integrated_by" | "rebased_by" | "amended_by" | "observed_by";
    source: "observed" | "declared" | "derived";
    evidence: string;
};
export type Rewrite = {
    id: string;
    repo: string;
    old: string;
    new: string;
    operation: "amend" | "rebase" | "cherry-pick" | "squash";
    execution: string | null;
    observedAt: string;
};
export type PullRequest = {
    id: string;
    repo: string;
    number: number;
    url: string;
    title: string;
    author: string | null;
    head: string;
    base: string;
    state: string;
    draft: boolean;
    commits: string[];
    reviews: {
        id: string;
        author: string;
        sha: string;
        state: string;
    }[];
    checks: {
        name: string;
        sha: string;
        status: string;
    }[];
    publisher: string | null;
    observer: string;
    updatedAt: string;
    snapshots: {
        head: string;
        commits: string[];
        observedAt: string;
    }[];
};
export type Delegation = {
    coordinatorIssuer?: string;
    issuerAgent?: string;
    id: string;
    parent: string | null;
    work: string;
    tokenHash: string;
    expiresAt: string;
    claimedBy: string | null;
    objective: string;
    state?: "issued" | "claimed" | "revoked" | "expired";
    parentGeneration?: number;
    parentScopeRevision?: number;
    workScopeRevision?: number;
    issuer?: string;
    device?: string;
    role?: string;
    mode?: "read" | "write";
    runtimeChildId?: string | null;
    revokedAt?: string | null;
};
/** Runtime lineage is independent from work decomposition and delegated work. */
export type RuntimeAgent = {
    lastSequence?: number;
    id: string;
    root: string;
    parent: string | null;
    runtime: string;
    externalSessionId: string;
    externalAgentId: string;
    invocationId: string;
    device: string;
    run: string;
    execution: string | null;
    state: "active" | "quiescent" | "ended" | "unknown";
    generation: number;
    startedAt: string;
    endedAt: string | null;
};
export type Source = {
    id: string;
    digest: string;
    root: string;
    mapping: Record<string, string>;
    mode: "shadow" | "next" | "legacy";
    importedAt: string;
    comparedAt: string | null;
};
export type Effect = {
    id: string;
    kind: "pr.create";
    execution: string | null;
    work: string;
    state: "prepared" | "succeeded" | "unknown";
    payload: Record<string, string>;
    result: string | null;
};
export type Device = {
    id: string;
    owner: string;
};
export type Lane = {
    id: string;
    capacity: number;
};
export type Rows = {
    coordinationGrants: CoordinationGrant;
    coordinators: Coordinator;
    dispatches: WorkDispatch;
    work: Work;
    dependencies: Dependency;
    sessions: Session;
    runs: Run;
    executions: Execution;
    reservations: Reservation;
    holds: Hold;
    results: Result;
    checks: Check;
    acceptances: Acceptance;
    events: Event;
    contexts: ContextRecord;
    artifacts: Artifact;
    contributions: Contribution;
    rewrites: Rewrite;
    prs: PullRequest;
    delegations: Delegation;
    sources: Source;
    effects: Effect;
    devices: Device;
    lanes: Lane;
    runtimeAgents: RuntimeAgent;
};
export const tables = ["work", "dependencies", "sessions", "runs", "executions", "reservations", "holds", "results", "checks", "acceptances", "events", "contexts", "artifacts", "contributions", "rewrites", "prs", "delegations", "sources", "effects", "devices", "lanes", "runtimeAgents", "coordinationGrants", "coordinators", "dispatches"] as const;
export type State = {
    [K in keyof Rows]: Record<string, Rows[K]>;
} & {
    meta: {
        revision: number;
        sequence: number;
        nextKey: number;
    };
};
export function emptyState(): State {
    return { ...Object.fromEntries(tables.map(t => [t, {}])), meta: { revision: 0, sequence: 0, nextKey: 1 } } as State;
}
/** Operator-approved repo/work scope. No execution is fabricated for planning. */
export type CoordinationGrant = {
    id: string;
    repository: string;
    work: string;
    owner: string;
    device: string;
    environments: string[];
    runtimes: string[];
    generation: number;
    state: "enabled" | "revoked";
    defaultPolicy: Policy;
    maxItems: number;
};
export type Coordinator = {
    id: string;
    grant: string;
    grantGeneration: number;
    work: string;
    runtimeAgent: string;
    run: string;
    device: string;
    owner: string;
    environment: string;
    generation: number;
    scopeRevision: number;
    intent: string;
    currentExecution: string | null;
    state: "active" | "closed" | "unknown";
};
/** A tool's assignment is pinned, never resolved from a mutable "latest work". */
export type WorkDispatch = {
    id: string;
    coordinator: string;
    externalId: string;
    inputDigest: string;
    execution: string | null;
    generation: number | null;
    state: "open" | "closed";
    releaseRequested: boolean;
};
