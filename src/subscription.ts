/** Variables that make Claude Code, or a provider SDK it starts, bill an API account instead of the owner's subscription. */
const BILLING = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|BEDROCK_.*|VERTEX_.*|FOUNDRY_.*)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|OPENAI_API_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)$/i;

/**
 * Owner's rule, 2026-11-21: Ratchet never uses an API key for real costs unless the owner says so.
 * Every claude process Ratchet starts gets this environment, so a key set in the shell cannot reach it and the login is the subscription's.
 */
export const subscriptionEnv = (env: Record<string, string | undefined>): Record<string, string | undefined> => Object.fromEntries(Object.entries(env).filter(([name]) => !BILLING.test(name)));
