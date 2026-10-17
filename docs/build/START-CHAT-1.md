# Paste this into the first Claude Code cloud session (repo alwiarif46/pd attached)

```
You are building E2E Proposal in this repo. Read docs/build/BUILD-PLAN.md, then docs/build/chat-1.md.
If docs/build/progress/chat-1.md exists, chat 1 already started: resume from it.
First check that docs/plans/00 to 09 and docs/build/ exist on master; if not, ask me once and stop.
Check that Atrium is in design/e2e/atrium-design/ (BUILD-PLAN s10).
Then run the setup in BUILD-PLAN s3, verifying each command in this session, and write the role agents in s4.
Follow the chat loop in BUILD-PLAN s2 exactly: build the whole chat-1 plan, merge each PR when CI is green
and its review passed (Fable reviews the items in s4), log every decision in docs/build/questions.md instead
of asking, and ask me only when the plan is finished. Then apply my answers and write
docs/build/handoffs/chat-1.md with the prompt for chat 2.
```
