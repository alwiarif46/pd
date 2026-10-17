# @pd/stage-interface

The contract every pipeline stage runs behind (02 s4, 04 s1). The orchestrator calls stage handlers through this interface only. Each handler lives in its owning service.

## Register a handler

```ts
import { StageRegistry, type StageHandler } from '@pd/stage-interface';

const shred: StageHandler<ShredInputs, ShredOutputs> = {
  id: 'shred',
  service: 'intel',
  skill: { name: 'compliance-matrix', version: '1.2' }, // version is optional; or skill: null for a stage with no skill
  inputSchema: { /* JSON Schema */ },
  outputSchema: { /* JSON Schema */ },
  async run(ctx, inputs) {
    // ctx.skill.body is the stage prompt. ctx.tenantId scopes every read.
    return { /* outputs */ };
  },
  gateCheck(outputs) {
    return { pass: outputs.rows.length > 0, reasons: [] };
  },
};

export const registry = new StageRegistry();
registry.register(shred); // a duplicate id throws
```

The orchestrator then calls `runStage(handler, { tenantId, runId, stageId }, inputs)`. It compiles the handler's schemas once (strict Ajv, so a typo keyword fails the stage), validates inputs, loads the skill and checks its version when the handler declares one, runs the handler, validates outputs, and runs the gate check. The result is a `StageResult` with status `done`, `failed` or `gate_failed`, and the skill name and version the stage ran with. `runStage` does not throw for stage errors. The context has no `skill` field for callers to pass; `runStage` sets it. If the handler declares `skill.version` and the loaded skill has another version, the stage fails. An `AbortSignal` on the context stops the wait and returns `failed`, with the signal's reason in the error when it is an `Error`. The abort listener is removed when the stage ends.

## Skills

- A skill is `<dir>/<name>/SKILL.md`. Optional frontmatter may set `version`. Without it, the version is the first 12 hex characters of the file's SHA-256.
- `loadSkill` in `src/skills.ts` is the only code that reads a SKILL.md. No service reads one directly (CLAUDE.md rule 7).
- Skills are not in git. Tests use stubs (this package's `test/fixtures/skills/`, until PR 10 adds `packages/testing/skills/`).
- `PD_SKILLS_DIR` sets the skills folder (a relative path is resolved against the working directory). Without it, the loader uses `<repo root>/skills`. `loadSkill(name, { dir })` and `runStage(..., { skills: { dir } })` override both.
- Skill names may not contain path parts. A missing skill throws `SkillNotFoundError`, which names the folder and the variable. So does a skill whose directory or `SKILL.md` is a symlink that leads outside the skills folder, or a `SKILL.md` that is not a regular file.

The model gateway client joins the stage context in chat 3.
