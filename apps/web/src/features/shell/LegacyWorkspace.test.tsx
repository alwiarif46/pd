// @vitest-environment jsdom
// The legacy Workspace as the shell embeds it (until v0 replaces the tabs).
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Workspace } from '@/screens/Workspace';
import { jsonResponse } from '@/test/fetch';
import { bidDto, docDto, orgPayload } from '@/test/fixtures';
import type { TabsStatus } from '@/api';

function stubApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/api\/bids\/[^/]+$/.test(url)) return jsonResponse(200, bidDto());
    if (/\/tabs\//.test(url)) return jsonResponse(200, { rows: [] });
    return jsonResponse(200, []);
  });
  vi.stubGlobal('fetch', fetchMock);
  return () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/jobs')).length;
}

function workspace(refreshKey: string) {
  return (
    <Workspace
      embedded
      bidId="bid-1"
      tab="compliance"
      bids={[]}
      org={orgPayload()}
      onTab={() => undefined}
      onSwitch={() => undefined}
      refreshKey={refreshKey}
    />
  );
}

describe('Workspace embedded in the shell', () => {
  it('has no sidebar, Menu button or bid select', async () => {
    stubApi();
    const { container } = render(workspace(''));
    expect(container.querySelector('nav.sidebar')).toBeNull();
    expect(container.querySelector('.menu-btn')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });

  it('loads once when the shell first sends its job key, and reloads when the key changes', async () => {
    const jobLoads = stubApi();
    const view = render(workspace(''));
    await waitFor(() => expect(jobLoads()).toBe(1));
    view.rerender(workspace('job-1:running'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(jobLoads()).toBe(1);
    view.rerender(workspace('job-1:completed'));
    await waitFor(() => expect(jobLoads()).toBe(2));
  });

  it('loads once when mounted with a key already set', async () => {
    const jobLoads = stubApi();
    const view = render(workspace('job-1:running'));
    await waitFor(() => expect(jobLoads()).toBe(1));
    view.rerender(workspace('job-1:running'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(jobLoads()).toBe(1);
  });

  it('shows Confirm only for proposed compliance links, not fact or date links', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/amendment-links')) {
        return jsonResponse(200, [
          { id: 'l1', status: 'proposed', rowTable: 'compliance_rows', action: 'supersede', oldRowId: 'a', newRowId: 'b', confidence: '0.9' },
          { id: 'l2', status: 'proposed', rowTable: 'bid_facts', action: 'supersede', oldRowId: 'c', newRowId: 'd', confidence: '0.9' },
        ]);
      }
      if (/\/api\/bids\/[^/]+$/.test(url)) return jsonResponse(200, bidDto());
      if (/\/tabs\//.test(url)) return jsonResponse(200, { rows: [] });
      return jsonResponse(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(workspace(''));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(1));
  });

  it('shows the amendment tabs status on the documents list', async () => {
    const docsWith = (status: TabsStatus | null) => [docDto({ id: 'amd', kind: 'amendment', amendmentNo: 2, fileName: 'amd2.pdf', amendmentTabsStatus: status })];
    const run = async (status: TabsStatus | null) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/documents')) return jsonResponse(200, docsWith(status));
          if (/\/api\/bids\/[^/]+$/.test(url)) return jsonResponse(200, bidDto());
          if (/\/tabs\//.test(url)) return jsonResponse(200, { rows: [] });
          return jsonResponse(200, []);
        }),
      );
      return render(
        <Workspace embedded bidId="bid-1" tab="documents" bids={[]} org={orgPayload()} onTab={() => undefined} onSwitch={() => undefined} refreshKey="" />,
      );
    };
    const pending = await run('pending');
    await waitFor(() => expect(screen.getByText('Updating bid facts and dates')).toBeTruthy());
    // The status text and the note are separate words.
    expect(screen.getByText('Updating bid facts and dates').closest('td')?.textContent).toBe('live Updating bid facts and dates');
    pending.unmount();
    const failed = await run('failed');
    await waitFor(() => expect(screen.getByText('Bid facts and dates did not update. Retry the failed step above.')).toBeTruthy());
    failed.unmount();
    await run('applied');
    await waitFor(() => expect(screen.getByText('amd2.pdf')).toBeTruthy());
    expect(screen.queryByText(/Updating bid facts|did not update/)).toBeNull();
  });
});
