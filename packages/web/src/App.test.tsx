import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('App', () => {
  it('shows the empty state on the home route', () => {
    render(<App />);
    expect(screen.getByText('No session selected')).toBeTruthy();
  });

  it('follows hash changes to a session route', () => {
    render(<App />);
    act(() => {
      window.location.hash = '#/s/abc';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByText('Session abc')).toBeTruthy();
  });
});
