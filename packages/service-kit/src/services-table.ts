/**
 * Service id to Postgres schema (09 s2). Kept in step with packages/contracts/services.json by a
 * test, so runtime code does not need to load the contracts package. The gateway has no schema.
 */
export const SERVICES: Readonly<Record<string, string | undefined>> = {
  gateway: undefined,
  identity: 'identity',
  billing: 'billing',
  ingest: 'ingest',
  intel: 'intel',
  orchestrator: 'orchestrator',
  modelgw: 'modelgw',
  drafting: 'drafting',
  review: 'review',
  render: 'render',
  evidence: 'evidence',
  comms: 'comms',
  portal: 'portal',
  drive: 'drive',
  notify: 'notify',
};
