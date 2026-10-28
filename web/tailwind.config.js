/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces (light theme): canvas → card → raised → inset → border → strong border
        ink: {
          950: '#f4f6fa',
          925: '#eff2f7',
          900: '#ffffff',
          850: '#ffffff',
          800: '#f1f4f8',
          750: '#e6eaf1',
          700: '#dbe0e8',
          600: '#c3cad6',
        },
        // Foreground ramp: slate-50/100/200/300/400/500/600 in the markup map onto this
        slate: {
          50: '#ffffff',
          100: '#0b1220',
          200: '#1c2634',
          300: '#334153',
          400: '#556375',
          500: '#6c798b',
          600: '#8b97a8',
          700: '#aab4c2',
          800: '#cfd6e0',
          900: '#e6eaf1',
        },
        accent: {
          300: '#0369a1',
          400: '#0284c7',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'Segoe UI',
          'sans-serif',
        ],
        mono: ['SF Mono', 'JetBrains Mono', 'Menlo', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-in': 'slideIn 0.25s ease-out',
      },
      keyframes: {
        slideIn: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
