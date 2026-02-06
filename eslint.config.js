import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';

export default tseslint.config(
	// Global ignores
	{
		ignores: ['dist/**', 'node_modules/**', 'examples/**'],
	},

	// Base JS rules
	eslint.configs.recommended,

	// TypeScript strict + stylistic
	...tseslint.configs.strictTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},

	// Project-specific TypeScript overrides
	{
		files: ['src/**/*.ts'],
		rules: {
			// Allow explicit type annotations where helpful for documentation
			'@typescript-eslint/no-inferrable-types': 'off',

			// Allow non-null assertions in trusted internal code
			'@typescript-eslint/no-non-null-assertion': 'warn',

			// Enforce consistent type imports
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{ prefer: 'type-imports', fixStyle: 'inline-type-imports' },
			],

			// Ensure promises are handled
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',

			// Prefer nullish coalescing
			'@typescript-eslint/prefer-nullish-coalescing': 'warn',

			// Unused vars: allow underscore-prefixed
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
		},
	},

	// Prettier (must be last to override formatting rules)
	prettierConfig,
	{
		plugins: { prettier: prettierPlugin },
		rules: {
			'prettier/prettier': 'warn',
		},
	},
);
