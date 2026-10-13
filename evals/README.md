# Model Evaluation Harness

This directory contains the test harness for evaluating AI models against the golden set of solicitations.

## Structure

- `golden-set/` - 5 past solicitations with human matrices (3 for tuning, 2 held-out)
- `results/` - Evaluation reports per model
- `harness.ts` - Test harness implementation (to be created in Phase 1)

## Evaluation Criteria

- 98% recall on held-out documents
- 95% precision (row matches at 80% quote overlap)
- Correct due dates
- No row citing text missing from the solicitation
- Under 10 minutes per 200-page text-layer PDF on an idle worker

## Phase 1

The harness will be implemented in Phase 1 to select the production model.
