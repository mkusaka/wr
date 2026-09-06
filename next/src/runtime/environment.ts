/** Remove ancestor wr credentials/bindings before creating another invocation. */
export function cleanWorkEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env = { ...base };
    for (const key of Object.keys(env))
        if (key.startsWith("WR_NEXT_") && key !== "WR_NEXT_HOME" || ["WR_SESSION_RUN_ID", "WR_CLI_SESSION", "WR_EXECUTION_ID", "WR_PARENT_CLI_SESSION"].includes(key))
            delete env[key];
    return env;
}
/** Missing assignment is explicit: never fall back to the operator connection. */
export function unboundToolEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return { ...cleanWorkEnvironment(base), WR_NEXT_BINDING_REQUIRED: "1" };
}
