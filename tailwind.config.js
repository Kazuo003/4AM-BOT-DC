/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './public/**/*.{html,js}',
    './src/**/*.{html,js}'
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-ui)', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['var(--font-data)', 'ui-monospace', 'monospace']
      },
      colors: {
        brand: {
          50: '#EEF0FD',
          100: '#D5D8FB',
          400: '#727EF6',
          500: '#5865F2',
          600: '#4752C4',
          700: '#3C45A5'
        },
        canvas: '#0A0B0E',
        surface: {
          DEFAULT: '#13151B',
          subtle: '#0E1015',
          elevated: '#1A1D25',
          card: '#15171F'
        },
        border: {
          subtle: 'rgba(255, 255, 255, 0.06)',
          DEFAULT: 'rgba(255, 255, 255, 0.1)',
          focus: 'rgba(88, 101, 242, 0.5)'
        }
      }
    }
  },
  plugins: []
};
