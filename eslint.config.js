import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                URL: 'readonly',
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly'
            }
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "warn"
        }
    }
);
