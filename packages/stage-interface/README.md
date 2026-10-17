# @pd/stage-interface

The contract every pipeline stage runs behind (02 s4, 04 s1). The orchestrator calls stage handlers through this interface only. Each handler lives in its owning service.

## Register a handler

```ts
import { StageRegistry, type StageHandler } from '@pd/stage-interface';

const shred: StageHandler<ShredInputs, ShredOutputs> = {
  id: 'shred',
  service: 'intel',
  skill: { name: 'compliance-matrix' }, // or null for a stage with no skill
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

The orchestrator then calls `runStage(handler, { tenantId, runId, stageId }, inputs)`. It validates inputs, loads the skill, runs the handler, validates outputs, and runs the gate check. The result is a `StageResult` with status `done`, `failed` or `gate_failed`, and the skill name and version the stage ran with. `runStage` does not throw for stage errors. An `AbortSignal` on the context stops the wait and returns `failed`.

## Skills

- A skill is `<dir>/<name>/SKILL.md`. Optional frontmatter may set `version`. Without it, the version is the first 12 hex characters of the file's SHA-256.
- `loadSkill` in `src/skills.ts` is the only code that reads a SKILL.md. No service reads one directly (CLAUDE.md rule 7).
- Skills are not in git. Tests use stubs (this package's `test/fixtures/skills/`).
- `PD_SKILLS_DIR` sets the skills folder. Without it, the loader uses `<repo root>/skills`. `loadSkill(name, { dir })` and `runStage(..., { skills: { dir } })` override both.
- Skill names may not contain path parts. A missing skill throws `SkillNotFoundError`, which names the folder and the variable.

The model gateway client joins the stage context in chat 3.
