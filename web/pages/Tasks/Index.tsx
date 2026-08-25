import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  GitPullRequestIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  MoonIcon,
  SearchIcon,
  SquareTerminalIcon,
  SunIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Autocomplete, useFilter } from "react-aria-components";
import { router } from "@inertiajs/react";
import { parseAsBoolean, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectEmpty,
  SelectInput,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { matchesQuery } from "../../../src/search.ts";

export type Task = {
  issueId: string;
  title: string | null;
  status: "open" | "active" | "done" | "cancelled";
  updatedAt: string;
  deviceIds: string[];
  deviceNames: string[];
  repoRoots: string[];
  worktreePaths: string[];
};

export type Run = {
  id: string;
  cliSessionId: string;
  cli: "codex" | "claude" | "devin";
  externalSessionId: string;
  terminalId: string | null;
  startedCwd: string | null;
  source: string | null;
  status: "active" | "ended";
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  deviceIds: string[];
  deviceNames: string[];
  repoRoots: string[];
  worktreePaths: string[];
};

export type PullRequest = {
  repo: string;
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
  state: "open" | "closed" | "merged";
  updatedAt: string;
  deviceIds: string[];
  deviceNames: string[];
  repoRoots: string[];
  worktreePaths: string[];
};

export type Device = { id: string; name: string };

export type Repository = { repoRoot: string };

export type Worktree = { worktreePath: string };

export type ConversationLink = {
  id: string;
  cliSessionId: string;
  url: string;
  repoRoot: string | null;
  worktreePath: string | null;
  createdAt: string;
  deviceIds: string[];
  deviceNames: string[];
  tasks: Array<{ issueId: string; title: string | null; status: Task["status"] }>;
};

type Ledger = {
  runs: Run[];
  tasks: Task[];
  pullRequests: PullRequest[];
  conversationLinks: ConversationLink[];
  devices: Device[];
  repositories: Repository[];
  worktrees: Worktree[];
};

type Filters = {
  query: string;
  type: string;
  state: string;
  device: string;
  repository: string;
  worktree: string;
};

const filterParsers = {
  q: parseAsString.withDefault(""),
  type: parseAsStringLiteral([
    "all",
    "runs",
    "tasks",
    "pullRequests",
    "conversations",
  ] as const).withDefault("all"),
  state: parseAsStringLiteral([
    "current",
    "all",
    "open",
    "active",
    "ended",
    "done",
    "cancelled",
    "closed",
    "merged",
  ] as const).withDefault("current"),
  device: parseAsString.withDefault("all"),
  repo: parseAsString.withDefault("all"),
  worktree: parseAsString.withDefault("all"),
  global: parseAsBoolean.withDefault(false),
};

type SelectedRecord =
  | { kind: "task"; key: string; issueId: string }
  | { kind: "run"; key: string; id: string }
  | { kind: "pullRequest"; key: string; repo: string; number: number };

type TaskRelationships = {
  linearIssueId: string;
  title: string | null;
  status: Task["status"];
  executions: Array<{
    id: string;
    status: "active" | "finished" | "abandoned";
    sessionRunId: string | null;
    cli: "codex" | "claude" | "devin";
    externalSessionId: string;
    worktreePath: string | null;
    branch: string | null;
  }>;
  pullRequests: Array<{
    repo: string;
    number: number;
    url: string;
    headBranch: string;
    baseBranch: string;
    state: PullRequest["state"];
    parentNumber: number | null;
  }>;
  links: Array<{ kind: string; ref: string }>;
};

type PullRequestRelationships = {
  parentPullRequest: { repo: string; number: number; url: string } | null;
  childPullRequests: Array<{
    repo: string;
    number: number;
    url: string;
    state: PullRequest["state"];
  }>;
  tasks: Array<{ issueId: string; title: string | null; status: Task["status"] }>;
  runs: Array<{
    id: string;
    cli: "codex" | "claude" | "devin";
    externalSessionId: string;
    terminalId: string | null;
    startedAt: string;
    endedAt: string | null;
  }>;
  checkouts: Array<{
    id: string;
    repoRoot: string;
    worktreePath: string;
    branch: string | null;
  }>;
};

type LoadedRelationships =
  | { kind: "task"; data: TaskRelationships }
  | { kind: "run"; data: TaskRelationships[] }
  | { kind: "pullRequest"; data: PullRequestRelationships };

export function filterLedger(ledger: Ledger, filters: Filters) {
  const matchesScope = (record: Run | Task | PullRequest) =>
    (filters.device === "all" || record.deviceIds.includes(filters.device)) &&
    (filters.repository === "all" || record.repoRoots.includes(filters.repository)) &&
    (filters.worktree === "all" || record.worktreePaths.includes(filters.worktree));
  const matchesConversationScope = (conversation: ConversationLink) =>
    (filters.device === "all" || conversation.deviceIds.includes(filters.device)) &&
    (filters.repository === "all" || conversation.repoRoot === filters.repository) &&
    (filters.worktree === "all" || conversation.worktreePath === filters.worktree);
  const filterByState = <T extends Run | Task | PullRequest>(
    records: T[],
    typeMatch: boolean,
    isCurrent: (record: T) => boolean,
    stateValue: (record: T) => string,
    queryValues: (record: T) => unknown[],
  ): { current: T[]; nonCurrent: number } => {
    if (!typeMatch) return { current: [], nonCurrent: 0 };
    const current: T[] = [];
    let nonCurrent = 0;
    for (const record of records) {
      if (!matchesScope(record)) continue;
      if (filters.state === "current" && !isCurrent(record)) {
        nonCurrent++;
        continue;
      }
      if (!matchesQuery(queryValues(record), filters.query)) continue;
      if (filters.state === "all") {
        current.push(record);
      } else if (filters.state === "current") {
        current.push(record);
      } else if (stateValue(record) === filters.state) {
        current.push(record);
      }
    }
    return { current, nonCurrent };
  };
  const runs = filterByState<Run>(
    ledger.runs,
    filters.type === "all" || filters.type === "runs",
    (run) => run.status === "active",
    (run) => run.status,
    (run) => [
      run.id,
      run.cli,
      run.externalSessionId,
      run.terminalId,
      run.startedCwd,
      run.source,
      run.status,
      run.deviceIds,
      run.deviceNames,
      run.repoRoots,
      run.worktreePaths,
    ],
  );
  const tasks = filterByState<Task>(
    ledger.tasks,
    filters.type === "all" || filters.type === "tasks",
    (task) => task.status === "open" || task.status === "active",
    (task) => task.status,
    (task) => [
      task.issueId,
      task.title,
      task.deviceIds,
      task.deviceNames,
      task.repoRoots,
      task.worktreePaths,
    ],
  );
  const pullRequests = filterByState<PullRequest>(
    ledger.pullRequests,
    filters.type === "all" || filters.type === "pullRequests",
    (pullRequest) => pullRequest.state === "open",
    (pullRequest) => pullRequest.state,
    (pullRequest) => [
      pullRequest.repo,
      pullRequest.number,
      `${pullRequest.repo}#${pullRequest.number}`,
      pullRequest.url,
      pullRequest.headBranch,
      pullRequest.baseBranch,
      pullRequest.deviceIds,
      pullRequest.deviceNames,
      pullRequest.repoRoots,
      pullRequest.worktreePaths,
    ],
  );
  const conversationLinks =
    filters.type !== "all" && filters.type !== "conversations"
      ? []
      : ledger.conversationLinks.filter(
          (conversation) =>
            matchesConversationScope(conversation) &&
            matchesQuery(
              [
                conversation.url,
                conversation.repoRoot,
                conversation.worktreePath,
                conversation.deviceIds,
                conversation.deviceNames,
                conversation.tasks.map((task) => task.issueId),
                conversation.tasks.map((task) => task.title),
              ],
              filters.query,
            ),
        );
  return {
    runs: runs.current,
    tasks: tasks.current,
    pullRequests: pullRequests.current,
    conversationLinks,
    nonCurrentTotal: runs.nonCurrent + tasks.nonCurrent + pullRequests.nonCurrent,
  };
}

function statusVariant(status: Task["status"] | PullRequest["state"] | Run["status"]) {
  if (status === "cancelled") return "destructive" as const;
  if (status === "active" || status === "merged") return "default" as const;
  if (status === "done") return "secondary" as const;
  return "outline" as const;
}

function isStateAvailable(type: string, state: string) {
  if (state === "current" || state === "all") return true;
  if (type === "conversations") return false;
  if (type === "all") return state === "open";
  if (type === "runs") return state === "active" || state === "ended";
  if (type === "tasks")
    return state === "open" || state === "active" || state === "done" || state === "cancelled";
  if (type === "pullRequests") return state === "open" || state === "closed" || state === "merged";
  return false;
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);
  return (
    <Button
      size="xs"
      variant="outline"
      className="max-w-full justify-start"
      onPress={() => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          timeoutRef.current = setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      <code className="truncate">{copied ? "Copied" : command}</code>
    </Button>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <Button
      size="icon-sm"
      variant="outline"
      aria-label={`Switch to ${nextTheme} mode`}
      onPress={() => {
        localStorage.setItem("wr-theme", nextTheme);
        document.documentElement.classList.toggle("dark", nextTheme === "dark");
        setTheme(nextTheme);
      }}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

export default function TasksIndex({
  runs,
  tasks,
  pullRequests,
  conversationLinks,
  devices,
  repositories,
  worktrees,
}: {
  runs: Run[];
  tasks: Task[];
  pullRequests: PullRequest[];
  conversationLinks: ConversationLink[];
  devices: Device[];
  repositories: Repository[];
  worktrees: Worktree[];
}) {
  const { contains } = useFilter({ sensitivity: "base" });
  const [, startTransition] = useTransition();
  const [queryState, setQueryState] = useQueryStates(filterParsers, { history: "replace" });
  const query = queryState.q;
  const type = queryState.type;
  const state = isStateAvailable(type, queryState.state) ? queryState.state : "all";
  const device = queryState.device;
  const repository = queryState.repo;
  const worktree = queryState.worktree;
  const [deviceOptions, setDeviceOptions] = useState(devices);
  const [repositoryOptions, setRepositoryOptions] = useState(repositories);
  const [worktreeOptions, setWorktreeOptions] = useState(worktrees);
  const deviceRequest = useRef(0);
  const repositoryRequest = useRef(0);
  const worktreeRequest = useRef(0);
  const [selected, setSelected] = useState<SelectedRecord | null>(null);
  const [relationships, setRelationships] = useState<LoadedRelationships | null>(null);
  const [relationshipError, setRelationshipError] = useState<string | null>(null);
  const [relationshipsLoading, setRelationshipsLoading] = useState(false);
  const initialQuery = useRef(query);
  const filtered = useMemo(
    () =>
      filterLedger(
        { runs, tasks, pullRequests, conversationLinks, devices, repositories, worktrees },
        { query, type, state, device, repository, worktree },
      ),
    [
      runs,
      tasks,
      pullRequests,
      conversationLinks,
      devices,
      repositories,
      worktrees,
      query,
      type,
      state,
      device,
      repository,
      worktree,
    ],
  );
  const total = runs.length + tasks.length + pullRequests.length + conversationLinks.length;
  const filteredTotal =
    filtered.runs.length +
    filtered.tasks.length +
    filtered.pullRequests.length +
    filtered.conversationLinks.length;
  const nonCurrentTotal = filtered.nonCurrentTotal;
  const globalSearch = queryState.global ? "&global=true" : "";

  useEffect(() => {
    if (query === initialQuery.current) return;
    router.reload();
  }, [query]);

  const searchDevices = (value: string) => {
    const request = ++deviceRequest.current;
    void fetch(`/api/select-options/devices?q=${encodeURIComponent(value)}${globalSearch}`)
      .then(async (response) => {
        if (!response.ok) return;
        const options = (await response.json()) as Device[];
        if (request !== deviceRequest.current) return;
        startTransition(() => setDeviceOptions(options));
      })
      .catch(() => undefined);
  };
  const searchRepositories = (value: string) => {
    const request = ++repositoryRequest.current;
    void fetch(`/api/select-options/repositories?q=${encodeURIComponent(value)}${globalSearch}`)
      .then(async (response) => {
        if (!response.ok) return;
        const options = (await response.json()) as Repository[];
        if (request !== repositoryRequest.current) return;
        startTransition(() => setRepositoryOptions(options));
      })
      .catch(() => undefined);
  };
  const searchWorktrees = (value: string) => {
    const request = ++worktreeRequest.current;
    void fetch(`/api/select-options/worktrees?q=${encodeURIComponent(value)}${globalSearch}`)
      .then(async (response) => {
        if (!response.ok) return;
        const options = (await response.json()) as Worktree[];
        if (request !== worktreeRequest.current) return;
        startTransition(() => setWorktreeOptions(options));
      })
      .catch(() => undefined);
  };
  const clearFilters = () => {
    void setQueryState({
      q: null,
      type: null,
      state: null,
      device: null,
      repo: null,
      worktree: null,
    });
    setSelected(null);
  };

  useEffect(() => {
    if (!selected) {
      setRelationships(null);
      setRelationshipError(null);
      return;
    }

    const controller = new AbortController();
    setRelationships(null);
    setRelationshipError(null);
    setRelationshipsLoading(true);
    const url =
      selected.kind === "task"
        ? `/api/show?task=${encodeURIComponent(selected.issueId)}`
        : selected.kind === "run"
          ? `/api/show?run=${encodeURIComponent(selected.id)}`
          : `/api/pull-request-relationships?repo=${encodeURIComponent(selected.repo)}&number=${selected.number}`;
    void fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load relationships (${response.status})`);
        if (selected.kind === "task" || selected.kind === "run") {
          const data = (await response.json()) as TaskRelationships[];
          setRelationships(
            selected.kind === "task" ? { kind: "task", data: data[0]! } : { kind: "run", data },
          );
        } else {
          const data = (await response.json()) as PullRequestRelationships;
          setRelationships({ kind: "pullRequest", data });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name !== "AbortError")
          setRelationshipError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRelationshipsLoading(false);
      });
    return () => controller.abort();
  }, [selected]);

  useEffect(() => {
    const clearOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearFilters();
    };
    window.addEventListener("keydown", clearOnEscape);
    return () => window.removeEventListener("keydown", clearOnEscape);
  }, []);

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-16">
      <header className="mb-8 border-b pb-8">
        <p className="mb-2 text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
          relationship ledger
        </p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-heading text-5xl font-semibold tracking-tight sm:text-7xl">
              Ledger
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {filteredTotal} of {total} records
            </p>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-xs text-muted-foreground">Esc clears filters</p>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <Card className="mb-8" size="sm">
        <CardContent className="grid gap-4 md:grid-cols-2 md:items-end xl:grid-cols-4">
          <label className="grid gap-1.5 text-sm font-medium md:col-span-2">
            Search
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                autoFocus
                type="search"
                value={query}
                placeholder="Run, task, PR, conversation, device, repository, or worktree"
                onChange={(event) => void setQueryState({ q: event.target.value || null })}
              />
            </InputGroup>
          </label>
          <div className="grid gap-1.5 text-sm font-medium">
            <span>Type</span>
            <Select
              aria-label="Type"
              selectedKey={type}
              onSelectionChange={(key) => {
                const nextType = String(key) as typeof type;
                void setQueryState({
                  type: nextType,
                  state: isStateAvailable(nextType, state) ? state : "all",
                });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem id="all">All types</SelectItem>
                <SelectItem id="runs">Runs</SelectItem>
                <SelectItem id="tasks">Tasks</SelectItem>
                <SelectItem id="pullRequests">Pull requests</SelectItem>
                <SelectItem id="conversations">Conversations</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5 text-sm font-medium">
            <span>State</span>
            <Select
              aria-label="State"
              selectedKey={state}
              onSelectionChange={(key) =>
                void setQueryState({ state: String(key) as typeof queryState.state })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem id="current">Current</SelectItem>
                <SelectItem id="all">All states</SelectItem>
                {type === "all" || type === "tasks" || type === "pullRequests" ? (
                  <SelectItem id="open">Open</SelectItem>
                ) : null}
                {type === "runs" ? (
                  <>
                    <SelectItem id="active">Active</SelectItem>
                    <SelectItem id="ended">Ended</SelectItem>
                  </>
                ) : null}
                {type === "tasks" ? (
                  <>
                    <SelectItem id="active">Active</SelectItem>
                    <SelectItem id="done">Done</SelectItem>
                    <SelectItem id="cancelled">Cancelled</SelectItem>
                  </>
                ) : null}
                {type === "pullRequests" ? (
                  <>
                    <SelectItem id="closed">Closed</SelectItem>
                    <SelectItem id="merged">Merged</SelectItem>
                  </>
                ) : null}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5 text-sm font-medium">
            <span>Device</span>
            <Select
              className="w-full"
              aria-label="Device"
              selectedKey={device}
              onSelectionChange={(key) => void setQueryState({ device: String(key) })}
              onOpenChange={(isOpen) => {
                if (isOpen) searchDevices("");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <Autocomplete filter={contains} onInputChange={searchDevices}>
                <SelectPopover className="max-h-72">
                  <SelectInput aria-label="Search devices" placeholder="Search devices" />
                  <SelectList renderEmptyState={() => <SelectEmpty>No devices found.</SelectEmpty>}>
                    <SelectItem id="all">All devices</SelectItem>
                    {deviceOptions.map((deviceOption) => (
                      <SelectItem key={deviceOption.id} id={deviceOption.id}>
                        {deviceOption.name}
                      </SelectItem>
                    ))}
                  </SelectList>
                </SelectPopover>
              </Autocomplete>
            </Select>
          </div>
          <div className="grid gap-1.5 text-sm font-medium">
            <span>Repository</span>
            <Select
              className="w-full"
              aria-label="Repository"
              selectedKey={repository}
              onSelectionChange={(key) => void setQueryState({ repo: String(key) })}
              onOpenChange={(isOpen) => {
                if (isOpen) searchRepositories("");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <Autocomplete filter={contains} onInputChange={searchRepositories}>
                <SelectPopover className="max-h-72">
                  <SelectInput aria-label="Search repositories" placeholder="Search repositories" />
                  <SelectList
                    renderEmptyState={() => <SelectEmpty>No repositories found.</SelectEmpty>}
                  >
                    <SelectItem id="all">All repositories</SelectItem>
                    {repositoryOptions.map((repositoryOption) => (
                      <SelectItem
                        key={repositoryOption.repoRoot}
                        id={repositoryOption.repoRoot}
                        textValue={repositoryOption.repoRoot}
                        className="min-w-0"
                      >
                        <span className="block min-w-0 truncate" title={repositoryOption.repoRoot}>
                          {repositoryOption.repoRoot}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectList>
                </SelectPopover>
              </Autocomplete>
            </Select>
          </div>
          <div className="grid gap-1.5 text-sm font-medium">
            <span>Worktree</span>
            <Select
              className="w-full"
              aria-label="Worktree"
              selectedKey={worktree}
              onSelectionChange={(key) => void setQueryState({ worktree: String(key) })}
              onOpenChange={(isOpen) => {
                if (isOpen) searchWorktrees("");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <Autocomplete filter={contains} onInputChange={searchWorktrees}>
                <SelectPopover className="max-h-72">
                  <SelectInput aria-label="Search worktrees" placeholder="Search worktrees" />
                  <SelectList
                    renderEmptyState={() => <SelectEmpty>No worktrees found.</SelectEmpty>}
                  >
                    <SelectItem id="all">All worktrees</SelectItem>
                    {worktreeOptions.map((worktreeOption) => (
                      <SelectItem
                        key={worktreeOption.worktreePath}
                        id={worktreeOption.worktreePath}
                        textValue={worktreeOption.worktreePath}
                        className="min-w-0"
                      >
                        <span
                          className="block min-w-0 truncate"
                          title={worktreeOption.worktreePath}
                        >
                          {worktreeOption.worktreePath}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectList>
                </SelectPopover>
              </Autocomplete>
            </Select>
          </div>
          <Button className="w-fit self-end" variant="outline" onPress={clearFilters}>
            <XIcon data-icon="inline-start" />
            Clear
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-10">
        {filtered.runs.length > 0 ? (
          <section aria-label="Run list">
            <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <SquareTerminalIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Runs
              <span className="text-xs font-normal text-muted-foreground">
                {filtered.runs.length}
              </span>
            </h2>
            <div className="grid gap-3">
              {filtered.runs.map((run) => (
                <Card
                  key={run.id}
                  size="sm"
                  className={
                    selected?.kind === "run" && selected.key === run.id
                      ? "border-primary/40 ring-2 ring-primary/10"
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className="w-full text-left"
                    aria-expanded={selected?.kind === "run" && selected.key === run.id}
                    onClick={() =>
                      setSelected(
                        selected?.kind === "run" && selected.key === run.id
                          ? null
                          : { kind: "run", key: run.id, id: run.id },
                      )
                    }
                  >
                    <CardHeader>
                      <CardTitle className="break-all font-mono text-sm">
                        {run.cli}:{run.externalSessionId}
                      </CardTitle>
                      <CardDescription className="break-all font-mono text-xs">
                        {run.startedCwd || run.id}
                        {run.source ? ` · ${run.source}` : ""}
                      </CardDescription>
                      <CardAction className="flex items-center gap-2">
                        <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                        {selected?.kind === "run" && selected.key === run.id ? (
                          <ChevronDownIcon className="size-4 text-muted-foreground" />
                        ) : (
                          <ChevronRightIcon className="size-4 text-muted-foreground" />
                        )}
                      </CardAction>
                    </CardHeader>
                    <CardContent className="grid gap-3 text-xs text-muted-foreground">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <code className="break-all">{run.id}</code>
                        <time dateTime={run.updatedAt}>
                          {new Date(`${run.updatedAt}Z`).toLocaleString("en-US")}
                        </time>
                      </div>
                    </CardContent>
                  </button>
                  <CardContent className="grid gap-3 text-xs text-muted-foreground">
                    <div className="flex flex-wrap gap-2">
                      <CopyCommand
                        command={
                          run.cli === "codex"
                            ? `codex resume ${run.externalSessionId}`
                            : run.cli === "devin"
                              ? `devin --resume ${run.externalSessionId}`
                              : `claude --resume ${run.externalSessionId}`
                        }
                      />
                      {run.terminalId ? <CopyCommand command={`wr run focus ${run.id}`} /> : null}
                    </div>
                    {filtered.conversationLinks.filter(
                      (conversation) => conversation.cliSessionId === run.cliSessionId,
                    ).length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {filtered.conversationLinks
                          .filter((conversation) => conversation.cliSessionId === run.cliSessionId)
                          .map((conversation) => (
                            <a
                              key={conversation.id}
                              className="max-w-full truncate rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted"
                              href={conversation.url}
                              target="_blank"
                              rel="noreferrer"
                              title={conversation.url}
                            >
                              {conversation.url}
                            </a>
                          ))}
                      </div>
                    ) : null}
                  </CardContent>
                  {selected?.kind === "run" && selected.key === run.id ? (
                    <CardContent className="border-t pt-4" aria-live="polite">
                      {relationshipsLoading ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <LoaderCircleIcon className="size-4 animate-spin" />
                          Loading related tasks
                        </p>
                      ) : relationshipError ? (
                        <p className="text-sm text-destructive">{relationshipError}</p>
                      ) : relationships?.kind === "run" && relationships.data.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          <span className="text-xs font-medium text-muted-foreground uppercase">
                            Tasks
                          </span>
                          {relationships.data.map((task) => (
                            <span
                              key={task.linearIssueId}
                              className="rounded-md border px-2.5 py-1.5 text-xs"
                            >
                              {task.linearIssueId} · {task.status}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">No related tasks.</p>
                      )}
                    </CardContent>
                  ) : null}
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        {filtered.tasks.length > 0 ? (
          <section aria-label="Task list">
            <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <ListTodoIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Tasks{" "}
              <span className="text-xs font-normal text-muted-foreground">
                {filtered.tasks.length}
              </span>
            </h2>
            <div className="grid gap-3">
              {filtered.tasks.map((task) => (
                <Card
                  key={task.issueId}
                  size="sm"
                  className={
                    selected?.kind === "task" && selected.key === task.issueId
                      ? "border-primary/40 ring-2 ring-primary/10"
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className="w-full text-left"
                    aria-expanded={selected?.kind === "task" && selected.key === task.issueId}
                    onClick={() =>
                      setSelected(
                        selected?.kind === "task" && selected.key === task.issueId
                          ? null
                          : { kind: "task", key: task.issueId, issueId: task.issueId },
                      )
                    }
                  >
                    <CardHeader>
                      <CardTitle>{task.issueId}</CardTitle>
                      <CardDescription>{task.title || "Untitled"}</CardDescription>
                      <CardAction className="flex items-center gap-2">
                        <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                        {selected?.kind === "task" && selected.key === task.issueId ? (
                          <ChevronDownIcon className="size-4 text-muted-foreground" />
                        ) : (
                          <ChevronRightIcon className="size-4 text-muted-foreground" />
                        )}
                      </CardAction>
                    </CardHeader>
                    <CardContent className="text-xs text-muted-foreground">
                      <time dateTime={task.updatedAt}>
                        {new Date(`${task.updatedAt}Z`).toLocaleString("en-US")}
                      </time>
                    </CardContent>
                  </button>
                  {selected?.kind === "task" && selected.key === task.issueId ? (
                    <CardContent className="border-t pt-4" aria-live="polite">
                      {relationshipsLoading ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <LoaderCircleIcon className="size-4 animate-spin" />
                          Loading relationships
                        </p>
                      ) : relationshipError ? (
                        <p className="text-sm text-destructive">{relationshipError}</p>
                      ) : relationships?.kind === "task" ? (
                        <div className="grid gap-5">
                          <h3 className="text-sm font-semibold">Related models</h3>
                          {relationships.data.executions.length > 0 ? (
                            <section>
                              <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase">
                                Executions {relationships.data.executions.length}
                              </h4>
                              <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
                                {relationships.data.executions.map((execution) => (
                                  <div
                                    key={execution.id}
                                    className="rounded-lg border bg-muted/30 p-3 text-xs"
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <span className="font-mono">
                                        {execution.cli}:{execution.externalSessionId}
                                      </span>
                                      <Badge variant="outline">{execution.status}</Badge>
                                    </div>
                                    {execution.worktreePath ? (
                                      <p className="mt-2 break-all text-muted-foreground">
                                        {execution.worktreePath}
                                        {execution.branch ? ` · ${execution.branch}` : ""}
                                      </p>
                                    ) : null}
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      <CopyCommand
                                        command={
                                          execution.cli === "codex"
                                            ? `codex resume ${execution.externalSessionId}`
                                            : execution.cli === "devin"
                                              ? `devin --resume ${execution.externalSessionId}`
                                              : `claude --resume ${execution.externalSessionId}`
                                        }
                                      />
                                      {execution.sessionRunId ? (
                                        <CopyCommand
                                          command={`wr run focus ${execution.sessionRunId}`}
                                        />
                                      ) : null}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </section>
                          ) : null}
                          {relationships.data.pullRequests.length > 0 ? (
                            <section>
                              <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase">
                                Pull requests {relationships.data.pullRequests.length}
                              </h4>
                              <div className="flex max-h-72 flex-wrap gap-2 overflow-y-auto pr-1">
                                {relationships.data.pullRequests.map((pullRequest) => (
                                  <a
                                    key={`${pullRequest.repo}#${pullRequest.number}`}
                                    className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted"
                                    href={pullRequest.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {pullRequest.repo}#{pullRequest.number}
                                  </a>
                                ))}
                              </div>
                            </section>
                          ) : null}
                          {relationships.data.links.filter((link) => link.kind === "workpad")
                            .length > 0 ? (
                            <section>
                              <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase">
                                Workpads{" "}
                                {
                                  relationships.data.links.filter((link) => link.kind === "workpad")
                                    .length
                                }
                              </h4>
                              <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
                                {relationships.data.links
                                  .filter((link) => link.kind === "workpad")
                                  .map((link) => (
                                    <code
                                      key={link.ref}
                                      className="break-all rounded-md border bg-muted/30 px-2.5 py-2 text-xs"
                                    >
                                      {link.ref}
                                    </code>
                                  ))}
                              </div>
                            </section>
                          ) : null}
                          {relationships.data.links.filter((link) => link.kind === "conversation")
                            .length > 0 ? (
                            <section>
                              <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase">
                                Conversations{" "}
                                {
                                  relationships.data.links.filter(
                                    (link) => link.kind === "conversation",
                                  ).length
                                }
                              </h4>
                              <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
                                {relationships.data.links
                                  .filter((link) => link.kind === "conversation")
                                  .map((link) => (
                                    <a
                                      key={link.ref}
                                      className="break-all rounded-md border bg-muted/30 px-2.5 py-2 text-xs hover:bg-muted"
                                      href={link.ref}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {link.ref}
                                    </a>
                                  ))}
                              </div>
                            </section>
                          ) : null}
                          {relationships.data.executions.length === 0 &&
                          relationships.data.pullRequests.length === 0 &&
                          relationships.data.links.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No related models.</p>
                          ) : null}
                        </div>
                      ) : null}
                    </CardContent>
                  ) : null}
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        {filtered.pullRequests.length > 0 ? (
          <section aria-label="Pull request list">
            <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <GitPullRequestIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Pull requests
              <span className="text-xs font-normal text-muted-foreground">
                {filtered.pullRequests.length}
              </span>
            </h2>
            <div className="grid gap-3">
              {filtered.pullRequests.map((pullRequest) => (
                <Card
                  key={`${pullRequest.repo}#${pullRequest.number}`}
                  size="sm"
                  className={
                    selected?.kind === "pullRequest" &&
                    selected.key === `${pullRequest.repo}#${pullRequest.number}`
                      ? "border-primary/40 ring-2 ring-primary/10"
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className="w-full text-left"
                    aria-expanded={
                      selected?.kind === "pullRequest" &&
                      selected.key === `${pullRequest.repo}#${pullRequest.number}`
                    }
                    onClick={() =>
                      setSelected(
                        selected?.kind === "pullRequest" &&
                          selected.key === `${pullRequest.repo}#${pullRequest.number}`
                          ? null
                          : {
                              kind: "pullRequest",
                              key: `${pullRequest.repo}#${pullRequest.number}`,
                              repo: pullRequest.repo,
                              number: pullRequest.number,
                            },
                      )
                    }
                  >
                    <CardHeader>
                      <CardTitle>
                        {pullRequest.repo}#{pullRequest.number}
                      </CardTitle>
                      <CardDescription className="font-mono text-xs">
                        {pullRequest.headBranch} → {pullRequest.baseBranch}
                      </CardDescription>
                      <CardAction className="flex items-center gap-2">
                        <Badge variant={statusVariant(pullRequest.state)}>
                          {pullRequest.state}
                        </Badge>
                        {selected?.kind === "pullRequest" &&
                        selected.key === `${pullRequest.repo}#${pullRequest.number}` ? (
                          <ChevronDownIcon className="size-4 text-muted-foreground" />
                        ) : (
                          <ChevronRightIcon className="size-4 text-muted-foreground" />
                        )}
                      </CardAction>
                    </CardHeader>
                  </button>
                  <CardContent>
                    <div className="mb-2 flex flex-wrap gap-2">
                      <CopyCommand command={pullRequest.headBranch} />
                      <CopyCommand command={pullRequest.baseBranch} />
                    </div>
                    {pullRequest.deviceNames.length > 0 ? (
                      <p className="mb-2 text-xs text-muted-foreground">
                        Devices: {pullRequest.deviceNames.join(", ")}
                      </p>
                    ) : null}
                    <a
                      className="break-all text-xs text-primary underline-offset-4 hover:underline"
                      href={pullRequest.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {pullRequest.url}
                    </a>
                  </CardContent>
                  {selected?.kind === "pullRequest" &&
                  selected.key === `${pullRequest.repo}#${pullRequest.number}` ? (
                    <CardContent className="border-t pt-4" aria-live="polite">
                      {relationshipsLoading ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <LoaderCircleIcon className="size-4 animate-spin" />
                          Loading relationships
                        </p>
                      ) : relationshipError ? (
                        <p className="text-sm text-destructive">{relationshipError}</p>
                      ) : relationships?.kind === "pullRequest" ? (
                        <div className="grid gap-5">
                          <h3 className="text-sm font-semibold">Related models</h3>
                          {relationships.data.tasks.length > 0 ? (
                            <section>
                              <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase">
                                Tasks {relationships.data.tasks.length}
                              </h4>
                              <div className="flex flex-wrap gap-2">
                                {relationships.data.tasks.map((task) => (
                                  <span
                                    key={task.issueId}
                                    className="rounded-md border px-2.5 py-1.5 text-xs"
                                  >
                                    {task.issueId} · {task.status}
                                  </span>
                                ))}
                              </div>
                            </section>
                          ) : null}
                          {relationships.data.runs.length > 0 ? (
                            <section>
                              <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase">
                                Session runs {relationships.data.runs.length}
                              </h4>
                              <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
                                {relationships.data.runs.map((run) => (
                                  <div
                                    key={run.id}
                                    className="rounded-lg border bg-muted/30 p-3 text-xs"
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <span className="font-mono">
                                        {run.cli}:{run.externalSessionId}
                                      </span>
                                      <Badge variant="outline">
                                        {run.endedAt ? "ended" : "active"}
                                      </Badge>
                                    </div>
                                    <p className="mt-2 text-muted-foreground">
                                      {run.terminalId || "No terminal"} · {run.startedAt}
                                    </p>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      <CopyCommand
                                        command={
                                          run.cli === "codex"
                                            ? `codex resume ${run.externalSessionId}`
                                            : run.cli === "devin"
                                              ? `devin --resume ${run.externalSessionId}`
                                              : `claude --resume ${run.externalSessionId}`
                                        }
                                      />
                                      <CopyCommand command={`wr run focus ${run.id}`} />
                                      {run.terminalId ? (
                                        <CopyCommand
                                          command={`wr terminal focus ${run.terminalId}`}
                                        />
                                      ) : null}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </section>
                          ) : null}
                          {relationships.data.checkouts.length > 0 ? (
                            <section>
                              <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase">
                                Checkouts {relationships.data.checkouts.length}
                              </h4>
                              <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
                                {relationships.data.checkouts.map((checkout) => (
                                  <div
                                    key={checkout.id}
                                    className="rounded-lg border bg-muted/30 p-3 text-xs"
                                  >
                                    <p className="break-all font-mono">{checkout.worktreePath}</p>
                                    <p className="mt-1 break-all text-muted-foreground">
                                      {checkout.repoRoot}
                                      {checkout.branch ? ` · ${checkout.branch}` : ""}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            </section>
                          ) : null}
                          {relationships.data.parentPullRequest ||
                          relationships.data.childPullRequests.length > 0 ? (
                            <section>
                              <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase">
                                Pull request stack
                              </h4>
                              <div className="flex flex-wrap gap-2">
                                {relationships.data.parentPullRequest ? (
                                  <a
                                    className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted"
                                    href={relationships.data.parentPullRequest.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Parent: {relationships.data.parentPullRequest.repo}#
                                    {relationships.data.parentPullRequest.number}
                                  </a>
                                ) : null}
                                {relationships.data.childPullRequests.map((child) => (
                                  <a
                                    key={`${child.repo}#${child.number}`}
                                    className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted"
                                    href={child.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Child: {child.repo}#{child.number}
                                  </a>
                                ))}
                              </div>
                            </section>
                          ) : null}
                          {relationships.data.tasks.length === 0 &&
                          relationships.data.runs.length === 0 &&
                          relationships.data.checkouts.length === 0 &&
                          !relationships.data.parentPullRequest &&
                          relationships.data.childPullRequests.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No related models.</p>
                          ) : null}
                        </div>
                      ) : null}
                    </CardContent>
                  ) : null}
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        {filtered.conversationLinks.length > 0 ? (
          <section aria-label="Conversation list">
            <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <MessageSquareIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Conversations
              <span className="text-xs font-normal text-muted-foreground">
                {filtered.conversationLinks.length}
              </span>
            </h2>
            <div className="grid gap-3">
              {filtered.conversationLinks.map((conversation) => (
                <Card key={conversation.id} size="sm">
                  <CardContent className="grid gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="break-all font-mono">{conversation.id}</span>
                      <time dateTime={conversation.createdAt}>
                        {new Date(`${conversation.createdAt}Z`).toLocaleString("en-US")}
                      </time>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <CopyCommand command={conversation.url} />
                    </div>
                    <a
                      className="break-all text-xs text-primary underline-offset-4 hover:underline"
                      href={conversation.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {conversation.url}
                    </a>
                    {conversation.deviceNames.length > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Devices: {conversation.deviceNames.join(", ")}
                      </p>
                    ) : null}
                    {conversation.repoRoot || conversation.worktreePath ? (
                      <p className="break-all text-xs text-muted-foreground">
                        {conversation.repoRoot}
                        {conversation.worktreePath ? ` · ${conversation.worktreePath}` : ""}
                      </p>
                    ) : null}
                    {conversation.tasks.length > 0 ? (
                      <section>
                        <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase">
                          Tasks {conversation.tasks.length}
                        </h4>
                        <div className="flex flex-wrap gap-2">
                          {conversation.tasks.map((task) => (
                            <span
                              key={task.issueId}
                              className="rounded-md border px-2.5 py-1.5 text-xs"
                            >
                              {task.issueId} · {task.status}
                            </span>
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        {filteredTotal === 0 ? (
          <Card size="sm">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {nonCurrentTotal > 0
                ? "No current records match these filters."
                : "No records match these filters."}
            </CardContent>
          </Card>
        ) : null}
        {nonCurrentTotal > 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            + {nonCurrentTotal} non-current
          </p>
        ) : null}
      </div>
    </main>
  );
}
