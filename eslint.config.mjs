// Regras de correção, não de estilo: o que aqui falha costuma ser defeito de verdade.
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['out/**', 'node_modules/**', 'media/**', 'hooks/**', 'scripts/**', 'test/**', 'docs/**', '.claude/**'] },
	{
		files: ['src/**/*.ts'],
		languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
		plugins: { '@typescript-eslint': tseslint.plugin },
		rules: {
			// Uma promessa esquecida esconde a falha e a ordem dos efeitos.
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/no-unnecessary-type-assertion': 'error',
			'@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
			'@typescript-eslint/no-for-in-array': 'error',
			'@typescript-eslint/no-implied-eval': 'error',
			eqeqeq: ['error', 'always'],
			'no-var': 'error',
			'prefer-const': 'error',
			'no-throw-literal': 'error',
			'no-unsafe-finally': 'error',
		},
	},
);
