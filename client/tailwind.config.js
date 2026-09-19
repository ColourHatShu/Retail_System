/** @type {import('tailwindcss').Config} */

/**
 * Several utilities used throughout the app are Tailwind v4 names
 * (shadow-xs, shadow-2xs, backdrop-blur-xs) or plugin classes that were never
 * installed. On 3.4 they compiled to nothing, so the styling they expressed
 * silently never rendered. Rather than rewrite ~80 call sites, the tokens are
 * defined here with the values SPEC.md prescribes.
 */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      screens: {
        // Used as `hidden xs:inline` to drop label words on the narrowest phones.
        xs: '475px',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        // index.html has always downloaded JetBrains Mono; without this key
        // every `font-mono` fell through to Consolas and the font was paid
        // for on each page load without ever painting.
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        // v4 names. xs matches SPEC.md's card shadow exactly.
        '2xs': '0 1px 0 0 rgba(0, 0, 0, 0.05)',
        xs: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
      },
      backdropBlur: {
        xs: '4px',
      },
      scale: {
        98: '0.98',
      },
      flex: {
        2: '2 2 0%',
      },
      spacing: {
        0.2: '0.05rem',
      },
      colors: {
        brand: {
          50: '#f0fdf4',
          100: '#dcfce7',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
        }
      }
    },
  },
  plugins: [],
}
