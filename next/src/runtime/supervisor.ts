import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
const linuxSignalNumbers: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
    SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
    SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
    SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
    SIGPWR: 30, SIGSYS: 31,
};
function normalizeObservedSignal(signal: NodeJS.Signals | null): NodeJS.Signals | null {
    if (!signal || process.platform !== "darwin" || !process.versions.bun)
        return signal;
    // Bun reports the preserved numeric wait status through Linux signal names on macOS.
    const number = linuxSignalNumbers[signal];
    return Object.entries(constants.signals).find(([, value]) => value === number)?.[0] as NodeJS.Signals | undefined ?? signal;
}
export type ProcessOutcome = {
    kind: "exited" | "spawn_failed";
    code: number;
    signal: NodeJS.Signals | null;
};
export type ProcessObserver = {
    started(pid: number): void;
    uncertain(error: Error): void;
};
export function processExitCode(code: number | null, signal: NodeJS.Signals | null): number {
    return code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
}
/** Supervise the direct child only. No native-session/response semantics belong here. */
export function supervise(argv: string[], cwd: string, env: NodeJS.ProcessEnv, observer: ProcessObserver, spawnProcess: typeof spawn = spawn): Promise<ProcessOutcome> {
    return new Promise(resolve => {
        let child: ChildProcess;
        try {
            child = spawnProcess(argv[0]!, argv.slice(1), { cwd, env, stdio: "inherit" });
        }
        catch {
            resolve({ kind: "spawn_failed", code: 127, signal: null });
            return;
        }
        let spawned = false, settled = false;
        const notify = (error: Error) => {
            try {
                observer.uncertain(error);
            }
            catch { /* Keep observing the actual child even if the recorder is unavailable. */ }
        };
        const forward = (signal: NodeJS.Signals) => {
            if (settled || child.exitCode !== null || child.signalCode !== null)
                return;
            try {
                child.kill(signal);
            }
            catch (error) {
                notify(error instanceof Error ? error : new Error(String(error)));
            }
        };
        const term = () => forward("SIGTERM"), interrupt = () => forward("SIGINT");
        process.on("SIGTERM", term);
        process.on("SIGINT", interrupt);
        const finish = (outcome: ProcessOutcome) => {
            if (settled)
                return;
            settled = true;
            process.off("SIGTERM", term);
            process.off("SIGINT", interrupt);
            resolve(outcome);
        };
        child.once("spawn", () => {
            spawned = true;
            try {
                observer.started(child.pid!);
            }
            catch (error) {
                notify(error instanceof Error ? error : new Error(String(error)));
            }
        });
        child.on("error", error => {
            if (settled)
                return;
            // An error after spawn can be a failed kill/send; it is NOT proof of exit.
            if (!spawned)
                finish({ kind: "spawn_failed", code: 127, signal: null });
            else
                notify(error);
        });
        child.once("exit", (code, signal) => {
            const normalized = normalizeObservedSignal(signal);
            finish({ kind: "exited", code: processExitCode(code, normalized), signal: normalized });
        });
    });
}
