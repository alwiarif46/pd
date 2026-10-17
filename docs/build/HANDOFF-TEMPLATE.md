# Handoff: chat N to chat N+1

**Status:** complete or partial. A partial handoff names the PR where work stopped and why.

## Built
- One line per merged PR: number, title, plan section, reviewer.

## Done-when evidence
- Each check from chat-N.md, with the test name or log line that proves it, or "unverified: <reason>".

## Owner decisions this chat
- Question, answer, and where it now lives in the plans.

## Not done or changed
- Anything deferred, with the reason and the chat that picks it up.

## Stubs in place
- Each stub, the owner step it waits on, and the check it blocks.

## Design gaps
- Each screen or state built with frontend-design because the design had none, with the question logged.

## Open issues and risks
- Known bugs, flaky tests (tagged `@flaky`), workarounds, merges the session could not make.

## Environment notes
- Tools installed or missing, blocked hosts, commands that differed from BUILD-PLAN s3, env vars the next chat needs, owner steps still pending.

## Prompt for chat N+1
```
Continue the E2E Proposal build. Read docs/build/BUILD-PLAN.md, then docs/build/chat-<N+1>.md, then docs/build/handoffs/chat-<N>.md.
If docs/build/progress/chat-<N+1>.md exists, this chat already started: resume from it.
Run the setup check in BUILD-PLAN s3. Follow the chat loop in BUILD-PLAN s2 exactly: build the whole plan,
log decisions in docs/build/questions.md, ask me only at the end, then apply my answers and write the next handoff.
```
