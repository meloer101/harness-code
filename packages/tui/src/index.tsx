/**
 * `runTui` — the Ink entry point.
 *
 * Builds the push→pull bridge (EventBuffer + UiStore), creates the
 * `AgentSession` with the ask/confirm seams wired to the bridge, then renders
 * `<App>`. The theme comes from `settings.tui.theme` (dark is the v1 default).
 */

import React from 'react';
import { render } from 'ink';

import { AgentSession } from '@harness-code/core';
import type { AgentSessionConfig } from '@harness-code/core';
import { EventBuffer } from '@harness-code/protocol';

import { App } from './app.js';
import { renderBanner } from './banner.js';
import { ThemeContext } from './hooks/useTheme.js';
import { UiStore } from './state/bridges.js';
import { DARK, LIGHT } from './theme.js';

export interface RunTuiOptions extends AgentSessionConfig {
  onExit?: () => void;
}

export async function runTui(config: RunTuiOptions): Promise<void> {
  const { onExit, ...sessionConfig } = config;
  const theme = sessionConfig.settings.tui?.theme === 'light' ? LIGHT : DARK;

  const buffer = new EventBuffer();
  // The live session, shared by reference so the store's "always allow" seam
  // (and anything else outside React) targets whatever session `/resume` has
  // swapped in — `App` keeps `current` in sync with its session state.
  const sessionRef: { current: AgentSession | undefined } = { current: undefined };
  const store = new UiStore((label) => sessionRef.current?.engine.addAllowRule(label));

  const createSession = (resumeId?: string): Promise<AgentSession> =>
    AgentSession.create({
      ...sessionConfig,
      ...(resumeId ? { resumeId } : {}),
      askHandler: store.ask,
      confirm: store.confirm,
      onEvent: (e) => buffer.onEvent(e),
      onNotice: (n) => store.pushNotice(n),
    });

  const initialSession = await createSession(sessionConfig.resumeId);
  sessionRef.current = initialSession;

  // Print the MARVIS wordmark once, above the Ink app, before mounting.
  process.stdout.write(renderBanner(theme));

  const instance = render(
    <ThemeContext.Provider value={theme}>
      <App
        initialSession={initialSession}
        createSession={createSession}
        sessionRef={sessionRef}
        buffer={buffer}
        store={store}
        modelRef={sessionConfig.model.ref}
        cwd={sessionConfig.cwd}
        onExit={() => {
          instance.unmount();
          onExit?.();
        }}
      />
    </ThemeContext.Provider>,
    { exitOnCtrlC: false },
  );

  await instance.waitUntilExit();
  await sessionRef.current?.close();
}
