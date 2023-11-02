import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { forbidden, OperationOutcomeError } from '@medplum/core';
import { MockClient } from '@medplum/mock';
import { ErrorBoundary, Loading, MedplumProvider } from '@medplum/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { Suspense } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from '../AppRoutes';

describe('AppsPage', () => {
  async function setup(url: string, medplum = new MockClient()): Promise<void> {
    await act(async () => {
      render(
        <MedplumProvider medplum={medplum}>
          <MemoryRouter initialEntries={[url]} initialIndex={0}>
            <MantineProvider>
              <Notifications />
              <ErrorBoundary>
                <Suspense fallback={<Loading />}>
                  <AppRoutes />
                </Suspense>
              </ErrorBoundary>
            </MantineProvider>
          </MemoryRouter>
        </MedplumProvider>
      );
    });
  }

  test('No apps found', async () => {
    await setup('/Bot/123/apps');
    await waitFor(() => screen.getByText('No apps found.', { exact: false }));

    expect(screen.getByText('No apps found.', { exact: false })).toBeInTheDocument();
  });

  test('Patient apps', async () => {
    await setup('/Patient/123/apps');
    await waitFor(() => screen.getByText('Apps'));

    expect(screen.getByText('Apps')).toBeInTheDocument();
    expect(screen.getByText('Vitals')).toBeInTheDocument();
  });

  test('Patient Smart App Launch', async () => {
    Object.defineProperty(window, 'location', {
      value: {
        pathname: '/Patient/123/apps',
        assign: jest.fn(),
      },
      writable: true,
    });

    await setup('/Patient/123/apps');
    await waitFor(() => screen.getByText('Apps'));

    expect(screen.getByText('Inferno Client')).toBeInTheDocument();
    expect(screen.getByText('Client application used for Inferno ONC compliance testing')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Inferno Client'));
    });

    expect(window.location.assign).toBeCalled();
  });

  test('Encounter Smart App Launch', async () => {
    Object.defineProperty(window, 'location', {
      value: {
        pathname: '/Encounter/123/apps',
        assign: jest.fn(),
      },
      writable: true,
    });

    await setup('/Encounter/123/apps');
    await waitFor(() => screen.getByText('Apps'));

    expect(screen.getByText('Inferno Client')).toBeInTheDocument();
    expect(screen.getByText('Client application used for Inferno ONC compliance testing')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Inferno Client'));
    });

    expect(window.location.assign).toBeCalled();
  });

  test('Access denied to ClientApplications', async () => {
    const medplum = new MockClient();
    (medplum as any).originalSearchResources = medplum.searchResources;
    medplum.searchResources = jest.fn().mockImplementation(async (resourceType, query) => {
      if (resourceType === 'ClientApplication') {
        throw new OperationOutcomeError(forbidden);
      }

      // Otherwise, fallback to the default implementation
      return (medplum as any).originalSearchResources(resourceType, query);
    });

    await setup('/Patient/123/apps', medplum);
    await waitFor(() => screen.getByText('Apps'));

    expect(screen.getByText('Apps')).toBeInTheDocument();
    expect(screen.getByText('Vitals')).toBeInTheDocument();
  });
});
