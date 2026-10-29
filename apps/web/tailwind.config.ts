import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // the business's brand colour is injected as an "r g b" triple in --brand (see lib/format.ts)
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};

export default config;
