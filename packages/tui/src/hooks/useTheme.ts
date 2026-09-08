import { createContext, useContext } from 'react';

import { DARK } from '../theme.js';
import type { Theme } from '../theme.js';

export const ThemeContext = createContext<Theme>(DARK);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
