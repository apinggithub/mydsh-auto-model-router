# Copy-paste examples

These files are meant to be **copied into a profile**, not loaded from here.
Each one is a fragment for `profiles/<profile>/cordis.patch.yml`; merge the entry
into that file rather than replacing it.

| File | What it gives you |
| --- | --- |
| [`levels-free-first.yml`](levels-free-first.yml) | L0–L2 on free Zhipu flash models, L3 on the DeepSeek platform API |
| [`levels-deepseek-account.yml`](levels-deepseek-account.yml) | Everything on the logged-in DeepSeek account (no API key needed) |
| [`quota-watch.yml`](quota-watch.yml) | The cloud-bill watchdog block, with the RAM notes inline |
| [`add-credentials.ps1`](add-credentials.ps1) | Writes/updates/removes one credential in `$DSH_HOME/.credentials.yaml` |

## Quick start on a fresh machine

```powershell
dsh plugin --profile desktop add '@apinggithub/mydsh-auto-model-router@0.3.1'

# 1. store the keys the examples reference (secret is typed, never echoed)
.\examples\add-credentials.ps1 -Name ZHIPU_API_KEY
.\examples\add-credentials.ps1 -Name DEEPSEEK_API_KEY
# only if you enable quotaWatch:
.\examples\add-credentials.ps1 -Name ALIBABA_CLOUD_ACCESS_KEY_ID
.\examples\add-credentials.ps1 -Name ALIBABA_CLOUD_ACCESS_KEY_SECRET

# 2. append the levels block to the profile patch
notepad $env:DSH_HOME\profiles\desktop\cordis.patch.yml

# 3. restart DSH once (bundles compose at boot; later edits hot-reload)
```

Check what the plugin sees at any time:

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/api/mydsh-auto-model-router/status
```

(the port is in the GUI URL; the route is unauthenticated by design)

## Rules of thumb that cost us real time

- **`reasoningEffort: null`** on any model without a thinking mode (Qwen/GLM
  flash). Writing `off` makes the host reject the request with
  `UNSUPPORTED_REASONING_EFFORT`.
- **Never mark a route `freeQuota: true`** unless you verified the provider
  stops at the quota instead of silently billing. If in doubt, leave it out and
  let `quotaWatch` retire the route once the bill shows spend.
- **Provider ids are per machine.** `zhipu`, `bailian-dell-vostro`,
  `deepseek-account` only exist if that machine's `llm-pi-ai` `providers:` block
  defines them.
- **Keep `L3` on a model with a large context window** (or rely on
  `contextGuard`), otherwise a long session gets its answer truncated to a
  handful of tokens and reads as "reached the output token limit".
