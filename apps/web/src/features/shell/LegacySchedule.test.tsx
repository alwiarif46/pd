// @vitest-environment jsdom
// The legacy Schedule tab (until the port replaces it): a refused template shows the server's message.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Workspace } from '@/screens/Workspace';
import { jsonResponse } from '@/test/fetch';
import { bidDto, orgPayload } from '@/test/fixtures';

const REFUSED = 'This schedule already has template activities. Replace them to apply a template again.';

describe('legacy Schedule tab', () => {
  it('shows the error when a template is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/tabs/schedule/seed') && init?.method === 'POST') {
        return jsonResponse(409, { error: REFUSED, code: 'schedule_template_exists' });
      }
      if (/\/api\/bids\/[^/]+$/.test(url)) return jsonResponse(200, bidDto());
      if (url.endsWith('/tabs/schedule')) return jsonResponse(200, { activities: [], workdaysOnly: true });
      return jsonResponse(200, []);
    }));
    render(
      <Workspace
        embedded
        bidId="bid-1"
        tab="schedule"
        bids={[]}
        org={orgPayload()}
        onTab={() => undefined}
        onSwitch={() => undefined}
        refreshKey=""
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Standard template' }));
    expect(await screen.findByText(REFUSED)).toBeTruthy();
  });
});
