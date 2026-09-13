/**
 * Guards the transcript / live region so a render throw (e.g. a pathological
 * markdown token) shows a fallback line instead of tearing down the whole Ink
 * app. The status bars and input live outside the boundary and keep working.
 */

import React from 'react';
import { Text } from 'ink';

import type { Theme } from '../theme.js';

interface Props {
  theme: Theme;
  children: React.ReactNode;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { message: null };

  static getDerivedStateFromError(err: unknown): State {
    return { message: err instanceof Error ? err.message : String(err) };
  }

  override render(): React.ReactNode {
    if (this.state.message !== null) {
      return <Text color={this.props.theme.error}>⚠ render error: {this.state.message}</Text>;
    }
    return this.props.children;
  }
}
