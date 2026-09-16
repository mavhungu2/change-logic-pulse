# AI session logs

Transcript of the Claude Code session that produced this repository, exported
from the tool's own session file (`~/.claude/projects/**/*.jsonl`) and converted
to Markdown.

| File | Span (UTC) | Turns |
|---|---|---|
| [01-build-session.md](./01-build-session.md) | 2026-09-14 20:33 → 2026-09-15 22:14 | 26 typed prompts, 579 assistant turns, 358 tool calls |

One session, start to finish: constraints, spec, the schema and its RLS policies,
the policy proof and the mutation check that tests the proof, the request path,
the endpoints, the seed, the two React flows, an adversarial security review, and
the fixes that came out of it.

It was preceded by a false start — the same opening prompt, interrupted after
about thirty seconds and restarted as the session above. It produced no work
product and is not included here.

## What was removed

The transcript is a faithful record of the build. Four categories were stripped
before publishing, each replaced in place with a visible marker so the omission is
never silent:

1. **Unrelated projects.** The tool injects a memory index and reads local config
   at startup, which pulled in the names — and in one case the security posture —
   of client and personal work that has nothing to do with this assignment.
2. **Personal documents.** Two early `ls`/`find` calls enumerated a home directory
   containing CVs, a completed form carrying an identifier, and similar. Directory
   listings outside this project are dropped wholesale rather than filtered: a
   keyword list cannot keep pace with a home folder.
3. **Identifying details.** Absolute paths are rewritten to `~` and the local
   username is replaced.
4. **Harness plumbing.** Injected system reminders and memory attachments, which
   are not part of the conversation and carried category 1.

Two further changes are practical rather than protective: 20 browser-automation
screenshots are noted but not embedded, and tool *output* longer than 2,000
characters is truncated with the omitted length recorded. Prompts and tool
*inputs* — the code actually written — are complete and unedited.

Nothing was added, reordered, or rewritten.

The local development credentials visible in the log (`JWT_SECRET`,
`pulse_owner_pw`) were deliberately left in: they are already published in
[`.env.example`](../.env.example), they only ever reach a container on localhost,
and redacting them here while they sit in the repo would be theatre.

Redaction was scripted rather than done by hand, so it is applied uniformly. The
script is not committed — its keyword list names the very things it exists to
remove.
